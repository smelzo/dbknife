<script setup lang="ts">
import { markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { monaco } from '@/editor/monaco'
import { useApp } from '@/stores/app'

/**
 * Monaco wrapper. Either edits a caller-owned `model` (query tabs keep their
 * model alive across remounts) or a plain string through v-model.
 */
const props = defineProps<{
  model?: monaco.editor.ITextModel
  modelValue?: string
  readOnly?: boolean
  lineNumbers?: boolean
  language?: string
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  ready: [editor: monaco.editor.IStandaloneCodeEditor]
}>()

const app = useApp()
const host = ref<HTMLElement>()
let editor: monaco.editor.IStandaloneCodeEditor | undefined
let ownModel: monaco.editor.ITextModel | undefined

onMounted(() => {
  if (!props.model) {
    ownModel = monaco.editor.createModel(props.modelValue ?? '', props.language ?? 'mysql')
    ownModel.onDidChangeContent(() => emit('update:modelValue', ownModel!.getValue()))
  }
  editor = markRaw(
    monaco.editor.create(host.value!, {
      model: props.model ?? ownModel,
      automaticLayout: true,
      readOnly: props.readOnly,
      minimap: { enabled: false },
      lineNumbers: props.lineNumbers === false ? 'off' : 'on',
      fontSize: app.settings.editorFontSize,
      fontFamily: app.settings.editorFontFamily,
      wordWrap: app.settings.wordWrap ? 'on' : 'off',
      renderWhitespace: app.settings.showInvisibles ? 'all' : 'none',
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      tabSize: 4,
      insertSpaces: true,
      renderLineHighlight: 'line',
      suggest: { showWords: false },
      quickSuggestions: { other: true, comments: false, strings: false },
      wordBasedSuggestions: 'off'
    })
  )
  emit('ready', editor)
})

watch(
  () => props.modelValue,
  (v) => {
    if (ownModel && v !== undefined && v !== ownModel.getValue()) ownModel.setValue(v)
  }
)

watch(
  () => props.model,
  (m) => {
    if (m && editor) editor.setModel(m)
  }
)

watch(
  () => [app.settings.editorFontSize, app.settings.editorFontFamily, app.settings.wordWrap, app.settings.showInvisibles],
  () =>
    editor?.updateOptions({
      fontSize: app.settings.editorFontSize,
      fontFamily: app.settings.editorFontFamily,
      wordWrap: app.settings.wordWrap ? 'on' : 'off',
      renderWhitespace: app.settings.showInvisibles ? 'all' : 'none'
    })
)

onBeforeUnmount(() => {
  editor?.dispose()
  ownModel?.dispose()
})
</script>

<template>
  <div ref="host" class="monaco-host" />
</template>

<style scoped>
.monaco-host {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
