import { file, scoped, studioWork } from '@saas/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { STUDIO_KINDS } from '../src/kinds.ts'
import { publishStudioWork } from '../src/web/publish.ts'
import { listStudioWorks } from '../src/web/works.ts'
import {
  deleteStudioFixtures,
  seedStudioOutput,
  seedStudioWorkspace,
  testDb,
} from './works-fixtures.ts'

const db = testDb()
const workspaceIds: string[] = []
afterAll(async () => {
  try {
    await deleteStudioFixtures(db, workspaceIds)
  } finally {
    await db.close()
  }
})
async function workspace() {
  const result = await seedStudioWorkspace(db)
  workspaceIds.push(result.workspaceId)
  return result
}

describe('Studio 我的作品', () => {
  it('只展示本空间未删除且已成功生成的输出，区分公开审核和私有', async () => {
    const local = await workspace()
    const elsewhere = await workspace()
    const image = await seedStudioOutput(db, local)
    const video = await seedStudioOutput(db, local, { kind: 'video' })
    const unpublished = await seedStudioOutput(db, local)
    const deleted = await seedStudioOutput(db, local)
    const orphaned = await seedStudioOutput(db, local)
    const foreign = await seedStudioOutput(db, elsewhere)
    await seedStudioOutput(db, local, { status: 'failed' })
    const tenant = scoped(db, local.workspaceId)
    await tenant.updateById(file, deleted.fileId, { deletedAt: new Date() })
    await tenant.updateById(file, orphaned.fileId, { sourceTaskId: foreign.taskId })
    const filter = { workspaceId: local.workspaceId, kinds: STUDIO_KINDS }
    const actor = { userId: local.userId, role: 'owner', workspaceReadOnly: false }
    const work = await publishStudioWork(db, {
      ...filter,
      actor,
      fileId: image.fileId,
      title: 'A view',
      showPrompt: false,
    })
    await tenant.updateById(studioWork, work.id, {
      moderation: 'removed',
      removalReason: '侵权',
    })

    const results = await listStudioWorks(db, { ...filter, visibility: 'public' })
    expect(results.works).toMatchObject([
      { fileId: image.fileId, work: { id: work.id, moderation: 'removed', removalReason: '侵权' } },
    ])
    expect(
      (await listStudioWorks(db, { ...filter, visibility: 'private' })).works.map(
        ({ fileId }) => fileId,
      ),
    ).toEqual([unpublished.fileId, video.fileId])
    expect((await listStudioWorks(db, { ...filter, kind: 'video' })).works).toMatchObject([
      { fileId: video.fileId, kind: 'video', work: null },
    ])
    await expect(
      listStudioWorks(db, { ...filter, kind: 'video', kinds: ['image'] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('按生成时间倒序且游标跨微秒与同一时间戳时不漏行', async () => {
    const local = await workspace()
    const createdAt = new Date('2026-11-25T08:00:00Z')
    const first = await seedStudioOutput(db, local, { fileCreatedAt: createdAt })
    const tie = await seedStudioOutput(db, local, { fileCreatedAt: createdAt })
    const microsecond = await seedStudioOutput(db, local, { fileCreatedAt: createdAt })
    await scoped(db, local.workspaceId).update(
      file,
      {
        createdAt: sql`${file.createdAt} + interval '1 microsecond'`,
      },
      eq(file.id, microsecond.fileId),
    )

    const input = { workspaceId: local.workspaceId, kinds: STUDIO_KINDS, limit: 1 }
    const page1 = await listStudioWorks(db, input)
    const page2 = await listStudioWorks(db, { ...input, cursor: page1.nextCursor ?? '' })
    const page3 = await listStudioWorks(db, { ...input, cursor: page2.nextCursor ?? '' })
    expect([page1.works[0]?.fileId, page2.works[0]?.fileId, page3.works[0]?.fileId]).toEqual([
      microsecond.fileId,
      tie.fileId,
      first.fileId,
    ])
    expect(page3.nextCursor).toBeNull()
  })
})
