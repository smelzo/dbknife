import type { ComputedRef, Ref } from 'vue'
import { formatBytes } from '@/workspace/format'
import type { ChartSeries } from '../StatusChart.vue'

/** Samples kept by the charts: one per second. */
export const POINTS = 60

export type InfoRow = [label: string, value: string]

export interface Feature {
  label: string
  on: boolean
  detail?: string
}

export interface Chart {
  title: string
  format: (v: number) => string
  max?: number
  series: ChartSeries[]
}

/** What the Server Status page shows for an engine. */
export interface StatusModel {
  error: Ref<string>
  serverRows: ComputedRef<InfoRow[]>
  features: ComputedRef<Feature[]>
  sections: ComputedRef<{ title: string; rows: InfoRow[] }[]>
  charts: ComputedRef<Chart[]>
  /** Reads the server information, then takes a sample. */
  loadInfo: () => Promise<void>
  /** Takes a sample for the charts; called every second. */
  sample: () => Promise<void>
}

/** Appends a sample to a chart series, keeping the last POINTS. */
export function push(values: (number | null)[], value: number | null): void {
  values.push(value)
  if (values.length > POINTS) values.splice(0, values.length - POINTS)
}

/** Per-second rates of cumulative counters between two samples. */
export function rates(): (values: Record<string, string>) => (name: string) => number | null {
  let previous: { time: number; values: Record<string, string> } | undefined
  return (values) => {
    const time = Date.now()
    const before = previous
    previous = { time, values }
    return (name) => {
      if (!before || !(name in values) || !(name in before.values)) return null
      return Math.max(0, (Number(values[name]) - Number(before.values[name])) / ((time - before.time) / 1000))
    }
  }
}

export function uptimeText(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const hms = new Date((seconds % 86400) * 1000).toISOString().slice(11, 19)
  return d ? `${d}d ${hms}` : hms
}

/** Drops rows whose value is not available on this server. */
export const available = (rows: InfoRow[]): InfoRow[] => rows.filter((r) => r[1] !== '' && r[1] !== undefined)

export const count = (n: number): string => String(Math.round(n))
export const perSecond = (n: number): string => `${n < 10 ? n.toFixed(1) : Math.round(n)}/s`
export const bytesPerSecond = (n: number): string => `${formatBytes(n)}/s`
export const percent = (n: number): string => `${n.toFixed(1)}%`
