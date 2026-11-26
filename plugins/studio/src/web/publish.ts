import {
  type Database,
  notFound,
  type Scoped,
  scoped,
  studioPublication,
  studioWork,
} from '@saas/db'
import { AppError, newId } from '@saas/shared'
import { log } from '@saas/shared/log'
import { and, count, eq, gte, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { DEFAULT_PUBLISH_DAILY_LIMIT } from '../config.ts'
import {
  checkPublish as projectCheckPublish,
  type StudioPublishCheckInput,
  type StudioPublishCheckResult,
} from '../moderation.project.ts'
import {
  type InvalidateStudioWork,
  invalidateStudioMedia,
  invalidateStudioWork,
} from './work-invalidation.ts'
import {
  assertStudioWritable,
  DEFAULT_STUDIO_SITE,
  lockStudioWorkspace,
  readStudioOutput,
  type StudioTransaction,
  type StudioWorkMutation,
  type StudioWorkspace,
} from './works.ts'

export type { StudioPublishCheckInput, StudioPublishCheckResult } from '../moderation.project.ts'
export type { StudioWorkMutation } from './works.ts'

export type CheckStudioPublish = (
  input: StudioPublishCheckInput,
) => StudioPublishCheckResult | Promise<StudioPublishCheckResult>

export interface PublishStudioWorkInput extends StudioWorkMutation, StudioWorkspace {
  /** 由服务端站点解析提供，单站点使用默认键。 */
  site?: string
  title: string
  showPrompt: boolean
}

export interface PublishStudioWorkOptions {
  dailyLimit?: number
  checkPublish?: CheckStudioPublish
  invalidate?: InvalidateStudioWork
  /** 测试 UTC 日切时使用；线上以数据库时钟为准。 */
  now?: () => Date
}

const titleInput = z.string().trim().min(1).max(120)
const mediaPrompt = z.object({ prompt: z.string() })

function originalPrompt(input: Record<string, unknown>): string | null {
  if (typeof input.userPrompt === 'string') return input.userPrompt
  return mediaPrompt.safeParse(input.params).data?.prompt ?? null
}

function studioSlug(title: string, id: string) {
  const suffix = BigInt(`0x${id.replaceAll('-', '')}`)
    .toString(36)
    .slice(-8)
  const prefix = title
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .slice(0, 60)
    .replace(/-$/, '')
  return prefix ? `${prefix}-${suffix}` : suffix
}

async function findWork(tenant: Scoped, fileId: string, lock = false) {
  const query = tenant.select(studioWork, { where: eq(studioWork.fileId, fileId) }).limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (row?.moderation === 'removed')
    throw new AppError('STUDIO_WORK_REMOVED', row.removalReason ?? 'Work has been removed', {
      status: 409,
    })
  return row && { ...row, moderation: row.moderation }
}

async function runPublishCheck(
  input: StudioPublishCheckInput,
  checkPublish: CheckStudioPublish = projectCheckPublish,
): Promise<StudioPublishCheckResult> {
  try {
    return await checkPublish(input)
  } catch (error) {
    // 项目钩子可以访问外部服务，异常转人工且不记录标题、提示词或上游错误内容。
    log.warn('studio.publish.check_failed', {
      workspaceId: input.workspaceId,
      errorName: error instanceof Error ? error.name : typeof error,
    })
    return { action: 'review' }
  }
}

async function reservePublication(
  tx: StudioTransaction,
  userId: string,
  options: PublishStudioWorkOptions,
) {
  // 同一用户在多个空间的发布也共用额度。拿锁后的 SQL 语句能看到上一事务提交的额度。
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`studio:publish:${userId}`}, 0))`,
  )
  const now =
    options.now?.() ??
    (await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`))[0]?.now
  if (!now) throw new Error('Database clock unavailable')
  const publishedAt = new Date(now)
  const start = new Date(publishedAt)
  start.setUTCHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  const limit = options.dailyLimit ?? DEFAULT_PUBLISH_DAILY_LIMIT
  const [total] = await tx
    .select({ total: count() })
    .from(studioPublication)
    .where(
      and(
        eq(studioPublication.userId, userId),
        gte(studioPublication.publishedAt, start),
        lt(studioPublication.publishedAt, end),
      ),
    )
  if ((total?.total ?? 0) >= limit)
    throw new AppError('STUDIO_PUBLISH_LIMIT', 'Daily publication limit reached', {
      status: 429,
      publicDetails: { limit, resetsAt: end.toISOString() },
    })
  await tx
    .delete(studioPublication)
    .where(and(eq(studioPublication.userId, userId), lt(studioPublication.publishedAt, start)))
  await tx.insert(studioPublication).values({ userId, publishedAt })
  return publishedAt
}

