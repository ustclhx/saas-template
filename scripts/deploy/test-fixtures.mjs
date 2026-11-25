import { readFileSync } from 'node:fs'
import { parseJsonc } from '../production/check-wrangler-envs.mjs'

/** 测试夹具：读取仓库中已提交的 wrangler 配置。 */
export const wranglerText = (app) =>
  readFileSync(new URL(`../../apps/${app}/wrangler.jsonc`, import.meta.url), 'utf8')

export const template = () => ({
  web: parseJsonc(wranglerText('web')),
  jobs: parseJsonc(wranglerText('jobs')),
})

/** 模拟生成器输出：资源名加项目前缀，32 位 ID 换成占位序号，账号 vars 清空。 */
export function generatedTexts(prefix = 'acme') {
  let index = 0
  const text = ['web', 'jobs'].map((app) =>
    wranglerText(app)
      .replace(
        /("(?:name|script_name|queue|dead_letter_queue|bucket_name)"\s*:\s*")((?:web|jobs|email|events(?:-dlq)?|ai-media|files)(?:-staging|-production)?)"/g,
        `$1${prefix}-$2"`,
      )
      .replace(
        /("id"\s*:\s*")[a-f0-9]{32}"/g,
        (_match, key) => `${key}${(index++).toString(16).padStart(32, '0')}"`,
      )
      .replace(/("(?:AI_GATEWAY_ACCOUNT_ID|AI_GATEWAY_ID|R2_ACCOUNT_ID)"\s*:\s*")[^"]*"/g, '$1"'),
  )
  return { web: text[0], jobs: text[1] }
}

export function generated(prefix = 'acme') {
  const text = generatedTexts(prefix)
  return { web: parseJsonc(text.web), jobs: parseJsonc(text.jobs) }
}

/**
 * 假 Cloudflare API：按官方 API 参考的路径与响应形状模拟 KV、R2、Queues、Hyperdrive 的列表与创建。
 * `deny` 形如 `{ 'queue:create': 403 }`；`pageSize` 小于真实上限，用于覆盖翻页；
 * `failAfterCreates` 让第 N 次之后的创建返回 500，模拟中途失败。
 */
export function fakeCloudflare(seed = {}, { deny = {}, pageSize = 2, failAfterCreates } = {}) {
  const state = { kv: [], r2: [], queue: [], hyperdrive: [], ...structuredClone(seed) }
  const calls = []
  let sequence = 0
  let creates = 0
  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fail = (status, code) =>
    json(status, { success: false, errors: [{ code, message: 'secret body echo' }], result: null })
  const routes = [
    ['kv', /\/storage\/kv\/namespaces$/],
    ['r2', /\/r2\/buckets$/],
    ['queue', /\/queues$/],
    ['hyperdrive', /\/hyperdrive\/configs$/],
  ]
  async function fetch(input, init = {}) {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    const kind = routes.find(([, pattern]) => pattern.test(url.pathname))?.[0]
    calls.push({ method, kind, path: url.pathname, query: url.search, body, headers: init.headers })
    if (!kind) return fail(404, 7003)
    const action = method === 'GET' ? 'list' : 'create'
    if (deny[`${kind}:${action}`]) return fail(deny[`${kind}:${action}`], 10000)
    if (action === 'create') {
      creates += 1
      if (failAfterCreates !== undefined && creates > failAfterCreates) return fail(500, 10001)
      const name = body.title ?? body.name ?? body.queue_name
      if (kind === 'kv' && state.kv.some((item) => item.title === name)) return fail(400, 10014)
      sequence += 1
      const id = `${kind}${String(sequence).padStart(28, '0')}`.slice(-32)
      const created =
        kind === 'kv'
          ? { id, title: name }
          : kind === 'r2'
            ? { name }
            : kind === 'queue'
              ? { queue_id: id, queue_name: name }
              : { id, name, caching: body.caching, origin: { ...body.origin, password: undefined } }
      state[kind].push(created)
      return json(200, { success: true, errors: [], result: created })
    }
    const all = state[kind]
    if (kind === 'r2') {
      const start = Number(url.searchParams.get('cursor') ?? 0)
      const buckets = all.slice(start, start + pageSize)
      const next = start + pageSize < all.length ? String(start + pageSize) : undefined
      return json(200, {
        success: true,
        result: { buckets },
        result_info: { cursor: next, per_page: pageSize },
      })
    }
    const page = Number(url.searchParams.get('page') ?? 1)
    const result = all.slice((page - 1) * pageSize, page * pageSize)
    return json(200, {
      success: true,
      result,
      result_info: { page, per_page: pageSize, count: result.length, total_count: all.length },
    })
  }
  return { fetch, calls, state }
}
