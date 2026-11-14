import { describe, expect, it } from 'vitest'
import { planNodes, shortScalar } from '@/components/results/plans/mssql-plan'

// SET SHOWPLAN_XML of SQL Server 2019 on a test database (trimmed of unused elements and attributes)
const nestedLoops = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.539" Build="15.0.2000.5">
  <BatchSequence>
    <Batch>
      <Statements>
        <StmtSimple StatementText="SELECT c.name, o.total FROM shop.customer c JOIN shop.orders o ON o.customer_id = c.id WHERE c.balance &gt; 5 AND o.status = N'paid' ORDER BY o.total DESC" StatementId="1" StatementType="SELECT" StatementSubTreeCost="0.0179358" StatementEstRows="1" StatementOptmLevel="FULL">
          <QueryPlan>
            <RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="1" EstimateIO="0" EstimateCPU="4.18e-06" EstimatedTotalSubtreeCost="0.0179358">
              <OutputList>
                <ColumnReference Database="[dbm_test]" Schema="[shop]" Table="[customer]" Alias="[c]" Column="name"/>
                <ColumnReference Database="[dbm_test]" Schema="[shop]" Table="[orders]" Alias="[o]" Column="total"/>
              </OutputList>
              <NestedLoops Optimized="0">
                <OuterReferences>
                  <ColumnReference Database="[dbm_test]" Schema="[shop]" Table="[orders]" Alias="[o]" Column="customer_id"/>
                </OuterReferences>
                <RelOp NodeId="1" PhysicalOp="Sort" LogicalOp="Sort" EstimateRows="1" EstimateIO="0.0112613" EstimateCPU="0.000100019" EstimatedTotalSubtreeCost="0.014648">
                  <OutputList>
                    <ColumnReference Database="[dbm_test]" Schema="[shop]" Table="[orders]" Alias="[o]" Column="customer_id"/>
                    <ColumnReference Database="[dbm_test]" Schema="[shop]" Table="[orders]" Alias="[o]" Column="total"/>
                  </OutputList>
                  <MemoryFractions Input="1" Output="1"/>
                  <Sort Distinct="0">
                    <OrderBy>
                      <OrderByColumn Ascending="0">
                        <ColumnReference Database="[dbm_test]" Schema="[shop]" Table="[orders]" Alias="[o]" Column="total"/>
                      </OrderByColumn>
                    </OrderBy>
                    <RelOp NodeId="2" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="1" EstimatedRowsRead="3" EstimateIO="0.003125" EstimateCPU="0.0001603" EstimatedTotalSubtreeCost="0.0032853" TableCardinality="3">
                      <OutputList>
                        <ColumnReference Database="[dbm_test]" Schema="[shop]" Table="[orders]" Alias="[o]" Column="customer_id"/>
                        <ColumnReference Database="[dbm_test]" Schema="[shop]" Table="[orders]" Alias="[o]" Column="total"/>
                      </OutputList>
                      <IndexScan Ordered="0">
                        <Object Database="[dbm_test]" Schema="[shop]" Table="[orders]" Index="[pk_orders]" Alias="[o]" IndexKind="Clustered"/>
                        <Predicate>
                          <ScalarOperator ScalarString="[dbm_test].[shop].[orders].[status] as [o].[status]=N'paid'"/>
                        </Predicate>
                      </IndexScan>
                    </RelOp>
                  </Sort>
                </RelOp>
                <RelOp NodeId="3" PhysicalOp="Clustered Index Seek" LogicalOp="Clustered Index Seek" EstimateRows="1" EstimatedRowsRead="1" EstimateIO="0.003125" EstimateCPU="0.0001581" EstimatedTotalSubtreeCost="0.0032831" TableCardinality="3">
                  <OutputList>
                    <ColumnReference Database="[dbm_test]" Schema="[shop]" Table="[customer]" Alias="[c]" Column="name"/>
                  </OutputList>
                  <IndexScan Ordered="1" ScanDirection="FORWARD">
                    <Object Database="[dbm_test]" Schema="[shop]" Table="[customer]" Index="[pk_customer]" Alias="[c]" IndexKind="Clustered"/>
                    <SeekPredicates>
                      <SeekPredicateNew>
                        <SeekKeys>
                          <Prefix ScanType="EQ">
                            <RangeColumns>
                              <ColumnReference Database="[dbm_test]" Schema="[shop]" Table="[customer]" Alias="[c]" Column="id"/>
                            </RangeColumns>
                            <RangeExpressions>
                              <ScalarOperator ScalarString="[dbm_test].[shop].[orders].[customer_id] as [o].[customer_id]"/>
                            </RangeExpressions>
                          </Prefix>
                        </SeekKeys>
                      </SeekPredicateNew>
                    </SeekPredicates>
                    <Predicate>
                      <ScalarOperator ScalarString="[dbm_test].[shop].[customer].[balance] as [c].[balance]&gt;(5.00)"/>
                    </Predicate>
                  </IndexScan>
                </RelOp>
              </NestedLoops>
            </RelOp>
          </QueryPlan>
        </StmtSimple>
      </Statements>
    </Batch>
  </BatchSequence>
</ShowPlanXML>`

describe('planNodes', () => {
  it('flattens the RelOps in pre-order, outer input before inner', () => {
    const nodes = planNodes(nestedLoops)
    expect(nodes.map((n) => [n.label, n.depth])).toEqual([
      ['Nested Loops (Inner Join)', 0],
      ['Sort', 1],
      ['Clustered Index Scan', 2],
      ['Clustered Index Seek', 1]
    ])
    expect(nodes[2]).toMatchObject({ relation: 'shop.orders o', index: 'pk_orders', rows: 1 })
    expect(nodes[3]).toMatchObject({ relation: 'shop.customer c', index: 'pk_customer' })
  })

  it('costs each operator without its inputs, as a share of the statement', () => {
    const nodes = planNodes(nestedLoops)
    // Sort: 0.014648 subtree - 0.0032853 of the scan below
    expect(nodes[1].cost).toBeCloseTo(0.0113627, 7)
    expect(nodes.map((n) => n.share)).toEqual([0, 63, 18, 18])
  })

  it('shows seek and residual predicates with alias-qualified columns', () => {
    const nodes = planNodes(nestedLoops)
    expect(nodes[2].details).toEqual(["Predicate: [o].[status]=N'paid'"])
    expect(nodes[3].details).toEqual(['Seek Predicates: [c].[id] = [o].[customer_id]', 'Predicate: [c].[balance]>(5.00)'])
  })

  it('rejects text that is not a showplan', () => {
    expect(() => planNodes('[{"Plan": {}}]')).toThrow()
  })
})

describe('shortScalar', () => {
  it('keeps the alias or the table of four-part column names', () => {
    expect(shortScalar("[db].[s].[t].[a]]b] as [x].[a]]b] like N'A%'")).toBe("[x].[a]]b] like N'A%'")
    expect(shortScalar('[db].[s].[customer].[name]=[db].[s].[orders].[id]')).toBe('[customer].[name]=[orders].[id]')
  })
})