export async function publishStudioWork(
  db: Database,
  input: PublishStudioWorkInput,
  options: PublishStudioWorkOptions = {},
) {
  const { actor, workspaceId, kinds, fileId } = input
  assertStudioWritable(actor)
  const parsedTitle = titleInput.safeParse(input.title)
  if (!parsedTitle.success)
    throw new AppError('STUDIO_TITLE_INVALID', 'Title must be between 1 and 120 characters')
  const title = parsedTitle.data
  const tenant = scoped(db, workspaceId)
  const source = await readStudioOutput(tenant, fileId, kinds)
  const initial = await findWork(tenant, fileId)
  // 重放已提交的发布不消耗新额度，也不重新调用外部检查。
  const checked =
    initial?.visibility === 'public'
      ? undefined
      : await runPublishCheck(
          {
            title,
            prompt: initial ? initial.prompt : originalPrompt(source.input),
            kind: source.kind,
            modelKey: source.modelKey,
            workspaceId,
          },
          options.checkPublish,
        )

  const result = await db.transaction(async (tx) => {
    const locked = await lockStudioWorkspace(tx, workspaceId, actor)
    const currentSource = await readStudioOutput(locked, fileId, kinds, true)
    const current = await findWork(locked, fileId, true)
    if (current?.visibility === 'public') return { work: current }
    const prompt = current ? current.prompt : originalPrompt(currentSource.input)
    if (
      !checked ||
      current?.id !== initial?.id ||
      currentSource.taskId !== source.taskId ||
      currentSource.kind !== source.kind ||
      currentSource.modelKey !== source.modelKey ||
      prompt !== (initial ? initial.prompt : originalPrompt(source.input))
    )
      throw new AppError('STUDIO_WORK_CHANGED', 'Work changed while publishing', { status: 409 })
    if (checked.action === 'reject')
      throw new AppError('STUDIO_PUBLISH_REJECTED', checked.reason, { status: 422 })

    const publishedAt = await reservePublication(tx, actor.userId, options)
    const priorModeration = current?.moderation ?? 'pending'
    const needsApproval =
      current?.moderation === 'approved' &&
      (current.title !== title || current.showPrompt !== input.showPrompt)
    const moderation =
      checked.action === 'review' ? 'hidden' : needsApproval ? 'pending' : priorModeration
    const moderationBeforeHide =
      priorModeration === 'hidden'
        ? (current?.moderationBeforeHide ?? 'pending')
        : moderation === 'hidden'
          ? priorModeration
          : null
    const publication = {
      title,
      showPrompt: input.showPrompt,
      publishedAt,
      moderation,
      moderationBeforeHide,
      visibility: 'public' as const,
    }
    if (current) {
      const work = await locked.updateById(studioWork, current.id, {
        ...publication,
        version:
          current.version + (moderation === 'hidden' && priorModeration !== 'hidden' ? 1 : 0),
      })
      return { work, invalidate: current }
    }

    // UUID 后缀很短，唯一索引判冲突；重新生成 ID 保持 URL 格式。
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = newId()
      const [work] = await locked
        .insert(studioWork, {
          ...publication,
          id,
          fileId,
          userId: actor.userId,
          site: input.site ?? DEFAULT_STUDIO_SITE,
          slug: studioSlug(title, id),
          taskId: currentSource.taskId,
          kind: currentSource.kind,
          modelKey: currentSource.modelKey,
          prompt,
          width: currentSource.width,
          height: currentSource.height,
          durationMs:
            currentSource.duration === null ? null : Math.round(currentSource.duration * 1000),
        })
        .onConflictDoNothing({ target: studioWork.slug })
        .returning()
      if (work) return { work, invalidate: work }
    }
    throw new AppError('STUDIO_SLUG_UNAVAILABLE', 'Could not allocate a work address', {
      status: 409,
    })
  })
  if (result.invalidate) await invalidateStudioWork(result.invalidate, options.invalidate)
  return result.work
}

export async function unpublishStudioWork(
  db: Database,
  input: StudioWorkMutation,
  options: { invalidate?: InvalidateStudioWork } = {},
) {
  const { actor, workspaceId, fileId } = input
  assertStudioWritable(actor)
  if (!z.uuid().safeParse(fileId).success) throw notFound()
  const result = await db.transaction(async (tx) => {
    const tenant = await lockStudioWorkspace(tx, workspaceId, actor)
    const current = await findWork(tenant, fileId, true)
    if (!current) throw notFound()
    if (current.visibility === 'private') return { work: current }
    const work = await tenant.updateById(studioWork, current.id, {
      visibility: 'private',
      version: current.version + 1,
    })
    return { work, invalidate: current }
  })
  if (result.invalidate)
    await invalidateStudioWork(result.invalidate, options.invalidate ?? invalidateStudioMedia)
  return result.work
}
