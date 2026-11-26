// 做同款跳转（public-gallery「做同款」）：未登录 → 登录页（登录后回到本地址）；已登录 → 默认空间创作页，
// 预填作品模型与公开的提示词（未公开时只预填模型）。响应不缓存、不收录。
import { AppError } from '@saas/shared'
import { readRequestSession } from '@web/features/i18n/session.server.ts'
import { LOGIN_PATH } from '@web/server/middleware.ts'
import { getWebRuntime, pluginUnavailable } from '@web/server/runtime.ts'
import { resolveDefaultWorkspace } from '@web/server/workspace-context.ts'
import { studioUnavailable } from './document.server.ts'
import { loadRemixTarget } from './gallery.server.ts'
import { remixPath, studioRemixHref } from './paths.ts'

const headers = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' }

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { ...headers, location } })
}

export async function handleRemix(request: Request, slug: string): Promise<Response> {
  const runtime = getWebRuntime()
  if (pluginUnavailable(runtime, 'studio')) return studioUnavailable()
  let session: Awaited<ReturnType<typeof readRequestSession>>
  try {
    session = await readRequestSession({
      auth: runtime.auth,
      db: runtime.db,
      headers: request.headers,
    })
  } catch (error) {
    if (error instanceof AppError && (error.status === 401 || error.status === 403))
      return redirect(`${LOGIN_PATH}?redirect=${encodeURIComponent(remixPath(slug))}`)
    throw error
  }
  let target: Awaited<ReturnType<typeof loadRemixTarget>>
  try {
    target = await loadRemixTarget(request, slug)
  } catch (error) {
    if (error instanceof AppError && error.status === 404) target = null
    else throw error
  }
  if (!target) return new Response('Not found', { status: 404, headers })
  const workspace = await resolveDefaultWorkspace(
    runtime.db,
    session.user,
    session.session.activeOrganizationId,
  )
  // 已登录但没有可用空间：交给 /app 处理（补建个人空间或引导）
  if (!workspace) return redirect('/app')
  return redirect(studioRemixHref(workspace.workspace.slug, target))
}
