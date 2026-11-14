import { markRaw, shallowReactive, type Component } from 'vue'
import PromptDialog, { type PromptField } from './components/common/PromptDialog.vue'
import { t } from '@/i18n'

interface DialogEntry {
  id: number
  component: Component
  props: Record<string, unknown>
  resolve: (value: unknown) => void
}

/** Open modal dialogs, rendered by DialogHost. Each dialog emits `close` with its result. */
export const dialogs = shallowReactive<DialogEntry[]>([])
let nextId = 1

export function openDialog<T>(component: Component, props: Record<string, unknown> = {}): Promise<T | undefined> {
  return new Promise((resolve) => {
    const entry: DialogEntry = {
      id: nextId++,
      component: markRaw(component),
      props,
      resolve: (value) => {
        const i = dialogs.indexOf(entry)
        if (i >= 0) dialogs.splice(i, 1)
        resolve(value as T | undefined)
      }
    }
    dialogs.push(entry)
  })
}

export type { PromptField }

/** Form dialog; resolves with the field values or undefined when cancelled. */
export function prompt(options: {
  title: string
  message?: string
  fields: PromptField[]
  okLabel?: string
}): Promise<Record<string, string | boolean> | undefined> {
  return openDialog(PromptDialog, options)
}

export async function promptText(title: string, label: string, value = ''): Promise<string | undefined> {
  const r = await prompt({ title, fields: [{ key: 'value', label, value }] })
  return r ? String(r.value) : undefined
}

export function alertError(message: string, detail?: string): Promise<number> {
  return window.api.ui.message({ type: 'error', message, detail, buttons: [t('common.ok')] })
}

export async function confirm(message: string, detail?: string, okLabel = t('common.ok')): Promise<boolean> {
  const r = await window.api.ui.message({
    type: 'question',
    message,
    detail,
    buttons: [okLabel, t('common.cancel')],
    defaultId: 0,
    cancelId: 1
  })
  return r === 0
}
