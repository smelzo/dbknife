// Nodes of a PostgreSQL `EXPLAIN (FORMAT JSON)` plan, flattened in display order.

// from @shared, not @/i18n: vitest loads this module without the renderer's window.api
import { t } from '@shared/i18n'

/** Access cost class, coloured like MySQL's visual explain: full scans bad, index scans good. */
export type AccessClass = 'bad' | 'medium' | 'good' | 'none'

export interface PlanNode {
  /** Nesting level, 0 for the root. */
  depth: number
  /** Node type, with the join type for joins (e.g. "Hash Join (Inner)"). */
  label: string
  relation: string
  index: string
  /** Estimated rows. */
  rows: number
  startupCost: number
  totalCost: number
  /** Conditions and keys of the node, e.g. "Index Cond: (id = 1)". */
  details: string[]
  cls: AccessClass
}

interface JsonNode {
  'Node Type': string
  'Join Type'?: string
  'Relation Name'?: string
  Schema?: string
  Alias?: string
  'Index Name'?: string
  'Plan Rows'?: number
  'Startup Cost'?: number
  'Total Cost'?: number
  'Subplan Name'?: string
  Plans?: JsonNode[]
  [key: string]: unknown
}

const classes: Record<string, AccessClass> = {
  'Seq Scan': 'bad',
  'Parallel Seq Scan': 'bad',
  'Bitmap Heap Scan': 'medium',
  'Bitmap Index Scan': 'medium',
  'Index Scan': 'good',
  'Index Only Scan': 'good'
}

const detailKeys = ['Index Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Recheck Cond', 'Filter', 'Sort Key', 'Group Key', 'Subplan Name']

/** Parses the plan cell (JSON text or an already parsed value) into its nodes in pre-order. */
export function planNodes(cell: unknown): PlanNode[] {
  const json: unknown = typeof cell === 'string' ? JSON.parse(cell) : cell
  const top: unknown = Array.isArray(json) ? json[0] : json
  const root = typeof top === 'object' && top !== null && 'Plan' in top ? (top.Plan as JsonNode | undefined) : undefined
  if (!root) throw new Error(t('plan.notPostgresJson'))
  const out: PlanNode[] = []
  const visit = (n: JsonNode, depth: number): void => {
    const type = n['Node Type']
    const relation = n['Relation Name'] ? (n.Alias && n.Alias !== n['Relation Name'] ? `${n['Relation Name']} ${n.Alias}` : n['Relation Name']) : ''
    out.push({
      depth,
      label: n['Join Type'] ? `${type} (${n['Join Type']})` : type,
      relation,
      index: n['Index Name'] ?? '',
      rows: n['Plan Rows'] ?? 0,
      startupCost: n['Startup Cost'] ?? 0,
      totalCost: n['Total Cost'] ?? 0,
      details: detailKeys
        .filter((k) => n[k] !== undefined)
        .map((k) => `${k}: ${Array.isArray(n[k]) ? (n[k] as unknown[]).join(', ') : String(n[k])}`),
      cls: classes[type] ?? 'none'
    })
    for (const child of n.Plans ?? []) visit(child, depth + 1)
  }
  visit(root, 0)
  return out
}
