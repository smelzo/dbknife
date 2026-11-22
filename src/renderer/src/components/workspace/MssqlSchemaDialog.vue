<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { valueText } from '@shared/value-text'
import { reviewAndApply } from '@/workspace/review'
import { metadataQuery } from '@/workspace/catalog/mssql'
import { t } from '@/i18n'
import type { Workspace } from '@/workspace/workspace'
import Modal from '../common/Modal.vue'

/** Create a SQL Server schema, or change its owner: T-SQL cannot rename a schema. */
const props = defineProps<{ ws: Workspace; schema: string | null }>()
const emit = defineEmits<{ close: [done?: boolean] }>()

const name = ref(props.schema ?? 'new_schema')
const owner = ref('')
let originalOwner = ''
const principals = ref<string[]>([])
const error = ref('')

onMounted(async () => {
  const query = metadataQuery(props.ws.query)
  try {
    // users and roles of the database that can own a schema
    principals.value = (
      await query(
        `SELECT name FROM sys.database_principals
         WHERE type IN ('S', 'U', 'G', 'E', 'X', 'C', 'K', 'R') AND is_fixed_role = 0 AND name NOT IN ('public', 'guest', 'sys', 'INFORMATION_SCHEMA')
         ORDER BY name`
      )
    ).map((r) => String(r.name))
    if (props.schema) {
      const [r] = await query('SELECT USER_NAME(principal_id) AS owner FROM sys.schemas WHERE name = @p1', [props.schema])
      originalOwner = owner.value = valueText(r?.owner)
    }
  } catch (e) {
    error.value = (e as Error).message
  }
})

const statements = computed(() => {
  const d = props.ws.dialect
  if (!props.schema) return [`CREATE SCHEMA ${d.quoteIdentifier(name.value.trim())}${owner.value ? ` AUTHORIZATION ${d.quoteIdentifier(owner.value)}` : ''}`]
  return owner.value && owner.value !== originalOwner ? [`ALTER AUTHORIZATION ON SCHEMA::${d.quoteIdentifier(props.schema)} TO ${d.quoteIdentifier(owner.value)}`] : []
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
      <label for="md-name">{{ t('schema.name') }}</label>
      <input id="md-name" v-model="name" type="text" spellcheck="false" :disabled="!!schema" :title="schema ? t('schema.mssqlNoRename') : ''" autofocus />
      <label for="md-owner">{{ t('schema.owner') }}</label>
      <select id="md-owner" v-model="owner">
        <option v-if="!schema" value="">{{ t('schema.currentUser') }}</option>
        <option v-if="owner && !principals.includes(owner)" :value="owner">{{ owner }}</option>
        <option v-for="p in principals" :key="p" :value="p">{{ p }}</option>
      </select>
    </div>
    <p v-if="error" class="error selectable">{{ error }}</p>
    <template #footer>
      <button @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="primary" :disabled="!statements.length || !name.trim()" @click="apply">{{ t('common.apply') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.error {
  color: var(--danger);
  white-space: pre-wrap;
}
</style>
