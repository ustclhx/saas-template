import type { Database } from '@saas/db'
import { AppError, newId } from '@saas/shared'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { z } from 'zod'
import { type AuthContextSource, requireFreshSession } from './fresh-session.ts'
import type { KvStore } from './session.ts'

export type DeletionKind = 'account' | 'workspace'
export type DeletionTransaction = Parameters<Parameters<Database['$client']['begin']>[1]>[0]
export interface DeletionContext {
  readonly actorUserId: string
  readonly workspaceIds: readonly string[]
  readonly db: Database
}
export interface DeletionStep {
  /** External provider calls belong here, outside the database transaction. */
  readonly before?: (context: DeletionContext) => Promise<void>
  /** Database writes only; throwing rolls back the entire deletion. */
  readonly execute?: (context: DeletionContext, sql: DeletionTransaction) => Promise<void>
}
const steps: Record<DeletionKind, DeletionStep[]> = { account: [], workspace: [] }
/** Register once at application startup; the returned disposer is useful in tests. */
export function registerDeletionStep(kind: DeletionKind, step: DeletionStep): () => void {
  steps[kind].push(step)
  return () => {
    const index = steps[kind].indexOf(step)
    if (index >= 0) steps[kind].splice(index, 1)
  }
}
interface Options {
  readonly auth: AuthContextSource
  readonly db: Database
  readonly headers: Headers
  readonly kv?: KvStore | undefined
}
function fail(
  code: string,
  message: string,
  status = 403,
  details?: Record<string, unknown>,
): never {
  throw new AppError(code, message, { status, ...(details ? { details } : {}) })
}
async function freshInTransaction(sql: DeletionTransaction, token: string, recent: boolean) {
  const [row] = await sql<
    { id: string; email: string; created_at: string; impersonated_by: string | null }[]
  >`
    select u.id,u.email,s.created_at,s.impersonated_by from session s join "user" u on u.id=s.user_id
    where s.token=${token} and s.expires_at>now() and not coalesce(u.banned,false)`
  if (!row) fail('SESSION_REQUIRED', 'Sign in required', 401)
  if (recent && (row.impersonated_by || Date.now() - new Date(row.created_at).getTime() > 600000))
    fail('REAUTHENTICATION_REQUIRED', 'Sign out and sign in again within ten minutes')
  return row
}
async function clearKv(kv: KvStore | undefined, keys: readonly string[]) {
  if (!kv) return
  const results = await Promise.allSettled(
    [...new Set(keys)].map((key) => kv.delete(`auth:${key}`)),
  )
  if (results.some((result) => result.status === 'rejected'))
    fail(
      'DELETION_CLEANUP_FAILED',
      'Deletion completed; credential cache cleanup needs retry',
      503,
      { deletionCompleted: true },
    )
}
async function softDelete(sql: DeletionTransaction, id: string, actorId: string) {
  const owners = await sql<
    { user_id: string }[]
  >`select user_id from member where organization_id=${id} and role='owner'`
  await sql`update organization set deleted_at=now(),updated_at=now() where id=${id}`
  await sql`update invitation set status='canceled',updated_at=now() where organization_id=${id} and status='pending'`
  // metadata is text in the installed API key schema. Parse without a SQL JSON cast so malformed
  // unrelated metadata cannot prevent deleting a workspace.
  const keys = await sql<
    { id: string; metadata: string | null }[]
  >`select id,metadata from apikey where enabled=true`
  for (const key of keys) {
    let metadata: { workspace_id?: string; workspaceId?: string } | null
    try {
      metadata = key.metadata ? JSON.parse(key.metadata) : null
    } catch {
      continue
    }
    if (metadata?.workspace_id === id || metadata?.workspaceId === id)
      await sql`update apikey set enabled=false,updated_at=now() where id=${key.id}`
  }
  const sessions = await sql<
    { token: string }[]
  >`update session set active_organization_id=null,updated_at=now() where active_organization_id=${id} returning token`
  await sql`delete from member where organization_id=${id}`
  await sql`insert into audit_log (id,actor_user_id,workspace_id,action,target_type,target_id,meta)
    values (${newId()},${actorId},${id},'workspace.deleted','organization',${id},${JSON.stringify({ originalOwnerUserIds: owners.map((owner) => owner.user_id) })}::jsonb)`
  return sessions.map((session) => session.token)
}
export async function deleteTeamWorkspace(options: Options & { readonly workspaceId: string }) {
  const fresh = await requireFreshSession(options)
  const workspaceId = z.uuid().parse(options.workspaceId)
  const workspace = await options.db.query.organization.findFirst({
    where: (o, { eq, and, isNull }) => and(eq(o.id, workspaceId), isNull(o.deletedAt)),
    with: { members: true },
  })
  if (!workspace) fail('WORKSPACE_NOT_FOUND', 'Workspace not found', 404)
  if (workspace.isPersonal)
    fail('PERSONAL_WORKSPACE', 'Delete your account to delete the personal workspace')
  if (
    !workspace.members.some((member) => member.userId === fresh.user.id && member.role === 'owner')
  )
    fail('WORKSPACE_PERMISSION', 'Only owners can delete a team workspace')
  const context = { db: options.db, actorUserId: fresh.user.id, workspaceIds: [workspaceId] }
  const registered = [...steps.workspace]
  for (const step of registered) await step.before?.(context)
  const keys = await options.db.$client.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${fresh.user.id}`},0))`
    await sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspaceId}`},0))`
    await freshInTransaction(sql, fresh.session.token, false)
    const [workspace] = await sql<{ is_personal: boolean; role: string }[]>`
      select o.is_personal,m.role from organization o join member m on m.organization_id=o.id
      where o.id=${workspaceId} and o.deleted_at is null and m.user_id=${fresh.user.id}`
    if (!workspace) fail('WORKSPACE_NOT_FOUND', 'Workspace not found', 404)
    if (workspace.is_personal)
      fail('PERSONAL_WORKSPACE', 'Delete your account to delete the personal workspace')
    if (workspace.role !== 'owner')
      fail('WORKSPACE_PERMISSION', 'Only owners can delete a team workspace')
    for (const step of registered) await step.execute?.(context, sql)
    return softDelete(sql, workspaceId, fresh.user.id)
  })
  await clearKv(options.kv, keys)
  return { deleted: true }
}
/** Installed Better Auth 1.7.7 uses plain verification identifiers by default. */
function belongsToUser(row: { identifier: string; value: string }, id: string, email: string) {
  if (row.value === id) return true // password reset / two factor challenges
  if (
    ['sign-in', 'email-verification', 'forget-password'].some(
      (type) => row.identifier === `${type}-otp-${email}`,
    )
  )
    return true
  if (row.identifier.startsWith(`change-email-otp-${email}-`)) return true
  if (row.identifier.startsWith('magic-link:')) {
    try {
      return JSON.parse(row.value).email?.toLowerCase() === email.toLowerCase()
    } catch {
      return false
    }
  }
  return false
}
export async function deleteAccount(options: Options) {
  const fresh = await requireFreshSession(options)
  if (fresh.session.impersonatedBy || Date.now() - fresh.session.createdAt.getTime() > 600000)
    fail('REAUTHENTICATION_REQUIRED', 'Sign out and sign in again within ten minutes')
  const context = { db: options.db, actorUserId: fresh.user.id, workspaceIds: [fresh.user.id] }
  const registered = [...steps.account]
  for (const step of registered) await step.before?.(context)
  const keys = await options.db.$client.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${fresh.user.id}`},0))`
    const current = await freshInTransaction(sql, fresh.session.token, true)
    const workspaces = await sql<
      { id: string }[]
    >`select organization_id as id from member where user_id=${current.id} order by organization_id`
    for (const workspace of workspaces)
      await sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspace.id}`},0))`
    const blocked = await sql<{ id: string; name: string; slug: string }[]>`
      select o.id,o.name,o.slug from organization o join member m on m.organization_id=o.id
      where m.user_id=${current.id} and m.role='owner' and not o.is_personal and o.deleted_at is null
      and not exists(select 1 from member other where other.organization_id=o.id and other.role='owner' and other.user_id<>${current.id})`
    if (blocked.length)
      fail('SOLE_WORKSPACE_OWNER', 'Transfer or delete these workspaces first', 409, {
        workspaces: blocked,
      })
    for (const step of registered) await step.execute?.(context, sql)
    const personal = await sql<
      { id: string }[]
    >`select o.id from organization o join member m on m.organization_id=o.id where m.user_id=${current.id} and o.is_personal and o.deleted_at is null`
    const cacheKeys: string[] = [`active-sessions-${current.id}`]
    for (const workspace of personal)
      cacheKeys.push(...(await softDelete(sql, workspace.id, current.id)))
    const sessions = await sql<
      { token: string }[]
    >`delete from session where user_id=${current.id} returning token`
    cacheKeys.push(...sessions.map((session) => session.token))
    const verification = await sql<
      { id: string; identifier: string; value: string }[]
    >`select id,identifier,value from verification`
    const owned = verification.filter((row) => belongsToUser(row, current.id, current.email))
    for (const row of owned) {
      await sql`delete from verification where id=${row.id}`
      cacheKeys.push(`verification:${row.identifier}`)
    }
    await sql`delete from account where user_id=${current.id}`
    await sql`delete from two_factor where user_id=${current.id}`
    await sql`delete from apikey where reference_id=${current.id}`
    await sql`delete from member where user_id=${current.id}`
    await sql`update invitation set status='canceled',updated_at=now() where status='pending' and (inviter_id=${current.id} or lower(email)=lower(${current.email}))`
    await sql`update "user" set email=${`deleted+${current.id}@invalid`},name='',image=null,locale=null,timezone=null,email_verified=false,two_factor_enabled=false,banned=true,ban_reason='Account deleted',ban_expires=null,updated_at=now() where id=${current.id}`
    await sql`insert into audit_log (id,actor_user_id,action,target_type,target_id) values (${newId()},${current.id},'account.deleted','user',${current.id})`
    return cacheKeys
  })
  await clearKv(options.kv, keys)
  return { deleted: true }
}
/** Mount before the native organization plugin. The HTTP endpoints validate signed cookies in DB. */
export function deletionPlugin(db: Database, kv?: KvStore) {
  const endpoint = (kind: DeletionKind) =>
    createAuthEndpoint(
      `/deletion/${kind}`,
      {
        method: 'POST',
        body: kind === 'workspace' ? z.object({ workspaceId: z.uuid() }) : z.object({}),
        requireHeaders: true,
      },
      async (ctx) => {
        try {
          const options = {
            db,
            kv,
            headers: ctx.headers,
            auth: { $context: Promise.resolve(ctx.context) },
          }
          return ctx.json(
            kind === 'account'
              ? await deleteAccount(options)
              : await deleteTeamWorkspace({
                  ...options,
                  workspaceId: (ctx.body as unknown as { workspaceId: string }).workspaceId,
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
                  : error.status === 503
                    ? 'SERVICE_UNAVAILABLE'
                    : 'FORBIDDEN',
            { code: error.code, message: error.message, ...error.details },
          )
        }
      },
    )
  return {
    id: 'deletion',
    endpoints: { deleteAccount: endpoint('account'), deleteWorkspace: endpoint('workspace') },
  } satisfies BetterAuthPlugin
}
