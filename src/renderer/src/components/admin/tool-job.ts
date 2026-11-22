import { onUnmounted, reactive } from 'vue'
import type { AlignPreview, ToolProgress } from '@shared/types'
import { t } from '@/i18n'

/** State of a background export/import job, fed by the 'tools:progress' events. */
export function useToolJob(onDone?: (p: ToolProgress) => void) {
  const job = reactive({ id: '', running: false, progress: 0, message: '', log: '', error: '', preview: undefined as AlignPreview | undefined })
  /** Resolves the promise of the running start(). */
  let finish: ((p: ToolProgress | undefined) => void) | undefined

  const off = window.api.tools.onProgress((p) => {
    if (p.jobId !== job.id) return
    job.progress = p.progress
    if (p.message) job.message = p.message
    if (p.log) job.log += p.log + '\n'
    if (p.preview) job.preview = p.preview
    if (p.done) {
      job.running = false
      job.error = p.error ?? ''
      onDone?.(p)
      finish?.(p)
      finish = undefined
    }
  })
  // a caller awaiting start() goes on when the page closes; the job itself continues in the main
  onUnmounted(() => {
    off()
    finish?.(undefined)
    finish = undefined
  })

  /** Starts a job; resolves with its last event when it ends, undefined when it could not start or the page closed. */
  async function start(launch: () => Promise<string>): Promise<ToolProgress | undefined> {
    Object.assign(job, { running: true, progress: 0, message: t('admin.job.starting'), log: '', error: '', preview: undefined })
    const ended = new Promise<ToolProgress | undefined>((resolve) => (finish = resolve))
    try {
      job.id = await launch()
    } catch (err) {
      Object.assign(job, { running: false, error: (err as Error).message, message: (err as Error).message })
      finish = undefined
      return undefined
    }
    return ended
  }

  const cancel = (): Promise<void> => window.api.tools.cancel(job.id)

  return { job, start, cancel }
}

export type ToolJob = ReturnType<typeof useToolJob>
