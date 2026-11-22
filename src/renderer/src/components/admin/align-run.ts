import type { AlignAction, AlignKind, AlignNote, AlignObjectDiff, AlignObjectRef, AlignPreview, AlignRequest, AlignStatus, ToolProgress } from '@shared/types'
import type { MessageKey } from '@shared/i18n'
import type { Workspace } from '@/workspace/workspace'
import { confirm } from '@/dialogs'
import { t } from '@/i18n'
import { alignConnection } from './align-sessions'
import type { ToolJob } from './tool-job'

// Apply of an alignment, the one path of the Alignments page, its editor and the
// quick dialog of the table menu; and the texts of the codes the main reports.

export const kindLabels: Record<AlignKind, MessageKey> = {
  table: 'admin.align.kind.table',
  sequence: 'admin.align.kind.sequence',
  view: 'admin.align.kind.view',
  procedure: 'admin.align.kind.procedure',
  function: 'admin.align.kind.function',
  trigger: 'admin.align.kind.trigger',
  event: 'admin.align.kind.event'
}

export const statusLabels: Record<AlignStatus, MessageKey> = {
  same: 'admin.align.status.same',
  different: 'admin.align.status.different',
  sourceOnly: 'admin.align.status.sourceOnly',
  targetOnly: 'admin.align.status.targetOnly'
}

export const actionLabels: Record<AlignAction, MessageKey> = {
  none: 'admin.align.action.none',
  skip: 'admin.align.action.skip',
  create: 'admin.align.action.create',
  recreate: 'admin.align.action.recreate',
  syncRows: 'admin.align.action.syncRows',
  replaceRows: 'admin.align.action.replaceRows',
  drop: 'admin.align.action.drop'
}

/** The codes of AlignNote (src/shared/sql/align.ts and src/main/tools/align-mysql.ts); columnOnlyIn depends on its side. */
const noteKeys: Record<string, MessageKey> = {
  checkDiffers: 'admin.align.note.checkDiffers',
  columnDiffers: 'admin.align.note.columnDiffers',
  contextDiffers: 'admin.align.note.contextDiffers',
  definitionDiffers: 'admin.align.note.definitionDiffers',
  foreignKeyDiffers: 'admin.align.note.foreignKeyDiffers',
  functionalIndex: 'admin.align.note.functionalIndex',
  indexDiffers: 'admin.align.note.indexDiffers',
  kindDiffers: 'admin.align.note.kindDiffers',
  missing: 'admin.align.note.missing',
  notTargetOnly: 'admin.align.note.notTargetOnly',
  notTransactional: 'admin.align.note.notTransactional',
  partitioned: 'admin.align.note.partitioned',
  spatialSrid: 'admin.align.note.spatialSrid',
  structureDiffers: 'admin.align.note.structureDiffers',
  tableOptionDiffers: 'admin.align.note.tableOptionDiffers',
  wouldLoseRows: 'admin.align.note.wouldLoseRows'
}

const kindParams = ['kind', 'source', 'target'] as const

/** Text of a note of the main; an unknown code shows as itself. */
export function noteText(n: AlignNote): string {
  const params = { ...n.params }
  if (n.code === 'columnOnlyIn') return t(params.side === 'target' ? 'admin.align.note.columnOnlyInTarget' : 'admin.align.note.columnOnlyInSource', params)
  const key = noteKeys[n.code]
  if (!key) return n.code
  // kinds arrive as AlignKind codes
  if (n.code === 'kindDiffers' || n.code === 'missing' || n.code === 'notTargetOnly') {
    for (const p of kindParams) if (params[p] && Object.hasOwn(kindLabels, params[p])) params[p] = t(kindLabels[params[p] as AlignKind])
  }
  return t(key, params)
}

const sameRef = (a: AlignObjectRef, b: AlignObjectRef): boolean => a.kind === b.kind && a.name === b.name
const ref = (o: AlignObjectDiff): AlignObjectRef => ({ kind: o.kind, name: o.name })

/** A recreation that loses rows: the table recreated, or what replaces a table of the target (as isTableChange of the main). */
const recreatesTable = (o: AlignObjectDiff): boolean =>
  o.action === 'recreate' && (o.kind === 'table' || o.notes.some((n) => n.code === 'kindDiffers' && n.params?.target === 'table'))

interface Changes {
  recreate: AlignObjectDiff[]
  drop: AlignObjectDiff[]
}

/** The table recreations and the drops of the preview, named as the main names them. */
const destructive = (preview: AlignPreview | undefined): Changes => ({
  recreate: (preview?.objects ?? []).filter(recreatesTable),
  drop: (preview?.objects ?? []).filter((o) => o.action === 'drop')
})

/** Those the request did not confirm yet, to ask about; all of them when the names do not tell (lower_case_table_names). */
function toAsk(all: Changes, r: AlignRequest): Changes {
  const fresh = {
    recreate: all.recreate.filter((o) => !(r.confirmed?.recreate ?? []).some((c) => sameRef(c, o))),
    drop: all.drop.filter((o) => !(r.confirmed?.drop ?? []).some((c) => sameRef(c, o)))
  }
  return fresh.recreate.length || fresh.drop.length ? fresh : all
}

/** The question of what the job stopped for: the tables losing their rows, with or without a backup, and the objects dropped. */
function confirmChanges(r: AlignRequest, pending: Changes): Promise<boolean> {
  const lines = [
    ...pending.recreate.map((o) =>
      o.rows ? t('admin.align.confirm.recreateRows', { name: o.name, target: o.rows.delete, source: o.rows.insert }) : t('admin.align.confirm.recreate', { name: o.name })
    ),
    ...pending.drop.map((o) => t('admin.align.confirm.drop', { name: o.name, kind: t(kindLabels[o.kind]) })),
    '',
    t(r.options.backup ? 'admin.align.confirm.backup' : 'admin.align.confirm.noBackup')
  ]
  return confirm(t('admin.align.confirm.title', { schema: r.target.schema }), lines.join('\n'), t('admin.align.apply'))
}

/**
 * Applies `request` with `tool`: confirmation for a production target, then
 * the job; a stop for recreations or drops not confirmed asks about them and,
 * with a yes, runs again with them confirmed. Resolves with the last job's end.
 */
export async function runAlignment(ws: Workspace, request: AlignRequest, targetConnectionId: string, tool: ToolJob): Promise<ToolProgress | undefined> {
  const target = alignConnection(ws, targetConnectionId)
  if (target?.environment === 'production') {
    const ok = await confirm(t('admin.align.productionConfirm', { name: target.name, schema: request.target.schema }), undefined, t('admin.align.apply'))
    if (!ok) return undefined
  }
  let r = request
  let end: ToolProgress | undefined
  for (;;) {
    end = await tool.start(() => window.api.tools.alignApply(r))
    if (end?.errorCode !== 'needsConfirmation') break
    // the job stopped before any change, with the preview of what it would do
    const all = destructive(tool.job.preview)
    if (!(await confirmChanges(r, toAsk(all, r)))) {
      ws.log('info', t('workspace.admin.align'), t('tools.cancelled'))
      end = undefined
      break
    }
    r = { ...r, confirmed: { recreate: all.recreate.map(ref), drop: all.drop.map(ref) } }
  }
  if (end) ws.log(end.error ? 'error' : 'ok', t('workspace.admin.align'), end.error ?? end.message ?? '')
  if (targetConnectionId === ws.config.id) ws.refreshAfterDdl()
  return end
}
