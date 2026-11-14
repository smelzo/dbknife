import { t } from '@/i18n'
import { hasEdits, type ResultTab } from './results'

/** Asks before grid edits not applied to the database are thrown away; true when there are none or the user discards them. */
export async function confirmDiscardEdits(results: ResultTab[]): Promise<boolean> {
  const edited = results.filter(hasEdits)
  if (!edited.length) return true
  const r = await window.api.ui.message({
    type: 'warning',
    message: t('results.discardEdits.confirm', { names: edited.map((rt) => rt.title).join(', ') }),
    detail: t('results.discardEdits.detail'),
    buttons: [t('results.discardEdits.discard'), t('common.cancel')],
    defaultId: 1,
    cancelId: 1
  })
  return r === 0
}
