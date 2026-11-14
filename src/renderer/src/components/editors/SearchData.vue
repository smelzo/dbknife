<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Play, Square } from 'lucide-vue-next'
import type { Cell, Engine } from '@shared/types'
import { applyRowLimit } from '@shared/sql/analyze'
import { t } from '@/i18n'
import { runInNewTab } from '@/workspace/object-actions'
import type { Workspace } from '@/workspace/workspace'
import DataGrid, { type GridCell, type GridColumn } from '../grid/DataGrid.vue'

/**
 * "Search Table Data": looks for a value in the columns of every
 * table of the selected schemas, one query per table on the auxiliary connection.
 */
const props = defineProps<{ ws: Workspace }>()

type Mode = 'contains' | 'equals' | 'like' | 'regexp'

interface Match {
  schema: string
  table: string
  keyColumns: string[]
  /** Types of the key columns, for their literals (T-SQL dates). */
  keyTypes: string[]
  key: unknown[]
  column: string
  type: string
  value: string
}

const text = ref('')
const mode = ref<Mode>('contains')
const maxPerTable = ref(100)
const maxTotal = ref(10000)
const allTypes = ref(false)
const schemas = ref<string[]>([])
const selected = ref<Set<string>>(new Set())
const matches = ref<Match[]>([])
const status = ref('')
const running = ref(false)
let stop = false
const halt = (): void => {
  stop = true
}

onMounted(async () => {
  await props.ws.meta.loadSchemas().catch(() => undefined)
  schemas.value = props.ws.visibleSchemas()
  if (props.ws.defaultSchema) selected.value = new Set([props.ws.defaultSchema])
})

function toggle(schema: string): void {
  const next = new Set(selected.value)
  if (next.has(schema)) next.delete(schema)
  else next.add(schema)
  selected.value = next
}

interface SearchSql {
  /** Columns searched unless "all types" is checked. */
  isText(type: string): boolean
  /** Condition on the quoted column `c` with parameter number `n` (1-based). */
  condition(c: string, mode: Mode, n: number): string
  /** Columns left out even when all types are searched. */
  excluded?(type: string): boolean
  /** Expression comparing the quoted column `c` of type `type` with =, for types without the = operator. */
  equatable?(c: string, type: string): string
  /** False when the engine has no regular expressions. */
  regexp?: false
}

// ntext/text have no = operator: they are compared as nvarchar(max)
const asNvarchar = (c: string): string => `CAST(${c} AS nvarchar(max))`

// LIKE patterns escape their wildcards with a backslash; matching ignores case, as MySQL collations do
const searchSql: Partial<Record<Engine, SearchSql>> = {
  mysql: {
    isText: (type) => /char|text|enum|set|json/i.test(type),
    condition: (c, mode) => `${c} ${{ contains: 'LIKE', equals: '=', like: 'LIKE', regexp: 'REGEXP' }[mode]} ?`
  },
  postgres: {
    isText: (type) => /char|text|json|xml/i.test(type),
    condition: (c, mode, n) =>
      mode === 'equals' ? `lower(${c}::text) = lower($${n})` : `${c}::text ${mode === 'regexp' ? '~*' : 'ILIKE'} $${n}`
  },
  sqlite: {
    // columns without a declared type hold any value, text included
    isText: (type) => !type || /char|clob|text/i.test(type),
    condition: (c, mode) =>
      mode === 'equals' ? `${c} = ? COLLATE NOCASE` : mode === 'regexp' ? `${c} REGEXP ?` : `${c} LIKE ? ESCAPE '\\'`
  },
  mssql: {
    isText: (type) => /char|text/i.test(type),
    condition: (c, mode, n) => `${asNvarchar(c)} ${mode === 'equals' ? '=' : 'LIKE'} @p${n}${mode === 'equals' ? '' : " ESCAPE '\\'"}`,
    equatable: (c, type) => (/^n?text$/i.test(type) ? asNvarchar(c) : c),
    excluded: (type) => /binary|image|timestamp|rowversion|xml|geography|geometry|hierarchyid/i.test(type),
    regexp: false
  }
}

