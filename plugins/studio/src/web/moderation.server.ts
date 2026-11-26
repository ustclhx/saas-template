import { notFound, type StudioWork, scoped, studioReport, studioWork } from '@saas/db'
import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { isNotFound } from '@tanstack/react-router'
import { adminAction } from '@web/features/admin/action.server.ts'
import type { AdminActionContext, AdminActionScope } from '@web/features/admin/action.ts'
import { defineAdminActions } from '@web/features/admin/actions.registry.ts'
import { and, eq, isNull } from 'drizzle-orm'
import {
  type StudioBatchModerationInput,
  type StudioModerationInput,
  studioBatchModerationSchema,
  studioModerationSchema,
} from './moderation-input.ts'
import {
  type InvalidateStudioWork,
  type InvalidateStudioWorks,
  invalidateStudioWork,
  invalidateStudioWorks,
  type StudioWorkAddress,
} from './work-invalidation.ts'

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
      ...(data.action === 'remove' && {
        reason: data.reason,
        ...(data.note && { note: data.note }),
      }),
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

export type StudioBatchResult =
  | { readonly workId: string; readonly ok: true; readonly moderation: StudioWork['moderation'] }
  | { readonly workId: string; readonly ok: false; readonly code: string }

/** 管理员权限在批量途中失效：当前件与其余件以此码返回，不再继续 */
export const STUDIO_BATCH_ADMIN_REVOKED = 'ADMIN_ACCESS_REVOKED'

/**
 * 批量通过 / 下架（tasks 7.3）：逐件一个 adminAction 事务与审计，某件失败不回滚其他件，
 * 每件的结果都返回（已提交的件始终出现在结果中）。缓存失效在循环结束后一次处理。
 * adminAction 发现管理员已失效时抛出路由 notFound（与单件 404 的 AppError 不同），此时停止处理。
 */
export async function moderateStudioWorks(
  context: AdminActionContext,
  input: StudioBatchModerationInput,
  invalidateMany?: InvalidateStudioWorks,
): Promise<StudioBatchResult[]> {
  const data = studioBatchModerationSchema.parse(input)
  const results: StudioBatchResult[] = []
  const addresses: StudioWorkAddress[] = []
  const ids = [...new Set(data.workIds)]
  for (const [index, workId] of ids.entries()) {
    const item: StudioModerationInput =
      data.action === 'remove'
        ? { workId, action: 'remove', reason: data.reason, ...(data.note && { note: data.note }) }
        : { workId, action: 'approve' }
    try {
      const result = await actions[item.action]({ context, data: item })
      if (result.invalidate) addresses.push(result.invalidate)
      results.push({ workId, ok: true, moderation: result.work.moderation })
    } catch (error) {
      if (isNotFound(error)) {
        for (const rest of ids.slice(index))
          results.push({ workId: rest, ok: false, code: STUDIO_BATCH_ADMIN_REVOKED })
        break
      }
      const code = error instanceof AppError ? error.code : 'INTERNAL'
      if (!(error instanceof AppError && error.expose && error.status < 500))
        log.error('studio.moderation.batch_item_failed', {
          workId,
          code,
          errorName: error instanceof Error ? error.name : typeof error,
        })
      results.push({ workId, ok: false, code })
    }
  }
  await invalidateStudioWorks(addresses, invalidateMany)
  return results
}
