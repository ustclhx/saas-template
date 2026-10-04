import type { ResolveMaxSeats } from '@saas/auth'
import { type Database, invitation, member, scoped, user } from '@saas/db'
import { eq } from 'drizzle-orm'

/** P2 replaces this resolver with persisted entitlements; null means unlimited. */
export const resolveWorkspaceMaxSeats: ResolveMaxSeats = async () => null

export async function workspaceMembers(db: Database, workspaceId: string) {
  return scoped(db, workspaceId)
    .select(member, {
      fields: {
        id: member.id,
        userId: member.userId,
        role: member.role,
        name: user.name,
        email: user.email,
      },
    })
    .innerJoin(user, eq(member.userId, user.id))
}

export async function workspaceInvitations(db: Database, workspaceId: string) {
  return scoped(db, workspaceId).select(invitation)
}

export async function userWorkspaces(db: Database, userId: string) {
  const memberships = await db.query.member.findMany({ where: (m, { eq }) => eq(m.userId, userId) })
  const spaces = await Promise.all(
    memberships.map((m) =>
      db.query.organization.findFirst({ where: (o, { eq }) => eq(o.id, m.organizationId) }),
    ),
  )
  return spaces.flatMap((o) =>
    o && !o.deletedAt ? [{ id: o.id, name: o.name, slug: o.slug, isPersonal: o.isPersonal }] : [],
  )
}
export async function recipientInvitation(
  db: Database,
  id: string,
  email: string,
  emailVerified: boolean,
) {
  const invite = await db.query.invitation.findFirst({ where: (i, { eq }) => eq(i.id, id) })
  if (!invite) return { error: 'INVITATION_INVALID' } as const
  if (invite.email.toLowerCase() !== email.toLowerCase())
    return { error: 'INVITATION_RECIPIENT' } as const
  if (invite.status !== 'pending' || invite.expiresAt <= new Date())
    return { error: 'INVITATION_INVALID' } as const
  if (!emailVerified) return { verifyRequired: true, email, id: invite.id } as const
  const workspace = await db.query.organization.findFirst({
    where: (o, { eq }) => eq(o.id, invite.organizationId),
  })
  if (!workspace || workspace.deletedAt) return { error: 'INVITATION_INVALID' } as const
  return {
    invitation: { id: invite.id, role: invite.role },
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
  } as const
}
