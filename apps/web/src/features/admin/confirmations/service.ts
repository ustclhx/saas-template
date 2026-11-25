import {
  type AdminPendingAction,
  type AdminPendingActionStatus,
  adminApiToken,
  adminPendingAction,
  adminStepUp,
  auditLog,
  type Database,
  type JsonValue,
  user,
} from '@saas/db'
import type { KeyValueStore } from '@saas/platform'
import { AppError, newId } from '@saas/shared'
import { and, asc, count, desc, eq, gt, ne, type SQL, sql } from 'drizzle-orm'
import {
  type AdminActionConfirmation,
  type AdminActionContext,
  type AdminActionScope,
  type AdminTransaction,
  isActiveAdmin,
  runAdminAction,
  runDelegatedAdminAction,
} from '../action.ts'
import type { AdminSessionRef } from '../step-up/check.ts'
import { dropConfirmationSecret, openConfirmationSecret, sealConfirmationSecret } from './secret.ts'

/**
 * AI（admin MCP）发起、管理员确认后执行的待确认记录（openspec add-admin-step-up 决策 6–8）。
 *
 * - 创建：工具在 MCP 调用时解析目标并快照现值，这里只负责落库、限额、加密密钥参数与审计。
 * - 读取 / 列表 / 确认 / 拒绝时惰性把到期的 pending 置为 expired 并清空密文，不新增定时任务；
 *   残留行由 jobs 的每日清理兜底（@saas/db cleanupAdminPendingActions）。
 * - 确认与拒绝都用带条件的 UPDATE 抢占：只有仍为 pending 且未到期的记录能被抢占，
 *   并发的确认与确认、确认与拒绝只有一个成功。
 * - 纯数据库动作的「抢占 + 业务写入 + 审计 + 置 done」在同一事务；失败回滚即回到 pending。
 *   令牌失效、目标已变化与业务校验失败是确定的结局，回滚后另起事务记为 failed。
 * - 需要提交后调用外部服务的动作（退款通过）由业务在自己的决策事务内调用 `decide(tx)` 完成抢占。
 */

export const CONFIRMATION_TTL_MS = 30 * 60_000
/** 每个令牌同时待确认的记录上限，防止失控的 agent 堆积记录 */
export const MAX_PENDING_PER_TOKEN = 20
/** result 列上限：超出时只保留截断标记，避免把大对象写进审计视图 */
export const CONFIRMATION_RESULT_MAX_BYTES = 2048

export type PendingActionRecord = AdminPendingAction

/** 工具在创建时给出的内容：可读摘要、确认页展示的结构化内容、执行参数与（可选）密钥参数 */
export interface ConfirmationRequest {
  readonly summary: string
  readonly display: Record<string, unknown>
  readonly payload: Record<string, unknown>
  /** 密钥参数，加密后保存；不得出现在 summary / display / payload 中 */
  readonly secret?: unknown
}

export interface ConfirmationExecution {
  readonly record: PendingActionRecord
  /** 解密后的密钥参数；记录没有密钥参数时为 undefined */
  readonly secret: unknown
  readonly confirmation: AdminActionConfirmation
  /** 合并进业务审计 meta 的来源信息（决策 8） */
  readonly auditMeta: {
    readonly via: 'mcp'
    readonly tokenId: string
    readonly tool: string
    readonly confirmationId: string
    readonly confirmedBy: string
    readonly stepUpMethod: string
  }
  readonly ip: string | null
}

export type ConfirmationExecutor =
  | {
      /** 纯数据库动作：在抢占事务内执行，scope.audit 已合并来源信息 */
      readonly kind: 'transaction'
      run(scope: AdminActionScope, execution: ConfirmationExecution): Promise<unknown>
      /** 提交后的副作用（清缓存等），失败不影响已提交的结果 */
      afterCommit?(execution: ConfirmationExecution): Promise<void>
    }
  | {
      /**
       * 业务自管事务的动作：必须在其决策事务内调用一次 `decide(tx)`（抢占、复核令牌、置 done 与确认审计），
       * 决策提交后的外部调用失败不改变记录状态。
       */
      readonly kind: 'delegated'
      run(
        db: Database,
        execution: ConfirmationExecution,
        decide: (tx: AdminTransaction) => Promise<void>,
      ): Promise<unknown>
    }

