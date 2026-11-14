<script setup lang="ts">
import { onMounted, ref } from 'vue'

defineProps<{ title: string; width?: string; height?: string }>()
const emit = defineEmits<{ cancel: [] }>()
const panel = ref<HTMLElement>()

onMounted(() => {
  const first = panel.value?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button.primary')
  first?.focus()
})

const focusable = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const isGroupedRadio = (el: HTMLElement): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'radio' && el.name !== ''

/** A named radio group is one Tab stop: its checked radio, or the first when none is checked. */
function tabStops(items: HTMLElement[]): HTMLElement[] {
  return items.filter((el) => {
    if (!isGroupedRadio(el)) return true
    const group = items.filter((other) => isGroupedRadio(other) && other.name === el.name)
    return el.checked || (!group.some((radio) => isGroupedRadio(radio) && radio.checked) && group[0] === el)
  })
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('cancel')
  } else if (e.key === 'Tab') {
    // Tab and Shift+Tab stay inside the dialog: from the last element to the first and back
    const items = tabStops([...(panel.value?.querySelectorAll<HTMLElement>(focusable) ?? [])].filter((el) => el.checkVisibility()))
    const first = items[0]
    const last = items[items.length - 1]
    if (first && document.activeElement === (e.shiftKey ? first : last)) {
      e.preventDefault()
      const target = e.shiftKey ? last : first
      target.focus()
    }
  }
}
</script>

<template>
  <div class="overlay" @keydown="onKey">
    <div ref="panel" class="panel" role="dialog" aria-modal="true" :aria-label="title" :style="{ width, height }">
      <div class="title">{{ title }}</div>
      <div class="body"><slot /></div>
      <div v-if="$slots.footer" class="footer"><slot name="footer" /></div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.panel {
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow);
  min-width: 360px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
}

.title {
  padding: 12px 16px 6px;
  font-weight: 600;
  font-size: 13px;
}

.body {
  padding: 8px 16px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px 14px;
}
</style>
