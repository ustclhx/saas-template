import { templateConfigDefaults } from '@saas/config'
import type { Database } from '@saas/db'
import { AppError, newId } from '@saas/shared'
import {
  BULK_JOB_TIME_FLOOR,
  bulkJobOutcome,
  bulkJobSkipped,
  checkBulkJobTime,
  cutoffBefore,
} from '@saas/shared/bulk-job'
import { log } from '@saas/shared/log'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { z } from 'zod'
import {
  AI_PURGE_BATCH_SIZE,
  AI_PURGE_MAX_BATCHES,
  addAiPurge,
  type CleanupWorkspaceShareCards,
  emptyAiPurge,
  purgeAiBatch,
} from './ai-content-cleanup.ts'
import { type AuthContextSource, requireFreshSession } from './fresh-session.ts'

export const WORKSPACE_RETENTION_DAYS = 30
/** 过期空间清理每轮最多处理的空间数（add-ops-safeguards D2），同时限制通知与邀请的删除量 */
export const EXPIRED_WORKSPACE_CAP = 20
/** 保留期常量被误改时的最小值：低于 1 天整轮不执行 */
const WORKSPACE_MIN_RETENTION_MS = 86_400_000
const deletionMeta = z.object({ originalOwnerUserIds: z.array(z.uuid()) })
type Transaction = Parameters<Parameters<Database['$client']['begin']>[1]>[0]
function refuse(code: string, message: string, status = 403): never {
  throw new AppError(code, message, { status })
}
async function latestDeletion(sql: Database['$client'] | Transaction, workspaceId: string) {
  const [event] = await sql<{ id: string; meta: unknown }[]>`
    select id,meta from audit_log where workspace_id=${workspaceId} and action='workspace.deleted'
    order by created_at desc,id desc limit 1`
  return event
}
async function alreadyCleaned(sql: Transaction, workspaceId: string, deletionId: string) {
  const [event] = await sql`select id from audit_log where workspace_id=${workspaceId}
    and action='workspace.cleanup.completed' and meta->>'deletionAuditId'=${deletionId} limit 1`
  return Boolean(event)
}

/** Restore only valid original owners; invitations, API keys and old sessions stay revoked. */
export async function restoreWorkspace(options: {
  readonly auth: AuthContextSource
  readonly db: Database
  readonly headers: Headers
  readonly workspaceId: string
  readonly maxWorkspacesPerUser?: number
  readonly clientIp?: string | null | undefined
}) {
  const fresh = await requireFreshSession(options)
  if (fresh.user.role !== 'admin') refuse('ADMIN_REQUIRED', 'Platform administrator required')
  const workspaceId = z.uuid().parse(options.workspaceId)
  const deletion = await latestDeletion(options.db.$client, workspaceId)
  if (!deletion) refuse('WORKSPACE_NOT_FOUND', 'Deleted workspace not found', 404)
  const owners = [...new Set(deletionMeta.parse(deletion.meta).originalOwnerUserIds)].sort()
  return options.db.$client.begin(async (sql) => {
    for (const id of owners)
      await sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${id}`},0))`
    await sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspaceId}`},0))`
    // Lock the administrator row so revocation/ban cannot commit during restoration.
    const [admin] = await sql`select u.id from session s join "user" u on u.id=s.user_id
      where s.token=${fresh.session.token} and s.expires_at>clock_timestamp() and s.impersonated_by is null
      and u.role='admin' and not (coalesce(u.banned,false) and (u.ban_expires is null or u.ban_expires>clock_timestamp())) for update of u,s`
    if (!admin) refuse('ADMIN_REQUIRED', 'Active platform administrator session required')
    const [workspace] = await sql<{ is_personal: boolean; eligible: boolean }[]>`
      select is_personal,deleted_at>clock_timestamp()-(${WORKSPACE_RETENTION_DAYS} * interval '1 day') as eligible
      from organization where id=${workspaceId} and deleted_at is not null for update`
    if (!workspace) refuse('WORKSPACE_NOT_FOUND', 'Deleted workspace not found', 404)
    const current = await latestDeletion(sql, workspaceId)
    if (current?.id !== deletion.id)
      refuse('WORKSPACE_CHANGED', 'Deletion changed; retry restoration', 409)
    if (!workspace.eligible || (await alreadyCleaned(sql, workspaceId, deletion.id)))
      refuse('WORKSPACE_RETENTION_EXPIRED', 'Workspace retention period has ended', 409)
    const valid: string[] = []
    for (const id of owners) {
      const [owner] = await sql`select id from "user" where id=${id}
        and email<>${`deleted+${id}@invalid`}
        and not (coalesce(banned,false) and (ban_expires is null or ban_expires>clock_timestamp())) for update`
      if (!owner) continue
      if (!workspace.is_personal) {
        const [owned] = await sql<{ total: number }[]>`select count(*)::int as total from member m
          join organization o on o.id=m.organization_id where m.user_id=${id} and m.role='owner'
          and not o.is_personal and o.deleted_at is null`
        if (
          (owned?.total ?? 0) >=
          (options.maxWorkspacesPerUser ?? templateConfigDefaults.tenancy.maxWorkspacesPerUser)
        )
          refuse('WORKSPACE_LIMIT', 'Original owner workspace limit reached', 409)
      }
      valid.push(id)
    }
    if (!valid.length) refuse('WORKSPACE_OWNER_UNAVAILABLE', 'No original owner is available', 409)
    await sql`delete from member where organization_id=${workspaceId}`
    for (const id of valid)
      await sql`insert into member (id,organization_id,user_id,role) values (${newId()},${workspaceId},${id},'owner')`
    await sql`update organization set deleted_at=null,updated_at=now() where id=${workspaceId}`
    await sql`insert into audit_log (id,actor_user_id,workspace_id,action,target_type,target_id,ip,meta)
      values (${newId()},${fresh.user.id},${workspaceId},'workspace.restored','organization',${workspaceId},${options.clientIp ?? null},${JSON.stringify({ deletionAuditId: deletion.id, ownerUserIds: valid })}::jsonb)`
    return { restored: true, ownerUserIds: valid }
  })
}

