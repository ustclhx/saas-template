import { type StudioSiteOrigins, studioSiteOrigin } from '../site.ts'
import { studioMediaPath } from './media-url.ts'

// 「我的作品」与创作页共用的纯函数：不依赖服务端模块，客户端视图与 Server Function 都可导入。

export interface StudioWorkActorLike {
  role: string
  workspaceReadOnly: boolean
}

export function canWriteStudio(actor: StudioWorkActorLike) {
  return !actor.workspaceReadOnly && ['owner', 'admin', 'member'].includes(actor.role)
}

/** 页面预览与下载走现有的空间文件接口（会话鉴权、短时签名地址）。 */
export function studioFileUrl(workspaceId: string, fileId: string) {
  return `/api/files/${encodeURIComponent(fileId)}?${new URLSearchParams({ workspaceId })}`
}

export interface StudioPreviewWork {
  id: string
  site: string
  version: number
  visibility: 'public' | 'private'
  moderation: 'pending' | 'approved' | 'hidden' | 'removed'
}

/**
 * 公开中的作品预览用可缓存的公开媒体地址。公开媒体路由按请求主机校验作品站点，多站点项目中
 * app 所在主机可能不是作品站点，所以必须用作品站点的绝对地址；站点地址无法解析时回退到空间文件接口。
 */
export function studioWorkPreviewUrl(
  work: StudioPreviewWork | null,
  fallback: string,
  { appUrl, sites }: { appUrl: string; sites?: StudioSiteOrigins | undefined },
) {
  if (work?.visibility !== 'public') return fallback
  if (work.moderation !== 'pending' && work.moderation !== 'approved') return fallback
  const origin = studioSiteOrigin(work.site, appUrl, sites)
  return origin ? `${origin}${studioMediaPath(work.id, work.version)}` : fallback
}
