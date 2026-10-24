import { defineConfig } from '@playwright/test'

// 本地入口：沿用 fault.local.config 的隔离库、假上游与故障开关，只收集 harden-ai 两个 project。
// 每次运行默认新的 run ID，且不复用主 checkout 的固定本地管理员，使管理员与其个人空间都是新建的：
// 免费失败按空间每小时计、已开始任务的免费取消按空间终身计，复用空间会让结果不确定。
process.env.STAGING_ACCEPTANCE_RUN_ID ??= `local-harden-ai-${Date.now()}`
process.env.LOCAL_ADMIN_EMAIL ??= ''
process.env.LOCAL_ADMIN_PASSWORD ??= ''
// 本地 Workflow 同步执行，延迟启动才能让任务停留在 queued（staging 无此夹具，见 harden-ai.spec.ts）。
process.env.LOCAL_WORKFLOW_START_DELAY_MS ??= '15000'
const { default: base } = await import('./fault.local.config.ts')
const { default: root } = await import('./playwright.config.ts')

export default defineConfig({
  ...base,
  projects: (root.projects ?? []).filter((project) => project.name?.startsWith('harden-ai-')),
})
