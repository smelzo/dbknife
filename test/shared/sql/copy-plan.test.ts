import { describe, expect, it } from 'vitest'
import { buildCopyPlan, type PlanInput, type PlanStep, type SourceObject } from '@shared/sql/copy-plan'

// DDL as returned by SHOW CREATE … (MariaDB 11 and MySQL 8.4) after `USE <schema>`
const uca = 'utf8mb4_uca1400_ai_ci'
const createDb = (name: string, collation = uca): string =>
  `CREATE DATABASE \`${name}\` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE ${collation} */`

const table = (schema: string, name: string): SourceObject => ({
  kind: 'table',
  schema,
  name,
  ddl: `CREATE TABLE \`${name}\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`label\` varchar(40) COLLATE ${uca} DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=${uca}`
})

const view = (schema: string, name: string, select: string): SourceObject => ({
  kind: 'view',
  schema,
  name,
  ddl: `CREATE ALGORITHM=UNDEFINED DEFINER=\`root\`@\`localhost\` SQL SECURITY DEFINER VIEW \`${name}\` AS ${select}`,
  sqlMode: 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
  collationConnection: 'utf8mb4_general_ci'
})

const routine = (schema: string, kind: 'function' | 'procedure', ddl: string, name: string): SourceObject => ({
  kind,
  schema,
  name,
  ddl,
  sqlMode: 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
  collationConnection: 'utf8mb4_general_ci',
  databaseCollation: uca
})

const f1 = (schema: string): SourceObject =>
  routine(schema, 'function', 'CREATE DEFINER=`root`@`localhost` FUNCTION `f1`() RETURNS int(11)\n    DETERMINISTIC\nRETURN 1', 'f1')

const trigger = (schema: string): SourceObject => ({
  kind: 'trigger',
  schema,
  name: 'trg',
  ddl: 'CREATE DEFINER=`root`@`localhost` TRIGGER `trg` BEFORE INSERT ON `t` FOR EACH ROW SET NEW.`label` = UPPER(NEW.`label`)',
  sqlMode: 'STRICT_TRANS_TABLES',
  collationConnection: 'utf8mb4_general_ci',
  databaseCollation: uca
})

function input(objects: SourceObject[], over: Partial<PlanInput> = {}): PlanInput {
  const names = [...new Set(objects.map((o) => o.schema))]
  return {
    schemas: names.map((name) => ({ name, ddl: createDb(name), collation: uca })),
    objects,
    rename: Object.fromEntries(names.map((n) => [n, n])),
    definers: 'keep',
    existing: 'stop',
    structureOnly: false,
    collations: {},
    ...over
  }
}

const sqls = (steps: PlanStep[]): string[] => steps.map((s) => s.sql)
const creates = (steps: PlanStep[]): string[] => steps.filter((s) => /^CREATE\b/.test(s.sql)).map((s) => s.object)

describe('buildCopyPlan order', () => {
  it('creates a view after the views it uses, also across schemas', () => {
    const plan = buildCopyPlan(
      input([
        view('a', 'v1', 'select `v2`.`x` AS `x` from `v2`'),
        view('a', 'v2', 'select `v_b`.`x` AS `x` from `b`.`v_b`'),
        view('b', 'v_b', 'select `t`.`id` AS `x` from `t`'),
        table('b', 't')
      ])
    )
    const order = creates(plan.structure)
    expect(order.indexOf('b.v_b')).toBeLessThan(order.indexOf('a.v2'))
    expect(order.indexOf('a.v2')).toBeLessThan(order.indexOf('a.v1'))
    expect(plan.warnings).toEqual([])
  })

  it('creates every function before every view', () => {
    const plan = buildCopyPlan(
      input([view('a', 'v', 'select `b`.`f1`() AS `x`,`t`.`id` AS `id` from `t`'), table('a', 't'), f1('b'), f1('a')])
    )
    const order = creates(plan.structure)
    expect(order.indexOf('a.v')).toBeGreaterThan(order.indexOf('a.f1'))
    expect(order.indexOf('a.v')).toBeGreaterThan(order.indexOf('b.f1'))
    expect(plan.structure.find((s) => s.object === 'a.f1')?.compound).toBe(true)
  })

  it('leaves triggers to the finish steps, after the data', () => {
    const plan = buildCopyPlan(input([table('a', 't'), trigger('a')]))
    expect(plan.structure.some((s) => s.object === 'a.trg')).toBe(false)
    expect(plan.finish.find((s) => s.object === 'a.trg')).toMatchObject({ compound: true })
  })

  it('warns about a view cycle and still creates every view', () => {
    const plan = buildCopyPlan(
      input([view('a', 'v1', 'select `v2`.`x` AS `x` from `v2`'), view('a', 'v2', 'select `v1`.`x` AS `x` from `v1`')])
    )
    expect(creates(plan.structure)).toEqual(expect.arrayContaining(['a.v1', 'a.v2']))
    expect(plan.warnings).toEqual([{ code: 'viewCycle', objects: ['a.v1', 'a.v2'] }])
  })
})

