<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { valueText } from '@shared/value-text'
import { reviewAndApply } from '@/workspace/review'
import { t } from '@/i18n'
import type { Workspace } from '@/workspace/workspace'
import Modal from '../common/Modal.vue'

/** Create or alter a PostgreSQL schema: name, owner and comment. */
const props = defineProps<{ ws: Workspace; schema: string | null }>()
const emit = defineEmits<{ close: [done?: boolean] }>()

const name = ref(props.schema ?? 'new_schema')
const owner = ref('')
const comment = ref('')
const original = { owner: '', comment: '' }
const roles = ref<string[]>([])
const error = ref('')

async function rows(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const r = await window.api.db.query(props.ws.sessionId, sql, params)
  if (r.error) throw new Error(r.error.message)
  return r.rows
}

onMounted(async () => {
  try {
    roles.value = (await rows("SELECT rolname AS n FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1")).map((r) => String(r.n))
    if (props.schema) {
      const [r] = await rows(
        "SELECT pg_get_userbyid(nspowner) AS owner, obj_description(oid, 'pg_namespace') AS comment FROM pg_namespace WHERE nspname = $1",
        [props.schema]
      )
      original.owner = owner.value = valueText(r?.owner)
      original.comment = comment.value = valueText(r?.comment)
    }
  } catch (e) {
    error.value = (e as Error).message
  }
})

const statements = computed(() => {
  const d = props.ws.dialect
  const target = d.quoteIdentifier(name.value.trim())
  const out: string[] = []
  if (!props.schema) {
    out.push(`CREATE SCHEMA ${target}${owner.value ? ` AUTHORIZATION ${d.quoteIdentifier(owner.value)}` : ''}`)
    if (comment.value) out.push(`COMMENT ON SCHEMA ${target} IS ${d.quoteString(comment.value)}`)
    return out
  }
  if (name.value.trim() !== props.schema) out.push(`ALTER SCHEMA ${d.quoteIdentifier(props.schema)} RENAME TO ${target}`)
  if (owner.value && owner.value !== original.owner) out.push(`ALTER SCHEMA ${target} OWNER TO ${d.quoteIdentifier(owner.value)}`)
  if (comment.value !== original.comment) out.push(`COMMENT ON SCHEMA ${target} IS ${comment.value ? d.quoteString(comment.value) : 'NULL'}`)
  return out
})

async function apply(): Promise<void> {
  if (!name.value.trim()) return
  if (await reviewAndApply(props.ws, statements.value)) {
    props.ws.refreshAfterDdl()
    emit('close', true)
  }
}
</script>

<template>
  <Modal :title="schema ? t('schema.alterTitle', { name: schema }) : t('schema.createTitle')" width="460px" @cancel="emit('close')">
    <div class="form-grid">
      <label for="pd-name">{{ t('schema.name') }}</label>
      <input id="pd-name" v-model="name" type="text" spellcheck="false" autofocus />
      <label for="pd-owner">{{ t('schema.owner') }}</label>
      <select id="pd-owner" v-model="owner">
        <option v-if="!schema" value="">{{ t('schema.currentUser') }}</option>
        <option v-if="owner && !roles.includes(owner)" :value="owner">{{ owner }}</option>
        <option v-for="r in roles" :key="r" :value="r">{{ r }}</option>
      </select>
      <label for="pd-comment">{{ t('schema.comment') }}</label>
      <textarea id="pd-comment" v-model="comment" rows="3" />
    </div>
    <p v-if="error" class="error selectable">{{ error }}</p>
    <template #footer>
      <button @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="primary" :disabled="!statements.length || !name.trim()" @click="apply">{{ t('common.apply') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
textarea {
  font-family: var(--font-ui);
  resize: vertical;
}

.error {
  color: var(--danger);
  white-space: pre-wrap;
}
</style>
