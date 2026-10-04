import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cookieHeader, setup, signUpBody, testUsers } from './helpers.ts'

const users = testUsers('teams')
beforeAll(() => users.start())
afterAll(() => users.cleanup())
async function actor(app: ReturnType<typeof setup>, name: string) {
  const address = users.email(name)
  const response = await app.post('/sign-up/email', signUpBody(address))
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  return { id: user.id, email: address, cookie: cookieHeader(response) }
}
async function team(app: ReturnType<typeof setup>, cookie: string, suffix: string) {
  const response = await app.post(
    '/organization/create',
    { name: 'Team', slug: `team-${suffix}-${Date.now()}` },
    { cookie },
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { id: string }
  users.createdOrgs.push(body.id)
  return body.id
}
describe('native organization admission', () => {
  it('disables every team write while preserving existing team reads', async () => {
    const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: true } } })
    const owner = await actor(app, 'owner')
    const organizationId = await team(app, owner.cookie, 'read')
    const off = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: false } } })
    expect((await off.get('/organization/list', { cookie: owner.cookie })).status).toBe(200)
    for (const path of [
      'create',
      'invite-member',
      'accept-invitation',
      'cancel-invitation',
      'update',
      'remove-member',
      'update-member-role',
      'leave',
      'transfer-owner',
    ]) {
      const response = await off.post(
        `/organization/${path}`,
        {
          name: 'Other',
          slug: 'other-team',
          organizationId,
          invitationId: owner.id,
          memberId: owner.id,
          memberIdOrEmail: owner.id,
          role: 'admin',
          data: { name: 'Changed' },
        },
        { cookie: owner.cookie },
      )
      expect(response.status, path).toBe(403)
    }
  })
  it('rejects personal membership changes and reserved slugs', async () => {
    const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: true } } })
    const owner = await actor(app, 'personal')
    expect(
      (
        await app.post(
          '/organization/invite-member',
          { organizationId: owner.id, email: users.email('guest'), role: 'member' },
          { cookie: owner.cookie },
        )
      ).status,
    ).toBe(403)
    for (const slug of ['admin', 'api', 'app', 'Bad_Name', 'u-personal']) {
      expect(
        (await app.post('/organization/create', { name: 'Team', slug }, { cookie: owner.cookie }))
          .status,
      ).toBe(400)
    }
  })
  it('serializes concurrent owned-workspace creation', async () => {
    const app = setup({
      config: {
        auth: { turnstile: false },
        tenancy: { multiTenant: true, maxWorkspacesPerUser: 1 },
      },
    })
    const owner = await actor(app, 'limit')
    const responses = await Promise.all(
      ['one', 'two'].map((suffix) =>
        app.post(
          '/organization/create',
          { name: 'Team', slug: `limit-${suffix}-${Date.now()}` },
          { cookie: owner.cookie },
        ),
      ),
    )
    expect(responses.map((r) => r.status).sort()).toEqual([200, 403])
    for (const response of responses)
      if (response.status === 200)
        users.createdOrgs.push(((await response.json()) as { id: string }).id)
  })
  it('allows only one concurrent acceptance of the final seat', async () => {
    const app = setup({
      config: { auth: { turnstile: false }, tenancy: { multiTenant: true } },
      maxSeats: 2,
    })
    const owner = await actor(app, 'seat-owner')
    const one = await actor(app, 'one')
    const two = await actor(app, 'two')
    const organizationId = await team(app, owner.cookie, 'seat')
    const invitations: string[] = []
    for (const guest of [one, two]) {
      const response = await app.post(
        '/organization/invite-member',
        { organizationId, email: guest.email, role: 'member' },
        { cookie: owner.cookie },
      )
      expect(response.status).toBe(200)
      invitations.push(((await response.json()) as { id: string }).id)
    }
    expect(app.sent.filter((m) => m.type === 'invitation')).toHaveLength(2)
    const results = await Promise.all(
      [one, two].map((guest, index) =>
        app.post(
          '/organization/accept-invitation',
          { invitationId: invitations[index] },
          { cookie: guest.cookie },
        ),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual([200, 403])
    expect(
      (
        await app.post(
          '/organization/invite-member',
          { organizationId, email: users.email('full'), role: 'member' },
          { cookie: owner.cookie },
        )
      ).status,
    ).toBe(403)
  })
})

