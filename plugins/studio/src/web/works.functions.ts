import { notFound } from '@saas/db'
import { AppError } from '@saas/shared'
import { createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseStatus } from '@tanstack/react-start/server'
import { requireFileStorage } from '@web/features/files/runtime.ts'
import { withWorkspace } from '@web/server/middleware.ts'
import { getWebRuntime, pluginUnavailable } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { z } from 'zod'
import { studioConfigSchema } from '../config.ts'
import { enabledStudioKinds, STUDIO_KINDS } from '../kinds.ts'
import { resolveStudioSite } from '../site.ts'
import { studioMediaPath } from './media-url.ts'
import { getStudioPublishQuota, publishStudioWork, unpublishStudioWork } from './publish.ts'
import { listStudioWorks, type StudioWorkActor } from './works.ts'
import { deleteStudioWork } from './works-delete.server.ts'

// 「我的作品」与创作页结果的读写入口（openspec add-media-studio 8.2）。身份、角色与只读状态
// 全部来自 withWorkspace 的可信上下文，客户端只给 slug 与输出文件 ID。

const slug = z.string().min(1).max(64)
const fileId = z.uuid()

interface StudioWorkspaceContext {
  user: { id: string }
  member: { role: string }
  workspace: { id: string; slug: string }
  workspaceReadOnly: boolean
}

function studioScope() {
  const kinds = enabledStudioKinds(templateConfig)
  if (kinds.length === 0) throw notFound()
  if (pluginUnavailable(getWebRuntime(), 'studio'))
    throw new AppError('STUDIO_UNAVAILABLE', 'Studio is unavailable', { status: 503 })
  // 注册表生成时已校验配置；服务端补齐默认值（每日发布上限等）。
  return { kinds, config: studioConfigSchema.parse(templateConfig.plugins.studio ?? {}) }
}

function actorOf(context: StudioWorkspaceContext): StudioWorkActor {
  return {
    userId: context.user.id,
    role: context.member.role,
    workspaceReadOnly: context.workspaceReadOnly,
  }
}

function siteOf(sites: Parameters<typeof resolveStudioSite>[2]) {
  const site = resolveStudioSite(
    new URL(getRequest().url).origin,
    getWebRuntime().config.APP_URL,
    sites,
  )
  return site ? { site: site.key } : {}
}

export function canWriteStudio(actor: StudioWorkActor) {
  return !actor.workspaceReadOnly && ['owner', 'admin', 'member'].includes(actor.role)
}

/** 页面预览与下载走现有的空间文件接口（会话鉴权、短时签名地址）。 */
export function studioFileUrl(workspaceId: string, fileId: string) {
  return `/api/files/${encodeURIComponent(fileId)}?${new URLSearchParams({ workspaceId })}`
}

type ListedWork = NonNullable<Awaited<ReturnType<typeof listStudioWorks>>['works'][number]['work']>

/** 左连接的列在类型上可空；有作品行时这些非空列一定有值。 */
function publishedWork(work: ListedWork) {
  return {
    id: work.id as string,
    title: work.title as string,
    slug: work.slug as string,
    visibility: work.visibility as 'public' | 'private',
    moderation: work.moderation as 'pending' | 'approved' | 'hidden' | 'removed',
    removalReason: work.removalReason,
    showPrompt: work.showPrompt as boolean,
    version: work.version as number,
  }
}

