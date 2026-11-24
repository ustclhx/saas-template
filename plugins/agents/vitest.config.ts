import { defineConfig } from 'vitest/config'

// 插件自身只跑 test/（清单与 Worker 侧）；src/web 的组件测试依赖 @web/* 别名，由 apps/web 的 unit 项目运行
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
