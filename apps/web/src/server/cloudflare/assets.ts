/**
 * 命中的静态资源（预渲染页面、构建产物）；未命中返回 null。
 * WebSocket 升级（agents 插件的 /agents/*）不查静态资源：本地 dev 中 ASSETS 是 Vite 的 Node 服务，
 * 收到升级请求会让 miniflare 断言失败并退出 dev 进程。
 */
export async function staticAsset(
  request: Request,
  assets: Cloudflare.Env['ASSETS'] | undefined,
): Promise<Response | null> {
  if (!assets || (request.method !== 'GET' && request.method !== 'HEAD')) return null
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return null
  const asset = await assets.fetch(request)
  if (asset.status !== 404) return asset
  await asset.body?.cancel()
  return null
}