/** 确定的失败结局（令牌失效、目标已变化、业务校验失败）：记录改为 failed，不再可确认 */
export class ConfirmationFailedError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message)
    this.name = 'ConfirmationFailedError'
  }
}

/** 委托型执行中抢占阶段的拒绝，穿过业务代码后还原为原错误 */
class ClaimRejected extends Error {
  constructor(override readonly cause: unknown) {
    super('Confirmation claim rejected')
    this.name = 'ClaimRejected'
  }
}

export const STALE_TARGET = 'STALE_TARGET'
export const TOKEN_REVOKED = 'TOKEN_REVOKED'
export const SECRET_UNAVAILABLE = 'SECRET_UNAVAILABLE'

const pending = eq(adminPendingAction.status, 'pending')
const notExpired = gt(adminPendingAction.expiresAt, sql`now()`)

/** 到期的 pending 置为 expired 并清空密文（惰性过期） */
export async function expireOverduePendingActions(
  db: Pick<Database, 'update'>,
  where?: SQL,
): Promise<number> {
  const expired = await db
    .update(adminPendingAction)
    .set({ status: 'expired', secretCiphertext: null })
    .where(and(pending, sql`${adminPendingAction.expiresAt} <= now()`, where))
    .returning({ id: adminPendingAction.id })
  return expired.length
}

export type ConfirmationResult = { [key: string]: JsonValue }

/** 结果按 JSON 规范化（日期转字符串），超过上限时只保留截断标记 */
function boundedResult(result: unknown): ConfirmationResult {
  const text = JSON.stringify(
    result && typeof result === 'object' && !Array.isArray(result)
      ? result
      : { value: result ?? null },
  )
  return new TextEncoder().encode(text).length <= CONFIRMATION_RESULT_MAX_BYTES
    ? (JSON.parse(text) as ConfirmationResult)
    : { truncated: true }
}

