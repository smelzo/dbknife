<script setup lang="ts">
import { ref } from 'vue'
import { t } from '@/i18n'
import Modal from '../common/Modal.vue'

/** "New Schema Privilege Definition": picks the schema or pattern a privilege entry applies to. */
const props = defineProps<{ schemas: string[] }>()
const emit = defineEmits<{ close: [schema?: string] }>()

const mode = ref<'all' | 'pattern' | 'selected'>('selected')
const pattern = ref('')
const selected = ref(props.schemas[0] ?? '')

function submit(): void {
  const schema = mode.value === 'all' ? '%' : mode.value === 'pattern' ? pattern.value.trim() : selected.value
  if (schema) emit('close', schema)
}
</script>

<template>
  <Modal :title="t('admin.schemaEntry.title')" width="460px" @cancel="emit('close')">
    <p class="muted">{{ t('admin.schemaEntry.intro') }}</p>
    <form class="choices" @submit.prevent="submit">
      <label class="check"><input v-model="mode" type="radio" value="all" /> {{ t('admin.schemaEntry.all') }}</label>
      <p class="muted hint">{{ t('admin.schemaEntry.allHint') }}</p>
      <label class="check"><input v-model="mode" type="radio" value="pattern" /> {{ t('admin.schemaEntry.pattern') }}</label>
      <input v-model="pattern" type="text" :placeholder="t('admin.schemaEntry.patternPlaceholder')" @focus="mode = 'pattern'" />
      <p class="muted hint">{{ t('admin.schemaEntry.patternHint') }}</p>
      <label class="check"><input v-model="mode" type="radio" value="selected" /> {{ t('admin.schemaEntry.selected') }}</label>
      <select v-model="selected" @focus="mode = 'selected'">
        <option v-for="s in schemas" :key="s" :value="s">{{ s }}</option>
      </select>
      <button type="submit" hidden />
    </form>
    <template #footer>
      <button @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="primary" @click="submit">{{ t('common.ok') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.choices {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.choices input[type='text'],
.choices select {
  margin-left: 22px;
}

.hint {
  margin: 0 0 6px 22px;
  font-size: var(--fs-small);
}
</style>
