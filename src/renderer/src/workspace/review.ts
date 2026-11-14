import { openDialog } from '@/dialogs'
import ReviewSqlDialog from '@/components/common/ReviewSqlDialog.vue'
import type { Workspace } from './workspace'

/**
 * Shows the statements in the "Apply SQL Script" review dialog and runs them
 * when confirmed. Resolves true when the script was applied without errors.
 * When it fails, a transaction it opened is rolled back and the `cleanup`
 * statements run. `exempt`: statements that skip the client-side Safe Updates
 * check while the user leaves them unchanged (Workspace.runStatements).
 */
export async function reviewAndApply(
  ws: Workspace,
  statements: string[],
  options: { title?: string; description?: string; cleanup?: string[]; exempt?: string[] } = {}
): Promise<boolean> {
  if (!statements.length) return false
  return !!(await openDialog<boolean>(ReviewSqlDialog, { ws, statements, ...options }))
}
