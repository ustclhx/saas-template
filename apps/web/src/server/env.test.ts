import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkEnv } from './env.ts'

const SECRET = 'postgres://app:super-secret@db.internal.example:5432/app'

/** 齐全的 env：Hyperdrive 加上形状正确的 Workflow / Queue 绑定 */
function completeEnv() {
  const fn = () => undefined
  return {
    HYPERDRIVE: { connectionString: SECRET },
    AI_MEDIA_WORKFLOW: { create: fn, get: fn },
    EMAIL_QUEUE: { send: fn },
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
    const response = checkEnv({ ...env, OTHER_SECRET: SECRET })
    expect(response?.status).toBe(500)
    const body = await response?.text()
    expect(body).toBe('Internal Server Error')

    expect(error).toHaveBeenCalledTimes(1)
    const logged = error.mock.calls.flat().join(' ')
    expect(JSON.parse(logged)).toEqual({
      event: 'env.invalid',
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
      event: 'env.invalid',
      missing: [],
      invalid: ['HYPERDRIVE'],
    })
    expect(logged).not.toContain(SECRET)
  })

  it('缺少 Workflow / Queue 绑定时返回 500 并列出绑定名', () => {
    const error = captureErrors()
    const response = checkEnv({ HYPERDRIVE: { connectionString: SECRET }, EMAIL_QUEUE: {} })
    expect(response?.status).toBe(500)
    expect(JSON.parse(error.mock.calls.flat().join(' '))).toEqual({
      event: 'env.invalid',
      missing: ['AI_MEDIA_WORKFLOW'],
      invalid: ['EMAIL_QUEUE'],
    })
  })

  it('配置齐全时放行', () => {
    const error = captureErrors()
    const env = completeEnv()
    expect(checkEnv(env)).toBeNull()
    expect(checkEnv(env)).toBeNull()
    expect(error).not.toHaveBeenCalled()
  })
})
