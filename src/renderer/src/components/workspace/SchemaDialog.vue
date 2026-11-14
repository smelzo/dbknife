<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { quoteIdentifier } from '@shared/sql/quote'
import { reviewAndApply } from '@/workspace/review'
import { t } from '@/i18n'
import type { Workspace } from '@/workspace/workspace'
import Modal from '../common/Modal.vue'

/** Create or alter a schema (name, default character set and collation). */
const props = defineProps<{ ws: Workspace; schema: string | null }>()
const emit = defineEmits<{ close: [done?: boolean] }>()

const name = ref(props.schema ?? 'new_schema')
const charset = ref('')
const collation = ref('')
const original = { charset: '', collation: '' }
const charsets = ref<string[]>([])
const collations = ref<string[]>([])

async function rows(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const r = await window.api.db.query(props.ws.sessionId, sql, params)
  return r.rows
}

onMounted(async () => {
  charsets.value = (await rows('SELECT CHARACTER_SET_NAME AS n FROM information_schema.CHARACTER_SETS ORDER BY 1')).map((r) =>
    String(r.n)
  )
  if (props.schema) {
    const [r] = await rows(
      'SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [props.schema]
    )
    original.charset = charset.value = String(r?.cs ?? '')
    original.collation = collation.value = String(r?.co ?? '')
  }
})

watch(
  charset,
  async (cs) => {
    collations.value = cs
      ? (await rows('SELECT COLLATION_NAME AS n FROM information_schema.COLLATIONS WHERE CHARACTER_SET_NAME = ? ORDER BY 1', [cs])).map(
          (r) => String(r.n)
        )
      : []
    if (collation.value && !collations.value.includes(collation.value)) collation.value = ''
  }
)

const statements = computed(() => {
  const options = [
    charset.value ? `DEFAULT CHARACTER SET ${charset.value}` : '',
    collation.value ? `COLLATE ${collation.value}` : ''
  ]
    .filter(Boolean)
    .join(' ')
  if (!props.schema) return [`CREATE SCHEMA ${quoteIdentifier(name.value)}${options ? ' ' + options : ''}`]
  if (charset.value === original.charset && collation.value === original.collation) return []
  return [`ALTER SCHEMA ${quoteIdentifier(props.schema)} ${options}`]
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
      <label for="sd-name">{{ t('schema.name') }}</label>
      <input id="sd-name" v-model="name" type="text" :disabled="!!schema" autofocus />
      <label for="sd-cs">{{ t('schema.charset') }}</label>
      <select id="sd-cs" v-model="charset">
        <option value="">{{ t('schema.default') }}</option>
        <option v-for="c in charsets" :key="c" :value="c">{{ c }}</option>
      </select>
      <label for="sd-co">{{ t('schema.collation') }}</label>
      <select id="sd-co" v-model="collation" :disabled="!charset">
        <option value="">{{ t('schema.default') }}</option>
        <option v-for="c in collations" :key="c" :value="c">{{ c }}</option>
      </select>
    </div>
    <template #footer>
      <button @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="primary" :disabled="!statements.length" @click="apply">{{ t('common.apply') }}</button>
    </template>
  </Modal>
</template>