it('enforces roles, recipient identity, cancellation, last-owner and atomic transfer', async () => {
  const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: true } } })
  const owner = await actor(app, 'matrix-owner')
  const admin = await actor(app, 'matrix-admin')
  const member = await actor(app, 'matrix-member')
  const outsider = await actor(app, 'matrix-outsider')
  const organizationId = await team(app, owner.cookie, 'matrix')
  for (const [guest, role] of [
    [admin, 'admin'],
    [member, 'member'],
  ] as const) {
    const invitation = await app.post(
      '/organization/invite-member',
      { organizationId, email: guest.email, role },
      { cookie: owner.cookie },
    )
    const { id } = (await invitation.json()) as { id: string }
    expect(
      (
        await app.post(
          '/organization/accept-invitation',
          { invitationId: id },
          { cookie: outsider.cookie },
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.post(
          '/organization/accept-invitation',
          { invitationId: id },
          { cookie: guest.cookie },
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await app.post(
          '/organization/accept-invitation',
          { invitationId: id },
          { cookie: guest.cookie },
        )
      ).status,
    ).toBe(403)
  }
  const memberships = await app.db.query.member.findMany({
    where: (m, { eq }) => eq(m.organizationId, organizationId),
  })
  const ownerMember = memberships.find((m) => m.userId === owner.id)
  const adminMember = memberships.find((m) => m.userId === admin.id)
  const memberRow = memberships.find((m) => m.userId === member.id)
  expect(
    (
      await app.post(
        '/organization/remove-member',
        { organizationId, memberIdOrEmail: memberRow?.id },
        { cookie: member.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.post(
        '/organization/remove-member',
        { organizationId, memberIdOrEmail: ownerMember?.id },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.post(
        '/organization/update-member-role',
        { organizationId, memberId: memberRow?.id, role: 'owner' },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (await app.post('/organization/leave', { organizationId }, { cookie: owner.cookie })).status,
  ).toBe(403)
  const invitation = await app.post(
    '/organization/invite-member',
    { organizationId, email: outsider.email, role: 'member' },
    { cookie: admin.cookie },
  )
  const { id } = (await invitation.json()) as { id: string }
  expect(
    (
      await app.post(
        '/organization/cancel-invitation',
        { invitationId: id },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await app.post(
        '/organization/accept-invitation',
        { invitationId: id },
        { cookie: outsider.cookie },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.post(
        '/organization/transfer-owner',
        { organizationId, memberId: adminMember?.id },
        { cookie: owner.cookie },
      )
    ).status,
  ).toBe(200)
  const transferred = await app.db.query.member.findMany({
    where: (m, { eq }) => eq(m.organizationId, organizationId),
  })
  expect(transferred.find((m) => m.userId === owner.id)?.role).toBe('admin')
  expect(transferred.find((m) => m.userId === admin.id)?.role).toBe('owner')
  expect(
    (
      await app.post(
        '/organization/remove-member',
        { organizationId, memberIdOrEmail: memberRow?.id },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await app.get(`/organization/get-full-organization?organizationId=${organizationId}`, {
        cookie: member.cookie,
      })
    ).status,
  ).toBeGreaterThanOrEqual(400)
  expect(
    (
      await app.post(
        '/organization/remove-member',
        { organizationId: outsider.id, memberIdOrEmail: adminMember?.id },
        { cookie: admin.cookie },
      )
    ).status,
  ).toBe(404)
})

it('rejects expired invitations and server-only native admission bypasses', async () => {
  const app = setup({ config: { auth: { turnstile: false }, tenancy: { multiTenant: true } } })
  const owner = await actor(app, 'expiry-owner')
  const guest = await actor(app, 'expiry-guest')
  const organizationId = await team(app, owner.cookie, 'expiry')
  const response = await app.post(
    '/organization/invite-member',
    { organizationId, email: guest.email, role: 'member' },
    { cookie: owner.cookie },
  )
  const { id } = (await response.json()) as { id: string }
  await app.db.$client`update invitation set expires_at=now()-interval '1 second' where id=${id}`
  expect(
    (
      await app.post(
        '/organization/accept-invitation',
        { invitationId: id },
        { cookie: guest.cookie },
      )
    ).status,
  ).toBe(403)
  await expect(
    app.auth.api.addMember({ body: { organizationId, userId: guest.id, role: 'member' } }),
  ).rejects.toMatchObject({ status: 'FORBIDDEN' })
  await expect(
    app.auth.api.createOrganization({
      body: { name: 'Bypass', slug: 'bypass-team', userId: owner.id },
    }),
  ).rejects.toMatchObject({ status: 'FORBIDDEN' })
})