/** 创建待确认记录；需在 runAdminAction 的事务内调用（scope.audit 写发起审计）。 */
export async function createPendingAction(
  scope: AdminActionScope & { readonly cache: KeyValueStore },
  input: {
    readonly tool: string
    readonly action: string
    readonly tokenId: string
    readonly request: ConfirmationRequest
    /** 合并进发起审计的调用信息（via、tokenId、tool、脱敏参数） */
    readonly auditMeta: Record<string, unknown>
  },
  now = new Date(),
) {
  const { tx } = scope
  // 同一令牌的创建串行化，计数与插入之间不会被并发请求越过上限
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`admin-confirmation-token:${input.tokenId}`}, 0))`,
  )
  await expireOverduePendingActions(tx, eq(adminPendingAction.tokenId, input.tokenId))
  const [row] = await tx
    .select({ n: count() })
    .from(adminPendingAction)
    .where(and(eq(adminPendingAction.tokenId, input.tokenId), pending))
  if ((row?.n ?? 0) >= MAX_PENDING_PER_TOKEN)
    throw new AppError(
      'CONFIRMATION_LIMIT_REACHED',
      `This token already has ${MAX_PENDING_PER_TOKEN} actions waiting for confirmation`,
      { status: 429 },
    )

  const id = newId()
  const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MS)
  const { summary, display, payload, secret } = input.request
  const secretCiphertext =
    secret === undefined
      ? null
      : await sealConfirmationSecret(scope.cache, id, secret, expiresAt, now)
  await tx.insert(adminPendingAction).values({
    id,
    tool: input.tool,
    action: input.action,
    tokenId: input.tokenId,
    requestedBy: scope.admin.id,
    summary,
    payload,
    display,
    secretCiphertext,
    expiresAt,
    createdAt: now,
  })
  await scope.audit({
    action: 'admin.confirmation.requested',
    targetType: 'admin_pending_action',
    targetId: id,
    meta: { ...input.auditMeta, confirmationId: id, action: input.action, summary },
  })
  return { id, summary, expiresAt }
}

const viewColumns = {
  id: adminPendingAction.id,
  tool: adminPendingAction.tool,
  action: adminPendingAction.action,
  tokenId: adminPendingAction.tokenId,
  requestedBy: adminPendingAction.requestedBy,
  summary: adminPendingAction.summary,
  display: adminPendingAction.display,
  status: adminPendingAction.status,
  result: adminPendingAction.result,
  decidedBy: adminPendingAction.decidedBy,
  decidedAt: adminPendingAction.decidedAt,
  expiresAt: adminPendingAction.expiresAt,
  createdAt: adminPendingAction.createdAt,
  hasSecret: sql<boolean>`${adminPendingAction.secretCiphertext} is not null`,
  token: { name: adminApiToken.name, prefix: adminApiToken.prefix },
}

/** 确认页与 MCP 查询使用的视图：不含执行参数与密文 */
export type PendingActionView = NonNullable<Awaited<ReturnType<typeof getPendingAction>>>

function viewQuery(db: Database) {
  return db
    .select(viewColumns)
    .from(adminPendingAction)
    .innerJoin(adminApiToken, eq(adminApiToken.id, adminPendingAction.tokenId))
}

/** 按 ID 读取并惰性过期；不存在时返回 undefined */
export async function getPendingAction(db: Database, id: string) {
  await expireOverduePendingActions(db, eq(adminPendingAction.id, id))
  const [row] = await viewQuery(db).where(eq(adminPendingAction.id, id))
  return row
}

/**
 * 后台列表：`pending` 按到期时间升序（最早到期在前），`history` 按结束时间倒序。
 * 列表前先惰性过期全部到期记录（数量受每令牌上限约束）。
 */
export async function listPendingActions(
  db: Database,
  input: { readonly view: 'pending' | 'history'; readonly offset: number; readonly limit: number },
) {
  await expireOverduePendingActions(db)
  const ended = sql`coalesce(${adminPendingAction.decidedAt}, ${adminPendingAction.expiresAt})`
  const rows = await viewQuery(db)
    .where(input.view === 'pending' ? pending : ne(adminPendingAction.status, 'pending'))
    .orderBy(
      ...(input.view === 'pending'
        ? [asc(adminPendingAction.expiresAt), asc(adminPendingAction.id)]
        : [desc(ended), desc(adminPendingAction.id)]),
    )
    .limit(input.limit + 1)
    .offset(input.offset)
  return { rows: rows.slice(0, input.limit), hasMore: rows.length > input.limit }
}

/** 导航上的待确认数量：只读，不触发过期写入 */
export async function countPendingActions(db: Database) {
  const [row] = await db
    .select({ n: count() })
    .from(adminPendingAction)
    .where(and(pending, notExpired))
  return row?.n ?? 0
}

/** 当前会话最近一次有效的重新验证方式；强制开关关闭期间可能没有记录，记为 none */
export async function currentStepUpMethod(
  db: Database,
  session: AdminSessionRef | null | undefined,
): Promise<string> {
  if (!session) return 'none'
  const [row] = await db
    .select({ method: adminStepUp.method })
    .from(adminStepUp)
    .where(
      and(
        eq(adminStepUp.sessionId, session.id),
        eq(adminStepUp.userId, session.userId),
        gt(adminStepUp.expiresAt, sql`now()`),
      ),
    )
  return row?.method ?? 'none'
}

/** 抢占失败时说明原因：不存在 404、非发起人 403、已过期或已处理 409 */
async function explainUnclaimable(
  tx: Pick<Database, 'select'>,
  id: string,
  adminId: string | undefined,
): Promise<never> {
  const [row] = await tx
    .select({
      status: adminPendingAction.status,
      requestedBy: adminPendingAction.requestedBy,
      expired: sql<boolean>`${adminPendingAction.expiresAt} <= now()`,
    })
    .from(adminPendingAction)
    .where(eq(adminPendingAction.id, id))
  if (!row) throw new AppError('CONFIRMATION_NOT_FOUND', 'Confirmation not found', { status: 404 })
  if (adminId !== undefined && row.requestedBy !== adminId && row.status === 'pending')
    throw new AppError(
      'CONFIRMATION_FORBIDDEN',
      'Only the administrator who owns the requesting token can confirm this action',
      { status: 403 },
    )
  if (row.status === 'pending' && row.expired)
    throw new AppError('CONFIRMATION_EXPIRED', 'Confirmation has expired', { status: 409 })
  throw new AppError('CONFIRMATION_NOT_PENDING', `Confirmation is already ${row.status}`, {
    status: 409,
    details: { status: row.status },
  })
}

/** 条件抢占：只有发起令牌所属管理员、且记录仍为 pending 未到期时成功（行锁保证只有一个事务赢） */
async function claim(
  tx: AdminTransaction,
  id: string,
  adminId: string,
  status: 'running' | 'done',
) {
  const [claimed] = await tx
    .update(adminPendingAction)
    .set({ status, decidedBy: adminId, decidedAt: new Date() })
    .where(
      and(
        eq(adminPendingAction.id, id),
        eq(adminPendingAction.requestedBy, adminId),
        pending,
        notExpired,
      ),
    )
    .returning()
  return claimed ?? explainUnclaimable(tx, id, adminId)
}

/** 复核发起令牌：已吊销、已过期或所属用户不再是有效管理员时不执行（决策 7） */
async function assertTokenUsable(tx: AdminTransaction, record: PendingActionRecord) {
  const [row] = await tx
    .select({
      revokedAt: adminApiToken.revokedAt,
      expiresAt: adminApiToken.expiresAt,
      userId: adminApiToken.userId,
      role: user.role,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(adminApiToken)
    .innerJoin(user, eq(user.id, adminApiToken.userId))
    .where(eq(adminApiToken.id, record.tokenId))
    .for('share', { of: adminApiToken })
  if (
    !row ||
    row.revokedAt !== null ||
    row.expiresAt <= new Date() ||
    row.userId !== record.requestedBy ||
    !isActiveAdmin(row)
  )
    throw new ConfirmationFailedError(TOKEN_REVOKED, 'The requesting token is no longer valid')
}

async function finish(
  tx: AdminTransaction,
  id: string,
  status: Extract<AdminPendingActionStatus, 'done' | 'failed'>,
  result: unknown,
) {
  await tx
    .update(adminPendingAction)
    .set({ status, result: boundedResult(result), secretCiphertext: null })
    .where(eq(adminPendingAction.id, id))
}

/** 业务校验错误（AppError 4xx）是确定的结局，转为失败；其他异常原样抛出，记录回滚为 pending */
function asConfirmationFailure(error: unknown): unknown {
  if (error instanceof ConfirmationFailedError) return error
  if (error instanceof AppError && error.expose && error.status < 500)
    return new ConfirmationFailedError(error.code, error.message)
  return error
}

async function recordFailure(
  context: AdminActionContext,
  id: string,
  error: ConfirmationFailedError,
) {
  return runAdminAction(context, 'admin.confirmation.confirm', async ({ tx, admin, audit }) => {
    const [failed] = await tx
      .update(adminPendingAction)
      .set({
        status: 'failed',
        result: boundedResult({ code: error.code, message: error.message }),
        decidedBy: admin.id,
        decidedAt: new Date(),
        secretCiphertext: null,
      })
      .where(
        and(
          eq(adminPendingAction.id, id),
          eq(adminPendingAction.requestedBy, admin.id),
          pending,
          notExpired,
        ),
      )
      .returning({ tool: adminPendingAction.tool, tokenId: adminPendingAction.tokenId })
    if (!failed) return explainUnclaimable(tx, id, admin.id)
    await audit({
      action: 'admin.confirmation.failed',
      targetType: 'admin_pending_action',
      targetId: id,
      meta: { confirmationId: id, tool: failed.tool, tokenId: failed.tokenId, code: error.code },
    })
    return { status: 'failed' as const, result: { code: error.code, message: error.message } }
  })
}

export type ConfirmOutcome =
  | { readonly status: 'done'; readonly result: ConfirmationResult }
  | { readonly status: 'failed'; readonly result: { code: string; message: string } }

/**
 * 确认执行（动作名 `admin.confirmation.confirm`，敏感，需要当前会话已重新验证）。
 * `executorFor` 按记录的工具名给出执行器；找不到时记为失败（工具已被移除或插件已停用）。
 */
export async function confirmPendingAction(
  context: AdminActionContext & { readonly cache: KeyValueStore },
  id: string,
  executorFor: (record: PendingActionRecord) => ConfirmationExecutor | undefined,
): Promise<ConfirmOutcome> {
  const [record] = await context.db
    .select()
    .from(adminPendingAction)
    .where(eq(adminPendingAction.id, id))
  // 不存在时同样先经过重新验证检查，未验证的会话不能借此探测记录是否存在
  if (!record)
    return runAdminAction(context, 'admin.confirmation.confirm', ({ tx }) =>
      explainUnclaimable(tx, id, context.admin.id),
    )
  const stepUpMethod = await currentStepUpMethod(context.db, context.session)
  const confirmation: AdminActionConfirmation = { id, confirmedBy: context.admin.id, stepUpMethod }
  const auditMeta = {
    via: 'mcp' as const,
    tokenId: record.tokenId,
    tool: record.tool,
    confirmationId: id,
    confirmedBy: context.admin.id,
    stepUpMethod,
  }
  const executor = executorFor(record)
  const confirmedAudit = {
    action: 'admin.confirmation.confirmed',
    targetType: 'admin_pending_action',
    targetId: id,
    meta: { ...auditMeta, action: record.action },
  }

  async function prepare(tx: AdminTransaction, status: 'running' | 'done') {
    const claimed = await claim(tx, id, context.admin.id, status)
    await assertTokenUsable(tx, claimed)
    if (!executor)
      throw new ConfirmationFailedError('TOOL_UNAVAILABLE', 'The requesting tool is unavailable')
    let secret: unknown
    if (claimed.secretCiphertext) {
      const opened = await openConfirmationSecret(context.cache, id, claimed.secretCiphertext)
      if (!opened)
        throw new ConfirmationFailedError(
          SECRET_UNAVAILABLE,
          'The secret value is no longer available',
        )
      secret = opened.value
    }
    return {
      record: claimed,
      secret,
      confirmation,
      auditMeta,
      ip: context.ip ?? null,
    } satisfies ConfirmationExecution
  }

  try {
    if (!executor || executor.kind === 'transaction') {
      let execution: ConfirmationExecution | undefined
      const outcome = await runAdminAction(context, 'admin.confirmation.confirm', async (scope) => {
        execution = await prepare(scope.tx, 'running')
        let result: unknown
        try {
          result = await (executor as Extract<ConfirmationExecutor, { kind: 'transaction' }>).run(
            {
              ...scope,
              audit: (entry) =>
                scope.audit({
                  ...entry,
                  meta: {
                    ...(entry.meta && typeof entry.meta === 'object' ? entry.meta : {}),
                    ...auditMeta,
                  },
                }),
            },
            execution,
          )
        } catch (error) {
          throw asConfirmationFailure(error)
        }
        const bounded = boundedResult(result)
        await finish(scope.tx, id, 'done', bounded)
        await scope.audit(confirmedAudit)
        return { status: 'done' as const, result: bounded }
      })
      await dropConfirmationSecret(context.cache, id)
      if (execution && executor?.kind === 'transaction' && executor.afterCommit) {
        try {
          await executor.afterCommit(execution)
        } catch {
          return { ...outcome, result: { ...outcome.result, followUpError: 'AFTER_COMMIT_FAILED' } }
        }
      }
      return outcome
    }

    let started = false
    let decided: ConfirmationResult | undefined
    try {
      const result = await runDelegatedAdminAction(
        context,
        'admin.confirmation.confirm',
        async (db) => {
          started = true
          const [current] = await db
            .select()
            .from(adminPendingAction)
            .where(eq(adminPendingAction.id, id))
          const execution: ConfirmationExecution = {
            record: current ?? record,
            secret: undefined,
            confirmation,
            auditMeta,
            ip: context.ip ?? null,
          }
          return executor.run(db, execution, async (tx) => {
            try {
              await prepare(tx, 'done')
            } catch (error) {
              // 抢占阶段的拒绝（不存在、非发起人、已处理）原样返回，不能被当成业务失败
              throw error instanceof ConfirmationFailedError ? error : new ClaimRejected(error)
            }
            decided = { confirmationId: id }
            await finish(tx, id, 'done', decided)
            // biome-ignore lint/plugin: Platform-admin confirmation audit is written in the business decision transaction.
            await tx.insert(auditLog).values({
              ...confirmedAudit,
              actorUserId: context.admin.id,
              ip: context.ip ?? null,
            })
          })
        },
      )
      const bounded = boundedResult(result)
      // 决策已提交，补写最终结果（尽力而为；失败时保留决策时的结果）
      await context.db
        .update(adminPendingAction)
        .set({ result: bounded })
        .where(and(eq(adminPendingAction.id, id), eq(adminPendingAction.status, 'done')))
        .catch(() => undefined)
      return { status: 'done', result: bounded }
    } catch (error) {
      if (error instanceof ClaimRejected) throw error.cause
      // 守卫拒绝（重新验证、管理员已失效）发生在业务开始之前
      if (!started) throw error
      if (!decided) throw asConfirmationFailure(error)
      // 决策已提交，之后的外部调用失败沿用业务自己的重试，记录保持 done
      const code = error instanceof AppError ? error.code : 'FOLLOW_UP_FAILED'
      return { status: 'done', result: { ...decided, followUpError: code } }
    }
  } catch (error) {
    if (error instanceof ConfirmationFailedError) {
      const outcome = await recordFailure(context, id, error)
      await dropConfirmationSecret(context.cache, id)
      return outcome
    }
    throw error
  }
}

/** 拒绝（动作名 `admin.confirmation.reject`，任何有效管理员均可）；需在 runAdminAction 事务内调用 */
export async function rejectPendingAction(scope: AdminActionScope, id: string) {
  const [rejected] = await scope.tx
    .update(adminPendingAction)
    .set({
      status: 'rejected',
      decidedBy: scope.admin.id,
      decidedAt: new Date(),
      secretCiphertext: null,
    })
    .where(and(eq(adminPendingAction.id, id), pending, notExpired))
    .returning({ tool: adminPendingAction.tool, tokenId: adminPendingAction.tokenId })
  if (!rejected) return explainUnclaimable(scope.tx, id, undefined)
  await scope.audit({
    action: 'admin.confirmation.rejected',
    targetType: 'admin_pending_action',
    targetId: id,
    meta: { confirmationId: id, tool: rejected.tool, tokenId: rejected.tokenId },
  })
  return { status: 'rejected' as const }
}

/** 拒绝提交后删除数据密钥 */
export async function rejectPendingActionAndDropSecret(
  context: AdminActionContext & { readonly cache: KeyValueStore },
  id: string,
) {
  const outcome = await runAdminAction(context, 'admin.confirmation.reject', (scope) =>
    rejectPendingAction(scope, id),
  )
  await dropConfirmationSecret(context.cache, id)
  return outcome
}

/** 结构化值的稳定指纹（键排序后的 SHA-256），用于快照比对且不在记录中保存原值 */
export async function fingerprint(value: unknown): Promise<string> {
  const canonical = JSON.stringify(value ?? null, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  )
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
