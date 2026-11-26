import { aiTask, type Database, file, notFound, studioWork } from '@saas/db'
import { AppError } from '@saas/shared'
import type { Storage } from '@saas/storage'
import { and, eq, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  type InvalidateStudioWork,
  invalidateStudioMedia,
  invalidateStudioWork,
} from './work-invalidation.ts'
import {
  assertStudioWritable,
  lockStudioWorkspace,
  type StudioWorkMutation,
  studioOutputTaskJoin,
} from './works.ts'

export async function deleteStudioWork(
  db: Database,
  storage: Pick<Storage, 'delete'>,
  input: StudioWorkMutation,
  options: { invalidate?: InvalidateStudioWork } = {},
): Promise<{ deleted: true }> {
  assertStudioWritable(input.actor)
  if (!z.uuid().safeParse(input.fileId).success) throw notFound()

  const { output, publication } = await db.transaction(async (tx) => {
    const tenant = await lockStudioWorkspace(tx, input.workspaceId, input.actor)
    // 与发布共用的锁序：空间 → 输出 → 作品。墓碑仍可用于重试对象删除。
    const [output] = await tenant
      .select(file, {
        fields: { id: file.id, r2Key: file.r2Key, deletedAt: file.deletedAt },
        where: and(
          eq(file.id, input.fileId),
          eq(file.purpose, 'ai_output'),
          eq(file.status, 'ready'),
        ) as SQL,
      })
      .innerJoin(aiTask, studioOutputTaskJoin(tenant))
      .for('update', { of: file })
    if (!output) throw notFound()

    const where = eq(studioWork.fileId, output.id)
    const [publication] = await tenant
      .select(studioWork, {
        fields: {
          id: studioWork.id,
          slug: studioWork.slug,
          site: studioWork.site,
          version: studioWork.version,
        },
        where,
      })
      .for('update')
    if (publication) {
      await tenant.update(studioWork, { version: sql`${studioWork.version} + 1` }, where)
      await tenant.delete(studioWork, where)
    }
    if (!output.deletedAt) await tenant.updateById(file, output.id, { deletedAt: sql`now()` })
    return { output, publication }
  })

  if (publication)
    await invalidateStudioWork(publication, options.invalidate ?? invalidateStudioMedia)
  try {
    await storage.delete(output.r2Key)
  } catch (cause) {
    // 即使调用方不重试，存储清理 Cron 仍会根据文件墓碑重试删除。
    throw new AppError('STUDIO_OBJECT_DELETE_FAILED', 'Work deleted; file cleanup needs retry', {
      status: 503,
      cause,
    })
  }
  return { deleted: true }
}
