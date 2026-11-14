<script setup lang="ts">
import { reactive } from 'vue'
import { t } from '@/i18n'
import Modal from './Modal.vue'

export interface PromptField {
  key: string
  label: string
  type?: 'text' | 'password' | 'checkbox' | 'textarea' | 'select'
  value?: string | boolean
  options?: string[]
}

const props = defineProps<{ title: string; message?: string; fields: PromptField[]; okLabel?: string }>()
const emit = defineEmits<{ close: [value?: Record<string, string | boolean>] }>()

const values = reactive<Record<string, string | boolean>>(
  Object.fromEntries(props.fields.map((f) => [f.key, f.value ?? (f.type === 'checkbox' ? false : '')]))
)

const submit = (): void => emit('close', { ...values })
</script>

<template>
  <Modal :title="title" width="440px" @cancel="emit('close')">
    <form @submit.prevent="submit">
      <p v-if="message" class="message selectable">{{ message }}</p>
      <div class="form-grid">
        <template v-for="(f, i) in fields" :key="f.key">
          <template v-if="f.type === 'checkbox'">
            <span />
            <label class="check"><input v-model="values[f.key]" type="checkbox" /> {{ f.label }}</label>
          </template>
          <template v-else>
            <label :for="`pf-${f.key}`">{{ f.label }}</label>
            <textarea v-if="f.type === 'textarea'" :id="`pf-${f.key}`" v-model="values[f.key] as string" rows="6" />
            <select v-else-if="f.type === 'select'" :id="`pf-${f.key}`" v-model="values[f.key]">
              <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
            </select>
            <input
              v-else
              :id="`pf-${f.key}`"
              v-model="values[f.key] as string"
              :type="f.type ?? 'text'"
              :autofocus="i === 0 || f.type === 'password'"
            />
          </template>
        </template>
      </div>
      <button type="submit" hidden />
    </form>
    <template #footer>
      <button @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="primary" @click="submit">{{ okLabel ?? t('common.ok') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.message {
  margin: 0 0 12px;
  white-space: pre-wrap;
}

input,
textarea,
select {
  width: 100%;
}
</style>
