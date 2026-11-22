import { sqliteDialect } from '@shared/sql/dialect'
import { valueText } from '@shared/value-text'
import type { Row } from '@shared/types'
import type { ColumnMeta, DdlKind, ForeignKeyMeta, IndexMeta, SchemaObjects, TableMeta, TriggerMeta } from '../metadata'
import type { Catalog, Query } from './catalog'

const q = sqliteDialect.quoteIdentifier
const name = `(?:"(?:[^"]|"")*"|\`[^\`]*\`|\\[[^\\]]*\\]|[^\\s.("]+)`
const triggerHead = new RegExp(
  `^\\s*CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}(?:\\s*\\.\\s*${name})?\\s+(?:(BEFORE|AFTER|INSTEAD\\s+OF)\\s+)?(DELETE|INSERT|UPDATE)\\b`,
  'i'
)

/** Timing and event of a trigger from its CREATE TRIGGER statement (timing defaults to BEFORE). */
export function triggerTiming(sql: string): { timing: string; event: string } {
  const m = triggerHead.exec(sql)
  if (!m) return { timing: '', event: '' }
  return { timing: (m[1] ?? 'BEFORE').toUpperCase().replace(/\s+/, ' '), event: m[2].toUpperCase() }
}

/** SQLite catalog from sqlite_master and the table-valued PRAGMA functions. */
export class SqliteCatalog implements Catalog {
  constructor(private query: Query) {}

  async schemas(): Promise<string[]> {
    const rows = await this.query('SELECT name FROM pragma_database_list ORDER BY seq')
    return rows.map((r) => String(r.name))
  }

  async objects(schema: string): Promise<SchemaObjects> {
    const rows = await this.query(
      `SELECT name, type FROM ${q(schema)}.sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`
    )
    const all: TableMeta[] = rows.map((r) => ({
      name: String(r.name),
      type: r.type === 'view' ? 'VIEW' : 'BASE TABLE',
      engine: null,
      rows: null,
      comment: ''
    }))
    return { tables: all.filter((t) => t.type !== 'VIEW'), views: all.filter((t) => t.type === 'VIEW'), routines: [] }
  }

  async columns(schema: string, table: string): Promise<ColumnMeta[]> {
    // hidden: 1 = hidden column of a virtual table, 2/3 = generated VIRTUAL/STORED
    const rows = await this.query(
      'SELECT name, type, "notnull" AS nn, dflt_value AS def, pk, hidden FROM pragma_table_xinfo(?, ?) WHERE hidden <> 1 ORDER BY cid',
      [table, schema]
    )
    const rowid = await this.rowidAlias(schema, table, rows)
    return rows.map((r) => ({
      name: String(r.name),
      type: valueText(r.type),
      nullable: Number(r.nn) === 0,
      key: Number(r.pk) > 0 ? 'PRI' : '',
      default: r.def === null || r.def === undefined ? null : valueText(r.def),
      extra:
        r === rowid?.column ? rowid.extra : Number(r.hidden) === 2 ? 'VIRTUAL GENERATED' : Number(r.hidden) === 3 ? 'STORED GENERATED' : '',
      comment: ''
    }))
  }

  /**
   * The INTEGER PRIMARY KEY column that aliases the rowid (the only key column, declared exactly INTEGER, in a table
   * with a rowid), which SQLite fills when left out: extra AUTOINCREMENT when the table declares it, otherwise rowid.
   */
  private async rowidAlias(
    schema: string,
    table: string,
    columns: Row[]
  ): Promise<{ column: Row; extra: string } | null> {
    const keys = columns.filter((r) => Number(r.pk) > 0)
    if (keys.length !== 1 || valueText(keys[0].type).toUpperCase() !== 'INTEGER') return null
    const [row] = await this.query(
      `SELECT l.wr AS wr, m.sql AS sql FROM pragma_table_list l JOIN ${q(schema)}.sqlite_master m ON m.type = 'table' AND m.name = l.name
       WHERE l.schema = ? AND l.name = ?`,
      [schema, table]
    )
    if (!row || Number(row.wr) !== 0) return null
    return { column: keys[0], extra: /\bAUTOINCREMENT\b/i.test(valueText(row.sql)) ? 'AUTOINCREMENT' : 'rowid' }
  }

