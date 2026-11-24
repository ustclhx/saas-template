import { defineConfig } from 'vitest/config'
import { webAlias } from './scripts/web-alias.ts'

export default defineConfig({
  // 插件代码经 @web/* 访问 web 核心模块
  plugins: [webAlias()],
  test: {
    environment: 'node',
    include: ['test/files-node/*.node.ts', 'src/features/files/http.test.ts'],
  },
})
