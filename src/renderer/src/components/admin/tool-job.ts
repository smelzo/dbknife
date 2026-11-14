import { onUnmounted, reactive } from 'vue'
import type { ToolProgress } from '@shared/types'
import { t } from '@/i18n'

/** State of a background export/import job, fed by the 'tools:progress' events. */
export function useToolJob(onDone?: (p: ToolProgress) => void) {
  const job = reactive({ id: '', running: false, progress: 0, message: '', log: '', error: '' })

  const off = window.api.tools.onProgress((p) => {
    if (p.jobId !== job.id) return
    job.progress = p.progress
    if (p.message) job.message = p.message
    if (p.log) job.log += p.log + '\n'
    if (p.done) {
      job.running = false
      job.error = p.error ?? ''
      onDone?.(p)
    }
  })
  onUnmounted(off)

  async function start(launch: () => Promise<string>): Promise<void> {
    Object.assign(job, { running: true, progress: 0, message: t('admin.job.starting'), log: '', error: '' })
    try {
      job.id = await launch()
    } catch (err) {
      Object.assign(job, { running: false, error: (err as Error).message, message: (err as Error).message })
    }
  }

  const cancel = (): Promise<void> => window.api.tools.cancel(job.id)

  return { job, start, cancel }
}