/**
 * 保留期结束后的内容清理。organization/user、财务与审计记录永久保留。
 * 通知与邀请在首次清理时删除并写入完成标记；AI 内容分批删除，跳过的行（held 预扣）
 * 留到下一轮，因此仍有 AI 内容的已到期空间每轮都会重新处理。
 */
export async function cleanupExpiredWorkspaces(
  db: Database,
  {
    batchSize = AI_PURGE_BATCH_SIZE,
    maxBatches = AI_PURGE_MAX_BATCHES,
    cleanupShareCards,
    now = new Date(),
    retentionDays = WORKSPACE_RETENTION_DAYS,
    workspaceCap = EXPIRED_WORKSPACE_CAP,
  }: {
    batchSize?: number
    maxBatches?: number
    cleanupShareCards?: CleanupWorkspaceShareCards
    /** 应用时钟，只与数据库时钟对照 */
    now?: Date
    /** 仅供测试替换保留期常量，验证误配时整轮不执行 */
    retentionDays?: number
    workspaceCap?: number
  } = {},
) {
  const floor = BULK_JOB_TIME_FLOOR.toISOString()
  const [probe] = await db.$client<{ db_now: Date; out_of_range: number }[]>`
    select now() as db_now, (select count(*) from organization o
      where o.deleted_at<${floor})::int as out_of_range`
  const dbNow = new Date(probe?.db_now ?? Number.NaN)
  const cutoff = cutoffBefore(dbNow, retentionDays * 86_400_000)
  const verdict = checkBulkJobTime({
    appNow: now,
    dbNow,
    cutoffs: [{ at: cutoff, minRetentionMs: WORKSPACE_MIN_RETENTION_MS }],
  })
  if (!verdict.ok)
    return {
      cleaned: 0,
      failed: 0,
      ai: { ...emptyAiPurge(), remaining: false },
      guard: bulkJobSkipped(verdict.reason),
    }
  const before = cutoff.toISOString()
  const candidates = await db.$client<{ id: string }[]>`select o.id from organization o
    where o.deleted_at>=${floor} and o.deleted_at<=${before}
      and (not exists(select 1 from audit_log l where l.workspace_id=o.id and l.action='workspace.cleanup.completed')
        or exists(select 1 from ai_conversation c where c.workspace_id=o.id)
        or exists(select 1 from ai_task t where t.workspace_id=o.id))
    order by o.deleted_at, o.id
    limit ${workspaceCap}`
  let cleaned = 0
  let failed = 0
  let batches = 0
  let remaining = false
  const ai = emptyAiPurge()
  const lock = (sql: Transaction, workspaceId: string) => lockExpired(sql, workspaceId, before)
  for (const workspace of candidates) {
    try {
      // 存储失效失败时不写 completed；即使没有 AI 内容，下一轮仍会发现该空间。
      const shareCards = await cleanupShareCards?.(workspace.id)
      if (shareCards?.complete === false) continue
      for (;;) {
        if (batches >= maxBatches) {
          remaining = true
          break
        }
        batches++
        // 每批重新加空间锁并确认仍已到期，与 restoreWorkspace 串行。
        const batch = await db.$client.begin(async (sql) =>
          (await lock(sql, workspace.id))
            ? purgeAiBatch(sql, { workspaceId: workspace.id }, batchSize)
            : emptyAiPurge(),
        )
        addAiPurge(ai, batch)
        if (Math.max(batch.messages, batch.conversations, batch.tasks) < batchSize) break
      }
      if (!remaining) {
        const completed = await db.$client.begin(async (sql) => {
          if (!(await lock(sql, workspace.id))) return false
          const deletion = await latestDeletion(sql, workspace.id)
          if (!deletion || (await alreadyCleaned(sql, workspace.id, deletion.id))) return false
          await sql`delete from notification where workspace_id=${workspace.id}`
          await sql`delete from invitation where organization_id=${workspace.id}`
          await sql`insert into audit_log (id,workspace_id,action,target_type,target_id,meta)
        values (${newId()},${workspace.id},'workspace.cleanup.completed','organization',${workspace.id},${JSON.stringify({ deletionAuditId: deletion.id })}::jsonb)`
          return true
        })
        if (completed) cleaned++
      }
      if (remaining) break
    } catch {
      failed++
      log.error('workspace.cleanup.failed', { workspaceId: workspace.id })
    }
  }
  return {
    cleaned,
    failed,
    ai: { ...ai, remaining },
    guard: bulkJobOutcome({
      processed: candidates.length,
      cap: workspaceCap,
      capReached: remaining || candidates.length >= workspaceCap,
      outOfRange: probe?.out_of_range ?? 0,
    }),
  }
}

