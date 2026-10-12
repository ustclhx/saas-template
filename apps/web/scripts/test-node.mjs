import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
// Node job 是干净 checkout，不能依赖另一个 CI job 生成的文案或内容。
for (const script of ['compile-messages.mjs', 'build-content.mjs']) {
  const result = spawnSync(process.execPath, [`scripts/${script}`], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const suites = [
  ['@saas/config', 'test'],
  ['@saas/ai', 'test'],
  ['@saas/web', 'exec', 'vitest', 'run', '--config', 'vitest.node.config.ts'],
  // DB 项目已经复用 credits 的账本/并发测试，避免重复运行同一组用例。
  ['@saas/db', 'test:node'],
  ['@saas/platform', 'test:node:integration'],
  ['@saas/auth', 'exec', 'vitest', 'run', '--config', 'vitest.node.config.ts'],
  ['@saas/billing', 'exec', 'vitest', 'run', '--config', 'vitest.node.config.ts'],
  ['@saas/entitlements', 'exec', 'vitest', 'run', '--config', 'vitest.node.config.ts'],
  ['@saas/web', 'exec', 'vitest', 'run', '--config', 'vitest.ai-node.config.ts'],
  ['@saas/web', 'exec', 'vitest', 'run', '--config', 'vitest.public.node.config.ts'],
  ['@saas/web', 'exec', 'vitest', 'run', '--config', 'vitest.files.node.config.ts'],
  ['@saas/web', 'exec', 'vitest', 'run', '--config', 'vitest.billing.node.config.ts'],
]

// 多个业务项目共享隔离数据库；顺序运行可防止清理夹具影响其他项目。
for (const suite of suites) {
  console.log(`\nRunning pnpm --filter ${suite.join(' ')}`)
  const result = spawnSync('pnpm', ['--filter', ...suite], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
