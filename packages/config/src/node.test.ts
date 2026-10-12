import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvValidationError } from './env.ts'
import { loadNodeEnv } from './node.ts'
import { templateConfigDefaults } from './template.ts'

const valid = {
  DATABASE_URL: 'postgres://fixture:fixture@localhost/test',
  VALKEY_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'test-auth-secret-with-at-least-32-characters',
  APP_URL: 'https://example.test',
}
const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'node-config-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true })
})
function failure(fn: () => unknown, names: string[], values: string[]) {
  let error: unknown
  try {
    fn()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(EnvValidationError)
  const safe = error as EnvValidationError
  expect([...safe.missing, ...safe.invalid].sort()).toEqual(names.sort())
  const visible = [String(safe), safe.stack, JSON.stringify(safe)].join('\n')
  for (const value of values) expect(visible).not.toContain(value)
}

describe('Node runtime config', () => {
  it('Node 文本出口默认 direct，可显式选择 gateway，非法值启动失败且脱敏', () => {
    expect(loadNodeEnv({ dotenvPath: false, env: valid }).AI_TEXT_EGRESS).toBe('direct')
    expect(
      loadNodeEnv({ dotenvPath: false, env: { ...valid, AI_TEXT_EGRESS: 'gateway' } })
        .AI_TEXT_EGRESS,
    ).toBe('gateway')
    failure(
      () =>
        loadNodeEnv({ dotenvPath: false, env: { ...valid, AI_TEXT_EGRESS: 'private-invalid' } }),
      ['AI_TEXT_EGRESS'],
      ['private-invalid'],
    )
  })
  it('使用 dotenv 语法且进程环境优先，不改变 process.env，不要求 CF 或可选集成', () => {
    const path = join(directory(), '.env')
    writeFileSync(
      path,
      'export CACHE_NAMESPACE="fixture # quoted"\nDB_POOL_MAX=2\nPAYMENT_MODE=invalid\n',
    )
    const before = { ...process.env }
    const env = loadNodeEnv({ dotenvPath: path, env: { ...valid, DB_POOL_MAX: '3' } })
    expect(env.DB_POOL_MAX).toBe(3)
    expect(env.CACHE_NAMESPACE).toBe('fixture # quoted')
    // 模式仍由支付入口拒绝；配置错误不阻断公开页面和认证。
    expect(env.PAYMENT_MODE).toBe('invalid')
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    expect(env.TURNSTILE_SECRET_KEY).toBeUndefined()
    expect(env).not.toHaveProperty('HYPERDRIVE')
    expect(process.env).toEqual(before)
  })

  it('仅启用的 OAuth、Turnstile 和邮件通道要求凭据', () => {
    const disabled = { auth: { ...templateConfigDefaults.auth, oauth: [], turnstile: false } }
    expect(loadNodeEnv({ dotenvPath: false, env: valid, templateConfig: disabled }).APP_URL).toBe(
      valid.APP_URL,
    )
    failure(
      () =>
        loadNodeEnv({
          dotenvPath: false,
          env: valid,
          templateConfig: { auth: { ...disabled.auth, oauth: ['google'], turnstile: true } },
        }),
      ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'],
      [],
    )
    failure(
      () => loadNodeEnv({ dotenvPath: false, env: { ...valid, EMAIL_TRANSPORT: 'resend' } }),
      ['RESEND_API_KEY', 'EMAIL_FROM'],
      [],
    )
  })

  it('声明的文件密钥仅去掉一个末尾换行，输出剔除文件路径及无关变量', () => {
    const path = join(directory(), 'auth')
    const value = ` ${valid.BETTER_AUTH_SECRET} \n`
    writeFileSync(path, `${value}\r\n`)
    const { BETTER_AUTH_SECRET: _, ...env } = valid
    const loaded = loadNodeEnv({
      dotenvPath: false,
      env: {
        ...env,
        BETTER_AUTH_SECRET_FILE: path,
        UNKNOWN_FILE: '/unreadable',
        VITE_SECRET: 'private',
      },
    })
    expect(loaded.BETTER_AUTH_SECRET).toBe(value)
    expect(
      Object.keys(loaded).some((key) => key.endsWith('_FILE') || key.startsWith('VITE_')),
    ).toBe(false)
  })

  it('dotenv 和进程环境合并后直接值与 _FILE 冲突（包括空直接值）', () => {
    const path = join(directory(), '.env')
    writeFileSync(path, 'BETTER_AUTH_SECRET_FILE=/private/runtime/auth\n')
    for (const value of [valid.BETTER_AUTH_SECRET, '']) {
      failure(
        () => loadNodeEnv({ dotenvPath: path, env: { ...valid, BETTER_AUTH_SECRET: value } }),
        ['BETTER_AUTH_SECRET'],
        [valid.BETTER_AUTH_SECRET, '/private/runtime/auth'],
      )
    }
  })

  it('不可读或空文件仅报告变量名，无文件路径、内容或底层错误', () => {
    const dir = directory()
    const empty = join(dir, 'empty')
    writeFileSync(empty, '\n')
    const { BETTER_AUTH_SECRET: _, ...env } = valid
    for (const path of [join(dir, 'missing'), dir, empty, '']) {
      failure(
        () => loadNodeEnv({ dotenvPath: false, env: { ...env, BETTER_AUTH_SECRET_FILE: path } }),
        ['BETTER_AUTH_SECRET'],
        [dir, 'ENOENT', 'EISDIR'],
      )
    }
  })

  it('显式 dotenv 不可读会失败且隐藏路径', () => {
    const path = join(directory(), 'missing')
    failure(() => loadNodeEnv({ dotenvPath: path, env: valid }), ['DOTENV'], [path, 'ENOENT'])
  })

  it('必需 URL、secret 和池上限非法时只报告字段名', () => {
    const env = {
      ...valid,
      DATABASE_URL: 'https://private-database-host',
      VALKEY_URL: 'postgres://private-cache-host',
      BETTER_AUTH_SECRET: 'private-short-secret',
      APP_URL: 'http://example.test',
      DB_POOL_MAX: '0',
    }
    failure(
      () => loadNodeEnv({ dotenvPath: false, env }),
      ['DATABASE_URL', 'VALKEY_URL', 'BETTER_AUTH_SECRET', 'APP_URL', 'DB_POOL_MAX'],
      [
        'private-database-host',
        'private-cache-host',
        'private-short-secret',
        'http://example.test',
      ],
    )
    failure(() => loadNodeEnv({ dotenvPath: false, env: {} }), Object.keys(valid), [])
  })

  it('真实 Node 启动先校验，非法配置非零退出且未执行 listen', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `import { loadNodeEnv } from ${JSON.stringify(new URL('./node.ts', import.meta.url).href)};
       import { createServer } from 'node:http';
       try { loadNodeEnv({ dotenvPath: false, env: { DATABASE_URL: 'private-invalid-input' } }); }
       catch (error) { console.error(error.message); process.exit(1); }
       createServer().listen(0, () => console.log('LISTENED'));`,
      ],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Invalid environment:')
    expect(result.stderr).toContain('DATABASE_URL')
    expect(result.stderr).not.toContain('private-invalid-input')
    expect(result.stdout).not.toContain('LISTENED')
  })
})
