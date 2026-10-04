import {
  type CreditGrant,
  type CreditHold,
  creditDebt,
  creditGrant,
  creditHold,
  creditHoldAllocation,
  creditLedger,
  type Database,
  member,
  payment,
} from '@saas/db'
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm'

export type CreditsTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type CreditsErrorCode =
  | 'INVALID_CREDIT_AMOUNT'
  | 'SOURCE_ALREADY_GRANTED'
  | 'CREDIT_DEBT'
  | 'INSUFFICIENT_CREDITS'
  | 'WORKSPACE_RESOURCE_NOT_FOUND'

export class CreditsError extends Error {
  constructor(public readonly code: CreditsErrorCode) {
    super(code)
    this.name = 'CreditsError'
  }
}

function validateAmount(amount: number) {
  // Credit columns are PostgreSQL int4, in addition to the JS safe-integer boundary.
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2_147_483_647) {
    throw new CreditsError('INVALID_CREDIT_AMOUNT')
  }
}

/** All credit mutations (including settlement) must acquire this lock first. */
export async function lockWorkspaceCredits(tx: CreditsTransaction, workspaceId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`credits:${workspaceId}`}, 0))`,
  )
}

/** A supplied transaction participates directly; its caller owns commit/rollback. */
export async function withCreditsTransaction<T>(
  db: Database,
  tx: CreditsTransaction | undefined,
  operation: (tx: CreditsTransaction) => Promise<T>,
): Promise<T> {
  return tx ? operation(tx) : db.transaction(operation)
}

export interface GrantInput {
  workspaceId: string
  source: CreditGrant['source']
  sourceRef: string
  amount: number
  paymentId?: string | null
  expiresAt?: Date | null
}

/** Replays return the existing workspace-owned grant without changing debt or ledger. */
export async function grant(
  db: Database,
  input: GrantInput,
  tx?: CreditsTransaction,
): Promise<CreditGrant> {
  validateAmount(input.amount)
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, input.workspaceId)
    const sameSource = and(
      eq(creditGrant.workspaceId, input.workspaceId),
      eq(creditGrant.source, input.source),
      eq(creditGrant.sourceRef, input.sourceRef),
    )
    const [existing] = await tx.select().from(creditGrant).where(sameSource)
    if (existing) return existing
    if (input.paymentId) {
      const [owned] = await tx
        .select({ id: payment.id })
        .from(payment)
        .where(and(eq(payment.id, input.paymentId), eq(payment.workspaceId, input.workspaceId)))
      if (!owned) throw new CreditsError('WORKSPACE_RESOURCE_NOT_FOUND')
    }
    // Claim the global (source, source_ref) key BEFORE touching debt. ON CONFLICT
    // handles concurrent grants in different workspaces without aborting tx.
    const [created] = await tx
      .insert(creditGrant)
      .values({ ...input, remaining: input.amount })
      .onConflictDoNothing({ target: [creditGrant.source, creditGrant.sourceRef] })
      .returning()
    if (!created) {
      const [replay] = await tx.select().from(creditGrant).where(sameSource)
      if (replay) return replay
      // Never return the grant (or workspace ID) belonging to another workspace.
      throw new CreditsError('SOURCE_ALREADY_GRANTED')
    }
    const [debt] = await tx
      .select()
      .from(creditDebt)
      .where(eq(creditDebt.workspaceId, input.workspaceId))
      .for('update')
    const repaid = Math.min(debt?.amount ?? 0, input.amount)
    let result = created
    if (repaid > 0) {
      await tx
        .update(creditDebt)
        .set({ amount: (debt?.amount ?? 0) - repaid })
        .where(eq(creditDebt.workspaceId, input.workspaceId))
      const [updated] = await tx
        .update(creditGrant)
        .set({ remaining: input.amount - repaid })
        .where(and(eq(creditGrant.id, created.id), eq(creditGrant.workspaceId, input.workspaceId)))
        .returning()
      if (!updated) throw new Error('Inserted credit grant disappeared')
      result = updated
    }
    await tx.insert(creditLedger).values({
      workspaceId: input.workspaceId,
      grantId: created.id,
      type: 'grant',
      delta: input.amount,
      refType: input.source,
      refId: input.sourceRef,
    })
    if (repaid > 0) {
      await tx.insert(creditLedger).values({
        workspaceId: input.workspaceId,
        grantId: created.id,
        type: 'debt_repay',
        delta: 0,
        note: `Repaid ${repaid} credits of debt`,
      })
    }
    return result
  })
}

export interface HoldInput {
  workspaceId: string
  userId: string
  amount: number
  refType: CreditHold['refType']
  refId: string
  expiresAt?: Date | null
}

export async function hold(
  db: Database,
  input: HoldInput,
  tx?: CreditsTransaction,
): Promise<CreditHold> {
  validateAmount(input.amount)
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, input.workspaceId)
    const [owned] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, input.workspaceId), eq(member.userId, input.userId)))
    if (!owned) throw new CreditsError('WORKSPACE_RESOURCE_NOT_FOUND')
    const [debt] = await tx
      .select({ amount: creditDebt.amount })
      .from(creditDebt)
      .where(eq(creditDebt.workspaceId, input.workspaceId))
    if (debt && debt.amount > 0) throw new CreditsError('CREDIT_DEBT')
    const batches = await tx
      .select()
      .from(creditGrant)
      .where(
        and(
          eq(creditGrant.workspaceId, input.workspaceId),
          eq(creditGrant.status, 'active'),
          gt(creditGrant.remaining, 0),
          or(isNull(creditGrant.expiresAt), gt(creditGrant.expiresAt, sql`now()`)),
        ),
      )
      .orderBy(
        sql`${creditGrant.expiresAt} asc nulls last`,
        asc(creditGrant.createdAt),
        asc(creditGrant.id),
      )
      .for('update')
    // Check before any mutation, including when an external caller catches errors.
    if (batches.reduce((total, batch) => total + batch.remaining, 0) < input.amount) {
      throw new CreditsError('INSUFFICIENT_CREDITS')
    }
    const [created] = await tx.insert(creditHold).values(input).returning()
    if (!created) throw new Error('Credit hold insert returned no row')
    let needed = input.amount
    for (const batch of batches) {
      if (needed === 0) break
      const amount = Math.min(needed, batch.remaining)
      await tx
        .update(creditGrant)
        .set({ remaining: batch.remaining - amount })
        .where(and(eq(creditGrant.id, batch.id), eq(creditGrant.workspaceId, input.workspaceId)))
      await tx
        .insert(creditHoldAllocation)
        .values({ holdId: created.id, grantId: batch.id, amount })
      needed -= amount
    }
    // Held credits remain in the reconciliation invariant; consume is settlement-only.
    return created
  })
}
