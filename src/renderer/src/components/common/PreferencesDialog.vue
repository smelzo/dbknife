<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { resolveLocale } from '@shared/i18n'
import { knownLanguages } from '@shared/i18n/languages'
import type { LanguageInfo, Settings } from '@shared/types'
import { alertError, confirm } from '@/dialogs'
import { currentLocale, t } from '@/i18n'
import { useApp } from '@/stores/app'
import Modal from './Modal.vue'

const emit = defineEmits<{ close: [] }>()
const app = useApp()
const s = reactive<Settings>(JSON.parse(JSON.stringify(app.settings)))
const builtIn = window.api.i18n.info.builtIn
const isBuiltIn = (code: string): boolean => builtIn.some((l) => l.code === code)
const installed = ref<LanguageInfo[]>(window.api.i18n.info.installed)
/** Built-in languages and packs of the folder, a code once. */
const choices = computed(() =>
  [...builtIn, ...installed.value.filter((l) => !isBuiltIn(l.code))].sort((a, b) => a.code.localeCompare(b.code))
)
const languageLabel = (l: LanguageInfo): string => `${l.nativeName} — ${l.name}`
/** The chosen language, resolved as at startup, is not the one loaded. */
const restartNeeded = computed(
  () =>
    resolveLocale(
      s.language,
      window.api.i18n.info.systemLanguages,
      choices.value.map((l) => l.code)
    ) !== currentLocale()
)

async function installLanguage(): Promise<void> {
  const r = await window.api.i18n.install()
  if (r?.error) await alertError(t('prefs.installFailed'), r.error)
  else if (r?.installed) installed.value = await window.api.i18n.list()
}

const openLanguagesFolder = (): Promise<void> => window.api.i18n.openFolder()

async function removeLanguage(l: LanguageInfo): Promise<void> {
  if (!(await confirm(t('prefs.removeLanguageConfirm', { language: languageLabel(l) }), undefined, t('prefs.removeLanguage')))) return
  await window.api.i18n.remove(l.code)
  // the main process has already saved 'system' when it was the language in use; a built-in one stays
  if (!isBuiltIn(l.code)) {
    if (app.settings.language === l.code) app.settings.language = 'system'
    if (s.language === l.code) s.language = 'system'
  }
  installed.value = await window.api.i18n.list()
}

async function importWorkbench(): Promise<void> {
  const r = await window.api.connections.importWorkbench()
  await app.loadConnections()
  await window.api.ui.message({
    type: r.error ? 'warning' : 'info',
    message: r.error ?? t('prefs.importWorkbench.done', { count: r.imported }),
    detail: r.error ? undefined : t('prefs.importWorkbench.detail', { count: r.skipped })
  })
}

async function save(): Promise<void> {
  const { window: _w, ...patch } = s
  void _w
  await app.updateSettings(patch)
  emit('close')
}

async function saveAndRestart(): Promise<void> {
  await save()
  await app.restart()
}
</script>

