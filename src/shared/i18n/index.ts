// User-facing text: the English catalog is built in, another language comes
// from a language pack loaded once at startup. Messages use {name}
// placeholders and, when they have {count}, plural forms chosen with
// Intl.PluralRules.

import en from './en_US.json'
import { knownLanguages } from './languages'

export type MessageKey = keyof typeof en.messages

export type Message = string | (Partial<Record<Intl.LDMLPluralRule, string>> & { other: string })

export interface LanguagePack {
  locale: string
  name: string
  nativeName: string
  messages: Partial<Record<MessageKey, Message>>
}

const english = en.messages as Record<MessageKey, Message>
const englishRules = new Intl.PluralRules('en')
const pluralCategories: readonly string[] = ['zero', 'one', 'two', 'few', 'many', 'other'] satisfies Intl.LDMLPluralRule[]
const placeholder = /\{(\w+)\}/g

let active: LanguagePack | null = null
let activeRules = englishRules

/** Makes `pack` the source of `t`; null (the initial state) means English. */
export function initI18n(pack: LanguagePack | null): void {
  active = pack
  activeRules = pack ? new Intl.PluralRules(toBcp47(pack.locale)) : englishRules
}

/** The message of `key` in the active language, English when the pack lacks it. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const own = active?.messages[key]
  const message = own ?? english[key]
  const text =
    typeof message === 'string'
      ? message
      : (message[(own ? activeRules : englishRules).select(Number(params?.count))] ?? message.other)
  if (!params) return text
  return text.replace(placeholder, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match))
}

/** Code of the active language: 'en_US' or the pack's locale. */
export function currentLocale(): string {
  return active?.locale ?? 'en_US'
}

/** 'it_IT' → 'it-IT', the tag Intl and toLocale…String expect. */
export function toBcp47(code: string): string {
  return code.replace('_', '-')
}

/**
 * Language to load: the setting when it is available, otherwise the first
 * system language (BCP 47 tags, in order of preference) with an exact match
 * or, failing that, a pack of the same language; English when none fits.
 * English is built in, so it is always available.
 */
export function resolveLocale(setting: string, system: string[], installed: string[]): string {
  const available = ['en_US', ...installed].sort()
  if (setting !== 'system' && available.includes(setting)) return setting
  for (const tag of system) {
    const code = tag.replaceAll('-', '_')
    if (available.includes(code)) return code
    const language = code.split('_')[0]
    const sameLanguage = available.find((c) => c.split('_')[0] === language)
    if (sameLanguage) return sameLanguage
  }
  return 'en_US'
}

/**
 * `pack` over `base`, entry by entry: a pack in the languages folder may be older
 * than the built-in one of the same locale, and the entries it lacks keep the
 * built-in text instead of falling back to English.
 */
export function overlayPack(base: LanguagePack | undefined, pack: LanguagePack | undefined): LanguagePack | undefined {
  if (!base || !pack) return pack ?? base
  return { ...pack, messages: { ...base.messages, ...pack.messages } }
}

export type PackValidation = { ok: true; pack: LanguagePack; ignored: string[] } | { ok: false; error: string }

/**
 * Checks a language pack read from `json`. Invalid metadata reject the whole
 * file; an entry with an unknown key, a malformed value or placeholders the
 * English message does not have is left out and listed in `ignored`.
 * `fileCode` is the file name without `.json`, for packs read from the
 * languages folder: it must match the locale.
 */
export function validatePack(json: unknown, fileCode?: string): PackValidation {
  if (!isRecord(json)) return { ok: false, error: t('i18n.notObject') }
  for (const field of ['locale', 'name', 'nativeName'])
    if (typeof json[field] !== 'string' || !json[field]) return { ok: false, error: t('i18n.invalidField', { field }) }
  if (!isRecord(json.messages)) return { ok: false, error: t('i18n.invalidField', { field: 'messages' }) }
  const locale = json.locale as string
  if (!Object.hasOwn(knownLanguages, locale)) return { ok: false, error: t('i18n.unknownLocale', { locale }) }
  if (locale === 'en_US') return { ok: false, error: t('i18n.builtInLocale', { locale }) }
  if (fileCode !== undefined && fileCode !== locale)
    return { ok: false, error: t('i18n.fileNameMismatch', { file: fileCode, locale }) }

  const messages: LanguagePack['messages'] = {}
  const ignored: string[] = []
  for (const [key, value] of Object.entries(json.messages)) {
    if (Object.hasOwn(english, key) && isValidMessage(value, placeholders(english[key as MessageKey])))
      messages[key as MessageKey] = value
    else ignored.push(key)
  }
  return {
    ok: true,
    pack: { locale, name: json.name as string, nativeName: json.nativeName as string, messages },
    ignored
  }
}

/** A string, or plural forms (only when English has {count}), using only English placeholders. */
function isValidMessage(value: unknown, allowed: Set<string>): value is Message {
  const usesAllowed = (text: string): boolean => [...placeholders(text)].every((name) => allowed.has(name))
  if (typeof value === 'string') return usesAllowed(value)
  if (!isRecord(value) || !allowed.has('count') || typeof value.other !== 'string') return false
  return Object.entries(value).every(
    ([category, form]) => pluralCategories.includes(category) && typeof form === 'string' && usesAllowed(form)
  )
}

function placeholders(message: Message): Set<string> {
  const texts = typeof message === 'string' ? [message] : (Object.values(message) as string[])
  return new Set(texts.flatMap((text) => [...text.matchAll(placeholder)].map((m) => m[1])))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
