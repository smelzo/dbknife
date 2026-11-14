<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowDown, ArrowUp, Minus, Plus } from 'lucide-vue-next'
import type { ColumnDef, TableDef } from '@shared/sql/create-table'
import { t } from '@/i18n'
import type { ColumnFlag, TableEditorEngine } from './engines'
import { isPrimary, isUnique, newColumn, removeColumn, renameColumn, setPrimary, setUnique, uniqueName, type Collation } from './model'

/** Columns grid of the table editor with the detail panel of the selected column. */
const props = defineProps<{ model: TableDef; collations: Collation[]; engine: TableEditorEngine; existing: boolean; readOnly?: boolean }>()

const selected = ref(0)
const column = computed<ColumnDef | undefined>(() => props.model.columns[selected.value])
const charsets = computed(() => [...new Set(props.collations.map((c) => c.charset))].sort())
const columnCollations = computed(() => {
  const cs = column.value?.charset || props.model.options.charset
  return props.collations.filter((c) => !cs || c.charset === cs).map((c) => c.name)
})
/** Existing columns keep their place where the engine cannot move them. */
const fixedOrder = computed(() => props.existing && !props.engine.reorderColumns)

const value = (e: Event): string => (e.target as HTMLInputElement).value
const checked = (e: Event): boolean => (e.target as HTMLInputElement).checked

function rename(c: ColumnDef, e: Event): void {
  const name = value(e).trim()
  if (name) renameColumn(props.model, c, name)
  else (e.target as HTMLInputElement).value = c.name
}

function add(): void {
  const cols = props.model.columns
  const name = uniqueName('new_column', cols.map((c) => c.name))
  const at = column.value ? selected.value + 1 : cols.length
  cols.splice(at, 0, newColumn(name, props.engine.defaultType))
  selected.value = at
}

function remove(): void {
  if (!column.value) return
  removeColumn(props.model, column.value)
  selected.value = Math.min(selected.value, props.model.columns.length - 1)
}

function move(delta: number): void {
  const cols = props.model.columns
  const to = selected.value + delta
  if (!column.value || to < 0 || to >= cols.length) return
  cols.splice(to, 0, ...cols.splice(selected.value, 1))
  selected.value = to
}

function setGenerated(c: ColumnDef, on: boolean): void {
  c.generated = on ? { expression: c.default, storage: props.engine.generatedStorage[0] } : null
  if (on) {
    c.default = ''
    c.autoIncrement = false
  }
}

function setDefault(c: ColumnDef, text: string): void {
  if (c.generated) c.generated.expression = text
  else c.default = text
}

function setCharset(c: ColumnDef, charset: string): void {
  c.charset = charset
  c.collation = ''
}

const flagTitles: Record<ColumnFlag, string> = {
  PK: t('tableEditor.flag.primaryKey'),
  NN: t('tableEditor.flag.notNull'),
  UQ: t('tableEditor.flag.uniqueIndex'),
  B: t('tableEditor.flag.binary'),
  UN: t('tableEditor.flag.unsigned'),
  ZF: t('tableEditor.flag.zeroFill'),
  AI: t('tableEditor.flag.autoIncrement'),
  G: t('tableEditor.flag.generatedColumn')
}
const has = (flag: ColumnFlag): boolean => props.engine.flags.includes(flag)
</script>

