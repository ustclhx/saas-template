import {
  aiTask,
  createDb,
  type Database,
  file,
  member,
  organization,
  scoped,
  studioWork,
  user,
} from '@saas/db'
import { newId } from '@saas/shared'
import { eq, inArray } from 'drizzle-orm'
import type { StudioKind } from '../src/kinds.ts'

export function testDb() {
  const url = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
  if (!url) throw new Error('Integration database is unavailable')
  return createDb(url)
}

export async function seedStudioWorkspace(
  db: Database,
  options: { userId?: string; workspaceId?: string; isPersonal?: boolean } = {},
) {
  const userId = options.userId ?? newId()
  const workspaceId = options.workspaceId ?? (options.isPersonal ? userId : newId())
  await db
    .insert(user)
    .values({ id: userId, name: 'Studio test', email: `studio-${userId}@example.test` })
    .onConflictDoNothing({ target: user.id })
  await db.insert(organization).values({
    id: workspaceId,
    name: 'Studio test',
    slug: `studio-${workspaceId}`,
    isPersonal: options.isPersonal ?? false,
  })
  await scoped(db, workspaceId).insert(member, { id: newId(), userId, role: 'owner' })
  return { workspaceId, userId }
}

export async function seedStudioOutput(
  db: Database,
  { workspaceId, userId }: { workspaceId: string; userId: string },
  options: {
    kind?: StudioKind
    status?: 'succeeded' | 'failed' | 'running'
    fileCreatedAt?: Date
    input?: Record<string, unknown>
  } = {},
) {
  const taskId = newId()
  const fileId = newId()
  const kind = options.kind ?? 'image'
  const tenant = scoped(db, workspaceId)
  const r2Key = `ws/${workspaceId}/ai/${taskId}/0`
  await tenant.insert(aiTask, {
    id: taskId,
    userId,
    kind,
    status: options.status ?? 'succeeded',
    modelKey: `studio-fixture-${kind}`,
    provider: 'fixture',
    providerRequestKey: taskId,
    pricing: { mode: 'per_call', credits: 1 },
    input: options.input ?? { params: { prompt: '原始旧提示词' } },
    deadlineAt: new Date(),
  })
  await tenant.insert(file, {
    id: fileId,
    userId,
    purpose: 'ai_output',
    status: 'ready',
    r2Key,
    mime: kind === 'image' ? 'image/webp' : 'video/mp4',
    size: 128,
    width: 640,
    height: 480,
    duration: kind === 'video' ? 2.125 : null,
    sourceTaskId: taskId,
    ...(options.fileCreatedAt && { createdAt: options.fileCreatedAt }),
  })
  return { fileId, taskId, r2Key }
}

export async function deleteStudioFixtures(db: Database, workspaceIds: readonly string[]) {
  const userIds = new Set<string>()
  for (const workspaceId of workspaceIds) {
    const tenant = scoped(db, workspaceId)
    const members = await tenant.select(member, { fields: { userId: member.userId } })
    for (const row of members) userIds.add(row.userId)
    await tenant.delete(studioWork, undefined)
    await tenant.delete(file, undefined)
    await tenant.delete(aiTask, undefined)
    await tenant.delete(member, undefined)
    await db.delete(organization).where(eq(organization.id, workspaceId))
  }
  if (userIds.size) await db.delete(user).where(inArray(user.id, [...userIds]))
}
