<script setup lang="ts">
import { computed } from 'vue'
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { t } from '@/i18n'
import { cellFullText } from '@/workspace/format'
import { cellValue, rowCount, setCell, type ResultTab } from '@/workspace/results'

/** The "Form Editor": one record at a time, fields stacked vertically. */
const props = defineProps<{ rt: ResultTab }>()
const row = defineModel<number>('row', { required: true })

const total = computed(() => {
  void props.rt.version
  return rowCount(props.rt)
})
const editable = computed(() => !!props.rt.target)

const fields = computed(() => {
  void props.rt.version
  if (row.value >= total.value) return []
  return props.rt.columns.map((col, c) => {
    const v = cellValue(props.rt, row.value, c)
    return { col, c, isNull: v === null, text: v === null || v === undefined ? '' : cellFullText(v, col), binary: v instanceof Uint8Array }
  })
})

function go(n: number): void {
  row.value = Math.max(0, Math.min(total.value - 1, n))
}

function update(c: number, text: string): void {
  setCell(props.rt, row.value, c, text)
}
</script>

<template>
  <div class="form">
    <div class="toolbar">
      <button class="icon-btn" :title="t('results.form.first')" @click="go(0)"><ChevronFirst :size="15" /></button>
      <button class="icon-btn" :title="t('results.form.previous')" @click="go(row - 1)"><ChevronLeft :size="15" /></button>
      <span class="pos">{{ total ? row + 1 : 0 }} / {{ total }}</span>
      <button class="icon-btn" :title="t('results.form.next')" @click="go(row + 1)"><ChevronRight :size="15" /></button>
      <button class="icon-btn" :title="t('results.form.last')" @click="go(total - 1)"><ChevronLast :size="15" /></button>
    </div>
    <div class="fields">
      <div v-for="f in fields" :key="f.c" class="field">
        <label :for="`ff-${f.c}`" :title="f.col.type">{{ f.col.name }}</label>
        <textarea
          v-if="f.text.length > 80 || f.text.includes('\n')"
          :id="`ff-${f.c}`"
          :value="f.text"
          :placeholder="f.isNull ? 'NULL' : ''"
          :readonly="!editable || f.binary"
          rows="4"
          @change="update(f.c, ($event.target as HTMLTextAreaElement).value)"
        />
        <input
          v-else
          :id="`ff-${f.c}`"
          type="text"
          :value="f.binary ? `<${f.text.length} bytes>` : f.text"
          :placeholder="f.isNull ? 'NULL' : ''"
          :readonly="!editable || f.binary"
          @change="update(f.c, ($event.target as HTMLInputElement).value)"
        />
        <span class="type">{{ f.col.type }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.form {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-content);
}

.pos {
  padding: 0 8px;
  color: var(--text-muted);
}

.fields {
  overflow: auto;
  padding: 10px 14px;
  display: grid;
  grid-template-columns: max-content minmax(200px, 600px) max-content;
  gap: 6px 10px;
  align-content: start;
}

.field {
  display: contents;
}

.field label {
  text-align: right;
  font-weight: 600;
  padding-top: 4px;
}

.type {
  color: var(--text-faint);
  font-size: var(--fs-small);
  padding-top: 5px;
}

input::placeholder,
textarea::placeholder {
  color: var(--null);
  font-style: italic;
}
</style>