/** 截止时间由本轮以数据库时钟算出并经过防护检查；删除时间早于下限的空间不视为到期 */
async function lockExpired(sql: Transaction, workspaceId: string, before: string) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspaceId}`},0))`
  const [expired] = await sql`select id from organization where id=${workspaceId}
    and deleted_at>=${BULK_JOB_TIME_FLOOR.toISOString()} and deleted_at<=${before} for update`
  return Boolean(expired)
}

/** Mount separately in createAuth; all authorization comes from the current database session. */
export function workspaceLifecyclePlugin(
  db: Database,
  maxWorkspacesPerUser = templateConfigDefaults.tenancy.maxWorkspacesPerUser as number,
  clientIp?: string | null,
) {
  return {
    id: 'workspace-lifecycle',
    endpoints: {
      restoreWorkspace: createAuthEndpoint(
        '/admin/restore-workspace',
        {
          method: 'POST',
          body: z.object({ workspaceId: z.uuid() }),
          requireHeaders: true,
        },
        async (ctx) => {
          try {
            return ctx.json(
              await restoreWorkspace({
                db,
                clientIp,
                maxWorkspacesPerUser,
                workspaceId: ctx.body.workspaceId,
                headers: ctx.headers,
                auth: { $context: Promise.resolve(ctx.context) },
              }),
            )
          } catch (error) {
            if (!(error instanceof AppError)) throw error
            throw new APIError(
              error.status === 401
                ? 'UNAUTHORIZED'
                : error.status === 404
                  ? 'NOT_FOUND'
                  : error.status === 409
                    ? 'CONFLICT'
                    : 'FORBIDDEN',
              { code: error.code, message: error.message },
            )
          }
        },
      ),
    },
  } satisfies BetterAuthPlugin
}
