<script setup lang="ts">
import { computed } from 'vue'
import type { ResultSet } from '@shared/types'
import type { MessageKey } from '@shared/i18n'
import { t } from '@/i18n'

/**
 * Visual explain built from MySQL's tabular EXPLAIN output: one box per table
 * access in join order, coloured by access type
 * (full scans red, index/range scans orange, key lookups green).
 */
const props = defineProps<{ plan: ResultSet }>()

interface Step {
  id: string
  selectType: string
  table: string
  type: string
  key: string
  rows: string
  filtered: string
  extra: string
  cls: string
  label: string
}

const accessLabels: Record<string, [MessageKey, string]> = {
  ALL: ['plan.access.fullTableScan', 'bad'],
  index: ['plan.access.fullIndexScan', 'bad'],
  range: ['plan.access.indexRangeScan', 'medium'],
  index_merge: ['plan.access.indexMerge', 'medium'],
  ref: ['plan.access.nonUniqueKeyLookup', 'good'],
  ref_or_null: ['plan.access.keyLookupNull', 'good'],
  eq_ref: ['plan.access.uniqueKeyLookup', 'good'],
  const: ['plan.access.singleRowConstant', 'good'],
  system: ['plan.access.singleRowSystem', 'good'],
  fulltext: ['plan.access.fulltextSearch', 'medium'],
  unique_subquery: ['plan.access.uniqueSubquery', 'good'],
  index_subquery: ['plan.access.indexSubquery', 'medium']
}

const steps = computed<Step[]>(() => {
  const p = props.plan
  const idx = (name: string): number => p.columns.findIndex((c) => c.name.toLowerCase() === name)
  const get = (row: unknown[], name: string): string => {
    const i = idx(name)
    return i < 0 || row[i] === null ? '' : String(row[i])
  }
  return p.rows.map((row) => {
    const type = get(row, 'type')
    const access = accessLabels[type]
    const [label, cls] = access ? [t(access[0]), access[1]] : [type || t('plan.access.noTableAccess'), 'none']
    return {
      id: get(row, 'id'),
      selectType: get(row, 'select_type'),
      table: get(row, 'table'),
      type,
      key: get(row, 'key'),
      rows: get(row, 'rows'),
      filtered: get(row, 'filtered'),
      extra: get(row, 'extra'),
      cls,
      label
    }
  })
})
</script>

<template>
  <div class="flow">
    <template v-for="(s, i) in steps" :key="i">
      <div v-if="i > 0" class="join">
        <span>{{ t('plan.nestedLoop') }}</span>
      </div>
      <div class="step">
        <div class="access" :class="s.cls">
          <div class="kind">{{ s.label }}</div>
          <div class="rows" v-if="s.rows">{{ s.filtered ? t('plan.rowsFiltered', { count: s.rows, filtered: s.filtered }) : t('plan.rows', { count: s.rows }) }}</div>
        </div>
        <div class="table">
          <strong>{{ s.table || '—' }}</strong>
          <span v-if="s.key" class="key">{{ s.key }}</span>
        </div>
        <div class="meta">#{{ s.id }} {{ s.selectType }}</div>
        <div v-if="s.extra" class="extra">{{ s.extra }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.flow {
  display: flex;
  align-items: flex-start;
  gap: 0;
  flex-wrap: wrap;
  row-gap: 16px;
}

.join {
  align-self: center;
  padding: 0 10px;
  color: var(--text-muted);
  font-size: var(--fs-small);
  display: flex;
  align-items: center;
}

.join::before,
.join::after {
  content: '';
  width: 18px;
  height: 1px;
  background: var(--border-strong);
  margin: 0 4px;
}

.step {
  width: 190px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-panel);
}

.access {
  padding: 6px 8px;
  color: #fff;
}

.access.bad {
  background: #c0392b;
}

.access.medium {
  background: #d68910;
}

.access.good {
  background: #2e8b57;
}

.access.none {
  background: #7f8c8d;
}

.kind {
  font-weight: 600;
}

.rows {
  font-size: var(--fs-small);
  opacity: 0.9;
}

.table {
  padding: 6px 8px 2px;
  display: flex;
  flex-direction: column;
}

.key {
  color: var(--text-muted);
  font-size: var(--fs-small);
}

.meta,
.extra {
  padding: 0 8px 6px;
  font-size: var(--fs-small);
  color: var(--text-muted);
}
</style>