<template>
  <div class="columns-tab">
    <div class="toolbar">
      <button class="icon-btn" :title="t('tableEditor.columns.add')" :disabled="readOnly" @click="add"><Plus :size="14" /></button>
      <button class="icon-btn" :title="t('tableEditor.columns.remove')" :disabled="readOnly || !column" @click="remove"><Minus :size="14" /></button>
      <span class="sep" />
      <button class="icon-btn" :title="t('tableEditor.columns.moveUp')" :disabled="readOnly || fixedOrder || selected <= 0" @click="move(-1)"><ArrowUp :size="14" /></button>
      <button class="icon-btn" :title="t('tableEditor.columns.moveDown')" :disabled="readOnly || fixedOrder || selected >= model.columns.length - 1" @click="move(1)">
        <ArrowDown :size="14" />
      </button>
    </div>
    <div class="grid">
      <table class="list">
        <thead>
          <tr>
            <th>{{ t('tableEditor.columns.columnName') }}</th>
            <th>{{ t('tableEditor.columns.datatype') }}</th>
            <th v-for="f in engine.flags" :key="f" class="flag" :title="flagTitles[f]">{{ f }}</th>
            <th>{{ t('tableEditor.columns.defaultExpression') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(c, i) in model.columns" :key="i" :class="{ selected: i === selected }" @mousedown="selected = i">
            <td><input type="text" :value="c.name" :disabled="readOnly" spellcheck="false" @change="rename(c, $event)" /></td>
            <td>
              <input
                type="text"
                :value="c.type"
                list="te-data-types"
                :disabled="readOnly"
                spellcheck="false"
                @change="c.type = engine.normalizeType(value($event))"
              />
            </td>
            <td v-if="has('PK')" class="flag"><input type="checkbox" :checked="isPrimary(model, c.name)" :disabled="readOnly" @change="setPrimary(model, c, checked($event))" /></td>
            <td v-if="has('NN')" class="flag"><input type="checkbox" :checked="!c.nullable" :disabled="readOnly" @change="c.nullable = !checked($event)" /></td>
            <td v-if="has('UQ')" class="flag"><input type="checkbox" :checked="isUnique(model, c.name)" :disabled="readOnly" @change="setUnique(model, c, checked($event))" /></td>
            <td v-if="has('B')" class="flag"><input v-model="c.binary" type="checkbox" :disabled="readOnly" /></td>
            <td v-if="has('UN')" class="flag"><input v-model="c.unsigned" type="checkbox" :disabled="readOnly" /></td>
            <td v-if="has('ZF')" class="flag"><input v-model="c.zerofill" type="checkbox" :disabled="readOnly" /></td>
            <td v-if="has('AI')" class="flag"><input v-model="c.autoIncrement" type="checkbox" :disabled="readOnly || !!c.generated" /></td>
            <td v-if="has('G')" class="flag"><input type="checkbox" :checked="!!c.generated" :disabled="readOnly" @change="setGenerated(c, checked($event))" /></td>
            <td class="wide">
              <input
                type="text"
                class="mono"
                :value="c.generated ? c.generated.expression : c.default"
                :disabled="readOnly"
                spellcheck="false"
                @change="setDefault(c, value($event))"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <datalist id="te-data-types">
        <option v-for="type in engine.dataTypes" :key="type" :value="type" />
      </datalist>
    </div>
    <div v-if="column" class="detail">
      <div class="form-grid">
        <label>{{ t('tableEditor.columns.columnNameLabel') }}</label>
        <input type="text" :value="column.name" :disabled="readOnly" spellcheck="false" @change="rename(column, $event)" />
        <label>{{ engine.mysqlOptions ? t('tableEditor.charsetCollation') : t('tableEditor.columns.collation') }}</label>
        <div class="pair">
          <select v-if="engine.mysqlOptions" :value="column.charset" :disabled="readOnly" @change="setCharset(column, value($event))">
            <option value="">{{ t('tableEditor.columns.tableDefault') }}</option>
            <option v-if="column.charset && !charsets.includes(column.charset)" :value="column.charset">{{ column.charset }}</option>
            <option v-for="cs in charsets" :key="cs" :value="cs">{{ cs }}</option>
          </select>
          <select v-model="column.collation" :disabled="readOnly">
            <option value="">{{ t('common.default') }}</option>
            <option v-if="column.collation && !columnCollations.includes(column.collation)" :value="column.collation">{{ column.collation }}</option>
            <option v-for="co in columnCollations" :key="co" :value="co">{{ co }}</option>
          </select>
        </div>
        <template v-if="engine.comments">
          <label>{{ t('tableEditor.comments') }}</label>
          <textarea v-model="column.comment" rows="2" :disabled="readOnly" />
        </template>
      </div>
      <div class="form-grid">
        <label>{{ t('tableEditor.columns.dataType') }}</label>
        <input
          type="text"
          :value="column.type"
          list="te-data-types"
          :disabled="readOnly"
          spellcheck="false"
          @change="column.type = engine.normalizeType(value($event))"
        />
        <label>{{ column.generated ? t('tableEditor.columns.expression') : t('tableEditor.columns.default') }}</label>
        <input
          type="text"
          class="mono"
          :value="column.generated ? column.generated.expression : column.default"
          :disabled="readOnly"
          spellcheck="false"
          @change="setDefault(column, value($event))"
        />
        <label>{{ t('tableEditor.columns.storage') }}</label>
        <div class="pair">
          <template v-if="column.generated">
            <label v-for="storage in engine.generatedStorage" :key="storage" class="check">
              <input v-model="column.generated.storage" type="radio" :value="storage" :disabled="readOnly" />
              {{ storage === 'VIRTUAL' ? t('tableEditor.columns.virtual') : t('tableEditor.columns.stored') }}
            </label>
          </template>
          <span v-else class="muted">{{ t('tableEditor.columns.notGenerated') }}</span>
        </div>
        <template v-if="column.extra">
          <label>{{ t('tableEditor.other') }}</label>
          <span class="mono selectable" :title="t('tableEditor.columns.keptAttributes')">{{ column.extra }}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.columns-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

table.list td {
  padding: 1px 4px;
}

table.list td input[type='text'] {
  width: 100%;
  min-width: 120px;
  border-color: transparent;
  background: transparent;
  padding: 2px 4px;
}

table.list td input[type='text']:focus {
  border-color: var(--accent);
  background: var(--bg-input);
}

table.list td.wide {
  width: 40%;
}

.flag {
  width: 30px;
  text-align: center !important;
}

.detail {
  flex-shrink: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}

.detail textarea {
  font-family: var(--font-ui);
  resize: none;
}

.pair {
  display: flex;
  gap: 12px;
  align-items: center;
  min-width: 0;
}

.pair select {
  flex: 1;
  min-width: 0;
}
</style>
