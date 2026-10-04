import { creditGrant, creditLedger, type Database, payment } from '@saas/db'
import { and, eq, lte, type SQL, sql } from 'drizzle-orm'
import {
  CreditsError,
  type CreditsTransaction,
  lockWorkspaceCredits,
  withCreditsTransaction,
} from './index.ts'

/** Cancel only unreserved credits; outstanding allocations settle through capture/release. */
async function cancelGrants(
  tx: CreditsTransaction,
  workspaceId: string,
  status: 'expired' | 'revoked',
  predicate?: SQL,
) {
  const grants = await tx
    .select()
    .from(creditGrant)
    .where(
      and(eq(creditGrant.workspaceId, workspaceId), eq(creditGrant.status, 'active'), predicate),
    )
    .for('update')
  let canceled = 0
  for (const grant of grants) {
    await tx
      .update(creditGrant)
      .set({ remaining: 0, status })
      .where(and(eq(creditGrant.workspaceId, workspaceId), eq(creditGrant.id, grant.id)))
    if (grant.remaining > 0) {
      await tx.insert(creditLedger).values({
        workspaceId,
        grantId: grant.id,
        type: status === 'expired' ? 'expire' : 'revoke',
        delta: -grant.remaining,
      })
    }
    canceled += grant.remaining
  }
  return { grants: grants.length, canceled }
}

/** Marks elapsed active grants expired, including fully reserved/consumed grants. */
export async function expireWorkspaceCredits(
  db: Database,
  workspaceId: string,
  tx?: CreditsTransaction,
  now?: Date,
) {
  if (now && !Number.isFinite(now.getTime())) throw new Error('Invalid credit expiration time')
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, workspaceId)
    return cancelGrants(tx, workspaceId, 'expired', lte(creditGrant.expiresAt, now ?? sql`now()`))
  })
}

export interface RevokePaymentCreditsInput {
  workspaceId: string
  paymentId: string
}

/** Covers every linked monthly grant already present, without chasing consumed credits. */
export async function revokePaymentCredits(
  db: Database,
  input: RevokePaymentCreditsInput,
  tx?: CreditsTransaction,
) {
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, input.workspaceId)
    const [owned] = await tx
      .select({ id: payment.id })
      .from(payment)
      .where(and(eq(payment.workspaceId, input.workspaceId), eq(payment.id, input.paymentId)))
    if (!owned) throw new CreditsError('WORKSPACE_RESOURCE_NOT_FOUND')
    return cancelGrants(
      tx,
      input.workspaceId,
      'revoked',
      eq(creditGrant.paymentId, input.paymentId),
    )
  })
}

/** Deletion prerequisite: cancel all active grants, preserving holds and existing debt. */
export async function revokeWorkspaceCredits(
  db: Database,
  workspaceId: string,
  tx?: CreditsTransaction,
) {
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, workspaceId)
    return cancelGrants(tx, workspaceId, 'revoked')
  })
}
