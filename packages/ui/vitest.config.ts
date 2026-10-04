import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // 交互测试在 happy-dom 中渲染；SSR 测试在文件头用 `@vitest-environment node` 切换
    environment: 'happy-dom',
  },
})
