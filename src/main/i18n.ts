import { app, dialog, type BrowserWindow } from 'electron'
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initI18n, overlayPack, resolveLocale, t, validatePack, type LanguagePack } from '@shared/i18n'
import { knownLanguages } from '@shared/i18n/languages'
import type { I18nInfo, LanguageInfo } from '@shared/types'
import { dataDir, getSettings, updateSettings } from './store'
import itIT from '../../languages/it_IT.json'

/** Packs built into the app: each update brings their new messages. */
const builtInJson: unknown[] = [itIT]

/** Language packs, one `<locale>.json` each, put there by hand or with Install Language…. */
export const languagesDir = (): string => dataDir('languages')

const packFile = (code: string): string => join(languagesDir(), `${code}.json`)

const languageInfo = (code: string): LanguageInfo => ({ code, ...knownLanguages[code] })

const logIgnored = (file: string, ignored: string[]): void => {
  if (ignored.length) console.warn(`Language pack ${file}: ignored entries ${ignored.join(', ')}`)
}

let info: I18nInfo = { pack: null, builtIn: [], installed: [], system: true, systemLanguages: [] }

/** The built-in packs by code, checked like those of the folder. */
function builtInPacks(): Map<string, LanguagePack> {
  const packs = new Map<string, LanguagePack>()
  for (const json of builtInJson) {
    const result = validatePack(json)
    if (!result.ok) console.warn(`Built-in language pack rejected: ${result.error}`)
    else {
      logIgnored(`${result.pack.locale} (built in)`, result.ignored)
      packs.set(result.pack.locale, result.pack)
    }
  }
  return packs
}

/** Valid packs of the languages folder by code; rejected files and ignored entries go to the console. */
function scanLanguages(): Map<string, LanguagePack> {
  const packs = new Map<string, LanguagePack>()
  const files = readdirSync(languagesDir())
    .filter((f) => f.endsWith('.json'))
    .sort()
  for (const file of files) {
    const code = file.slice(0, -'.json'.length)
    if (!Object.hasOwn(knownLanguages, code)) {
      console.warn(`Language pack ${file} rejected: ${t('i18n.unknownLocale', { locale: code })}`)
      continue
    }
    try {
      const result = validatePack(JSON.parse(readFileSync(join(languagesDir(), file), 'utf8')), code)
      if (!result.ok) {
        console.warn(`Language pack ${file} rejected: ${result.error}`)
        continue
      }
      logIgnored(file, result.ignored)
      packs.set(code, result.pack)
    } catch (err) {
      console.warn(`Language pack ${file} rejected: ${(err as Error).message}`)
    }
  }
  return packs
}

/** Picks the language from the setting and the system languages and loads it for `t`; at startup (and on a restart in dev). */
export function loadLanguage(): void {
  const builtIn = builtInPacks()
  const installed = scanLanguages()
  const setting = getSettings().language
  const systemLanguages = app.getPreferredSystemLanguages()
  const locale = resolveLocale(setting, systemLanguages, [...new Set([...builtIn.keys(), ...installed.keys()])])
  const pack = overlayPack(builtIn.get(locale), installed.get(locale)) ?? null
  initI18n(pack)
  info = {
    pack,
    builtIn: [...builtIn.keys()].map(languageInfo),
    installed: [...installed.keys()].map(languageInfo),
    system: locale !== setting,
    systemLanguages
  }
}

/** The language loaded at startup, for the renderer. */
export const i18nInfo = (): I18nInfo => info

/** Reads the folder again: Preferences also lists packs added by hand while the app runs. */
export const listInstalled = (): LanguageInfo[] => [...scanLanguages().keys()].map(languageInfo)

/**
 * Copies a pack the user picks into the languages folder as `<locale>.json`,
 * whatever the name of the source file. Null when the user cancels.
 */
export async function installLanguage(win: BrowserWindow): Promise<{ installed?: LanguageInfo; error?: string } | null> {
  const r = await dialog.showOpenDialog(win, {
    title: t('prefs.installLanguage'),
    filters: [{ name: t('prefs.languagePacks'), extensions: ['json'] }],
    properties: ['openFile']
  })
  if (r.canceled || !r.filePaths[0]) return null
  let json: unknown
  try {
    json = JSON.parse(await readFile(r.filePaths[0], 'utf8'))
  } catch (err) {
    return { error: t('i18n.unreadable', { error: (err as Error).message }) }
  }
  const result = validatePack(json)
  if (!result.ok) return { error: result.error }
  logIgnored(r.filePaths[0], result.ignored)

  const language = languageInfo(result.pack.locale)
  const target = packFile(language.code)
  if (existsSync(target)) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      message: t('prefs.replaceLanguage', { language: `${language.nativeName} — ${language.name}` }),
      buttons: [t('common.replace'), t('common.cancel')],
      defaultId: 0,
      cancelId: 1
    })
    if (response !== 0) return null
  }
  // through a temporary file, like the store, so a crash never leaves a truncated pack
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(json, null, 2))
  renameSync(tmp, target)
  return { installed: language }
}

/** Deletes the pack of `code`; the path comes only from the closed list of codes. A built-in language stays chosen. */
export function removeLanguage(code: string): void {
  if (typeof code !== 'string' || !Object.hasOwn(knownLanguages, code)) return
  const target = packFile(code)
  if (!existsSync(target)) return
  unlinkSync(target)
  if (getSettings().language === code && !info.builtIn.some((l) => l.code === code)) updateSettings({ language: 'system' })
}
