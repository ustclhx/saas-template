import { createHmac } from 'node:crypto'
import { cleanupExpiredWorkspaces, deleteAccount, deleteTeamWorkspace } from '@saas/auth'
import {
  createDb,
  member,
  organization,
  scoped,
  session,
  studioPublication,
  studioReport,
  studioWork,
} from '@saas/db'
import { newId } from '@saas/shared'
import { BULK_JOB_TIME_FLOOR } from '@saas/shared/bulk-job'
import { cleanupFiles } from '@saas/storage'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { getPublicWorkMedia } from '../src/web/public-works.ts'
import { deleteStudioWork } from '../src/web/works-delete.server.ts'
import { registerStudioDeletionSteps } from '../src/web/works-delete-cleanup.ts'
import {
  deleteStudioFixtures,
  seedStudioOutput,
  seedStudioWorkspace,
  testDb,
} from './works-fixtures.ts'

const kinds = ['image'] as const
let db: ReturnType<typeof testDb>
const workspaces: { userId: string; workspaceId: string }[] = []

beforeAll(() => {
  db = testDb()
})

afterEach(async () => {
  if (!workspaces.length) return
  const fixtures = workspaces.splice(0)
  const workspaceIds = fixtures.map(({ workspaceId }) => workspaceId)
  const userIds = fixtures.map(({ userId }) => userId)
  const migrationUrl = process.env.MIGRATION_DATABASE_URL
  if (!migrationUrl) throw new Error('未配置 Studio 集成测试迁移连接')
  const migrator = createDb(migrationUrl)
  try {
    const sql = migrator.$client
    await sql`delete from audit_log where workspace_id in ${sql(workspaceIds)} or actor_user_id in ${sql(userIds)}`
  } finally {
    await migrator.close()
  }
  await db.$client`delete from session where user_id in ${db.$client(userIds)}`
  await deleteStudioFixtures(db, workspaceIds)
  // 删号与删空间已清空成员关系，共用夹具无法从成员表找回这些账号。
  await db.$client`delete from "user" where id in ${db.$client(userIds)}`
})

afterAll(async () => db?.close())

async function workspace(options?: Parameters<typeof seedStudioWorkspace>[1]) {
  const fixture = await seedStudioWorkspace(db, options)
  workspaces.push(fixture)
  return fixture
}

async function publishedOutput(
  owner: { workspaceId: string; userId: string },
  publisherId = owner.userId,
) {
  const output = await seedStudioOutput(db, owner)
  const id = newId()
  const work = { id, slug: `work-${id}`, site: 'studio-deletion-test', version: 7 }
  await scoped(db, owner.workspaceId).insert(studioWork, {
    ...work,
    userId: publisherId,
    fileId: output.fileId,
    taskId: output.taskId,
    kind: 'image',
    title: 'Published work',
    modelKey: 'test',
  })
  await db.insert(studioReport).values({ workId: id, reporterKey: 'test', reason: 'spam' })
  return { ...output, work }
}

function workRow(id: string) {
  return db.query.studioWork.findFirst({ where: eq(studioWork.id, id) })
}

function reports(id: string) {
  return db.query.studioReport.findMany({ where: eq(studioReport.workId, id) })
}

async function authOptions(userId: string) {
  const token = newId()
  const secret = 'studio-integration-test-secret-only'
  const signature = createHmac('sha256', secret).update(token).digest('base64')
  await db.insert(session).values({
    id: newId(),
    userId,
    token,
    expiresAt: new Date(Date.now() + 60_000),
  })
  return {
    db,
    auth: {
      $context: Promise.resolve({ secret, authCookies: { sessionToken: { name: 'test' } } }),
    },
    headers: new Headers({ cookie: `test=${encodeURIComponent(`${token}.${signature}`)}` }),
  }
}

