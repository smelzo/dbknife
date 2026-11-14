<script setup lang="ts">
import { computed } from 'vue'
import type { ResultSet } from '@shared/types'
import { t } from '@/i18n'

/**
 * Tree of SQLite's EXPLAIN QUERY PLAN rows (id, parent, notused, detail), each
 * step coloured like the MySQL plan: full table scans red, full index scans and
 * temporary b-trees orange, index searches green.
 */
const props = defineProps<{ plan: ResultSet }>()

interface Step {
  detail: string
  depth: number
  label: string
  cls: string
}

function classify(detail: string): [string, string] {
  if (/^SCAN /.test(detail) && !/ USING /.test(detail) && detail !== 'SCAN CONSTANT ROW') return [t('plan.access.fullTableScan'), 'bad']
  if (/^SCAN .* USING (COVERING )?INDEX /.test(detail)) return [t('plan.access.fullIndexScan'), 'medium']
  if (/^SEARCH .* USING (INTEGER )?PRIMARY KEY/.test(detail)) return [t('plan.access.primaryKeyLookup'), 'good']
  if (/^SEARCH /.test(detail)) return [t('plan.access.indexSearch'), 'good']
  if (/^USE TEMP B-TREE/.test(detail)) return [t('plan.access.temporaryBTree'), 'medium']
  return ['', 'none']
}

const steps = computed<Step[]>(() => {
  const p = props.plan
  const col = (name: string): number => p.columns.findIndex((c) => c.name.toLowerCase() === name)
  const [id, parent, detail] = [col('id'), col('parent'), col('detail')]
  const children = new Map<number, unknown[][]>()
  for (const row of p.rows) {
    const key = Number(row[parent])
    children.set(key, [...(children.get(key) ?? []), row])
  }
  const out: Step[] = []
  const walk = (key: number, depth: number): void => {
    for (const row of children.get(key) ?? []) {
      const text = String(row[detail] ?? '')
      const [label, cls] = classify(text)
      out.push({ detail: text, depth, label, cls })
      walk(Number(row[id]), depth + 1)
    }
  }
  walk(0, 0)
  return out
})
</script>

<template>
  <div class="tree">
    <div v-for="(s, i) in steps" :key="i" class="plan-node" :class="s.cls" :style="{ marginLeft: `${s.depth * 28}px` }">
      <span v-if="s.label" class="access">{{ s.label }}</span>
      <span class="detail selectable">{{ s.detail }}</span>
    </div>
  </div>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.plan-node {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-panel);
}

.access {
  padding: 4px 8px;
  color: #fff;
  font-weight: 600;
  white-space: nowrap;
}

.bad .access {
  background: #c0392b;
}

.medium .access {
  background: #d68910;
}

.good .access {
  background: #2e8b57;
}

.detail {
  padding: 4px 8px;
  font-family: var(--font-mono);
  font-size: var(--fs-small);
}
</style>
