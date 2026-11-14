<script setup lang="ts">
import type { ResultSet } from '@shared/types'
import { t } from '@/i18n'
import PlanTree from './PlanTree.vue'
import { planNodes, type PlanNode } from './postgres-plan'

/**
 * Visual explain of a PostgreSQL `EXPLAIN (FORMAT JSON)` plan: the node tree,
 * children indented under their parent, scans coloured by access cost
 * (sequential scans red, bitmap scans orange, index scans green).
 */
defineProps<{ plan: ResultSet }>()

const summary = (n: PlanNode): string => t('plan.rowsCost', { count: n.rows, startup: n.startupCost, total: n.totalCost })
</script>

<template>
  <PlanTree :plan="plan" :parse="planNodes" :summary="summary" />
</template>
