import { afterEach, describe, expect, it } from 'vitest'
import { initI18n, overlayPack, resolveLocale, t, validatePack, type LanguagePack } from '@shared/i18n'
import en from '@shared/i18n/en_US.json'

const pack = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  locale: 'it_IT',
  name: 'Italian (Italy)',
  nativeName: 'italiano (Italia)',
  messages: {},
  ...patch
})

afterEach(() => initI18n(null))

describe('validatePack', () => {
  it.each([
    ['a code outside the list', pack({ locale: 'FF_44' }), undefined],
    ['the built-in English', pack({ locale: 'en_US' }), undefined],
    ['a file name that differs from the locale', pack(), 'de_DE'],
    ['missing nativeName', pack({ nativeName: undefined }), undefined],
    ['messages that are not an object', pack({ messages: ['Annulla'] }), undefined],
    ['a JSON value that is not an object', 'it_IT', undefined]
  ])('rejects the file for %s', (_, json, fileCode) => {
    const result = validatePack(json, fileCode)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).not.toBe('')
  })

  it('accepts the file but leaves out unknown keys, invented placeholders and plurals of messages without {count}', () => {
    const result = validatePack(
      pack({
        messages: {
          'common.cancel': 'Annulla',
          'common.noSuchKey': 'Nessuna',
          'i18n.unknownLocale': '{lcoale} non è un codice di lingua supportato.',
          'common.ok': { one: 'OK', other: 'OK' },
          'menu.query.limitTo': { one: 'Limita a una riga', other: 'Limita a {count} righe' }
        }
      }),
      'it_IT'
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pack.messages).toEqual({
      'common.cancel': 'Annulla',
      'menu.query.limitTo': { one: 'Limita a una riga', other: 'Limita a {count} righe' }
    })
    expect(result.ignored.sort()).toEqual(['common.noSuchKey', 'common.ok', 'i18n.unknownLocale'])
  })
})

describe('t', () => {
  const italian: LanguagePack = {
    locale: 'it_IT',
    name: 'Italian (Italy)',
    nativeName: 'italiano (Italia)',
    messages: { 'menu.query.limitTo': { one: 'Limita a {count} riga', other: 'Limita a {count} righe' } }
  }

  it('falls back to English for keys the pack lacks', () => {
    initI18n(italian)
    expect(t('common.ok')).toBe(en.messages['common.ok'])
  })

  it('picks the Italian plural form: 1 is one, 0 is other (French would make 0 one)', () => {
    initI18n(italian)
    expect(t('menu.query.limitTo', { count: 1 })).toBe('Limita a 1 riga')
    expect(t('menu.query.limitTo', { count: 0 })).toBe('Limita a 0 righe')
  })
})

describe('overlayPack', () => {
  const builtIn: LanguagePack = { locale: 'it_IT', name: 'Italian (Italy)', nativeName: 'italiano (Italia)', messages: { 'common.ok': 'Va bene', 'common.cancel': 'Annulla' } }

  it('lets an older pack of the folder override entries without hiding those it lacks', () => {
    const folder: LanguagePack = { ...builtIn, messages: { 'common.ok': 'OK!' } }
    initI18n(overlayPack(builtIn, folder) ?? null)
    expect(t('common.ok')).toBe('OK!')
    expect(t('common.cancel')).toBe('Annulla')
  })
})

describe('resolveLocale', () => {
  it('maps a system language of another region to the installed pack of that language', () => {
    expect(resolveLocale('system', ['it-CH'], ['it_IT'])).toBe('it_IT')
  })

  it('applies the system rule when the chosen language is not installed', () => {
    expect(resolveLocale('de_DE', ['it-IT'], ['it_IT'])).toBe('it_IT')
  })

  it('keeps English when it is chosen explicitly or preferred first by the system', () => {
    expect(resolveLocale('en_US', ['it-IT'], ['it_IT'])).toBe('en_US')
    expect(resolveLocale('system', ['en-GB', 'it-IT'], ['it_IT'])).toBe('en_US')
  })

  it('falls back to English when nothing matches', () => {
    expect(resolveLocale('system', ['ja-JP', 'fr-FR'], ['it_IT', 'de_DE'])).toBe('en_US')
  })
})
