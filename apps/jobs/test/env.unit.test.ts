import { EnvValidationError } from '@saas/config'
import { describe, expect, it, vi } from 'vitest'
import { requireEnv } from '../src/env.ts'

vi.mock('../src/plugins.gen.ts', () => ({
  default: [{ id: 'fixture', bindings: [{ name: 'WORKFLOW', kind: 'workflow' }] }],
}))

const valid = {
  HYPERDRIVE: { connectionString: 'fixture' },
  WORKFLOW: { create() {}, get() {} },
}

describe('jobs fault environment gate', () => {
  it('所有 jobs 事件入口拒绝不安全故障配置，错误只含变量名', () => {
    for (const env of [
      { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'production' },
      { AI_FAULT_INJECTION: 'disabled', SENTRY_ENVIRONMENT: 'production' },
      { AI_FAULT_INJECTION: 'enabled' },
      { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'private-unknown' },
      { AI_FAULT_INJECTION: 'private-invalid', SENTRY_ENVIRONMENT: 'staging' },
    ]) {
      expect(() => requireEnv({ ...valid, ...env })).toThrow(EnvValidationError)
      expect(() => requireEnv({ ...valid, ...env })).toThrow(
        'Invalid environment: invalid AI_FAULT_INJECTION',
      )
    }
    for (const env of [
      {},
      { AI_FAULT_INJECTION: 'disabled' },
      { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'staging' },
    ])
      expect(() => requireEnv({ ...valid, ...env })).not.toThrow()
  })
})
