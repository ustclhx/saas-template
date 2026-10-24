import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

// harden-audit-findings 7.3（auth 领域）显式入口；默认 acceptance 配置不收集这些用例。
// 三个 project 各自独立运行；harden-auth 会触发认证限流，需在其它验收之后最后执行。
export const hardenProjects = [
  { name: 'harden-csp', testMatch: 'harden-csp.spec.ts' },
  { name: 'harden-deletion', testMatch: 'harden-deletion.spec.ts', timeout: 30 * 60_000 },
  { name: 'harden-auth', testMatch: 'harden-auth.spec.ts', timeout: 25 * 60_000 },
]

export default defineConfig({ ...base, projects: hardenProjects })
