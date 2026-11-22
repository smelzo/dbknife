<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Cell, ColumnInfo } from '@shared/types'
import { toHex } from '@shared/sql/quote'
import { t } from '@/i18n'
import { cellFullText } from '@/workspace/format'
import Modal from '../common/Modal.vue'
import MonacoEditor from '../editor/MonacoEditor.vue'

const props = defineProps<{ value: Cell; column: ColumnInfo; readOnly?: boolean }>()
const emit = defineEmits<{ close: [value?: Cell] }>()

const binary = props.value instanceof Uint8Array && props.column.kind !== 'bit'
const bytes = ref<Uint8Array | null>(binary ? props.value : null)
const isNull = ref(props.value === null)
const text = ref(props.value === null ? '' : cellFullText(props.value, props.column))
const mode = ref<'text' | 'hex'>(binary ? 'hex' : 'text')

const hexDump = computed(() => {
  const b = bytes.value
  if (!b) return ''
  const lines: string[] = []
  for (let i = 0; i < Math.min(b.length, 64 * 1024); i += 16) {
    const chunk = b.subarray(i, i + 16)
    const hex = toHex(chunk).replace(/(..)/g, '$1 ').padEnd(48)
    const ascii = Array.from(chunk, (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex} ${ascii}`)
  }
  if (b.length > 64 * 1024) lines.push(t('results.value.bytesTotal', { count: b.length }))
  return lines.join('\n')
})

function showAsText(): void {
  mode.value = 'text'
  if (bytes.value) text.value = new TextDecoder().decode(bytes.value)
}

async function load(): Promise<void> {
  const path = await window.api.files.chooseOpen({ title: t('results.loadValueTitle') })
  if (!path) return
  bytes.value = await window.api.files.readBinary(path)
  isNull.value = false
  mode.value = 'hex'
}

async function save(): Promise<void> {
  const path = await window.api.files.chooseSave({ title: t('results.saveValueTitle') })
  if (!path) return
  await window.api.files.write(path, bytes.value ?? text.value)
}

function apply(): void {
  if (isNull.value) emit('close', null)
  else if (bytes.value && mode.value === 'hex') emit('close', bytes.value)
  else emit('close', text.value)
}
</script>

<template>
  <Modal :title="t('results.value.title', { name: column.name, type: column.type })" width="760px" @cancel="emit('close')">
    <div class="bar">
      <button v-if="bytes" :class="{ active: mode === 'hex' }" @click="mode = 'hex'">{{ t('results.value.binary') }}</button>
      <button v-if="bytes" :class="{ active: mode === 'text' }" @click="showAsText">
        {{ t('results.view.text') }}
      </button>
      <span class="spacer" />
      <button v-if="!readOnly" @click="load">{{ t('results.value.load') }}</button>
      <button @click="save">{{ t('results.value.save') }}</button>
      <label v-if="!readOnly" class="check"><input v-model="isNull" type="checkbox" /> NULL</label>
    </div>
    <div class="editor">
      <pre v-if="mode === 'hex' && bytes" class="hex selectable">{{ hexDump }}</pre>
      <MonacoEditor v-else v-model="text" :read-only="readOnly || isNull" :line-numbers="false" language="plaintext" />
    </div>
    <template #footer>
      <span class="muted size">{{ bytes ? t('results.value.bytes', { count: bytes.length }) : t('results.value.characters', { count: text.length }) }}</span>
      <button @click="emit('close')">{{ readOnly ? t('common.close') : t('common.cancel') }}</button>
      <button v-if="!readOnly" class="primary" @click="apply">{{ t('common.apply') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.bar {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
}

.bar .spacer {
  flex: 1;
}

.bar button.active {
  background: var(--bg-selected);
}

.editor {
  height: 360px;
  border: 1px solid var(--border);
}

.hex {
  margin: 0;
  height: 100%;
  overflow: auto;
  padding: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg-content);
}

.size {
  margin-right: auto;
}
</style>
