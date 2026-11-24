import assert from 'node:assert/strict'
import test from 'node:test'

// 在关闭 media 的本地生产构建上运行。使用隔离数据库中测试账号的空间 slug 和 Cookie 请求头。
// MEDIA_DISABLED_BASE_URL=http://127.0.0.1:4173 MEDIA_DISABLED_WORKSPACE_SLUG="$fixtureSlug" \
// MEDIA_DISABLED_SESSION_COOKIE="$fixtureCookie" node --test apps/web/e2e/media-disabled.mjs
const baseUrl = process.env.MEDIA_DISABLED_BASE_URL
const slug = process.env.MEDIA_DISABLED_WORKSPACE_SLUG
const cookie = process.env.MEDIA_DISABLED_SESSION_COOKIE
assert.ok(baseUrl, 'Set MEDIA_DISABLED_BASE_URL to the isolated preview origin')
const origin = new URL(baseUrl)
assert.ok(
  origin.protocol === 'http:' &&
    ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname) &&
    origin.port &&
    origin.href === `${origin.origin}/`,
  'MEDIA_DISABLED_BASE_URL must be an HTTP loopback origin with an explicit port',
)
assert.ok(slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug), 'Set a valid fixture workspace slug')
assert.ok(cookie, 'Set MEDIA_DISABLED_SESSION_COOKIE to the fixture member’s Cookie header')

async function status(path, init) {
  const response = await fetch(new URL(path, origin), {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })
  await response.body?.cancel()
  return response.status
}

const taskId = '019a0000-0000-7000-8000-000000000001'

test('workspace members get 200 on the workspace and 404 on its media pages', async () => {
  const workspace = `/app/${slug}`
  const request = { headers: { accept: 'text/html', cookie } }
  assert.equal(
    await status(workspace, request),
    200,
    'The fixture member must access the workspace',
  )

  for (const path of ['/media/new', '/tasks', `/tasks/${taskId}`]) {
    assert.equal(await status(`${workspace}${path}`, request), 404, `GET ${path}`)
  }
})

for (const [method, path] of [
  ['POST', '/api/webhooks/media/fal'],
  ['GET', '/api/ai/tasks'],
  ['POST', '/api/ai/tasks'],
  ['GET', `/api/ai/tasks/${taskId}`],
  ['POST', `/api/ai/tasks/${taskId}/cancel`],
  ['POST', '/api/v1/tasks'],
  ['GET', `/api/v1/tasks/${taskId}`],
]) {
  test(`anonymous ${method} ${path} returns 404`, async () => {
    const request =
      method === 'POST'
        ? { method, headers: { 'content-type': 'application/json' }, body: '{}' }
        : { method }
    assert.equal(await status(path, request), 404)
  })
}
