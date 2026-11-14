<script setup lang="ts">
import { computed, ref } from 'vue'
import { Minus, Plus } from 'lucide-vue-next'
import type { IndexDef, IndexKind, TableDef } from '@shared/sql/create-table'
import { t } from '@/i18n'
import type { TableEditorEngine } from './engines'
import { uniqueName } from './model'

/** Indexes of the table: list on the left, columns and options of the selected one on the right. */
const props = defineProps<{ model: TableDef; engine: TableEditorEngine; readOnly?: boolean }>()

const selected = ref(0)
const index = computed<IndexDef | undefined>(() => props.model.indexes[selected.value])

const value = (e: Event): string => (e.target as HTMLInputElement).value

function add(): void {
  const name = uniqueName(`${props.model.name}_idx`, props.model.indexes.map((i) => i.name))
  props.model.indexes.push({ name, kind: 'INDEX', columns: [], using: '', comment: '', extra: '' })
  selected.value = props.model.indexes.length - 1
}

function remove(): void {
  if (!index.value) return
  props.model.indexes.splice(selected.value, 1)
  selected.value = Math.min(selected.value, props.model.indexes.length - 1)
}

function setKind(i: IndexDef, kind: IndexKind): void {
  if (kind === 'PRIMARY' && props.model.indexes.some((o) => o !== i && o.kind === 'PRIMARY')) return
  i.kind = kind
  // only a primary key or a unique index can be a constraint
  i.constraint = kind === 'PRIMARY' || (kind === 'UNIQUE' && i.constraint)
  if (kind === 'PRIMARY') i.name = 'PRIMARY'
}

const part = (column: string) => index.value?.columns.find((c) => c.name === column)

function toggle(column: string, on: boolean): void {
  const i = index.value!
  if (on) i.columns.push({ name: column, length: null, desc: false })
  else i.columns = i.columns.filter((c) => c.name !== column)
}
</script>

<template>
  <div class="indexes-tab">
    <div class="side">
      <div class="toolbar">
        <button class="icon-btn" :title="t('tableEditor.indexes.add')" :disabled="readOnly" @click="add"><Plus :size="14" /></button>
        <button class="icon-btn" :title="t('tableEditor.indexes.remove')" :disabled="readOnly || !index" @click="remove"><Minus :size="14" /></button>
      </div>
      <div class="scroll">
        <table class="list">
          <thead>
            <tr>
              <th>{{ t('tableEditor.indexes.indexName') }}</th>
              <th>{{ t('tableEditor.indexes.type') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(i, n) in model.indexes" :key="n" :class="{ selected: n === selected }" @mousedown="selected = n">
              <td>
                <input
                  v-if="i.kind !== 'PRIMARY'"
                  v-model.trim="i.name"
                  type="text"
                  :placeholder="i.constraint ? t('tableEditor.indexes.unnamedConstraint') : ''"
                  :disabled="readOnly"
                  spellcheck="false"
                />
                <span v-else>PRIMARY</span>
              </td>
              <td>
                <select :value="i.kind" :disabled="readOnly" @change="setKind(i, value($event) as IndexKind)">
                  <option v-for="k in engine.indexKinds" :key="k" :value="k">{{ k }}</option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-if="index" class="main">
      <div class="scroll">
        <table class="list">
          <thead>
            <tr>
              <th>{{ t('tableEditor.column') }}</th>
              <th>#</th>
              <th>{{ t('tableEditor.indexes.order') }}</th>
              <th v-if="engine.indexLength">{{ t('tableEditor.indexes.length') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in model.columns" :key="c.name">
              <td>
                <label class="check">
                  <input type="checkbox" :checked="!!part(c.name)" :disabled="readOnly" @change="toggle(c.name, ($event.target as HTMLInputElement).checked)" />
                  {{ c.name }}
                </label>
              </td>
              <td class="muted">{{ part(c.name) ? index.columns.indexOf(part(c.name)!) + 1 : '' }}</td>
              <td>
                <select v-if="part(c.name)" :value="part(c.name)!.desc ? 'DESC' : 'ASC'" :disabled="readOnly" @change="part(c.name)!.desc = value($event) === 'DESC'">
                  <option>ASC</option>
                  <option>DESC</option>
                </select>
              </td>
              <td v-if="engine.indexLength">
                <input
                  v-if="part(c.name)"
                  type="number"
                  min="1"
                  class="length"
                  :value="part(c.name)!.length ?? ''"
                  :disabled="readOnly"
                  @change="part(c.name)!.length = value($event) ? Number(value($event)) : null"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="options form-grid">
        <template v-if="engine.indexMethods.length && !index.constraint">
          <label>{{ t('tableEditor.indexes.storageType') }}</label>
          <select v-model="index.using" :disabled="readOnly">
            <option value="">{{ t('common.default') }}</option>
            <option v-for="m in engine.indexMethods" :key="m">{{ m }}</option>
          </select>
        </template>
        <template v-if="engine.indexComments && !index.constraint">
          <label>{{ t('tableEditor.indexes.comment') }}</label>
          <input v-model="index.comment" type="text" :disabled="readOnly" />
        </template>
        <template v-if="index.constraint && index.kind !== 'PRIMARY'">
          <label>{{ t('tableEditor.indexes.constraint') }}</label>
          <span class="muted">{{ t('tableEditor.indexes.uniqueConstraint') }}</span>
        </template>
        <template v-if="index.extra">
          <label>{{ t('tableEditor.other') }}</label>
          <span class="mono selectable">{{ index.extra }}</span>
        </template>
      </div>
    </div>
    <div v-else class="main empty-state">{{ t('tableEditor.indexes.noneSelected') }}</div>
  </div>
</template>

<style scoped>
.indexes-tab {
  display: grid;
  grid-template-columns: minmax(260px, 2fr) 3fr;
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

.length {
  width: 70px;
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