<template>
  <Modal :title="t('prefs.title')" width="560px" @cancel="emit('close')">
    <h4>{{ t('prefs.sqlEditor') }}</h4>
    <div class="form-grid">
      <label for="pr-limit">{{ t('prefs.limitRows') }}</label>
      <div>
        <input id="pr-limit" v-model.number="s.limitRows" type="number" min="0" /> <span class="muted">{{ t('prefs.limitRowsHint') }}</span>
      </div>
      <span />
      <label class="check"><input v-model="s.safeUpdates" type="checkbox" /> {{ t('prefs.safeUpdates') }}</label>
      <span />
      <label class="check"><input v-model="s.stopOnError" type="checkbox" /> {{ t('prefs.stopOnError') }}</label>
      <span />
      <label class="check"><input v-model="s.confirmDataChanges" type="checkbox" /> {{ t('prefs.confirmDataChanges') }}</label>
      <span />
      <label class="check"><input v-model="s.showSystemSchemas" type="checkbox" /> {{ t('prefs.showSystemSchemas') }}</label>
      <label for="pr-dblclick">{{ t('prefs.tableDoubleClick') }}</label>
      <select id="pr-dblclick" v-model="s.tableDoubleClick">
        <option value="openData">{{ t('prefs.tableDoubleClick.openData') }}</option>
        <option value="insertName">{{ t('prefs.tableDoubleClick.insertName') }}</option>
      </select>
      <span />
      <label class="check"><input v-model="s.uppercaseKeywords" type="checkbox" /> {{ t('prefs.uppercaseKeywords') }}</label>
    </div>
    <h4>{{ t('prefs.connections') }}</h4>
    <div class="form-grid">
      <label for="pr-recent">{{ t('prefs.recentFiles') }}</label>
      <div>
        <input id="pr-recent" v-model.number="s.recentFiles" type="number" min="0" max="100" /> <span class="muted">{{ t('prefs.recentFilesHint') }}</span>
      </div>
      <span />
      <div class="row">
        <button @click="importWorkbench">{{ t('prefs.importWorkbench') }}</button>
      </div>
    </div>
    <h4>{{ t('prefs.appearance') }}</h4>
    <div class="form-grid">
      <label for="pr-theme">{{ t('prefs.theme') }}</label>
      <select id="pr-theme" v-model="s.theme">
        <option value="system">{{ t('prefs.themeSystem') }}</option>
        <option value="light">{{ t('prefs.themeLight') }}</option>
        <option value="dark">{{ t('prefs.themeDark') }}</option>
      </select>
      <label for="pr-font">{{ t('prefs.editorFont') }}</label>
      <input id="pr-font" v-model="s.editorFontFamily" type="text" />
      <label for="pr-size">{{ t('prefs.editorFontSize') }}</label>
      <input id="pr-size" v-model.number="s.editorFontSize" type="number" min="8" max="32" />
      <span />
      <div class="row">
        <label class="check"><input v-model="s.hardwareAcceleration" type="checkbox" /> {{ t('prefs.hardwareAcceleration') }}</label>
        <button v-if="s.hardwareAcceleration !== app.settings.hardwareAcceleration" @click="saveAndRestart">{{ t('prefs.restart') }}</button>
      </div>
      <span />
      <span class="muted">{{ t('prefs.hardwareAccelerationHint') }}</span>
    </div>
    <h4>{{ t('prefs.languageSection') }}</h4>
    <div class="form-grid">
      <label for="pr-language">{{ t('prefs.language') }}</label>
      <div class="row">
        <select id="pr-language" v-model="s.language">
          <option value="system">{{ t('prefs.languageSystem') }}</option>
          <option value="en_US">{{ knownLanguages.en_US.nativeName }}</option>
          <option v-for="l in choices" :key="l.code" :value="l.code">{{ languageLabel(l) }}</option>
        </select>
        <template v-if="restartNeeded">
          <span class="muted">{{ t('prefs.languageRestart') }}</span>
          <button @click="saveAndRestart">{{ t('prefs.restart') }}</button>
        </template>
      </div>
      <label>{{ t('prefs.installedLanguages') }}</label>
      <table v-if="installed.length" class="list languages">
        <tr v-for="l in installed" :key="l.code">
          <td>{{ languageLabel(l) }}</td>
          <td class="actions"><button @click="removeLanguage(l)">{{ t('prefs.removeLanguage') }}</button></td>
        </tr>
      </table>
      <span v-else class="muted">{{ t('prefs.noLanguages') }}</span>
      <span />
      <div class="row">
        <button @click="installLanguage">{{ t('prefs.installLanguage') }}</button>
        <button @click="openLanguagesFolder">{{ t('prefs.openLanguagesFolder') }}</button>
      </div>
    </div>
    <h4>{{ t('prefs.administration') }}</h4>
    <div class="form-grid">
      <label for="pr-dump">{{ t('prefs.toolPath', { tool: 'mysqldump' }) }}</label>
      <input id="pr-dump" v-model="s.mysqldumpPath" type="text" :placeholder="t('prefs.autoDetect')" />
      <label for="pr-mysql">{{ t('prefs.toolPath', { tool: 'mysql' }) }}</label>
      <input id="pr-mysql" v-model="s.mysqlPath" type="text" :placeholder="t('prefs.autoDetect')" />
      <label for="pr-pgdump">{{ t('prefs.toolPath', { tool: 'pg_dump' }) }}</label>
      <input id="pr-pgdump" v-model="s.pgDumpPath" type="text" :placeholder="t('prefs.autoDetect')" />
      <label for="pr-psql">{{ t('prefs.toolPath', { tool: 'psql' }) }}</label>
      <input id="pr-psql" v-model="s.psqlPath" type="text" :placeholder="t('prefs.autoDetect')" />
    </div>
    <template #footer>
      <button @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="primary" @click="save">{{ t('common.ok') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
h4 {
  margin: 14px 0 8px;
}

h4:first-child {
  margin-top: 0;
}

input[type='number'] {
  width: 90px;
}

.row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.languages td.actions {
  text-align: right;
}
</style>
