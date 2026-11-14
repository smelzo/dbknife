import type { Engine, Snippet } from '@shared/types'
import type { SnippetSeed } from './seed'
import { mysqlSnippets } from './mysql'
import { postgresSnippets } from './postgres'
import { mssqlSnippets } from './mssql'
import { sqliteSnippets } from './sqlite'

const collections: Record<Engine, SnippetSeed[]> = {
  mysql: mysqlSnippets,
  postgres: postgresSnippets,
  mssql: mssqlSnippets,
  sqlite: sqliteSnippets
}

const fromSeeds = (engine: Engine, seeds: SnippetSeed[]): Snippet[] =>
  seeds.map(([category, title, sql]) => ({ id: crypto.randomUUID(), engine, category, title, sql }))

/**
 * The snippets the panel shows. Without our own file: MySQL Workbench's snippets, or
 * our MySQL collection, plus our collection of every other engine. A file written
 * before snippets had an engine holds MySQL snippets: they become MySQL's and the
 * other engines get their collection. Collections are added once: snippets the
 * user deletes do not come back.
 */
export function withDefaultSnippets(stored: Snippet[] | null, workbench: () => Snippet[] | null): Snippet[] {
  if (stored && stored.every((s) => s.engine)) return stored
  const mysql = stored ? stored.map((s) => ({ ...s, engine: 'mysql' as const })) : (workbench() ?? fromSeeds('mysql', collections.mysql))
  const others = (Object.keys(collections) as Engine[]).filter((e) => e !== 'mysql').flatMap((e) => fromSeeds(e, collections[e]))
  return [...mysql, ...others]
}
