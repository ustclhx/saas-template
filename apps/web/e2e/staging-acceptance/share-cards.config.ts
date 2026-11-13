import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

// add-og-images 8.2 独立入口：需要人工完成管理员登录，默认验收配置不收集。
export default defineConfig({
  ...base,
  timeout: 20 * 60_000,
  workers: 1,
  retries: 0,
  use: { ...base.use, headless: false },
  projects: [{ name: 'share-cards', testMatch: 'share-cards.spec.ts' }],
})
