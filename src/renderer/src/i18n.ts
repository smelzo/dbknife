// The language the main process loaded at startup, read synchronously by the
// preload: a module that imports t from here gets the catalog set before it
// evaluates, so module-level labels are translated too.
import { currentLocale, initI18n, toBcp47 } from '@shared/i18n'

initI18n(window.api.i18n.info.pack)

export { currentLocale, t } from '@shared/i18n'

/**
 * Locale for toLocale…String: undefined (the system's) while the language
 * setting is 'system', otherwise the language in use.
 */
export const formatLocale = (): string | undefined => (window.api.i18n.info.system ? undefined : toBcp47(currentLocale()))
