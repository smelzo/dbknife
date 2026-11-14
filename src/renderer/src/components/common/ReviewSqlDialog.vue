<script setup lang="ts">
import { ref } from 'vue'
import { splitStatements } from '@shared/sql/splitter'
import { statementKind } from '@shared/sql/analyze'
import type { Workspace } from '@/workspace/workspace'
import { t } from '@/i18n'
import Modal from './Modal.vue'
import MonacoEditor from '../editor/MonacoEditor.vue'

const props = defineProps<{ ws: Workspace; statements: string[]; title?: string; description?: string; cleanup?: string[]; exempt?: string[] }>()
const emit = defineEmits<{ close: [applied?: boolean] }>()

/**
 * Statements containing `;` (routine bodies, triggers) need a custom delimiter
 * in a MySQL script; the other engines' lexers find the end of such bodies,
 * except T-SQL's, where a module body runs up to GO.
 */
function scriptOf(statements: string[]): string {
  if (props.ws.dialect.rules.batchSeparator) return statements.map((s) => `${s}\nGO`).join('\n')
  const needsDelimiter = props.ws.dialect.rules.clientDelimiter && statements.some((s) => s.includes(';'))
  if (!needsDelimiter) return statements.map((s) => s + ';').join('\n')
  return ['DELIMITER $$', ...statements.map((s) => s + '$$'), 'DELIMITER ;'].join('\n')
}

const script = ref(scriptOf(props.statements))
const error = ref('')
const running = ref(false)

async function apply(): Promise<void> {
  error.value = ''
  running.value = true
  try {
    const statements = splitStatements(script.value, props.ws.dialect.rules).map((s) => s.text)
    const r = await props.ws.runStatements(statements, { exempt: props.exempt })
    if (r.ok) {
      emit('close', true)
      return
    }
    error.value = r.error ?? t('review.error')
    // a transaction the script opened would stay open (with its locks) after the failure
    let open = false
    for (const sql of statements.slice(0, r.failedAt)) {
      const kind = statementKind(sql, props.ws.dialect.rules)
      if (kind === 'BEGIN' || kind === 'START') open = true
      else if (kind === 'COMMIT' || kind === 'END' || kind === 'ROLLBACK') open = false
    }
    for (const sql of [...(open ? ['ROLLBACK'] : []), ...(props.cleanup ?? [])]) await props.ws.runStatements([sql])
  } finally {
    running.value = false
  }
}
</script>

<template>
  <Modal :title="title ?? t('review.title')" width="760px" @cancel="emit('close', false)">
    <p class="muted">{{ description ?? t('review.description') }}</p>
    <div class="editor"><MonacoEditor v-model="script" :language="ws.dialect.editorLanguage" /></div>
    <p v-if="error" class="error selectable">{{ error }}</p>
    <template #footer>
      <button :disabled="running" @click="emit('close', false)">{{ t('common.cancel') }}</button>
      <button class="primary" :disabled="running" @click="apply">{{ running ? t('review.applying') : t('common.apply') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.editor {
  height: 320px;
  border: 1px solid var(--border);
}

.error {
  color: var(--danger);
  white-space: pre-wrap;
}
</style>