export const getStudioWorks = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(
    z.strictObject({
      slug,
      kind: z.enum(STUDIO_KINDS).optional(),
      visibility: z.enum(['public', 'private']).optional(),
      cursor: z.string().min(1).max(128).optional(),
      limit: z.int().min(1).max(48).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    try {
      const { kinds, config } = studioScope()
      const actor = actorOf(context)
      const [page, quota] = await Promise.all([
        listStudioWorks(context.db, {
          workspaceId: context.workspace.id,
          kinds,
          ...(data.kind && { kind: data.kind }),
          ...(data.visibility && { visibility: data.visibility }),
          ...(data.cursor && { cursor: data.cursor }),
          limit: data.limit ?? 24,
        }),
        getStudioPublishQuota(context.db, context.user.id, config.publishDailyLimit),
      ])
      return {
        workspaceId: context.workspace.id,
        workspaceSlug: context.workspace.slug,
        kinds,
        canWrite: canWriteStudio(actor),
        readOnly: context.workspaceReadOnly,
        quota,
        nextCursor: page.nextCursor,
        works: page.works.map(({ work: row, createdAt, ...output }) => {
          // 左连接没有作品行时各列为 null：统一为「未发布」。
          const work = row?.id ? publishedWork(row) : null
          const download = studioFileUrl(context.workspace.id, output.fileId)
          const visible =
            work?.visibility === 'public' &&
            (work.moderation === 'pending' || work.moderation === 'approved')
          return {
            ...output,
            createdAt: createdAt.toISOString(),
            // 公开中的作品预览走可缓存的公开媒体地址；其余走需要会话的空间文件接口。
            url: visible ? studioMediaPath(work.id, work.version) : download,
            downloadUrl: download,
            work,
          }
        }),
      }
    } catch (error) {
      if (error instanceof AppError) setResponseStatus(error.status)
      throw error
    }
  })

export type StudioWorksPage = Awaited<ReturnType<typeof getStudioWorks>>
export type StudioWorkItem = StudioWorksPage['works'][number]

export interface StudioActionError {
  code: string
  message: string
  details?: { limit?: number; resetsAt?: string }
}

export type StudioActionResult<T> = ({ ok: true } & T) | { ok: false; error: StudioActionError }

/** 业务错误按结果返回，页面据此显示原因；未公开的异常仍然抛出。 */
async function studioAction<T>(action: () => Promise<T>): Promise<StudioActionResult<T>> {
  try {
    return { ok: true as const, ...(await action()) }
  } catch (error) {
    if (!(error instanceof AppError) || !error.expose) throw error
    setResponseStatus(error.status)
    const limit = error.publicDetails?.limit
    const resetsAt = error.publicDetails?.resetsAt
    return {
      ok: false as const,
      error: {
        code: error.code,
        message: error.message,
        ...(typeof limit === 'number' &&
          typeof resetsAt === 'string' && { details: { limit, resetsAt } }),
      },
    }
  }
}

export const publishStudioWorkFn = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    z.strictObject({ slug, fileId, title: z.string().max(200), showPrompt: z.boolean() }),
  )
  .handler(({ context, data }) =>
    studioAction(async () => {
      const { kinds, config } = studioScope()
      const work = await publishStudioWork(
        context.db,
        {
          workspaceId: context.workspace.id,
          kinds,
          actor: actorOf(context),
          fileId: data.fileId,
          title: data.title,
          showPrompt: data.showPrompt,
          // 多站点项目按请求所在站点冻结作品的站点键；无法识别时用默认站点。
          ...siteOf(config.sites),
        },
        { dailyLimit: config.publishDailyLimit },
      )
      return {
        work: {
          id: work.id,
          slug: work.slug,
          title: work.title,
          visibility: work.visibility,
          moderation: work.moderation,
        },
      }
    }),
  )

export const unpublishStudioWorkFn = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(z.strictObject({ slug, fileId }))
  .handler(({ context, data }) =>
    studioAction(async () => {
      studioScope()
      const work = await unpublishStudioWork(context.db, {
        workspaceId: context.workspace.id,
        actor: actorOf(context),
        fileId: data.fileId,
      })
      return { work: { id: work.id, visibility: work.visibility, moderation: work.moderation } }
    }),
  )

export const deleteStudioWorkFn = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(z.strictObject({ slug, fileId }))
  .handler(({ context, data }) =>
    studioAction(async () => {
      studioScope()
      const storage = requireFileStorage(getWebRuntime())
      try {
        await deleteStudioWork(context.db, storage, {
          workspaceId: context.workspace.id,
          actor: actorOf(context),
          fileId: data.fileId,
        })
      } catch (error) {
        // 作品与文件记录已删除，只是对象删除需要清理任务重试：对用户而言删除已经完成。
        if (!(error instanceof AppError && error.code === 'STUDIO_OBJECT_DELETE_FAILED'))
          throw error
      }
      return { deleted: true as const }
    }),
  )