  async indexes(schema: string, table: string): Promise<IndexMeta[]> {
    const rows = await this.query(
      `SELECT il.name AS name, il."unique" AS uniq, il.origin AS origin, ii.name AS col
       FROM pragma_index_list(?, ?) il JOIN pragma_index_info(il.name, ?) ii ORDER BY il.name, ii.seqno`,
      [table, schema, schema]
    )
    const byName = new Map<string, IndexMeta>()
    for (const r of rows) {
      const primary = r.origin === 'pk'
      const key = primary ? 'PRIMARY' : String(r.name)
      let index = byName.get(key)
      if (!index) {
        index = { name: key, unique: Number(r.uniq) === 1, columns: [], type: primary ? 'PRIMARY KEY' : r.origin === 'u' ? 'UNIQUE' : 'INDEX' }
        byName.set(key, index)
      }
      index.columns.push(r.col === null ? '<expression>' : valueText(r.col))
    }
    const list = [...byName.values()]
    if (!byName.has('PRIMARY')) {
      // an INTEGER PRIMARY KEY is the rowid: it has no index of its own
      const pk = (await this.columns(schema, table)).filter((c) => c.key === 'PRI')
      if (pk.length) list.unshift({ name: 'PRIMARY', unique: true, columns: pk.map((c) => c.name), type: 'PRIMARY KEY' })
    }
    return list.sort((a, b) => Number(b.name === 'PRIMARY') - Number(a.name === 'PRIMARY') || a.name.localeCompare(b.name))
  }

  async foreignKeys(schema: string, table: string): Promise<ForeignKeyMeta[]> {
    const rows = await this.query(
      'SELECT id, "table" AS ref_table, "from" AS col, "to" AS ref_col FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq',
      [table, schema]
    )
    const byId = new Map<number, ForeignKeyMeta & { implicit: boolean }>()
    for (const r of rows) {
      const id = Number(r.id)
      let fk = byId.get(id)
      if (!fk) {
        fk = { name: `fk_${table}_${id}`, refSchema: schema, refTable: String(r.ref_table), columns: [], refColumns: [], implicit: false }
        byId.set(id, fk)
      }
      fk.columns.push(String(r.col))
      // REFERENCES parent without columns targets the parent's primary key
      if (r.ref_col === null) fk.implicit = true
      else fk.refColumns.push(valueText(r.ref_col))
    }
    const list = [...byId.values()]
    for (const fk of list.filter((f) => f.implicit)) {
      fk.refColumns = (await this.columns(schema, fk.refTable)).filter((c) => c.key === 'PRI').map((c) => c.name)
    }
    return list.map(({ implicit: _, ...fk }) => fk)
  }

  async triggers(schema: string, table: string): Promise<TriggerMeta[]> {
    const rows = await this.query(
      `SELECT name, sql FROM ${q(schema)}.sqlite_master WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE ORDER BY name`,
      [table]
    )
    return rows.map((r) => ({ name: String(r.name), ...triggerTiming(valueText(r.sql)) }))
  }

  /** The statement stored in sqlite_master; for an attached database its ATTACH statement. */
  async ddl(kind: DdlKind, schema: string, name?: string): Promise<string> {
    if (kind === 'SCHEMA') {
      if (schema === 'main' || schema === 'temp') return ''
      const [row] = await this.query('SELECT file FROM pragma_database_list WHERE name = ?', [schema])
      return row ? `ATTACH DATABASE ${sqliteDialect.quoteString(String(row.file))} AS ${q(schema)}` : ''
    }
    if (kind !== 'TABLE' && kind !== 'VIEW' && kind !== 'TRIGGER') return ''
    const [row] = await this.query(`SELECT sql FROM ${q(schema)}.sqlite_master WHERE type = ? AND name = ?`, [kind.toLowerCase(), name])
    return valueText(row?.sql)
  }
}
