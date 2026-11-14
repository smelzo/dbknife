// Operators (RelOp) of a SQL Server showplan XML, flattened in display order.

import { XMLParser } from 'fast-xml-parser'
import { unquoteIdentifier } from '@shared/sql/lexer'
// from @shared, not @/i18n: vitest loads this module without the renderer's window.api
import { t } from '@shared/i18n'

/** Access cost class, coloured like the other plan views: scans bad, lookups medium, seeks good. */
export type AccessClass = 'bad' | 'medium' | 'good' | 'none'

export interface PlanNode {
  /** Nesting level, 0 for the root operator of each statement. */
  depth: number
  /** Physical operator, with the logical one when it differs (e.g. "Nested Loops (Inner Join)"). */
  label: string
  /** `schema.table alias` the operator reads. */
  relation: string
  index: string
  /** Estimated rows. */
  rows: number
  /** Estimated cost of the operator alone (its subtree minus its inputs). */
  cost: number
  /** Share of the statement's estimated cost, in percent. */
  share: number
  /** Seek and filter predicates, e.g. "Predicate: [o].[status]=N'paid'". */
  details: string[]
  cls: AccessClass
}

type XmlNode = { [key: string]: XmlNode[] | string }

const classes: Record<string, AccessClass> = {
  'Table Scan': 'bad',
  'Clustered Index Scan': 'bad',
  'Index Scan': 'bad',
  'Key Lookup': 'medium',
  'RID Lookup': 'medium',
  'Clustered Index Seek': 'good',
  'Index Seek': 'good'
}

const scanOperators: Record<string, string> = { EQ: '=', GT: '>', GE: '>=', LT: '<', LE: '<=' }

/** Longest predicate shown; longer ones are cut. */
const maxPredicate = 200

const attr = (n: XmlNode | undefined, name: string): string => (typeof n?.[`@${name}`] === 'string' ? (n[`@${name}`] as string) : '')
const children = (n: XmlNode | undefined, name: string): XmlNode[] => (Array.isArray(n?.[name]) ? (n[name] as XmlNode[]) : [])
const elements = (n: XmlNode): [string, XmlNode[]][] =>
  Object.entries(n).filter((e): e is [string, XmlNode[]] => !e[0].startsWith('@') && Array.isArray(e[1]))

const part = String.raw`\[(?:[^\]]|\]\])*\]`
const aliased = new RegExp(String.raw`(?:${part}\.)+${part} as (${part}\.${part})`, 'g')
const fourPart = new RegExp(String.raw`(?:${part}\.){2}(${part}\.${part})`, 'g')

/**
 * Column references as `[alias].[column]` or `[table].[column]`:
 * `[db].[s].[t].[c] as [a].[c]` → `[a].[c]`, `[db].[s].[t].[c]` → `[t].[c]`.
 */
export function shortScalar(text: string): string {
  return text.replace(aliased, '$1').replace(fourPart, '$1')
}

const short = (text: string): string => {
  const s = shortScalar(text)
  return s.length > maxPredicate ? `${s.slice(0, maxPredicate)}…` : s
}

const scalar = (n: XmlNode | undefined): string => attr(children(n, 'ScalarOperator')[0], 'ScalarString')

/** RelOps below `n`, without descending into them. */
function relOps(n: XmlNode): XmlNode[] {
  const out: XmlNode[] = []
  for (const [key, list] of elements(n)) for (const child of list) out.push(...(key === 'RelOp' ? [child] : relOps(child)))
  return out
}

/** Seek ranges of SeekPredicates, e.g. "[c].[id] = [o].[customer_id]". */
function seekText(seek: XmlNode): string {
  const ranges: string[] = []
  const visit = (n: XmlNode): void => {
    for (const [key, list] of elements(n)) {
      for (const child of list) {
        if (['Prefix', 'StartRange', 'EndRange'].includes(key)) {
          const cols = children(children(child, 'RangeColumns')[0], 'ColumnReference').map((c) =>
            [attr(c, 'Alias') || attr(c, 'Table'), `[${attr(c, 'Column').replace(/]/g, ']]')}]`].filter(Boolean).join('.')
          )
          const values = children(children(child, 'RangeExpressions')[0], 'ScalarOperator').map((s) => attr(s, 'ScalarString'))
          const op = scanOperators[attr(child, 'ScanType')] ?? attr(child, 'ScanType')
          ranges.push(cols.map((c, i) => `${c} ${op} ${values[i] ?? ''}`.trim()).join(' AND '))
        } else visit(child)
      }
    }
  }
  visit(seek)
  return ranges.join(' AND ')
}

function details(op: XmlNode): string[] {
  const out: string[] = []
  for (const seek of children(op, 'SeekPredicates')) out.push(`Seek Predicates: ${short(seekText(seek))}`)
  for (const p of children(op, 'Predicate')) out.push(`Predicate: ${short(scalar(p))}`)
  for (const key of ['ProbeResidual', 'Residual']) for (const p of children(op, key)) out.push(`Residual: ${short(scalar(p))}`)
  return out
}

/** Parses the plan cell (showplan XML text) into the operators of its statements, in pre-order. */
export function planNodes(cell: unknown): PlanNode[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseAttributeValue: false,
    isArray: (_tag, _path, _leaf, isAttribute) => !isAttribute
  })
  const doc = typeof cell === 'string' ? (parser.parse(cell) as XmlNode) : undefined
  const root = children(doc, 'ShowPlanXML')[0]
  if (!root) throw new Error(t('plan.notShowplanXml'))
  const plans: XmlNode[] = []
  const findPlans = (n: XmlNode): void => {
    for (const [key, list] of elements(n)) {
      for (const child of list) {
        if (key === 'QueryPlan') plans.push(child)
        else findPlans(child)
      }
    }
  }
  findPlans(root)
  const out: PlanNode[] = []
  for (const plan of plans) {
    for (const top of relOps(plan)) {
      const total = Number(attr(top, 'EstimatedTotalSubtreeCost')) || 0
      const visit = (n: XmlNode, depth: number): void => {
        const physical = attr(n, 'PhysicalOp')
        const logical = attr(n, 'LogicalOp')
        // the operator element (NestedLoops, IndexScan, Sort, ...), last child of RelOp, holds the object, the predicates and the inputs
        const op = elements(n).at(-1)?.[1][0]
        const inputs = op ? relOps(op) : []
        const subtree = Number(attr(n, 'EstimatedTotalSubtreeCost')) || 0
        const cost = Math.max(0, subtree - inputs.reduce((s, i) => s + (Number(attr(i, 'EstimatedTotalSubtreeCost')) || 0), 0))
        const object = children(op, 'Object')[0]
        const table = unquoteIdentifier(attr(object, 'Table'))
        const alias = unquoteIdentifier(attr(object, 'Alias'))
        const schema = unquoteIdentifier(attr(object, 'Schema'))
        const relation = table ? `${schema ? `${schema}.` : ''}${table}${alias && alias !== table ? ` ${alias}` : ''}` : ''
        out.push({
          depth,
          label: logical && logical !== physical ? `${physical} (${logical})` : physical,
          relation,
          index: unquoteIdentifier(attr(object, 'Index')),
          rows: Number(attr(n, 'EstimateRows')) || 0,
          cost,
          share: total > 0 ? Math.round((cost / total) * 100) : 0,
          details: op ? details(op) : [],
          cls: classes[physical] ?? 'none'
        })
        for (const input of inputs) visit(input, depth + 1)
      }
      visit(top, 0)
    }
  }
  return out
}
