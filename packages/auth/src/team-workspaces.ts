import type { TemplateConfig } from '@saas/config'
import type { Database } from '@saas/db'
import { newId } from '@saas/shared'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api'
import { z } from 'zod'
import type { SendAuthEmail } from './email.ts'
import { checkSessionInDatabase } from './fresh-session.ts'

/** P2 supplies the current entitlement; absence means unlimited seats. */
export type ResolveMaxSeats = (workspaceId: string) => Promise<number | null>
const roles = z.enum(['owner', 'admin', 'member'])
const uuid = z.uuid()
const slug = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const reserved = new Set([
  'admin',
  'api',
  'app',
  'account',
  'login',
  'logout',
  'signup',
  'settings',
  'invite',
  'new',
])
function validSlug(value: unknown): string {
  const parsed = slug.safeParse(value)
  if (!parsed.success || reserved.has(parsed.data) || parsed.data.startsWith('u-')) {
    throw APIError.from('BAD_REQUEST', {
      code: 'INVALID_WORKSPACE_SLUG',
      message: 'Invalid or reserved slug',
    })
  }
  return parsed.data
}
function deny(code: string, message: string): never {
  throw APIError.from('FORBIDDEN', { code, message })
}
function missing(): never {
  throw APIError.from('NOT_FOUND', { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' })
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success)
    throw APIError.from('BAD_REQUEST', { code: 'INVALID_INPUT', message: 'Invalid input' })
  return result.data
}
const mutations = new Set([
  'create',
  'invite-member',
  'accept-invitation',
  'cancel-invitation',
  'remove-member',
  'update-member-role',
  'leave',
])
const transferInput = z.object({ organizationId: uuid, memberId: uuid })
const readPosts = new Set(['set-active', 'check-slug', 'has-permission'])

/** Native organization HTTP writes use the same admission checks and SQL transaction. */
export function teamWorkspaces(
  db: Database,
  config: TemplateConfig,
  sendEmail: SendAuthEmail,
  resolveMaxSeats: ResolveMaxSeats = async () => null,
) {
  return {
    id: 'team-workspaces',
    endpoints: {
      transferWorkspaceOwner: createAuthEndpoint(
        '/organization/transfer-owner',
        { method: 'POST', body: transferInput, requireHeaders: true },
        async (ctx) => ctx.json({}),
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => (ctx.path ?? '').startsWith('/organization/'),
          handler: createAuthMiddleware(async (ctx) => {
            const action = (ctx.path ?? '').slice('/organization/'.length)
            if (action === 'check-slug') validSlug(ctx.body?.slug)
            const write = ctx.method === 'POST' && !readPosts.has(action)
            if (!write) return
            if (!config.tenancy.multiTenant)
              deny('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled')
            const token = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            )
            const fresh = token ? await checkSessionInDatabase(db, token) : null
            if (!fresh?.ok)
              throw APIError.from('UNAUTHORIZED', {
                code: 'SESSION_REQUIRED',
                message: 'Sign in required',
              })
            const { user, session } = fresh.value
            const body = ctx.body ?? {}
            if (action === 'create') {
              const input = parse(
                z.object({ name: z.string().trim().min(1).max(100), slug: z.string() }),
                body,
              )
              const requestedSlug = validSlug(input.slug)
              const result = await db.$client.begin(async (sql) => {
                await sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${user.id}`}, 0))`
                const [count] = await sql<
                  { total: number }[]
                >`select count(*)::int as total from member m join organization o on o.id=m.organization_id where m.user_id=${user.id} and m.role='owner' and not o.is_personal and o.deleted_at is null`
                if ((count?.total ?? 0) >= config.tenancy.maxWorkspacesPerUser)
                  deny('WORKSPACE_LIMIT', 'Workspace limit reached')
                // Serialize slug admission too; the database unique constraint remains the final invariant.
                await sql`select pg_advisory_xact_lock(hashtextextended(${`slug:${requestedSlug}`}, 0))`
                if ((await sql`select id from organization where slug=${requestedSlug}`).length)
                  throw APIError.from('BAD_REQUEST', {
                    code: 'SLUG_TAKEN',
                    message: 'Slug already in use',
                  })
                const id = newId()
                const [org] =
                  await sql`insert into organization (id,name,slug,is_personal) values (${id},${input.name},${requestedSlug},false) returning id,name,slug,logo,metadata,is_personal as "isPersonal",deleted_at as "deletedAt",created_at as "createdAt",updated_at as "updatedAt"`
                const [member] =
                  await sql`insert into member (id,organization_id,user_id,role) values (${newId()},${id},${user.id},'owner') returning id,organization_id as "organizationId",user_id as "userId",role,created_at as "createdAt"`
                return { ...org, members: [member] }
              })
              return ctx.json(result)
            }
            let workspaceId = body.organizationId ?? session.activeOrganizationId
            if (action === 'accept-invitation' || action === 'cancel-invitation') {
              const invitationId = parse(uuid, body.invitationId)
              const invitation = await db.query.invitation.findFirst({
                where: (i, { eq }) => eq(i.id, invitationId),
              })
              if (!invitation) missing()
              workspaceId = invitation.organizationId
            }
            workspaceId = parse(uuid, workspaceId)
            const result = await db.$client.begin(async (sql) => {
              await sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspaceId}`}, 0))`
              const [workspace] = await sql<
                { id: string; name: string; isPersonal: boolean; deletedAt: string | null }[]
              >`select id,name,is_personal as "isPersonal",deleted_at as "deletedAt" from organization where id=${workspaceId}`
              if (!workspace || workspace.deletedAt) missing()
              const [actor] = await sql<
                { id: string; role: string }[]
              >`select id,role from member where organization_id=${workspaceId} and user_id=${user.id}`
              if (action !== 'accept-invitation' && !actor) missing()
              if (workspace.isPersonal && action !== 'update')
                deny('PERSONAL_WORKSPACE', 'Personal workspace membership cannot change')
              const checkSeats = async () => {
                const limit = await resolveMaxSeats(workspaceId)
                const [count] = await sql<
                  { total: number }[]
                >`select count(*)::int as total from member where organization_id=${workspaceId}`
                if (limit !== null && (count?.total ?? 0) >= limit)
                  deny('SEATS_FULL', 'Workspace seats are full')
              }
              if (action === 'accept-invitation') {
                const [invite] = await sql<
                  { id: string; email: string; role: string; status: string; expires_at: string }[]
                >`select * from invitation where id=${body.invitationId} and organization_id=${workspaceId}`
                if (invite?.status !== 'pending' || new Date(invite.expires_at) <= new Date())
                  deny('INVITATION_INVALID', 'Invitation expired or unavailable')
                if (invite.email.toLowerCase() !== user.email.toLowerCase())
                  deny('INVITATION_RECIPIENT', 'Invitation belongs to another email')
                if (actor) deny('ALREADY_MEMBER', 'Already a member')
                if (invite.role === 'owner')
                  deny('USE_OWNER_TRANSFER', 'Use transfer ownership to grant ownership')
                await checkSeats()
                const [member] =
                  await sql`insert into member (id,organization_id,user_id,role) values (${newId()},${workspaceId},${user.id},${parse(roles, invite.role)}) returning id,organization_id as "organizationId",user_id as "userId",role,created_at as "createdAt"`
                const [invitation] =
                  await sql`update invitation set status='accepted',updated_at=now() where id=${invite.id} returning id,organization_id as "organizationId",email,role,status,expires_at as "expiresAt"`
                return { member, invitation }
              }
              if (action === 'transfer-owner') {
                if (actor?.role !== 'owner')
                  deny('WORKSPACE_PERMISSION', 'Only owners can transfer ownership')
                const input = parse(transferInput, body)
                const [target] = await sql<
                  { id: string; user_id: string }[]
                >`select id,user_id from member where id=${input.memberId} and organization_id=${workspaceId}`
                if (!target || target.id === actor.id)
                  deny('INVALID_TRANSFER', 'Choose another member')
                await sql`select pg_advisory_xact_lock(hashtextextended(${`owner:${target.user_id}`}, 0))`
                const [owned] = await sql<
                  { total: number }[]
                >`select count(*)::int as total from member m join organization o on o.id=m.organization_id where m.user_id=${target.user_id} and m.role='owner' and not o.is_personal and o.deleted_at is null`
                if ((owned?.total ?? 0) >= config.tenancy.maxWorkspacesPerUser)
                  deny('WORKSPACE_LIMIT', 'New owner workspace limit reached')
                await sql`update member set role='owner',updated_at=now() where id=${target.id}`
                await sql`update member set role='admin',updated_at=now() where id=${actor.id}`
                return { status: true }
              }
              if (action !== 'leave' && actor?.role !== 'owner' && actor?.role !== 'admin')
                deny('WORKSPACE_PERMISSION', 'Member management requires admin or owner')
              if (action === 'invite-member') {
                const input = parse(
                  z.object({ email: z.email(), role: roles.default('member') }),
                  body,
                )
                if (input.role === 'owner')
                  deny('WORKSPACE_PERMISSION', 'Use transfer ownership to grant ownership')
                await checkSeats()
                const [existing] =
                  await sql`select m.id from member m join "user" u on u.id=m.user_id where m.organization_id=${workspaceId} and lower(u.email)=lower(${input.email})`
                if (existing) deny('ALREADY_MEMBER', 'Already a member')
                const [pending] =
                  await sql`select id from invitation where organization_id=${workspaceId} and lower(email)=lower(${input.email}) and status='pending' and expires_at>now()`
                if (pending) deny('INVITATION_EXISTS', 'A pending invitation already exists')
                const [invitation] =
                  await sql`insert into invitation (id,organization_id,email,role,inviter_id,expires_at) values (${newId()},${workspaceId},${input.email.toLowerCase()},${input.role},${user.id},${(new Date(Date.now() + 7 * 86400000)).toISOString()}) returning id,organization_id as "organizationId",email,role,status,inviter_id as "inviterId",expires_at as "expiresAt"`
                return { invitation, workspace }
              }
              if (action === 'cancel-invitation') {
                const [invitation] =
                  await sql`update invitation set status='canceled',updated_at=now() where id=${body.invitationId} and organization_id=${workspaceId} and status='pending' returning id,organization_id as "organizationId",email,role,status,expires_at as "expiresAt"`
                if (!invitation) deny('INVITATION_INVALID', 'Invitation unavailable')
                return { invitation }
              }
              if (
                action === 'remove-member' ||
                action === 'update-member-role' ||
                action === 'leave'
              ) {
                const targetId =
                  action === 'leave' ? actor?.id : (body.memberId ?? body.memberIdOrEmail)
                const [target] = await sql<
                  { id: string; role: string }[]
                >`select m.id,m.role from member m join "user" u on u.id=m.user_id where m.organization_id=${workspaceId} and (m.id::text=${targetId ?? ''} or lower(u.email)=lower(${targetId ?? ''}))`
                if (!target) missing()
                const newRole = action === 'update-member-role' ? parse(roles, body.role) : null
                if (
                  action !== 'leave' &&
                  actor?.role !== 'owner' &&
                  (target.role === 'owner' || newRole === 'owner')
                )
                  deny('WORKSPACE_PERMISSION', 'Only owners can manage ownership')
                if (target.role === 'owner' && newRole !== 'owner') {
                  const [owners] = await sql<
                    { total: number }[]
                  >`select count(*)::int as total from member where organization_id=${workspaceId} and role='owner'`
                  if ((owners?.total ?? 0) <= 1)
                    deny('LAST_OWNER', 'The last owner cannot leave or be demoted')
                }
                if (newRole === 'owner' && target.role !== 'owner')
                  deny('USE_OWNER_TRANSFER', 'Use transfer ownership to grant ownership')
                if (newRole) {
                  const [member] =
                    await sql`update member set role=${newRole},updated_at=now() where id=${target.id} returning id,organization_id as "organizationId",user_id as "userId",role`
                  return { member }
                }
                await sql`delete from member where id=${target.id}`
                return { member: target }
              }
              // Native organization metadata updates retain BA validation/response behavior.
              if (action === 'update') {
                if (body.data?.slug !== undefined) validSlug(body.data.slug)
                return null
              }
              if (!mutations.has(action))
                deny('WORKSPACE_OPERATION_DISABLED', 'Unsupported workspace mutation')
              return null
            })
            if (result && 'workspace' in result && 'invitation' in result) {
              const invitation = result.invitation as { id: string; email: string; role: string }
              await sendEmail({
                type: 'invitation',
                to: invitation.email,
                invitationId: invitation.id,
                workspaceName: result.workspace.name,
                inviterName: user.name,
                role: invitation.role,
              })
              return ctx.json(invitation)
            }
            if (result) return ctx.json(result)
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
