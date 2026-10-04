import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteAccount, deleteTeamWorkspace, registerDeletionStep } from '../src/deletion.ts'
import { requireFreshSession } from '../src/fresh-session.ts'
import { cookieHeader, PASSWORD, setup, signUpBody, testUsers } from './helpers.ts'

const users = testUsers('deletion')
const deleted: { id: string; email: string }[] = []
beforeAll(() => users.start())
afterAll(async () => {
  const sql = setup().db.$client
  for (const user of deleted) {
    await sql`delete from audit_log where actor_user_id=${user.id} or workspace_id=${user.id}`
    await sql`update "user" set email=${users.email('cleanup')} where id=${user.id}`
  }
  for (const id of users.createdOrgs) await sql`delete from audit_log where workspace_id=${id}`
  await users.cleanup()
})
const app = () =>
  setup({
    env: { RL_AUTH: { limit: async () => ({ success: true }) } },
    config: { auth: { turnstile: false, magicLink: true }, tenancy: { multiTenant: true } },
  })
async function actor(a: ReturnType<typeof app>, name: string) {
  const email = users.email(name)
  const response = await a.post('/sign-up/email', signUpBody(email))
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  const cookie = cookieHeader(response)
  return {
    id: user.id,
    email,
    cookie,
    options: { auth: a.auth, db: a.db, headers: new Headers({ cookie }), kv: env.CACHE },
  }
}
async function team(a: ReturnType<typeof app>, owner: Awaited<ReturnType<typeof actor>>) {
  const response = await a.post(
    '/organization/create',
    { name: 'Deletion team', slug: `delete-${owner.id}` },
    { cookie: owner.cookie },
  )
  expect(response.status).toBe(200)
  const { id } = (await response.json()) as { id: string }
  users.createdOrgs.push(id)
  return id
}
describe('atomic deletion in workerd', () => {
  it('requires a DB session and recent real login, ignoring updated_at', async () => {
    const a = app()
    const owner = await actor(a, 'old')
    await a.db
      .$client`update session set created_at=now()-interval '1 day',updated_at=now() where user_id=${owner.id}`
    await expect(deleteAccount(owner.options)).rejects.toMatchObject({
      code: 'REAUTHENTICATION_REQUIRED',
    })
    await a.db.$client`delete from session where user_id=${owner.id}`
    await expect(deleteAccount(owner.options)).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
  })
  it('blocks sole owners, then soft deletes a team and resets active sessions', async () => {
    const a = app()
    const owner = await actor(a, 'sole')
    const id = await team(a, owner)
    await expect(deleteAccount(owner.options)).rejects.toMatchObject({
      code: 'SOLE_WORKSPACE_OWNER',
      details: { workspaces: [{ id }] },
    })
    await a.db.$client`update session set active_organization_id=${id} where user_id=${owner.id}`
    await deleteTeamWorkspace({ ...owner.options, workspaceId: id })
    expect(
      await a.db.query.member.findFirst({ where: (m, { eq }) => eq(m.organizationId, id) }),
    ).toBeUndefined()
    expect(
      (await a.db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, id) }))?.deletedAt,
    ).toBeTruthy()
    expect(
      (await a.db.query.session.findFirst({ where: (s, { eq }) => eq(s.userId, owner.id) }))
        ?.activeOrganizationId,
    ).toBeNull()
    await expect(deleteTeamWorkspace({ ...owner.options, workspaceId: id })).rejects.toMatchObject({
      status: 404,
    })
  })
  it('anonymizes and removes only owned credentials, invalidates old links, allows new email registration', async () => {
    const a = app()
    const owner = await actor(a, 'credentials')
    const other = await actor(a, 'other')
    await a.post('/email-otp/send-verification-otp', { email: owner.email, type: 'sign-in' })
    const otp = a.sent.find((mail) => mail.type === 'otp' && mail.to === owner.email)
    await a.post('/sign-in/magic-link', { email: owner.email, callbackURL: '/account' })
    const magic = a.sent.find((mail) => mail.type === 'magic-link')
    await a.post('/request-password-reset', { email: owner.email, redirectTo: '/reset-password' })
    const reset = a.sent.find((mail) => mail.type === 'reset-password')
    await a.post('/email-otp/send-verification-otp', { email: other.email, type: 'sign-in' })
    const verification = await a.db.query.verification.findMany()
    deleted.push(owner)
    await deleteAccount(owner.options)
    const row = await a.db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, owner.id) })
    expect(row).toMatchObject({
      email: `deleted+${owner.id}@invalid`,
      name: '',
      image: null,
      locale: null,
      timezone: null,
      banned: true,
      banExpires: null,
    })
    await expect(requireFreshSession(owner.options)).rejects.toMatchObject({
      code: 'SESSION_REQUIRED',
    })
    expect(await env.CACHE.get(`auth:active-sessions-${owner.id}`)).toBeNull()
    expect(
      await a.db.query.account.findFirst({ where: (u, { eq }) => eq(u.userId, owner.id) }),
    ).toBeUndefined()
    expect(
      (await a.post('/sign-in/email', { email: owner.email, password: PASSWORD })).status,
    ).not.toBe(200)
    const replacement = await a.post('/sign-up/email', signUpBody(owner.email))
    expect(replacement.status).toBe(200)
    expect(((await replacement.json()) as { user: { id: string } }).user.id).not.toBe(owner.id)
    if (otp?.type === 'otp')
      expect(
        (await a.post('/sign-in/email-otp', { email: owner.email, otp: otp.otp })).status,
      ).not.toBe(200)
    if (magic?.type === 'magic-link') {
      const response = await a.get(magic.url)
      expect(response.headers.get('location')).toContain('error=')
    }
    if (reset?.type === 'reset-password') {
      const token = new URL(reset.url).pathname.split('/').at(-1)
      expect(
        (await a.post('/reset-password', { token, newPassword: 'ChangedPassword123!' })).status,
      ).not.toBe(200)
    }
    const otherVerification = verification.find(
      (v) => v.identifier === `sign-in-otp-${other.email}`,
    )
    expect(otherVerification).toBeTruthy()
    expect(await env.CACHE.get(`auth:verification:${otherVerification?.identifier}`)).not.toBeNull()
  })
  it('lets one of multiple owners leave without deleting the team', async () => {
    const a = app()
    const owner = await actor(a, 'multiple')
    const other = await actor(a, 'remaining')
    const id = await team(a, owner)
    await a.db
      .$client`insert into member (id,organization_id,user_id,role) values (${other.id},${id},${other.id},'owner')`
    deleted.push(owner)
    await deleteAccount(owner.options)
    expect(
      (await a.db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, id) }))?.deletedAt,
    ).toBeNull()
    expect(
      (await a.db.query.member.findMany({ where: (m, { eq }) => eq(m.organizationId, id) })).map(
        (m) => m.userId,
      ),
    ).toEqual([other.id])
  })
  it('runs hooks in order and rolls back when execution refuses', async () => {
    const a = app()
    const owner = await actor(a, 'hooks')
    const id = await team(a, owner)
    const calls: string[] = []
    const dispose = registerDeletionStep('workspace', {
      before: async () => {
        calls.push('before')
      },
      execute: async () => {
        calls.push('execute')
        throw new Error('blocked')
      },
    })
    try {
      await expect(deleteTeamWorkspace({ ...owner.options, workspaceId: id })).rejects.toThrow(
        'blocked',
      )
    } finally {
      dispose()
    }
    expect(calls).toEqual(['before', 'execute'])
    expect(
      (await a.db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, id) }))?.deletedAt,
    ).toBeNull()
  })
})
