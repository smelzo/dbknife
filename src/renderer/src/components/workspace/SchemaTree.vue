<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Database,
  Eye,
  Folder,
  FunctionSquare,
  Info,
  KeyRound,
  Layers,
  Link2,
  ListOrdered,
  Puzzle,
  Shapes,
  Table2,
  Workflow,
  Wrench,
  Zap
} from 'lucide-vue-next'
import type { MenuItemSpec } from '@shared/types'
import type { MessageKey } from '@shared/i18n'
import { openDialog } from '@/dialogs'
import { t } from '@/i18n'
import {
  dropObject,
  maintenance,
  vacuumDatabase,
  newDatabase,
  objectStatement,
  schemaDialog,
  selectRows,
  sendToEditor,
  truncateTable,
  type ObjectKind,
  type ObjectRef,
  type StatementKind
} from '@/workspace/object-actions'
import type { TypeMeta } from '@/workspace/metadata'
import type { Workspace } from '@/workspace/workspace'
import ImportFileDialog from '../editors/ImportFileDialog.vue'

const props = defineProps<{ ws: Workspace; filter: string }>()
const emit = defineEmits<{ filter: [text: string] }>()

type NodeKind =
  | ObjectKind
  | 'database'
  | 'tables'
  | 'views'
  | 'procedures'
  | 'functions'
  | 'columns'
  | 'indexes'
  | 'fks'
  | 'triggers'
  | 'sequences'
  | 'types'
  | 'extensions'
  | 'sequence'
  | 'type'
  | 'extension'

interface Node {
  key: string
  kind: NodeKind
  depth: number
  label: string
  detail?: string
  schema: string
  name?: string
  table?: string
  expandable: boolean
  loading?: boolean
}

// the database root, when the engine has one, starts open
const expanded = reactive(new Set<string>(['db']))
const loading = reactive(new Set<string>())
const selectedKey = ref('')
const hoverKey = ref('')
const list = ref<HTMLElement>()

const typeKinds: Record<TypeMeta['kind'], MessageKey> = {
  enum: 'schemaTree.typeKind.enum',
  domain: 'schemaTree.typeKind.domain',
  composite: 'schemaTree.typeKind.composite',
  range: 'schemaTree.typeKind.range'
}

const meta = computed(() => props.ws.meta)
const f = computed(() => props.filter.trim().toLowerCase())
const match = (name: string): boolean => !f.value || name.toLowerCase().includes(f.value)

