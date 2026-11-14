<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/i18n'

export interface ChartSeries {
  label: string
  color: string
  /** Oldest first; null leaves a gap. */
  values: (number | null)[]
}

/** Live sparkline with the latest value of each series; `max` fixes the vertical scale. */
const props = defineProps<{ title: string; series: ChartSeries[]; points: number; max?: number; format: (v: number) => string }>()

const W = 300
const H = 60

const scale = computed(() => props.max ?? Math.max(1, ...props.series.flatMap((s) => s.values.filter((v): v is number => v !== null))))

function path(values: (number | null)[]): string {
  const step = W / Math.max(1, props.points - 1)
  const offset = props.points - values.length
  let d = ''
  let pen = false
  values.forEach((v, i) => {
    if (v === null) {
      pen = false
      return
    }
    const x = (offset + i) * step
    const y = H - (Math.min(v, scale.value) / scale.value) * (H - 2) - 1
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
    pen = true
  })
  return d
}

const latest = (s: ChartSeries): string => {
  const v = s.values[s.values.length - 1]
  return v === null || v === undefined ? t('admin.status.notAvailable') : props.format(v)
}
</script>

<template>
  <div class="chart">
    <div class="head">
      <span class="title">{{ title }}</span>
      <span v-for="s in series" :key="s.label" class="value">
        <span class="swatch" :style="{ background: s.color }" />
        <template v-if="series.length > 1">{{ s.label }}: </template>{{ latest(s) }}
      </span>
    </div>
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none">
      <line v-for="f in [0.25, 0.5, 0.75]" :key="f" class="grid-line" x1="0" :x2="W" :y1="H * f" :y2="H * f" />
      <path v-for="s in series" :key="s.label" :d="path(s.values)" :stroke="s.color" />
    </svg>
    <div class="scale muted">{{ t('admin.status.chartMax', { value: format(scale) }) }}</div>
  </div>
</template>

<style scoped>
.chart {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px 6px;
  background: var(--bg-panel);
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  margin-bottom: 4px;
}

.title {
  font-weight: 600;
  flex: 1 0 auto;
}

.value {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

.swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

svg {
  display: block;
  width: 100%;
  height: 60px;
  background: var(--bg-content);
  border: 1px solid var(--border);
}

path {
  fill: none;
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.grid-line {
  stroke: var(--border);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.scale {
  font-size: var(--fs-small);
  text-align: right;
  margin-top: 2px;
}
</style>