function engineSearch(engine: Engine): SearchSql {
  const s = searchSql[engine]
  if (!s) throw new Error(`No data search for ${engine}`)
  return s
}

/** Client-side test telling which of the returned columns matched. */
function matcher(): (v: string) => boolean {
  const wanted = text.value
  switch (mode.value) {
    case 'contains':
      return (v) => v.toLowerCase().includes(wanted.toLowerCase())
    case 'equals':
      return (v) => v.toLowerCase() === wanted.toLowerCase()
    case 'like': {
      const re = new RegExp(
        '^' + wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$',
        'is'
      )
      return (v) => re.test(v)
    }
    case 'regexp': {
      let re: RegExp
      try {
        re = new RegExp(wanted, 'i')
      } catch {
        return () => true
      }
      return (v) => re.test(v)
    }
  }
}

function condition(col: string, n: number): { sql: string; param: string } {
  const d = props.ws.dialect
  const q = d.quoteIdentifier(col)
  const c = allTypes.value && d.engine !== 'postgres' && d.engine !== 'mssql' ? `CAST(${q} AS ${d.engine === 'mysql' ? 'CHAR' : 'TEXT'})` : q
  // [ opens a character class in T-SQL LIKE patterns
  const special = d.engine === 'mssql' ? /[\\%_[]/g : /[\\%_]/g
  const param =
    mode.value === 'contains'
      ? `%${text.value.replace(special, '\\$&')}%`
      : mode.value === 'regexp' && d.engine === 'sqlite'
        ? `(?i:${text.value})`
        : text.value
  return { sql: engineSearch(d.engine).condition(c, mode.value, n), param }
}

async function search(): Promise<void> {
  if (!text.value || !selected.value.size) return
  running.value = true
  stop = false
  matches.value = []
  const test = matcher()
  const found: Match[] = []
  try {
    const tables: { schema: string; table: string }[] = []
    for (const schema of selected.value) {
      const objects = await props.ws.meta.loadObjects(schema)
      for (const o of objects.tables) tables.push({ schema, table: o.name })
    }
    for (let i = 0; i < tables.length && !stop && found.length < maxTotal.value; i++) {
      const { schema, table } = tables[i]
      status.value = t('searchData.searching', { schema, table, n: i + 1, total: tables.length })
      const cols = await props.ws.meta.loadColumns(schema, table)
      const d = props.ws.dialect
      const s = engineSearch(d.engine)
      const searchable = cols.filter((c) => !s.excluded?.(c.type) && (allTypes.value || s.isText(c.type)))
      if (!searchable.length) continue
      const keys = cols.filter((c) => c.key === 'PRI')
      const keyColumns = keys.map((c) => c.name)
      const keyTypes = keys.map((c) => c.type)
      const conds = searchable.map((c, j) => condition(c.name, j + 1))
      const select = [...keys, ...searchable].map((c, j) => `${d.quoteIdentifier(c.name)} AS c${j}`).join(', ')
      const sql = applyRowLimit(`SELECT ${select} FROM ${d.qualified(schema, table)} WHERE ${conds.map((c) => c.sql).join(' OR ')}`, Number(maxPerTable.value) || 100, d)
      const r = await window.api.db.query(props.ws.sessionId, sql, conds.map((c) => c.param))
      if (r.error) {
        props.ws.log('error', t('searchData.logSearch', { schema, table }), r.error.message)
        continue
      }
      for (const row of r.rows) {
        const key = keyColumns.map((_, j) => row[`c${j}`])
        searchable.forEach((col, j) => {
          const v = row[`c${keyColumns.length + j}`]
          if (v === null || v === undefined) return
          const value = v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v)
          if (test(value)) found.push({ schema, table, keyColumns, keyTypes, key, column: col.name, type: col.type, value })
        })
      }
      matches.value = [...found]
    }
    status.value = t(stop ? 'searchData.foundStopped' : 'searchData.found', { count: found.length })
  } catch (e) {
    status.value = (e as Error).message
  } finally {
    running.value = false
  }
}

