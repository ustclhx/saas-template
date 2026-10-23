import { z } from 'zod'

// 在路由依赖解析 schema 前关闭浏览器 JIT；Zod 的 Function 探测也会触发 CSP 违规。
z.config({ jitless: true })
