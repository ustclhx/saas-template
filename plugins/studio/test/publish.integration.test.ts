import { scoped, studioPublication, studioWork } from '@saas/db'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { STUDIO_KINDS } from '../src/kinds.ts'
import { getPublicWorkMedia } from '../src/web/public-works.ts'
import { publishStudioWork, unpublishStudioWork } from '../src/web/publish.ts'
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

async function fixture(userId?: string) {
  const workspace = await seedStudioWorkspace(db, userId ? { userId } : {})
  workspaceIds.push(workspace.workspaceId)
  return {
    workspace,
    actor: { userId: workspace.userId, role: 'owner', workspaceReadOnly: false },
    workspaceId: workspace.workspaceId,
    kinds: STUDIO_KINDS,
  }
}

describe('Studio 发布状态', () => {
  it('默认放行、快照只用原始提示词，重复发表不重复扣额度', async () => {
    const context = await fixture()
    const source = await seedStudioOutput(db, context.workspace, {
      kind: 'video',
      input: { userPrompt: '原始提示词', params: { prompt: '原始提示词\n附加预设' } },
    })
    const input = {
      ...context,
      ...source,
      site: 'branded',
      title: '  Café 片段 ',
      showPrompt: true,
    }
    const work = await publishStudioWork(db, input, { dailyLimit: 1 })
    expect(work).toMatchObject({
      userId: context.actor.userId,
      taskId: source.taskId,
      fileId: source.fileId,
      title: 'Café 片段',
      slug: expect.stringMatching(/^cafe-[a-z0-9]{8}$/),
      site: 'branded',
      prompt: '原始提示词',
      showPrompt: true,
      durationMs: 2125,
      visibility: 'public',
      moderation: 'pending',
      version: 1,
    })
    const checkPublish = vi.fn(() => ({ action: 'allow' as const }))
    expect(await publishStudioWork(db, input, { dailyLimit: 1, checkPublish })).toEqual(work)
    expect(checkPublish).not.toHaveBeenCalled()
  })

  it('先查发布内容，拒绝理由透出且不占额度', async () => {
    const context = await fixture()
    const source = await seedStudioOutput(db, context.workspace)
    const input = { ...context, ...source, title: '旧任务测试', showPrompt: false }
    const checkPublish = vi.fn(() => ({ action: 'reject' as const, reason: '违规词' }))
    await expect(
      publishStudioWork(db, input, { dailyLimit: 1, checkPublish }),
    ).rejects.toMatchObject({ status: 422, code: 'STUDIO_PUBLISH_REJECTED', message: '违规词' })
    expect(checkPublish).toHaveBeenCalledWith({
      workspaceId: context.workspaceId,
      title: input.title,
      prompt: '原始旧提示词',
      kind: 'image',
      modelKey: 'studio-fixture-image',
    })
    expect(await scoped(db, context.workspaceId).count(studioWork)).toBe(0)
    const result = await publishStudioWork(db, input, { dailyLimit: 1 })
    expect(result.site).toBe('default')
    expect(result.slug).toMatch(/^[a-z0-9]{8}$/)
  })

  it.each([
    ['人工审核', () => ({ action: 'review' as const })],
    [
      '检查异常',
      async () => {
        throw new Error('synthetic failure')
      },
    ],
  ])('%s发布为隐藏且撤回、重新发布不能解锁审核', async (_name, checkPublish) => {
    const context = await fixture()
    const source = await seedStudioOutput(db, context.workspace)
    const input = { ...context, ...source, title: 'Review', showPrompt: false }
    const work = await publishStudioWork(db, input, { checkPublish })
    expect(work).toMatchObject({
      visibility: 'public',
      moderation: 'hidden',
      moderationBeforeHide: 'pending',
    })
    await unpublishStudioWork(db, input)
    const result = await publishStudioWork(db, input)
    expect(result).toMatchObject({
      id: work.id,
      visibility: 'public',
      moderation: 'hidden',
      moderationBeforeHide: 'pending',
      version: 2,
    })
  })

  it('停用的视频模式仍可撤回，重新发布未修改的作品保留审核、站点和 slug', async () => {
    const context = await fixture()
    const source = await seedStudioOutput(db, context.workspace, { kind: 'video' })
    const site = `studio-${context.workspaceId}`
    const input = { ...context, ...source, site, title: 'Original', showPrompt: false }
    const withdrawal = {
      workspaceId: context.workspaceId,
      actor: context.actor,
      fileId: source.fileId,
      kinds: ['image'] as const,
    }
    const invalidate = vi.fn()
    const work = await publishStudioWork(db, input)
    const tenant = scoped(db, context.workspaceId)
    await tenant.updateById(studioWork, work.id, { moderation: 'approved' })
    const media = { site, kinds: STUDIO_KINDS, workId: work.id, version: 1 }
    expect(await getPublicWorkMedia(db, media)).toMatchObject({ r2Key: source.r2Key })
    await expect(unpublishStudioWork(db, withdrawal, { invalidate })).resolves.toMatchObject({
      visibility: 'private',
      moderation: 'approved',
      version: 2,
    })
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      id: work.id,
      site,
      slug: work.slug,
      version: 1,
    })
    expect(await getPublicWorkMedia(db, media)).toBeNull()
    await unpublishStudioWork(db, withdrawal, { invalidate })
    expect(invalidate).toHaveBeenCalledTimes(1)

    const restored = await publishStudioWork(
      db,
      { ...input, site: 'another', title: '  Original  ' },
      {
        checkPublish: () => ({ action: 'allow' }),
      },
    )
    expect(restored).toMatchObject({
      slug: work.slug,
      title: 'Original',
      site,
      moderation: 'approved',
    })
    expect(await getPublicWorkMedia(db, media)).toBeNull()
    expect(await getPublicWorkMedia(db, { ...media, version: 2 })).not.toBeNull()
  })

  it.each([
    ['标题', { title: 'Renamed' }],
    ['提示词可见性', { showPrompt: true }],
  ])('重新发布已通过的私有作品时修改%s会重新进入待审核', async (_field, change) => {
    const context = await fixture()
    const { fileId } = await seedStudioOutput(db, context.workspace)
    const input = { ...context, fileId, title: 'Original', showPrompt: false }
    const work = await publishStudioWork(db, input)
    await scoped(db, context.workspaceId).updateById(studioWork, work.id, {
      moderation: 'approved',
    })
    const privateWork = await unpublishStudioWork(db, input)
    await expect(publishStudioWork(db, { ...input, ...change })).resolves.toMatchObject({
      ...change,
      slug: work.slug,
      visibility: 'public',
      moderation: 'pending',
      moderationBeforeHide: null,
      version: privateWork.version,
    })
  })

  it('已通过的私有作品重新发布转人工时，记录原审核状态并递增版本', async () => {
    const context = await fixture()
    const { fileId } = await seedStudioOutput(db, context.workspace)
    const input = { ...context, fileId, title: 'Review again', showPrompt: false }
    const work = await publishStudioWork(db, input)
    await scoped(db, context.workspaceId).updateById(studioWork, work.id, {
      moderation: 'approved',
    })
    const privateWork = await unpublishStudioWork(db, input)
    const invalidate = vi.fn()
    await expect(
      publishStudioWork(db, input, {
        checkPublish: () => ({ action: 'review' }),
        invalidate,
      }),
    ).resolves.toMatchObject({
      visibility: 'public',
      moderation: 'hidden',
      moderationBeforeHide: 'approved',
      version: privateWork.version + 1,
    })
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      id: work.id,
      slug: work.slug,
      site: work.site,
      version: privateWork.version,
    })
  })

  it('已下架作品的取消发布与重新发布均返回 409，状态和版本保持不变', async () => {
    const context = await fixture()
    const { fileId } = await seedStudioOutput(db, context.workspace)
    const input = { ...context, fileId, title: 'Removed', showPrompt: false }
    const work = await publishStudioWork(db, input)
    const tenant = scoped(db, context.workspaceId)
    const removed = await tenant.updateById(studioWork, work.id, {
      moderation: 'removed',
      removalReason: '侵权',
    })
    const error = {
      status: 409,
      code: 'STUDIO_WORK_REMOVED',
      message: '侵权',
    }
    const invalidate = vi.fn()
    await expect(unpublishStudioWork(db, input, { invalidate })).rejects.toMatchObject(error)
    await expect(publishStudioWork(db, input, { invalidate })).rejects.toMatchObject(error)
    expect(await tenant.findById(studioWork, work.id)).toEqual(removed)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('同一用户跨空间并发只获得一次额度，删除或撤回不会归还当天额度，UTC 日切重置', async () => {
    const context = await fixture()
    const other = await fixture(context.actor.userId)
    const first = await seedStudioOutput(db, context.workspace)
    const second = await seedStudioOutput(db, other.workspace)
    const input1 = { ...context, ...first, title: 'First', showPrompt: false }
    const input2 = { ...other, ...second, title: 'Second', showPrompt: false }
    const daily = { dailyLimit: 1, now: () => new Date('2026-11-25T23:59:59.999Z') }
    const results = await Promise.allSettled([
      publishStudioWork(db, input1, daily),
      publishStudioWork(db, input2, daily),
    ])
    const winner = results[0]?.status === 'fulfilled' ? input1 : input2
    const loser = winner === input1 ? input2 : input1
    const error = {
      code: 'STUDIO_PUBLISH_LIMIT',
      status: 429,
      publicDetails: { limit: 1, resetsAt: '2026-11-26T00:00:00.000Z' },
    }
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: error })
    const hidden = await unpublishStudioWork(db, winner)
    await expect(publishStudioWork(db, winner, daily)).rejects.toMatchObject(error)
    await scoped(db, winner.workspaceId).deleteById(studioWork, hidden.id)
    await expect(publishStudioWork(db, loser, daily)).rejects.toMatchObject(error)
    await expect(
      publishStudioWork(db, loser, {
        ...daily,
        now: () => new Date('2026-11-26T00:00:00Z'),
      }),
    ).resolves.toMatchObject({ publishedAt: new Date('2026-11-26T00:00:00Z') })
    expect(
      await db
        .select()
        .from(studioPublication)
        .where(eq(studioPublication.userId, context.actor.userId)),
    ).toHaveLength(1)
  })

  it('拒绝跨空间、未完成输出、禁用模式和只读成员的写入', async () => {
    const context = await fixture()
    const other = await fixture()
    const foreign = await seedStudioOutput(db, other.workspace)
    const unfinished = await seedStudioOutput(db, context.workspace, { status: 'running' })
    const video = await seedStudioOutput(db, context.workspace, { kind: 'video' })
    const input = { ...context, title: 'Rejected', showPrompt: false }
    await expect(publishStudioWork(db, { ...input, fileId: foreign.fileId })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    )
    await expect(
      publishStudioWork(db, { ...input, fileId: unfinished.fileId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      publishStudioWork(db, { ...input, fileId: video.fileId, kinds: ['image'] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const denied = {
      ...input,
      fileId: video.fileId,
      actor: { ...context.actor, workspaceReadOnly: true },
    }
    await expect(publishStudioWork(db, denied)).rejects.toMatchObject({ status: 403 })
    await expect(unpublishStudioWork(db, denied)).rejects.toMatchObject({ status: 403 })
  })
})
