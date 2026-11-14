<script lang="ts">
/** The fields of a parsed plan node that the tree shows (postgres-plan.ts, mssql-plan.ts). */
export interface PlanTreeNode {
  depth: number
  label: string
  relation: string
  index: string
  details: string[]
  cls: string
}
</script>

<script setup lang="ts" generic="N extends PlanTreeNode">
import { computed } from 'vue'
import type { ResultSet } from '@shared/types'

/**
 * Plan nodes indented under their parent, each a box coloured by access cost
 * (class bad red, medium orange, good green) with its summary line, relation,
 * index and details.
 */
const props = defineProps<{ plan: ResultSet; parse: (raw: unknown) => N[]; summary: (node: N) => string }>()

const parsed = computed<{ nodes: N[]; error: string }>(() => {
  try {
    return { nodes: props.parse(props.plan.rows[0]?.[0]), error: '' }
  } catch (e) {
    return { nodes: [], error: (e as Error).message }
  }
})
</script>

<template>
  <div v-if="parsed.error" class="empty-state selectable">{{ parsed.error }}</div>
  <div v-else class="tree">
    <div v-for="(n, i) in parsed.nodes" :key="i" class="node" :style="{ marginLeft: `${n.depth * 28}px` }">
      <div class="step">
        <div class="access" :class="n.cls">
          <div class="kind">{{ n.label }}</div>
          <div class="rows">{{ summary(n) }}</div>
        </div>
        <div v-if="n.relation || n.index" class="table">
          <strong v-if="n.relation">{{ n.relation }}</strong>
          <span v-if="n.index" class="key">{{ n.index }}</span>
        </div>
        <div v-for="d in n.details" :key="d" class="extra">{{ d }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.node {
  position: relative;
}

.node + .node::before {
  content: '';
  position: absolute;
  left: -14px;
  top: -8px;
  height: 22px;
  width: 12px;
  border-left: 1px solid var(--border-strong);
  border-bottom: 1px solid var(--border-strong);
}

.step {
  width: 320px;
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

.extra {
  padding: 2px 8px 6px;
  font-size: var(--fs-small);
  color: var(--text-muted);
  word-break: break-word;
}
</style>