const columns: GridColumn[] = [
  { name: t('searchData.column.schema') },
  { name: t('searchData.column.table') },
  { name: t('searchData.column.key') },
  { name: t('searchData.column.column') },
  { name: t('searchData.column.data'), width: 420 }
]

const cell = (r: number, c: number): GridCell => {
  const m = matches.value[r]
  const v = [m.schema, m.table, m.key.map(String).join(', '), m.column, m.value.replace(/\r?\n/g, '↵')][c]
  return { text: v }
}

const canSearch = computed(() => !!text.value && selected.value.size > 0 && !running.value)

/** Opens the matching row in a new query tab. */
function openRow(r: number): void {
  const m = matches.value[r]
  const d = props.ws.dialect
  const column = d.quoteIdentifier(m.column)
  const where = m.keyColumns.length
    ? m.keyColumns.map((k, i) => `${d.quoteIdentifier(k)} = ${d.literal(m.key[i] as Cell, { type: m.keyTypes[i] })}`).join(' AND ')
    : `${engineSearch(d.engine).equatable?.(column, m.type) ?? column} = ${d.literal(m.value, { type: m.type })}`
  void runInNewTab(props.ws, `SELECT * FROM ${d.qualified(m.schema, m.table)} WHERE ${where};`, m.table)
}
</script>

<template>
  <div class="page">
    <div class="page-header">{{ t('workspace.tab.search') }}</div>
    <div class="options">
      <div class="schemas">
        <div class="muted label">{{ t('searchData.schemas') }}</div>
        <div class="list">
          <label v-for="s in schemas" :key="s" class="check"><input type="checkbox" :checked="selected.has(s)" @change="toggle(s)" /> {{ s }}</label>
        </div>
      </div>
      <div class="form-grid params">
        <label for="sd-text">{{ t('searchData.searchFor') }}</label>
        <input id="sd-text" v-model="text" type="text" autofocus @keydown.enter="canSearch && search()" />
        <label for="sd-mode">{{ t('searchData.searchUsing') }}</label>
        <select id="sd-mode" v-model="mode">
          <option value="contains">CONTAINS</option>
          <option value="equals">{{ t('searchData.mode.equals') }}</option>
          <option value="like">{{ t('searchData.mode.like') }}</option>
          <option v-if="engineSearch(ws.dialect.engine).regexp !== false" value="regexp">REGEXP</option>
        </select>
        <label for="sd-max">{{ t('searchData.maxPerTable') }}</label>
        <input id="sd-max" v-model.number="maxPerTable" type="number" min="1" />
        <label for="sd-total">{{ t('searchData.maxTotal') }}</label>
        <input id="sd-total" v-model.number="maxTotal" type="number" min="1" />
        <span />
        <label class="check"><input v-model="allTypes" type="checkbox" /> {{ t('searchData.allTypes') }}</label>
        <span />
        <div class="buttons">
          <button class="primary" :disabled="!canSearch" @click="search"><Play :size="12" /> {{ t('searchData.start') }}</button>
          <button :disabled="!running" @click="halt"><Square :size="11" /> {{ t('searchData.stop') }}</button>
          <span class="muted">{{ status }}</span>
        </div>
      </div>
    </div>
    <div class="results">
      <DataGrid :columns="columns" :row-count="matches.length" :cell="cell" :version="matches.length" @activate="openRow" />
    </div>
  </div>
</template>

<style scoped>
.options {
  display: flex;
  gap: 24px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.schemas {
  width: 240px;
  display: flex;
  flex-direction: column;
}

.label {
  margin-bottom: 4px;
}

.list {
  border: 1px solid var(--border);
  background: var(--bg-content);
  height: 150px;
  overflow: auto;
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.params {
  flex: 1;
  max-width: 620px;
  align-content: start;
}

.buttons {
  display: flex;
  gap: 8px;
  align-items: center;
}

.buttons button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.results {
  flex: 1;
  min-height: 0;
}
</style>
