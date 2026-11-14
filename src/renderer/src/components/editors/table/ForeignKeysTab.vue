<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Minus, Plus } from 'lucide-vue-next'
import type { ForeignKeyDef, TableDef } from '@shared/sql/create-table'
import type { Workspace } from '@/workspace/workspace'
import { t } from '@/i18n'
import type { TableEditorEngine } from './engines'
import { uniqueName } from './model'

/** Foreign keys: list with the referenced table, column mapping and actions of the selected one. */
const props = defineProps<{ ws: Workspace; schema: string; model: TableDef; engine: TableEditorEngine; readOnly?: boolean }>()

const selected = ref(0)
const fk = computed<ForeignKeyDef | undefined>(() => props.model.foreignKeys[selected.value])
const refColumns = ref<string[]>([])

const tables = computed(() => (props.ws.meta.objects[props.schema]?.tables ?? []).map((table) => `${props.schema}.${table.name}`))
const refTarget = (f: ForeignKeyDef): string => (f.refTable ? `${f.refSchema || props.schema}.${f.refTable}` : '')

const value = (e: Event): string => (e.target as HTMLInputElement).value

function setTarget(f: ForeignKeyDef, text: string): void {
  const dot = text.indexOf('.')
  const schema = dot < 0 ? '' : text.slice(0, dot).trim()
  f.refSchema = schema === props.schema ? '' : schema
  f.refTable = text.slice(dot + 1).trim()
}

watch(
  () => fk.value && [fk.value.refSchema, fk.value.refTable],
  async () => {
    refColumns.value = []
    const f = fk.value
    if (!f?.refTable) return
    try {
      refColumns.value = (await props.ws.meta.loadColumns(f.refSchema || props.schema, f.refTable)).map((c) => c.name)
    } catch {
      // unknown table: the mapping keeps what it has
    }
  },
  { immediate: true }
)

function add(): void {
  const name = uniqueName(`fk_${props.model.name}`, props.model.foreignKeys.map((f) => f.name))
  props.model.foreignKeys.push({ name, columns: [], refSchema: '', refTable: '', refColumns: [], onDelete: '', onUpdate: '' })
  selected.value = props.model.foreignKeys.length - 1
}

function remove(): void {
  if (!fk.value) return
  props.model.foreignKeys.splice(selected.value, 1)
  selected.value = Math.min(selected.value, props.model.foreignKeys.length - 1)
}

const position = (column: string): number => fk.value?.columns.indexOf(column) ?? -1

function toggle(column: string, on: boolean): void {
  const f = fk.value!
  if (on) {
    f.columns.push(column)
    f.refColumns.push(refColumns.value.find((c) => !f.refColumns.includes(c)) ?? '')
  } else {
    const n = position(column)
    f.columns.splice(n, 1)
    f.refColumns.splice(n, 1)
  }
}
</script>

<template>
  <div class="fks-tab">
    <div class="side">
      <div class="toolbar">
        <button class="icon-btn" :title="t('tableEditor.fks.add')" :disabled="readOnly" @click="add"><Plus :size="14" /></button>
        <button class="icon-btn" :title="t('tableEditor.fks.remove')" :disabled="readOnly || !fk" @click="remove"><Minus :size="14" /></button>
      </div>
      <div class="scroll">
        <table class="list">
          <thead>
            <tr>
              <th>{{ t('tableEditor.fks.fkName') }}</th>
              <th>{{ t('tableEditor.fks.referencedTable') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(f, n) in model.foreignKeys" :key="n" :class="{ selected: n === selected }" @mousedown="selected = n">
              <td><input v-model.trim="f.name" type="text" :disabled="readOnly" spellcheck="false" /></td>
              <td>
                <input type="text" :value="refTarget(f)" list="te-ref-tables" :disabled="readOnly" spellcheck="false" @change="setTarget(f, value($event))" />
              </td>
            </tr>
          </tbody>
        </table>
        <datalist id="te-ref-tables">
          <option v-for="table in tables" :key="table" :value="table" />
        </datalist>
      </div>
    </div>
    <div v-if="fk" class="main">
      <div class="scroll">
        <table class="list">
          <thead>
            <tr>
              <th>{{ t('tableEditor.column') }}</th>
              <th>{{ t('tableEditor.fks.referencedColumn') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in model.columns" :key="c.name">
              <td>
                <label class="check">
                  <input type="checkbox" :checked="position(c.name) >= 0" :disabled="readOnly" @change="toggle(c.name, ($event.target as HTMLInputElement).checked)" />
                  {{ c.name }}
                </label>
              </td>
              <td>
                <select v-if="position(c.name) >= 0" v-model="fk.refColumns[position(c.name)]" :disabled="readOnly">
                  <option v-if="!refColumns.includes(fk.refColumns[position(c.name)])" :value="fk.refColumns[position(c.name)]">
                    {{ fk.refColumns[position(c.name)] }}
                  </option>
                  <option v-for="r in refColumns" :key="r" :value="r">{{ r }}</option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="options form-grid">
        <label>{{ t('tableEditor.fks.onUpdate') }}</label>
        <select v-model="fk.onUpdate" :disabled="readOnly">
          <option value="">{{ t('tableEditor.fks.defaultAction') }}</option>
          <option v-for="a in engine.fkActions" :key="a">{{ a }}</option>
        </select>
        <label>{{ t('tableEditor.fks.onDelete') }}</label>
        <select v-model="fk.onDelete" :disabled="readOnly">
          <option value="">{{ t('tableEditor.fks.defaultAction') }}</option>
          <option v-for="a in engine.fkActions" :key="a">{{ a }}</option>
        </select>
      </div>
    </div>
    <div v-else class="main empty-state">{{ t('tableEditor.fks.noneSelected') }}</div>
  </div>
</template>

<style scoped>
.fks-tab {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) 1fr;
  height: 100%;
  min-height: 0;
}

.side,
.main {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.side {
  border-right: 1px solid var(--border);
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

table.list td {
  padding: 2px 6px;
}

table.list td input[type='text'] {
  width: 100%;
}

.options {
  flex-shrink: 0;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}

.options select {
  justify-self: start;
}
</style>
