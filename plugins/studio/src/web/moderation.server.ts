import { notFound, type StudioWork, scoped, studioReport, studioWork } from '@saas/db'
import { AppError } from '@saas/shared'
import { adminAction } from '@web/features/admin/action.server.ts'
import type { AdminActionContext, AdminActionScope } from '@web/features/admin/action.ts'
import { defineAdminActions } from '@web/features/admin/actions.registry.ts'
import { and, eq, isNull } from 'drizzle-orm'
import { type StudioModerationInput, studioModerationSchema } from './moderation-input.ts'
import { type InvalidateStudioWork, invalidateStudioWork } from './work-invalidation.ts'

export const studioAdminActions = defineAdminActions('studio', {
  'studio.work.approve': { stepUp: 'never', reason: '日常内容审核' },
  'studio.work.remove': { stepUp: 'never', reason: '内容下架可恢复' },
  'studio.work.restore': { stepUp: 'never', reason: '恢复已隐藏或下架的内容' },
  'studio.work.feature': { stepUp: 'never', reason: '精选可撤销' },
  'studio.work.unfeature': { stepUp: 'never', reason: '取消精选可撤销' },
})

export function studioAdminActionName(action: StudioModerationInput['action']) {
  return studioAdminActions[`studio.work.${action}`]
}

function moderationChanges(work: StudioWork, data: StudioModerationInput, now: Date) {
  switch (data.action) {
    case 'approve':
      if (work.visibility === 'public' && work.moderation === 'pending')
        return { moderation: 'approved' } as const
      break
    case 'remove':
      if (work.visibility === 'public' && work.moderation !== 'removed')
        return {
          moderation: 'removed',
          moderationBeforeHide: null,
          removalReason: data.reason,
          version: work.version + 1,
        } as const
      break
    case 'restore':
      if (work.moderation === 'hidden' || work.moderation === 'removed')
        return {
          moderation:
            work.moderation === 'hidden' ? (work.moderationBeforeHide ?? 'pending') : 'pending',
          moderationBeforeHide: null,
          removalReason: null,
        } as const
      break
    case 'feature':
      if (
        work.visibility === 'public' &&
        (work.moderation === 'pending' || work.moderation === 'approved')
      )
        return { featuredAt: work.featuredAt ?? now }
      break
    case 'unfeature':
      return { featuredAt: null }
  }
  throw new AppError('STUDIO_MODERATION_CONFLICT', 'Action is unavailable for this work', {
    status: 409,
  })
}

/** MCP 可在自己的 adminAction 事务中复用；预演校验状态并返回拟变更，不写作品或业务审计。 */
export async function applyStudioModeration(
  scope: AdminActionScope,
  input: StudioModerationInput,
  { dryRun = false }: { dryRun?: boolean } = {},
) {
  const data = studioModerationSchema.parse(input)
  const [before] = await scope.tx
    .select()
    // biome-ignore lint/plugin: 平台管理员可审核任意空间，后续作品写入使用作品所属空间。
    .from(studioWork)
    .where(eq(studioWork.id, data.workId))
    .for('update')
  if (!before) throw notFound()

  const now = new Date()
  const changes = moderationChanges(before, data, now)
  const work = {
    id: before.id,
    site: before.site,
    slug: before.slug,
    moderation: changes.moderation ?? before.moderation,
    removalReason: 'removalReason' in changes ? changes.removalReason : before.removalReason,
    featuredAt: 'featuredAt' in changes ? changes.featuredAt : before.featuredAt,
    version: changes.version ?? before.version,
  }
  if (dryRun) return { work, invalidate: null }

  const tenant = scoped(scope.tx, before.workspaceId)
  await tenant.updateById(studioWork, before.id, {
    ...changes,
    ...('moderation' in changes && { reviewedAt: now, reviewedBy: scope.admin.id }),
  })

  if (data.action === 'restore') {
    await scope.tx
      .update(studioReport)
      .set({ resolvedAt: now, resolution: 'restored' })
      .where(and(eq(studioReport.workId, before.id), isNull(studioReport.resolvedAt)))
  }

  await scope.audit({
    action: studioAdminActionName(data.action),
    targetType: 'studio_work',
    targetId: before.id,
    workspaceId: before.workspaceId,
    meta: {
      moderationBefore: before.moderation,
      moderationAfter: work.moderation,
      ...(data.action === 'remove' && { reason: data.reason }),
      ...((data.action === 'feature' || data.action === 'unfeature') && {
        featured: work.featuredAt !== null,
      }),
    },
  })

  return {
    work,
    invalidate: {
      id: before.id,
      site: before.site,
      slug: before.slug,
      version: before.version,
    },
  }
}

const apply = ({ data, ...scope }: AdminActionScope & { data: StudioModerationInput }) =>
  applyStudioModeration(scope, data)

const actions = {
  approve: adminAction(studioAdminActions['studio.work.approve'], apply),
  remove: adminAction(studioAdminActions['studio.work.remove'], apply),
  restore: adminAction(studioAdminActions['studio.work.restore'], apply),
  feature: adminAction(studioAdminActions['studio.work.feature'], apply),
  unfeature: adminAction(studioAdminActions['studio.work.unfeature'], apply),
}

export async function moderateStudioWork(
  context: AdminActionContext,
  input: StudioModerationInput,
  invalidate?: InvalidateStudioWork,
) {
  const data = studioModerationSchema.parse(input)
  const result = await actions[data.action]({ context, data })
  if (result.invalidate) await invalidateStudioWork(result.invalidate, invalidate)
  return result.work
}
