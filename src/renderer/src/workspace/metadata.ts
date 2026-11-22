import { markRaw, reactive } from 'vue'
import type { Catalog } from './catalog/catalog'

export interface TableMeta {
  name: string
  /** 'BASE TABLE', 'VIEW', 'SYSTEM VIEW' or an engine's own kind. */
  type: string
  engine: string | null
  rows: number | null
  comment: string
}

export interface RoutineMeta {
  name: string
  type: 'PROCEDURE' | 'FUNCTION'
}

export interface TypeMeta {
  name: string
  kind: 'enum' | 'domain' | 'composite' | 'range'
}

export interface SchemaObjects {
  tables: TableMeta[]
  views: TableMeta[]
  routines: RoutineMeta[]
  /** Read only by the engines that have them (EngineFeatures.extraPgObjects). */
  sequences?: { name: string }[]
  types?: TypeMeta[]
}

export interface ExtensionMeta {
  name: string
  version: string
  schema: string
}

export interface ColumnMeta {
  name: string
  type: string
  nullable: boolean
  key: string
  default: string | null
  extra: string
  comment: string
}

export interface IndexMeta {
  name: string
  unique: boolean
  columns: string[]
  type: string
}

export interface ForeignKeyMeta {
  name: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
}

export interface TriggerMeta {
  name: string
  timing: string
  event: string
}

export type DdlKind = 'TABLE' | 'VIEW' | 'PROCEDURE' | 'FUNCTION' | 'TRIGGER' | 'EVENT' | 'SCHEMA'

const key = (schema: string, table: string): string => `${schema}\u0000${table}`

/**
 * Cached catalog information read by the engine's Catalog through the
 * auxiliary connection. Reactive so the navigator updates as data arrives.
 */
export class Metadata {
  schemas: string[] = []
  schemasLoaded = false
  objects: Record<string, SchemaObjects | undefined> = {}
  columns: Record<string, ColumnMeta[] | undefined> = {}
  indexes: Record<string, IndexMeta[] | undefined> = {}
  foreignKeys: Record<string, ForeignKeyMeta[] | undefined> = {}
  triggers: Record<string, TriggerMeta[] | undefined> = {}
  extensions: ExtensionMeta[] | undefined = undefined
  // raw: promises must not be wrapped in reactive proxies
  private pending = markRaw(new Map<string, Promise<unknown>>())

  // raw: the catalog holds no reactive state
  private catalog: Catalog

  constructor(catalog: Catalog) {
    this.catalog = markRaw(catalog)
  }

  static create(catalog: Catalog): Metadata {
    return reactive(new Metadata(catalog)) as Metadata
  }

  private once<T>(id: string, load: () => Promise<T>): Promise<T> {
    let p = this.pending.get(id) as Promise<T> | undefined
    if (!p) {
      p = load().finally(() => this.pending.delete(id))
      this.pending.set(id, p)
    }
    return p
  }

  async loadSchemas(): Promise<string[]> {
    return this.once('schemas', async () => {
      this.schemas = await this.catalog.schemas()
      this.schemasLoaded = true
      return this.schemas
    })
  }

  async loadObjects(schema: string, force = false): Promise<SchemaObjects> {
    const cached = this.objects[schema]
    if (cached && !force) return cached
    return this.once(`objects:${schema}`, async () => {
      const objects = await this.catalog.objects(schema)
      this.objects[schema] = objects
      return objects
    })
  }

  /** Extensions of the session's database; none when the engine's catalog has no extensions. */
  async loadExtensions(force = false): Promise<ExtensionMeta[]> {
    const cached = this.extensions
    if (cached && !force) return cached
    return this.once('extensions', async () => {
      const list = (await this.catalog.extensions?.()) ?? []
      this.extensions = list
      return list
    })
  }

  async loadColumns(schema: string, table: string, force = false): Promise<ColumnMeta[]> {
    const k = key(schema, table)
    const cached = this.columns[k]
    if (cached && !force) return cached
    return this.once(`columns:${k}`, async () => {
      const cols = await this.catalog.columns(schema, table)
      this.columns[k] = cols
      return cols
    })
  }

  async loadIndexes(schema: string, table: string): Promise<IndexMeta[]> {
    const list = await this.catalog.indexes(schema, table)
    this.indexes[key(schema, table)] = list
    return list
  }

  async loadForeignKeys(schema: string, table: string): Promise<ForeignKeyMeta[]> {
    const list = await this.catalog.foreignKeys(schema, table)
    this.foreignKeys[key(schema, table)] = list
    return list
  }

  async loadTriggers(schema: string, table: string): Promise<TriggerMeta[]> {
    const list = await this.catalog.triggers(schema, table)
    this.triggers[key(schema, table)] = list
    return list
  }

  getColumns(schema: string, table: string): ColumnMeta[] | undefined {
    return this.columns[key(schema, table)]
  }

  getIndexes(schema: string, table: string): IndexMeta[] | undefined {
    return this.indexes[key(schema, table)]
  }

  getForeignKeys(schema: string, table: string): ForeignKeyMeta[] | undefined {
    return this.foreignKeys[key(schema, table)]
  }

  getTriggers(schema: string, table: string): TriggerMeta[] | undefined {
    return this.triggers[key(schema, table)]
  }

  /** CREATE statement of an object. */
  ddl(kind: DdlKind, schema: string, name?: string): Promise<string> {
    return this.catalog.ddl(kind, schema, name)
  }

  /** Forget cached data of a schema (or everything) so it is read again. */
  invalidate(schema?: string): void {
    if (!schema) {
      this.objects = {}
      this.columns = {}
      this.indexes = {}
      this.foreignKeys = {}
      this.triggers = {}
      this.extensions = undefined
      return
    }
    delete this.objects[schema]
    for (const store of [this.columns, this.indexes, this.foreignKeys, this.triggers]) {
      for (const k of Object.keys(store)) if (k.startsWith(schema + '\u0000')) delete store[k]
    }
  }

  invalidateTable(schema: string, table: string): void {
    const k = key(schema, table)
    delete this.columns[k]
    delete this.indexes[k]
    delete this.foreignKeys[k]
    delete this.triggers[k]
  }
}
