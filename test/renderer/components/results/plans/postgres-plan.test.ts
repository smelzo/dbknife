import { describe, expect, it } from 'vitest'
import { planNodes } from '@/components/results/plans/postgres-plan'

// EXPLAIN (FORMAT JSON) output of PostgreSQL 17 on a test database (trimmed of unused keys)
const hashJoin = `[
  {
    "Plan": {
      "Node Type": "Hash Join", "Join Type": "Inner", "Startup Cost": 12.70, "Total Cost": 35.00, "Plan Rows": 970,
      "Hash Cond": "(o.customer_id = c.id)",
      "Plans": [
        { "Node Type": "Seq Scan", "Parent Relationship": "Outer", "Relation Name": "orders", "Alias": "o",
          "Startup Cost": 0.00, "Total Cost": 19.70, "Plan Rows": 970 },
        { "Node Type": "Hash", "Parent Relationship": "Inner", "Startup Cost": 11.20, "Total Cost": 11.20, "Plan Rows": 120,
          "Plans": [
            { "Node Type": "Seq Scan", "Parent Relationship": "Outer", "Relation Name": "customer", "Alias": "c",
              "Startup Cost": 0.00, "Total Cost": 11.20, "Plan Rows": 120 }
          ] }
      ]
    }
  }
]`

const nestedLoop = [
  {
    Plan: {
      'Node Type': 'Nested Loop',
      'Join Type': 'Inner',
      'Plan Rows': 5,
      Plans: [
        { 'Node Type': 'Index Scan', 'Index Name': 'customer_pkey', 'Relation Name': 'customer', Alias: 'customer', 'Plan Rows': 1, 'Index Cond': '(id = 1)' },
        {
          'Node Type': 'Bitmap Heap Scan',
          'Relation Name': 'orders',
          Alias: 'o',
          'Plan Rows': 5,
          Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Index Name': 'fk_orders_customer_idx', 'Plan Rows': 5 }]
        }
      ]
    }
  }
]

describe('planNodes', () => {
  it('flattens the JSON text of a plan in pre-order with nesting depths', () => {
    const nodes = planNodes(hashJoin)
    expect(nodes.map((n) => [n.label, n.depth])).toEqual([
      ['Hash Join (Inner)', 0],
      ['Seq Scan', 1],
      ['Hash', 1],
      ['Seq Scan', 2]
    ])
    expect(nodes[0].details).toEqual(['Hash Cond: (o.customer_id = c.id)'])
    expect(nodes[1]).toMatchObject({ relation: 'orders o', rows: 970, startupCost: 0, totalCost: 19.7 })
  })

  it('names the relation without repeating an alias equal to it, with its index and conditions', () => {
    const nodes = planNodes(nestedLoop)
    expect(nodes[1]).toMatchObject({ relation: 'customer', index: 'customer_pkey', details: ['Index Cond: (id = 1)'] })
  })
})
