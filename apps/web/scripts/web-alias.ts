import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

// 插件访问 web 核心模块的路径别名（openspec add-plugin-system 决策 1 验证结果）：`@web/*` → `apps/web/src/*`。
// 只在 web 的构建、dev 与测试中可解析；tsconfig 的 paths 同名。jobs 不配置，插件的 jobs 入口不能导入 web。
export const WEB_SRC = fileURLToPath(new URL('../src/', import.meta.url))

export function webAlias(): Plugin {
  return {
    name: 'saas:web-alias',
    config: () => ({ resolve: { alias: [{ find: /^@web\//, replacement: WEB_SRC }] } }),
  }
}