describe('Studio 作品删除', () => {
  it('提交后举报和公开版本立即失效，存储失败可按同一文件重试', async () => {
    const own = await workspace()
    const other = await workspace()
    const { fileId, r2Key, work } = await publishedOutput(own)
    const remove = vi.fn(async (_key: string | string[]) => {}).mockRejectedValueOnce(new Error())
    const storage = { delete: remove }
    const invalidate = vi.fn()
    const actor = { userId: own.userId, role: 'owner', workspaceReadOnly: false }
    const input = { workspaceId: own.workspaceId, actor, fileId, kinds }
    await expect(
      deleteStudioWork(db, storage, {
        ...input,
        workspaceId: other.workspaceId,
        actor: { ...actor, userId: other.userId },
      }),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      deleteStudioWork(db, storage, { ...input, actor: { ...actor, workspaceReadOnly: true } }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_READ_ONLY' })
    expect(remove).not.toHaveBeenCalled()

    await expect(deleteStudioWork(db, storage, input, { invalidate })).rejects.toMatchObject({
      code: 'STUDIO_OBJECT_DELETE_FAILED',
    })
    expect(await workRow(work.id)).toBeUndefined()
    expect(await reports(work.id)).toEqual([])
    expect(
      await getPublicWorkMedia(db, {
        workId: work.id,
        site: work.site,
        version: work.version,
        kinds,
      }),
    ).toBeNull()
    const tombstone = await db.query.file.findFirst({ where: (f, { eq }) => eq(f.id, fileId) })
    expect(tombstone?.deletedAt).toBeInstanceOf(Date)
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(work)

    await expect(deleteStudioWork(db, storage, input, { invalidate })).resolves.toEqual({
      deleted: true,
    })
    expect(remove.mock.calls).toEqual([[r2Key], [r2Key]])
    expect(invalidate).toHaveBeenCalledTimes(1)
    const retried = await db.query.file.findFirst({ where: (f, { eq }) => eq(f.id, fileId) })
    expect(retried?.deletedAt).toEqual(tombstone?.deletedAt)
  })

  it('真实删号与删空间入口先删除作品和举报，输出继续按保留策略处理', async () => {
    const actor = await workspace({ isPersonal: true })
    const team = await workspace()
    await scoped(db, team.workspaceId).insert(member, {
      id: newId(),
      userId: actor.userId,
      role: 'member',
    })
    const personalWork = await publishedOutput(actor)
    const byActor = await publishedOutput(team, actor.userId)
    const onActorTask = await publishedOutput(
      { workspaceId: team.workspaceId, userId: actor.userId },
      team.userId,
    )
    const unaffected = await publishedOutput(team)
    await db.insert(studioPublication).values({ userId: actor.userId, publishedAt: new Date() })
    const invalidate = vi.fn()
    onTestFinished(registerStudioDeletionSteps(invalidate))

    await expect(deleteAccount(await authOptions(actor.userId))).resolves.toEqual({ deleted: true })
    for (const { work, fileId } of [personalWork, byActor, onActorTask]) {
      expect(await workRow(work.id)).toBeUndefined()
      expect(await reports(work.id)).toEqual([])
      const output = await db.query.file.findFirst({ where: (f, { eq }) => eq(f.id, fileId) })
      expect(output).toMatchObject({ deletedAt: null })
      expect(invalidate).toHaveBeenCalledWith(work)
    }
    expect(await workRow(unaffected.work.id)).toBeDefined()
    expect(
      await db.query.studioPublication.findMany({
        where: eq(studioPublication.userId, actor.userId),
      }),
    ).toEqual([])

    await expect(
      deleteTeamWorkspace({ ...(await authOptions(team.userId)), workspaceId: team.workspaceId }),
    ).resolves.toEqual({ deleted: true })
    expect(await workRow(unaffected.work.id)).toBeUndefined()
    expect(await reports(unaffected.work.id)).toEqual([])
    expect(invalidate).toHaveBeenLastCalledWith(unaffected.work)
    const output = await db.query.file.findFirst({
      where: (f, { eq }) => eq(f.id, unaffected.fileId),
    })
    expect(output).toMatchObject({ deletedAt: null, sourceTaskId: unaffected.taskId })
  })

  it('未注册插件时保留期清理仍按作品、任务、对象顺序解除引用', async () => {
    const owner = await workspace()
    const { work, fileId, taskId, r2Key } = await publishedOutput(owner)
    const unlinked = await seedStudioOutput(db, owner)
    await db
      .update(organization)
      .set({ deletedAt: BULK_JOB_TIME_FLOOR })
      .where(eq(organization.id, owner.workspaceId))
    const retentionDays = Math.floor((Date.now() - BULK_JOB_TIME_FLOOR.getTime()) / 86_400_000) - 1
    const options = { retentionDays, workspaceCap: 1 }
    const storage = {
      delete: vi.fn(async (key: string | string[]) => {
        if (key !== r2Key && key !== unlinked.r2Key) throw new Error('Fixture object only')
      }),
    }

    await cleanupFiles(db, storage, { workspaceRetentionDays: retentionDays, workspaceCap: 1 })
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(unlinked.r2Key)
    expect(await workRow(work.id)).toBeDefined()
    expect(await cleanupExpiredWorkspaces(db, options)).toMatchObject({ failed: 0 })
    expect(await workRow(work.id)).toBeUndefined()
    expect(await reports(work.id)).toEqual([])
    expect(
      await db.query.aiTask.findFirst({ where: (t, { eq }) => eq(t.id, taskId) }),
    ).toBeUndefined()

    const fileCleanupOptions = { workspaceRetentionDays: retentionDays, workspaceCap: 1 }
    await cleanupFiles(db, storage, fileCleanupOptions)
    await cleanupFiles(db, storage, fileCleanupOptions)
    expect(storage.delete.mock.calls).toEqual([[unlinked.r2Key], [r2Key]])
    expect(
      await db.query.file.findFirst({ where: (f, { eq }) => eq(f.id, fileId) }),
    ).toBeUndefined()
  })
})