describe('buildCopyPlan rewriting', () => {
  it('renames schema qualifiers but not strings, and flags them in routine bodies', () => {
    const p = routine(
      'a',
      'procedure',
      "CREATE DEFINER=`root`@`localhost` PROCEDURE `p`()\nBEGIN\n  SELECT 'a.t', COUNT(*) FROM `a`.`t`;\nEND",
      'p'
    )
    // MariaDB qualifies every table and column of a view
    const v = view('a', 'v', 'select `a`.`t`.`id` AS `id` from `a`.`t`')
    const plan = buildCopyPlan(input([table('a', 't'), p, v], { rename: { a: 'a2' } }))
    const body = plan.structure.find((s) => s.object === 'a2.p')!.sql
    expect(body).toContain("SELECT 'a.t', COUNT(*) FROM `a2`.`t`;")
    expect(plan.structure.find((s) => s.object === 'a2.v')!.sql).toContain('select `a2`.`t`.`id` AS `id` from `a2`.`t`')
    expect(sqls(plan.structure)).toContain('USE `a2`')
    expect(plan.warnings).toEqual([{ code: 'qualifiedReference', object: 'a.p' }])
  })

  it('renames only the schema part of a name when a table is named like its schema', () => {
    const v = view('log', 'v', 'select `log`.`log`.`id` AS `id` from `log`.`log`')
    const plan = buildCopyPlan(input([table('log', 'log'), v], { rename: { log: 'log2' } }))
    expect(plan.structure.find((s) => s.object === 'log2.v')!.sql).toContain('select `log2`.`log`.`id` AS `id` from `log2`.`log`')
  })

  it('warns about a view using a schema outside the copy, not about column qualifiers or system schemas', () => {
    const v = view('a', 'v', 'select `t`.`id` AS `id`,`x`.`n` AS `n` from ((`t` join `ext`.`u` `x`) join `mysql`.`user`)')
    const plan = buildCopyPlan(input([table('a', 't'), v]))
    expect(plan.warnings).toEqual([{ code: 'externalSchema', object: 'a.v', schema: 'ext' }])
  })

  it('removes DEFINER from the header only', () => {
    const p = routine(
      'a',
      'procedure',
      'CREATE DEFINER=`root`@`localhost` PROCEDURE `mkview`()\nBEGIN\n  CREATE DEFINER=`app`@`%` VIEW `v2` AS SELECT 1;\nEND',
      'mkview'
    )
    const v = view('a', 'v', 'select 1 AS `1`')
    const plan = buildCopyPlan(input([p, v], { definers: 'remove' }))
    expect(plan.structure.find((s) => s.object === 'a.mkview')!.sql).toBe(
      'CREATE PROCEDURE `mkview`()\nBEGIN\n  CREATE DEFINER=`app`@`%` VIEW `v2` AS SELECT 1;\nEND'
    )
    expect(plan.structure.find((s) => s.object === 'a.v')!.sql).toBe(
      'CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select 1 AS `1`'
    )
  })

  it('maps collations in the database, the tables and the session', () => {
    const plan = buildCopyPlan(
      input([table('a', 't'), f1('a')], { collations: { [uca]: 'utf8mb4_0900_ai_ci' } })
    )
    const all = sqls([...plan.structure, ...plan.finish])
    expect(all.filter((s) => s.includes('uca1400'))).toEqual([])
    expect(all).toContain('CREATE DATABASE `a` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci */')
    expect(plan.structure.find((s) => s.object === 'a.t')!.sql).toContain('COLLATE=utf8mb4_0900_ai_ci')
    expect(all).toContain("SET collation_connection = 'utf8mb4_general_ci'")
    // the routine's database collation maps to the schema's own: no ALTER DATABASE around it
    expect(all.filter((s) => s.startsWith('ALTER DATABASE'))).toEqual([])
  })

  it('leaves NO_AUTO_CREATE_USER out of the sql_mode, which MySQL 8 rejects', () => {
    const v = { ...view('a', 'v', 'select 1 AS `x`'), sqlMode: 'STRICT_TRANS_TABLES,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION' }
    const t = { ...trigger('a'), sqlMode: 'NO_AUTO_CREATE_USER' }
    const plan = buildCopyPlan(input([table('a', 't'), v, t]))
    const modes = sqls([...plan.structure, ...plan.finish]).filter((s) => s.startsWith('SET sql_mode ='))
    expect(modes).toContain("SET sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'")
    expect(modes).toContain("SET sql_mode = ''")
    expect(modes.filter((s) => s.includes('NO_AUTO_CREATE_USER'))).toEqual([])
  })

  it('creates a routine under its original database collation', () => {
    const f = { ...f1('a'), databaseCollation: 'latin1_swedish_ci' }
    const plan = buildCopyPlan(input([f], { rename: { a: 'a2' } }))
    const all = sqls(plan.structure)
    const at = all.findIndex((s) => s.startsWith('CREATE DEFINER'))
    expect(all.slice(at - 1, at + 2)).toEqual([
      'ALTER DATABASE `a2` COLLATE latin1_swedish_ci',
      all[at],
      `ALTER DATABASE \`a2\` COLLATE ${uca}`
    ])
  })

  it('drops the AUTO_INCREMENT table option for a structure-only copy, not the column attribute', () => {
    const plan = buildCopyPlan(input([table('a', 't')], { structureOnly: true }))
    const sql = plan.structure.find((s) => s.object === 'a.t')!.sql
    expect(sql).not.toContain('AUTO_INCREMENT=')
    expect(sql).toContain('`id` int(11) NOT NULL AUTO_INCREMENT,')
    expect(sql).toContain(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4')
  })
})

describe('buildCopyPlan recreate', () => {
  it('keeps an existing database and drops each object of the same name first', () => {
    const objects = [table('a', 't'), view('a', 'v', 'select 1 AS `1`')]
    const file = buildCopyPlan(input(objects, { existing: 'recreate' }))
    const all = sqls(file.structure)
    expect(all).toContain('CREATE DATABASE IF NOT EXISTS `a` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE ' + uca + ' */')
    expect(all[all.findIndex((s) => s.startsWith('CREATE TABLE')) - 1]).toBe('DROP TABLE IF EXISTS `a`.`t`')
    expect(all[all.findIndex((s) => s.startsWith('CREATE ALGORITHM')) - 1]).toBe('DROP VIEW IF EXISTS `a`.`v`')

    // a live target says what is there: a view named like the table, a table named like the view
    const live = sqls(buildCopyPlan(input(objects, { existing: 'recreate', targetKinds: { 'a.t': 'view', 'a.v': 'table' } })).structure)
    expect(live[live.findIndex((s) => s.startsWith('CREATE TABLE')) - 1]).toBe('DROP VIEW IF EXISTS `a`.`t`')
    expect(live[live.findIndex((s) => s.startsWith('CREATE ALGORITHM')) - 1]).toBe('DROP TABLE IF EXISTS `a`.`v`')

    const absent = sqls(buildCopyPlan(input([table('a', 't')], { existing: 'recreate', targetKinds: {} })).structure)
    expect(absent.filter((s) => s.startsWith('DROP'))).toEqual([])
  })
})
