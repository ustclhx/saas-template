// 生成插件注册文件（已 gitignore）：web / jobs 的 typecheck、test、build、dev 前置调用，
// web 的 Vite 配置也会在解析时调用（apps/web/scripts/vite-shared.ts）。配置或清单错误时以非零码退出。
import { generatePlugins } from './plugins.mjs'

try {
  const { plugins } = await generatePlugins()
  if (process.argv.includes('--verbose'))
    console.log(`[plugins] 启用：${plugins.map(({ manifest }) => manifest.id).join(', ') || '无'}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