const nodes = computed<Node[]>(() => {
  const out: Node[] = []
  const m = meta.value
  // PostgreSQL and SQL Server: the schemas are listed under the session's database
  const database = props.ws.info?.database
  const d = database ? 1 : 0
  if (database) {
    out.push({ key: 'db', kind: 'database', depth: 0, label: database, schema: '', expandable: true })
    if (!expanded.has('db') && !f.value) return out
  }
  for (const schema of props.ws.visibleSchemas()) {
    const objects = m.objects[schema]
    const label = props.ws.schemaLabel(schema)
    const schemaMatches = match(label)
    if (!schemaMatches && !objects) continue
    const sk = `s:${schema}`
    const filterObjects = !schemaMatches
    const tables = objects?.tables.filter((o) => !filterObjects || match(o.name)) ?? []
    const views = objects?.views.filter((o) => !filterObjects || match(o.name)) ?? []
    const procs = objects?.routines.filter((r) => r.type === 'PROCEDURE' && (!filterObjects || match(r.name))) ?? []
    const funcs = objects?.routines.filter((r) => r.type === 'FUNCTION' && (!filterObjects || match(r.name))) ?? []
    const extra = props.ws.features.extraPgObjects
    const sequences = extra ? (objects?.sequences?.filter((o) => !filterObjects || match(o.name)) ?? []) : []
    const types = extra ? (objects?.types?.filter((o) => !filterObjects || match(o.name)) ?? []) : []
    if (filterObjects && !tables.length && !views.length && !procs.length && !funcs.length && !sequences.length && !types.length) continue
    const open = expanded.has(sk) || (filterObjects && !!f.value)
    out.push({ key: sk, kind: 'schema', depth: d, label, schema, expandable: true, loading: loading.has(sk) })
    if (!open || !objects) continue
    const group = (kind: NodeKind, label: string, children: () => void): void => {
      const key = `${sk}/${kind}`
      out.push({ key, kind, depth: d + 1, label, schema, expandable: true })
      if (expanded.has(key) || (filterObjects && !!f.value)) children()
    }
    group('tables', t('schemaTree.tables'), () => {
      for (const table of tables) {
        const tk = `t:${schema}.${table.name}`
        out.push({ key: tk, kind: 'table', depth: d + 2, label: table.name, schema, name: table.name, expandable: true })
        if (!expanded.has(tk)) continue
        for (const [kind, label] of [
          ['columns', t('schemaTree.columns')],
          ['indexes', t('schemaTree.indexes')],
          ['fks', t('schemaTree.foreignKeys')],
          ...(props.ws.features.triggers ? ([['triggers', t('schemaTree.triggers')]] as const) : [])
        ] as const) {
          const gk = `${tk}/${kind}`
          out.push({ key: gk, kind, depth: d + 3, label, schema, table: table.name, expandable: true, loading: loading.has(gk) })
          if (!expanded.has(gk)) continue
          if (kind === 'columns') {
            for (const c of m.getColumns(schema, table.name) ?? [])
              out.push({ key: `${gk}:${c.name}`, kind: 'column', depth: d + 4, label: c.name, detail: c.type, schema, table: table.name, name: c.name, expandable: false })
          } else if (kind === 'indexes') {
            for (const ix of m.getIndexes(schema, table.name) ?? [])
              out.push({ key: `${gk}:${ix.name}`, kind: 'index', depth: d + 4, label: ix.name, detail: ix.columns.join(', '), schema, table: table.name, name: ix.name, expandable: false })
          } else if (kind === 'fks') {
            for (const fk of m.getForeignKeys(schema, table.name) ?? [])
              out.push({ key: `${gk}:${fk.name}`, kind: 'fk', depth: d + 4, label: fk.name, detail: `→ ${fk.refTable}`, schema, table: table.name, name: fk.name, expandable: false })
          } else {
            for (const tr of m.getTriggers(schema, table.name) ?? [])
              out.push({ key: `${gk}:${tr.name}`, kind: 'trigger', depth: d + 4, label: tr.name, detail: `${tr.timing} ${tr.event}`, schema, table: table.name, name: tr.name, expandable: false })
          }
        }
      }
    })
    group('views', t('schemaTree.views'), () => {
      for (const v of views) {
        const vk = `v:${schema}.${v.name}`
        out.push({ key: vk, kind: 'view', depth: d + 2, label: v.name, schema, name: v.name, expandable: true })
        if (!expanded.has(vk)) continue
        for (const c of m.getColumns(schema, v.name) ?? [])
          out.push({ key: `${vk}:${c.name}`, kind: 'column', depth: d + 3, label: c.name, detail: c.type, schema, table: v.name, name: c.name, expandable: false })
      }
    })
    if (props.ws.features.routines) {
      group('procedures', t('schemaTree.procedures'), () => {
        for (const r of procs) out.push({ key: `p:${schema}.${r.name}`, kind: 'procedure', depth: d + 2, label: r.name, schema, name: r.name, expandable: false })
      })
      group('functions', t('schemaTree.functions'), () => {
        for (const r of funcs) out.push({ key: `f:${schema}.${r.name}`, kind: 'function', depth: d + 2, label: r.name, schema, name: r.name, expandable: false })
      })
    }
    if (!extra) continue
    group('sequences', t('schemaTree.sequences'), () => {
      for (const q of sequences) out.push({ key: `q:${schema}.${q.name}`, kind: 'sequence', depth: d + 2, label: q.name, schema, name: q.name, expandable: false })
    })
    group('types', t('schemaTree.types'), () => {
      for (const ty of types)
        out.push({ key: `y:${schema}.${ty.name}`, kind: 'type', depth: d + 2, label: ty.name, detail: t(typeKinds[ty.kind]), schema, name: ty.name, expandable: false })
    })
  }
  // extensions belong to the database, not to a schema: their node's schema is the one holding their objects
  if (database && props.ws.features.extraPgObjects) {
    const extensions = m.extensions?.filter((x) => match(x.name)) ?? []
    if (!f.value || extensions.length) {
      const key = 'db/extensions'
      out.push({ key, kind: 'extensions', depth: 1, label: t('schemaTree.extensions'), schema: '', expandable: true, loading: loading.has(key) })
      if (expanded.has(key) || f.value)
        for (const x of extensions) out.push({ key: `x:${x.name}`, kind: 'extension', depth: 2, label: x.name, detail: x.version, schema: x.schema, name: x.name, expandable: false })
    }
  }
  return out
})

