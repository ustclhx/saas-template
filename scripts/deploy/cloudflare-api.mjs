/**
 * add-deploy-autoprovision 1.3：部署资源解析使用的 Cloudflare REST API 客户端（design 决策 5）。
 * 只覆盖 KV、R2、Queues、Hyperdrive 的列表与创建；列表翻完全部分页后由调用方按名称精确匹配。
 * 错误只保留 HTTP 状态与 Cloudflare 错误码，不回显响应正文、请求体或连接串。
 *
 * 接口与权限名核对自官方 API 参考（2026-11-25）：
 * - KV：https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/list/ 、…/create/
 *   page / per_page ≤ 1000，result 为数组（id、title）；同名 title 创建返回 400。
 * - R2：https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/ 、…/create/
 *   cursor 分页（result_info.cursor），result 为 { buckets: [{ name, … }] }，桶没有单独的 ID。
 * - Queues：https://developers.cloudflare.com/api/resources/queues/methods/list/ 、…/create/
 *   page / per_page ≤ 500，result 为数组（queue_id、queue_name）。
 * - Hyperdrive：https://developers.cloudflare.com/api/resources/hyperdrive/subresources/configs/methods/list/ 、…/create/
 *   page / per_page ≤ 100，result 为数组（id、name）；创建体为 name、origin、caching。
 */

const API_BASE = 'https://api.cloudflare.com/client/v4'
/** 防止异常分页信息造成死循环；单账号的资源数量远低于此上限。 */
const MAX_PAGES = 200

/** 各资源读取 / 创建所需的令牌权限（官方 API 参考的 Token permissions，取最小的一项）。 */
export const PERMISSIONS = {
  kv: { list: 'Workers KV Storage Read', create: 'Workers KV Storage Write' },
  r2: { list: 'Workers R2 Storage Read', create: 'Workers R2 Storage Write' },
  queue: { list: 'Queues Read', create: 'Queues Write' },
  hyperdrive: { list: 'Hyperdrive Read', create: 'Hyperdrive Write' },
}

const LABELS = { kv: 'KV', r2: 'R2', queue: 'Queues', hyperdrive: 'Hyperdrive' }

export class CloudflareApiError extends Error {
  constructor({ kind, action, status, codes = [], reason }) {
    const label = `${LABELS[kind] ?? kind} ${action === 'create' ? '创建' : '列表'}`
    let message
    if (status === 403)
      message = `${label}被拒绝（HTTP 403）：API 令牌缺少「${PERMISSIONS[kind]?.[action] ?? '对应'}」权限`
    else if (status === 401) message = `${label}被拒绝（HTTP 401）：API 令牌无效或已过期`
    else if (status) message = `${label}失败：HTTP ${status}`
    else message = `${label}失败：${reason ?? '网络错误'}`
    if (codes.length) message += `，Cloudflare 错误码 ${codes.join(', ')}`
    super(message)
    this.name = 'CloudflareApiError'
    this.kind = kind
    this.action = action
    this.status = status
    this.codes = codes
  }
}

/**
 * 解析 Postgres 连接串为 Hyperdrive origin。连接串只在内存中拆分，
 * 解析失败时的错误信息不包含原文。
 */
export function originFromConnectionString(connectionString) {
  let url
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('HYPERDRIVE_APP_URL 不是有效的连接串')
  }
  const scheme = url.protocol.replace(/:$/, '')
  if (!['postgres', 'postgresql'].includes(scheme))
    throw new Error('HYPERDRIVE_APP_URL 必须以 postgres:// 或 postgresql:// 开头')
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!url.hostname || !url.username || !url.password || !database)
    throw new Error('HYPERDRIVE_APP_URL 必须包含用户名、密码、主机与数据库名')
  return {
    scheme,
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  }
}

/**
 * 创建 API 客户端。`fetch` 可注入，测试用假实现；所有方法返回 `{ id, name }` 列表或单项。
 * R2 桶没有 ID，以桶名作为 id。
 */
