<script setup lang="ts">
import type { ResultSet } from '@shared/types'
import { t } from '@/i18n'
import PlanTree from './PlanTree.vue'
import { planNodes, type PlanNode } from './mssql-plan'

/**
 * Visual explain of a SQL Server showplan XML: the operator tree, inputs
 * indented under their operator, table access coloured by cost (scans red,
 * key/RID lookups orange, seeks green).
 */
defineProps<{ plan: ResultSet }>()

const summary = (n: PlanNode): string =>
  t('plan.rowsCostShare', { count: Number(n.rows.toFixed(2)), cost: Number(n.cost.toPrecision(3)), share: n.share })
</script>

<template>
  <PlanTree :plan="plan" :parse="planNodes" :summary="summary" />
</template>