async function load(node: Node, force = false): Promise<void> {
  const m = meta.value
  loading.add(node.key)
  try {
    if (node.kind === 'schema') await m.loadObjects(node.schema, force)
    else if (node.kind === 'table' || node.kind === 'view') await m.loadColumns(node.schema, node.name!, force)
    else if (node.kind === 'columns') await m.loadColumns(node.schema, node.table!, force)
    else if (node.kind === 'indexes') await m.loadIndexes(node.schema, node.table!)
    else if (node.kind === 'fks') await m.loadForeignKeys(node.schema, node.table!)
    else if (node.kind === 'triggers') await m.loadTriggers(node.schema, node.table!)
    else if (node.kind === 'extensions') await m.loadExtensions(force)
  } catch (e) {
    props.ws.log('error', t('schemaTree.load', { name: node.label }), (e as Error).message)
  } finally {
    loading.delete(node.key)
  }
}

/** The node shows its children: expanded, or opened by the filter. */
const isOpen = (node: Node): boolean => expanded.has(node.key) || (!!props.filter && node.kind !== 'table')

function toggle(node: Node): void {
  if (!node.expandable) return
  if (expanded.has(node.key)) expanded.delete(node.key)
  else {
    expanded.add(node.key)
    void load(node)
  }
}

function selectNode(node: Node): void {
  selectedKey.value = node.key
  const kind = node.kind
  props.ws.selection = kind === 'database' ? null : { kind, schema: node.schema, name: node.name ?? node.table }
  if (kind === 'table' || kind === 'view') void meta.value.loadColumns(node.schema, node.name!).catch(() => undefined)
  if (kind === 'schema') void meta.value.loadObjects(node.schema).catch(() => undefined)
}

function onDblClick(node: Node): void {
  const d = props.ws.dialect
  if (node.kind === 'schema') void props.ws.setDefaultSchema(node.schema)
  else if ((node.kind === 'table' || node.kind === 'view') && props.ws.settings.tableDoubleClick === 'openData') {
    void selectRows(props.ws, node.schema, node.name!)
  } else if (['table', 'view', 'procedure', 'function', 'column', 'extension'].includes(node.kind)) {
    sendToEditor(props.ws, d.quoteIdentifier(node.name!))
  } else if (node.kind === 'sequence' || node.kind === 'type') sendToEditor(props.ws, d.qualified(node.schema, node.name!))
  else toggle(node)
}