export function createCloudflareApi({
  token,
  accountId,
  fetch = globalThis.fetch,
  base = API_BASE,
}) {
  if (!token || !accountId) throw new Error('需要 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ACCOUNT_ID')
  const root = `${base}/accounts/${encodeURIComponent(accountId)}`

  async function request(kind, action, path, { method = 'GET', body } = {}) {
    let response
    try {
      response = await fetch(`${root}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (error) {
      // 只保留错误类别，不带可能回显请求内容的消息
      throw new CloudflareApiError({
        kind,
        action,
        reason: `网络错误（${error?.cause?.code ?? error?.name ?? 'unknown'}）`,
      })
    }
    let payload = null
    try {
      payload = await response.json()
    } catch {}
    const codes = (payload?.errors ?? [])
      .map((item) => item?.code)
      .filter((code) => code !== undefined)
    if (!response.ok || payload?.success === false)
      throw new CloudflareApiError({ kind, action, status: response.status || undefined, codes })
    return payload ?? {}
  }

  /** page / per_page 分页：直到本页不满、达到 total_count 或 total_pages。 */
  async function listPaged(kind, path, perPage, map) {
    const items = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const payload = await request(kind, 'list', `${path}?page=${page}&per_page=${perPage}`)
      const result = Array.isArray(payload.result) ? payload.result : []
      items.push(...result.map(map))
      const info = payload.result_info ?? {}
      if (result.length === 0 || result.length < (info.per_page ?? perPage)) return items
      if (typeof info.total_count === 'number' && items.length >= info.total_count) return items
      if (typeof info.total_pages === 'number' && page >= info.total_pages) return items
    }
    throw new CloudflareApiError({ kind, action: 'list', reason: `分页超过 ${MAX_PAGES} 页` })
  }

  async function listR2() {
    const items = []
    let cursor
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ per_page: '1000' })
      if (cursor) query.set('cursor', cursor)
      const payload = await request('r2', 'list', `/r2/buckets?${query}`)
      const buckets = payload.result?.buckets ?? []
      items.push(...buckets.map((item) => ({ id: item.name, name: item.name })))
      cursor = payload.result_info?.cursor
      if (!cursor || buckets.length === 0) return items
    }
    throw new CloudflareApiError({ kind: 'r2', action: 'list', reason: `分页超过 ${MAX_PAGES} 页` })
  }

  return {
    list(kind) {
      switch (kind) {
        case 'kv':
          return listPaged('kv', '/storage/kv/namespaces', 1000, (item) => ({
            id: item.id,
            name: item.title,
          }))
        case 'r2':
          return listR2()
        case 'queue':
          return listPaged('queue', '/queues', 500, (item) => ({
            id: item.queue_id,
            name: item.queue_name,
          }))
        case 'hyperdrive':
          return listPaged('hyperdrive', '/hyperdrive/configs', 100, (item) => ({
            id: item.id,
            name: item.name,
          }))
        default:
          throw new Error(`不支持的资源种类 ${kind}`)
      }
    },

    async create(kind, name, options = {}) {
      switch (kind) {
        case 'kv': {
          const { result } = await request('kv', 'create', '/storage/kv/namespaces', {
            method: 'POST',
            body: { title: name },
          })
          return { id: result?.id, name: result?.title ?? name }
        }
        case 'r2': {
          const { result } = await request('r2', 'create', '/r2/buckets', {
            method: 'POST',
            body: { name },
          })
          return { id: result?.name ?? name, name: result?.name ?? name }
        }
        case 'queue': {
          const { result } = await request('queue', 'create', '/queues', {
            method: 'POST',
            body: { queue_name: name },
          })
          return { id: result?.queue_id, name: result?.queue_name ?? name }
        }
        case 'hyperdrive': {
          // 连接串只进入请求体；缓存配置与 docs/07 §2 一致：关闭缓存，或缓存 60 秒
          const origin = originFromConnectionString(options.connectionString)
          const { result } = await request('hyperdrive', 'create', '/hyperdrive/configs', {
            method: 'POST',
            body: {
              name,
              origin,
              caching: options.cached ? { disabled: false, max_age: 60 } : { disabled: true },
            },
          })
          return { id: result?.id, name: result?.name ?? name }
        }
        default:
          throw new Error(`不支持的资源种类 ${kind}`)
      }
    },
  }
}
