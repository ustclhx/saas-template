import { withLogContext } from '@saas/shared/log'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { templateConfig } from '../template-config.ts'
import { checkEnv, pluginBindingStatus } from './env.ts'

// Node 单元测试只校验清单声明的绑定形状，不装配 Workerd Workflow adapter。
// 入口用例（server.ts）只走到静态资源与环境校验，Start 处理器与 Sentry 包装换成替身。
vi.mock('@saas/platform/cloudflare', () => ({
  createCloudflareWorkflow: vi.fn(),
  createCloudflareRequestMetadata: () => ({ requestId: 'entry-request', clientIp: null }),
}))
vi.mock('@tanstack/react-start/server', async (original) => ({
  ...(await original<typeof import('@tanstack/react-start/server')>()),
  createStartHandler: () => vi.fn(),
}))
vi.mock('./sentry.ts', async (original) => ({
  ...(await original<typeof import('./sentry.ts')>()),
  instrumentWeb: (handler: unknown) => handler,
}))

// 校验用例固定要求 OAuth 与 Turnstile，生成项目关闭登录方式时仍覆盖缺失变量。
vi.mock('../template-config.ts', async (original) => {
  const { templateConfig } = await original<typeof import('../template-config.ts')>()
  return {
    templateConfig: {
      ...templateConfig,
      auth: { ...templateConfig.auth, oauth: ['google', 'github'], turnstile: true },
      features: { ...templateConfig.features, publicApi: false },
    },
  }
})

const SECRET = 'postgres://app:super-secret@db.internal.example:5432/app'

/** 齐全的 env：Hyperdrive、形状正确的 Workflow / Queue / KV / Rate Limiting 绑定，以及模板配置要求的认证变量 */
function completeEnv() {
  const fn = () => undefined
  return {
    HYPERDRIVE: { connectionString: SECRET },
    AI_MEDIA_WORKFLOW: { create: fn, get: fn },
    // 模板启用的 agents 插件声明的 Durable Object 绑定（plugins.worker.gen.ts）
    AGENT_CONVERSATION: { idFromName: fn, get: fn },
    EMAIL_QUEUE: { send: fn },
    CACHE: { get: fn, put: fn, delete: fn },
    RL_AUTH: { limit: fn },
    RL_ADMIN_MCP: { limit: fn },
    RL_AI: { limit: fn },
    APP_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_SITE_KEY: 'turnstile-site-key',
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GITHUB_CLIENT_ID: 'github-id',
    GITHUB_CLIENT_SECRET: 'github-secret',
  }
}

function captureErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('checkEnv（请求入口的环境校验）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('缺少必需绑定时返回 500，日志只含变量名', async () => {
    const error = captureErrors()
    const { HYPERDRIVE: _, ...env } = completeEnv()
    const response = withLogContext({ requestId: 'env-request' }, () =>
      checkEnv({ ...env, OTHER_SECRET: SECRET }),
    )
    expect(response?.status).toBe(500)
    const body = await response?.text()
    expect(body).toBe('Internal Server Error')

    expect(error).toHaveBeenCalledTimes(1)
    const logged = error.mock.calls.flat().join(' ')
    expect(JSON.parse(logged)).toEqual({
      level: 'error',
      event: 'env.invalid',
      requestId: 'env-request',
      missing: ['HYPERDRIVE'],
      invalid: [],
    })
    expect(logged).not.toContain(SECRET)
  })

  it('绑定格式非法时返回 500，日志不含取值', () => {
    const error = captureErrors()
    const response = checkEnv({
      ...completeEnv(),
      HYPERDRIVE: { connectionString: '' },
      OTHER_SECRET: SECRET,
    })
    expect(response?.status).toBe(500)
    const logged = error.mock.calls.flat().join(' ')
    expect(JSON.parse(logged)).toEqual({
      level: 'error',
      event: 'env.invalid',
      missing: [],
      invalid: ['HYPERDRIVE'],
    })
    expect(logged).not.toContain(SECRET)
  })

  it('Queue 绑定形状非法时返回 500 并列出绑定名', () => {
    const error = captureErrors()
    expect(checkEnv({ ...completeEnv(), EMAIL_QUEUE: {} })?.status).toBe(500)
    expect(JSON.parse(error.mock.calls.flat().join(' '))).toMatchObject({
      missing: [],
      invalid: ['EMAIL_QUEUE'],
    })
  })

  it.skipIf(!templateConfig.plugins.media)(
    '插件绑定不进入全站校验：媒体缺 Workflow 绑定时只有该插件不可用，可选 AI 绑定可以省略',
    () => {
      const error = captureErrors()
      const { AI_MEDIA_WORKFLOW: _, ...env } = completeEnv()
      expect(checkEnv(env)).toBeNull()
      expect(pluginBindingStatus(env).media).toBe('unavailable')
      expect(JSON.parse(error.mock.calls.flat().join(' '))).toEqual({
        level: 'error',
        event: 'plugin.bindings_invalid',
        plugin: 'media',
        missing: ['AI_MEDIA_WORKFLOW'],
        invalid: [],
      })
    },
  )

  it.skipIf(!templateConfig.plugins['admin-mcp'])(
    '缺 RL_ADMIN_MCP 时公开页校验通过，只有 admin-mcp 标为不可用且同一 env 只记一次日志',
    () => {
      const error = captureErrors()
      const { RL_ADMIN_MCP: _, ...env } = completeEnv()
      expect(checkEnv(env)).toBeNull()
      const status = pluginBindingStatus(env)
      expect(status['admin-mcp']).toBe('unavailable')
      for (const [id, value] of Object.entries(status))
        if (id !== 'admin-mcp') expect(value, id).toBe('up')
      expect(pluginBindingStatus(env)).toBe(status)
      expect(error).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
        event: 'plugin.bindings_invalid',
        plugin: 'admin-mcp',
        missing: ['RL_ADMIN_MCP'],
      })
    },
  )

  it('插件绑定形状不对与缺失同样只影响该插件', () => {
    captureErrors()
    const plugins = [
      { id: 'sample', bindings: [{ name: 'RL_SAMPLE', kind: 'rate_limit' as const }] },
      { id: 'optional', bindings: [{ name: 'AI', kind: 'ai' as const, optional: true }] },
      { id: 'none', bindings: [] },
    ]
    expect(pluginBindingStatus({ RL_SAMPLE: {} }, plugins)).toEqual({
      sample: 'unavailable',
      optional: 'up',
    })
    expect(pluginBindingStatus({ RL_SAMPLE: { limit: () => undefined } }, plugins)).toEqual({
      sample: 'up',
      optional: 'up',
    })
  })

  it('缺少 KV / Rate Limiting 绑定与认证变量时一并列出（按模板配置要求）', () => {
    const error = captureErrors()
    const {
      CACHE: _c,
      RL_AUTH: _r,
      RL_AI: _a,
      BETTER_AUTH_SECRET: _s,
      GITHUB_CLIENT_SECRET: _g,
      TURNSTILE_SITE_KEY: _k,
      ...env
    } = completeEnv()
    const response = checkEnv({ ...env, TURNSTILE_SECRET_KEY: '' })
    expect(response?.status).toBe(500)
    const logged = error.mock.calls.flat().join(' ')
    expect(JSON.parse(logged)).toEqual({
      level: 'error',
      event: 'env.invalid',
      missing: [
        'BETTER_AUTH_SECRET',
        'CACHE',
        'GITHUB_CLIENT_SECRET',
        'RL_AI',
        'RL_AUTH',
        'TURNSTILE_SITE_KEY',
      ],
      invalid: ['TURNSTILE_SECRET_KEY'],
    })
    expect(logged).not.toContain('google-secret')
  })

  it('配置齐全时放行', () => {
    const error = captureErrors()
    const env = completeEnv()
    expect(checkEnv(env)).toBeNull()
    expect(checkEnv(env)).toBeNull()
    expect(error).not.toHaveBeenCalled()
  })

  it('非法文本出口在请求入口拒绝，日志只含字段名', () => {
    const error = captureErrors()
    expect(checkEnv({ ...completeEnv(), AI_TEXT_EGRESS: 'private-invalid' })?.status).toBe(500)
    const logged = error.mock.calls.flat().join(' ')
    expect(JSON.parse(logged).invalid).toEqual(['AI_TEXT_EGRESS'])
    expect(logged).not.toContain('private-invalid')
    expect(checkEnv({ ...completeEnv(), AI_TEXT_EGRESS: 'direct' })).toBeNull()
  })

  it('支付模式由入口工厂校验，不阻断公开页面', () => {
    expect(checkEnv({ ...completeEnv(), PAYMENT_MODE: 'invalid' })).toBeNull()
    expect(checkEnv({ ...completeEnv(), SENTRY_ENVIRONMENT: 'production' })).toBeNull()
  })

  it('故障开关只允许 staging enabled，生产 disabled 和未知环境开启均安全拒绝', () => {
    const error = captureErrors()
    for (const env of [
      { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'production' },
      { AI_FAULT_INJECTION: 'disabled', SENTRY_ENVIRONMENT: 'production' },
      { AI_FAULT_INJECTION: 'enabled' },
      { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'private-unknown' },
      { AI_FAULT_INJECTION: 'private-invalid', SENTRY_ENVIRONMENT: 'staging' },
    ])
      expect(checkEnv({ ...completeEnv(), ...env })?.status).toBe(500)
    for (const [logged] of error.mock.calls) {
      expect(JSON.parse(String(logged)).invalid).toEqual(['AI_FAULT_INJECTION'])
      expect(logged).not.toContain('private-')
    }
    for (const env of [
      { AI_FAULT_INJECTION: 'disabled' },
      { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'staging' },
    ])
      expect(checkEnv({ ...completeEnv(), ...env })).toBeNull()
  })
})

describe('预渲染页面不受运行时环境校验影响（public-site-availability）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('认证密钥缺失时预渲染首页 200，动态请求 500', async () => {
    const error = captureErrors()
    const { BETTER_AUTH_SECRET: _, ...env } = completeEnv()
    const assets = {
      fetch: vi.fn(async (request: Request) =>
        ['/', '/blog'].includes(new URL(request.url).pathname)
          ? new Response('<!doctype html><title>prerendered</title>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          : new Response('Not found', { status: 404 }),
      ),
    }
    const { default: entry } = await import('../../server.ts')
    const call = (path: string, init?: RequestInit) =>
      entry.fetch(
        new Request(`https://example.test${path}`, init) as Parameters<typeof entry.fetch>[0],
        { ...env, ASSETS: assets } as unknown as Cloudflare.Env,
        { waitUntil: () => undefined } as unknown as ExecutionContext,
      )

    for (const path of ['/', '/blog']) {
      const response = await call(path)
      expect(response.status, path).toBe(200)
      expect(await response.text()).toContain('prerendered')
      expect(response.headers.get('x-request-id')).toBe('entry-request')
    }
    const login = await call('/login')
    expect(login.status).toBe(500)
    expect(await login.text()).toBe('Internal Server Error')
    // 非 GET 请求不查静态资源，直接按校验结果返回
    expect((await call('/', { method: 'POST' })).status).toBe(500)
    const logged = error.mock.calls.map((args) => JSON.parse(String(args[0])))
    expect(logged).toContainEqual(
      expect.objectContaining({ event: 'env.invalid', missing: ['BETTER_AUTH_SECRET'] }),
    )
  })
})