function onKey(e: KeyboardEvent): void {
  const i = nodes.value.findIndex((n) => n.key === selectedKey.value)
  const node = nodes.value[i]
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const next = nodes.value[Math.max(0, Math.min(nodes.value.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next) {
      selectNode(next)
      list.value?.querySelector(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  } else if (node && e.key === 'ArrowRight' && node.expandable && !expanded.has(node.key)) toggle(node)
  else if (node && e.key === 'ArrowLeft' && expanded.has(node.key)) toggle(node)
  else if (node && e.key === 'Enter' && !e.repeat) onDblClick(node)
}

// --- context menus -----------------------------------------------------------

const copyItems = (prefix: string, table: boolean): MenuItemSpec[] => [
  { id: `${prefix}:name-short`, label: t('schemaTree.copy.nameShort') },
  { id: `${prefix}:name-long`, label: t('schemaTree.copy.nameLong') },
  ...(table
    ? [
        { id: `${prefix}:select`, label: t('schemaTree.copy.select') },
        { id: `${prefix}:insert`, label: t('schemaTree.copy.insert') },
        { id: `${prefix}:update`, label: t('schemaTree.copy.update') },
        { id: `${prefix}:delete`, label: t('schemaTree.copy.delete') }
      ]
    : []),
  { id: `${prefix}:create`, label: t('schemaTree.copy.create') }
]

/** Removes the items of features the engine lacks, and the separators left dangling. */
function available(node: Node, items: MenuItemSpec[]): MenuItemSpec[] {
  const f = props.ws.features
  const unavailable = new Set<string>()
  if (!props.ws.dialect.useSchema(node.schema)) unavailable.add('default')
  if (!f.newDatabase) unavailable.add('create-database')
  if (!f.schemaEditor) ['create-schema', 'alter-schema', ...(node.kind === 'schema' ? ['drop'] : [])].forEach((id) => unavailable.add(id))
  if (!f.triggers) unavailable.add('create-trigger')
  if (!f.vacuumDatabase) unavailable.add('vacuum')
  if (!f.adminPages.includes('copy')) unavailable.add('copy-database')
  const kept = items.filter((i) => !(i.id && unavailable.has(i.id)) && !(i.submenu && !i.submenu.length))
  return kept.filter((i, n) => i.type !== 'separator' || (n > 0 && kept[n - 1].type !== 'separator' && n < kept.length - 1))
}

function menuFor(node: Node): MenuItemSpec[] {
  return available(node, baseMenuFor(node))
}

function baseMenuFor(node: Node): MenuItemSpec[] {
  const refreshItems: MenuItemSpec[] = [{ type: 'separator' }, { id: 'refresh', label: t('navigator.refreshAll') }]
  switch (node.kind) {
    case 'database':
      return [{ id: 'create-database', label: t('schemaTree.menu.createDatabase') }, ...refreshItems]
    case 'schema':
      return [
        { id: 'default', label: t('schemaTree.menu.setDefault') },
        { id: 'filter', label: t('schemaTree.menu.filter') },
        { type: 'separator' },
        { id: 'inspect', label: t('schemaTree.menu.schemaInspector') },
        { id: 'vacuum', label: t('workspace.maintenance.vacuumDatabase') },
        { type: 'separator' },
        { label: t('schemaTree.menu.copy'), submenu: copyItems('copy', false) },
        { label: t('schemaTree.menu.send'), submenu: copyItems('send', false) },
        { type: 'separator' },
        // without a database node (MySQL, SQLite), New Database belongs with the schemas
        ...(props.ws.info?.database ? [] : [{ id: 'create-database', label: t('schemaTree.menu.createDatabase') }]),
        { id: 'create-schema', label: t('schemaTree.menu.createSchema') },
        { id: 'alter-schema', label: t('schemaTree.menu.alterSchema') },
        { id: 'copy-database', label: t('schemaTree.menu.copyDatabase') },
        { id: 'drop', label: t('schemaTree.menu.dropSchema') },
        ...refreshItems
      ]
    case 'tables':
      return [{ id: 'create-table', label: t('schemaTree.menu.createTable') }, ...refreshItems]
    case 'views':
      return [{ id: 'create-view', label: t('schemaTree.menu.createView') }, ...refreshItems]
    case 'procedures':
      return [{ id: 'create-procedure', label: t('schemaTree.menu.createProcedure') }, ...refreshItems]
    case 'functions':
      return [{ id: 'create-function', label: t('schemaTree.menu.createFunction') }, ...refreshItems]
    case 'table':
      return [
        { id: 'select', label: t('schemaTree.menu.selectRows') },
        { id: 'import-file', label: t('schemaTree.menu.importFile') },
        { id: 'inspect', label: t('schemaTree.menu.tableInspector') },
        { type: 'separator' },
        { label: t('schemaTree.menu.copy'), submenu: copyItems('copy', true) },
        { label: t('schemaTree.menu.send'), submenu: copyItems('send', true) },
        { type: 'separator' },
        { id: 'create-table', label: t('schemaTree.menu.createTable') },
        { id: 'alter-table', label: t('schemaTree.menu.alterTable') },
        { label: t('schemaTree.menu.maintenance'), submenu: props.ws.features.maintenance.map((op, i) => ({ id: `m:${i}`, label: op.label })) },
        { id: 'create-trigger', label: t('schemaTree.menu.createTrigger') },
        { type: 'separator' },
        { id: 'drop', label: t('schemaTree.menu.dropTable') },
        { id: 'truncate', label: t('schemaTree.menu.truncateTable') },
        ...refreshItems
      ]
    case 'view':
      return [
        { id: 'select', label: t('schemaTree.menu.selectRows') },
        { type: 'separator' },
        { label: t('schemaTree.menu.copy'), submenu: copyItems('copy', true) },
        { label: t('schemaTree.menu.send'), submenu: copyItems('send', true) },
        { type: 'separator' },
        { id: 'create-view', label: t('schemaTree.menu.createView') },
        { id: 'alter-routine', label: t('schemaTree.menu.alterView') },
        { id: 'drop', label: t('schemaTree.menu.dropView') },
        ...refreshItems
      ]
    case 'procedure':
    case 'function': {
      const procedure = node.kind === 'procedure'
      return [
        { label: t('schemaTree.menu.copy'), submenu: copyItems('copy', false) },
        { label: t('schemaTree.menu.send'), submenu: copyItems('send', false) },
        { type: 'separator' },
        { id: `create-${node.kind}`, label: t(procedure ? 'schemaTree.menu.createProcedure' : 'schemaTree.menu.createFunction') },
        { id: 'alter-routine', label: t(procedure ? 'schemaTree.menu.alterProcedure' : 'schemaTree.menu.alterFunction') },
        { id: 'drop', label: t(procedure ? 'schemaTree.menu.dropProcedure' : 'schemaTree.menu.dropFunction') },
        ...refreshItems
      ]
    }
    case 'trigger':
      return [
        { id: 'alter-routine', label: t('schemaTree.menu.alterTrigger') },
        { id: 'drop', label: t('schemaTree.menu.dropTrigger') },
        { label: t('schemaTree.menu.copy'), submenu: [{ id: 'copy:create', label: t('schemaTree.copy.create') }] },
        ...refreshItems
      ]
    case 'sequence':
    case 'type': {
      const names = (prefix: string): MenuItemSpec[] => copyItems(prefix, false).filter((i) => i.id !== `${prefix}:create`)
      return [
        { label: t('schemaTree.menu.copy'), submenu: names('copy') },
        { label: t('schemaTree.menu.send'), submenu: names('send') },
        ...refreshItems
      ]
    }
    // an extension's name is not schema-qualified: only the short name, as for a column
    case 'extension':
    case 'column':
      return [
        { id: 'copy:name-short', label: t('schemaTree.menu.copyName') },
        { id: 'send:name-short', label: t('schemaTree.menu.sendName') },
        ...refreshItems
      ]
    default:
      return refreshItems.slice(1)
  }
}

/** Label of the menu item with this id, submenus included. */
function labelOf(items: MenuItemSpec[], id: string): string | undefined {
  for (const item of items) {
    const label = item.id === id ? item.label : item.submenu && labelOf(item.submenu, id)
    if (label) return label
  }
  return undefined
}

async function onContext(node: Node): Promise<void> {
  selectNode(node)
  const items = menuFor(node)
  const choice = await window.api.ui.contextMenu(items)
  if (!choice) return
  const ws = props.ws
  const obj: ObjectRef = {
    kind: (node.kind === 'column' ? 'column' : node.kind) as ObjectKind,
    schema: node.schema,
    name: node.name,
    table: node.table
  }
  try {
    if (choice.startsWith('copy:') || choice.startsWith('send:')) {
      const [mode, what] = choice.split(':') as ['copy' | 'send', StatementKind]
      const text = await objectStatement(ws, obj, what)
      if (mode === 'copy') await navigator.clipboard.writeText(text)
      else sendToEditor(ws, text)
      return
    }
    if (choice.startsWith('m:')) {
      await maintenance(ws, ws.features.maintenance[Number(choice.slice(2))], node.schema, node.name!)
      return
    }
    switch (choice) {
      case 'refresh':
        await refresh()
        break
      case 'default':
        await ws.setDefaultSchema(node.schema)
        break
      case 'filter':
        emit('filter', node.schema)
        break
      case 'vacuum':
        await vacuumDatabase(ws, node.schema)
        break
      case 'inspect':
        ws.openInspector(node.schema, node.kind === 'table' ? node.name : undefined)
        break
      case 'create-database':
        await newDatabase(ws)
        break
      case 'create-schema':
        await schemaDialog(ws, null)
        break
      case 'alter-schema':
        await schemaDialog(ws, node.schema)
        break
      case 'copy-database':
        ws.openAdmin('copy', node.schema)
        break
      case 'create-table':
        ws.openTableEditor(node.schema, null)
        break
      case 'alter-table':
        ws.openTableEditor(node.schema, node.name!)
        break
      case 'create-view':
        ws.openRoutineEditor(node.schema, 'VIEW', null)
        break
      case 'create-procedure':
        ws.openRoutineEditor(node.schema, 'PROCEDURE', null)
        break
      case 'create-function':
        ws.openRoutineEditor(node.schema, 'FUNCTION', null)
        break
      case 'create-trigger':
        ws.openRoutineEditor(node.schema, 'TRIGGER', null, node.name)
        break
      case 'alter-routine':
        ws.openRoutineEditor(node.schema, node.kind.toUpperCase() as 'VIEW', node.name!, node.table)
        break
      case 'select':
        await selectRows(ws, node.schema, node.name!)
        break
      case 'import-file':
        await openDialog(ImportFileDialog, { ws, schema: node.schema, table: node.name! })
        break
      case 'drop':
        await dropObject(ws, obj)
        break
      case 'truncate':
        await truncateTable(ws, node.schema, node.name!)
        break
    }
  } catch (e) {
    ws.log('error', labelOf(items, choice) ?? choice, (e as Error).message)
  }
}

const iconFor: Record<string, unknown> = {
  database: Database,
  schema: Database,
  tables: Folder,
  views: Folder,
  procedures: Folder,
  functions: Folder,
  columns: Folder,
  indexes: Folder,
  fks: Folder,
  triggers: Folder,
  sequences: Folder,
  types: Folder,
  extensions: Folder,
  table: Table2,
  view: Eye,
  procedure: Workflow,
  function: FunctionSquare,
  column: Columns3,
  index: KeyRound,
  fk: Link2,
  trigger: Zap,
  sequence: ListOrdered,
  type: Shapes,
  extension: Puzzle
}

/** Reloads the schema list and everything currently expanded. */
async function refresh(): Promise<void> {
  props.ws.meta.invalidate()
  await props.ws.meta.loadSchemas().catch(() => undefined)
  for (const key of [...expanded]) {
    const n = nodes.value.find((x) => x.key === key)
    if (n) await load(n, true)
  }
}

defineExpose({ refresh })
</script>

<template>
  <div ref="list" class="tree" role="tree" tabindex="0" @keydown="onKey">
    <div v-if="!ws.meta.schemasLoaded" class="muted pad">{{ t('schemaTree.loading') }}</div>
    <div
      v-for="n in nodes"
      :key="n.key"
      :data-key="n.key"
      class="node"
      :class="{ selected: selectedKey === n.key, bold: n.kind === 'schema' && n.schema === ws.defaultSchema }"
      :style="{ paddingLeft: `${4 + n.depth * 14}px` }"
      role="treeitem"
      :aria-expanded="n.expandable ? isOpen(n) : undefined"
      :aria-level="n.depth + 1"
      :aria-selected="selectedKey === n.key"
      @mousedown="selectNode(n)"
      @dblclick="onDblClick(n)"
      @contextmenu.prevent="onContext(n)"
      @mouseenter="hoverKey = n.key"
      @mouseleave="hoverKey = ''"
    >
      <span class="twisty" @mousedown.stop="toggle(n)" @dblclick.stop>
        <template v-if="n.expandable">
          <ChevronDown v-if="isOpen(n)" :size="12" />
          <ChevronRight v-else :size="12" />
        </template>
      </span>
      <component :is="n.kind === 'schema' && ws.info?.database ? Layers : iconFor[n.kind]" :size="13" class="icon" :class="n.kind" />
      <span class="label">{{ n.label }}</span>
      <span v-if="n.detail" class="detail">{{ n.detail }}</span>
      <span v-if="n.loading" class="detail">…</span>
      <span v-if="n.kind === 'table' && hoverKey === n.key" class="hover-actions">
        <button class="icon-btn mini" :title="t('schemaTree.menu.tableInspector')" @mousedown.stop @click.stop="ws.openInspector(n.schema, n.name)">
          <Info :size="12" />
        </button>
        <button class="icon-btn mini" :title="t('schemaTree.alterTable')" @mousedown.stop @click.stop="ws.openTableEditor(n.schema, n.name!)">
          <Wrench :size="12" />
        </button>
        <button class="icon-btn mini" :title="t('schemaTree.menu.selectRows')" @mousedown.stop @click.stop="selectRows(ws, n.schema, n.name!)">
          <Table2 :size="12" />
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.tree {
  height: 100%;
  overflow: auto;
  outline: none;
  padding: 2px 0;
}

.pad {
  padding: 6px 10px;
}

.node {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  white-space: nowrap;
  padding-right: 6px;
  position: relative;
}

.node:hover {
  background: var(--bg-hover);
}

.node.selected {
  background: var(--bg-selected);
}

.node.bold .label {
  font-weight: 700;
}

.twisty {
  width: 14px;
  display: inline-flex;
  justify-content: center;
  color: var(--text-muted);
  flex: none;
}

.icon {
  flex: none;
  color: var(--text-muted);
}

.icon.database,
.icon.schema {
  color: #c08a2b;
}

.icon.table {
  color: #4a7fc1;
}

.icon.view {
  color: #7a5fc0;
}

.icon.procedure,
.icon.function {
  color: #2f9a70;
}

.icon.index,
.icon.fk {
  color: #c27c2c;
}

.label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.detail {
  color: var(--text-faint);
  font-size: var(--fs-small);
  overflow: hidden;
  text-overflow: ellipsis;
}

.hover-actions {
  position: absolute;
  right: 4px;
  display: flex;
  gap: 1px;
  background: var(--bg-panel);
  border-radius: 4px;
}

.icon-btn.mini {
  width: 20px;
  height: 18px;
}
</style>
