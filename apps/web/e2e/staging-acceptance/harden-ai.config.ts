import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

// harden-audit-findings 7.3（AI）独立入口：用例会临时修改后台运行时设置，默认验收配置不收集。
export default defineConfig({
  ...base,
  timeout: 40 * 60_000,
  workers: 1,
  retries: 0,
  use: { ...base.use, headless: false },
  projects: [
    { name: 'harden-ai-text', testMatch: 'harden-ai.spec.ts', grep: /@harden-ai-text/ },
    { name: 'harden-ai-media', testMatch: 'harden-ai.spec.ts', grep: /@harden-ai-media/ },
  ],
})
