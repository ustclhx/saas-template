import { defineConfig } from '@playwright/test'
import { hardenProjects } from './harden-auth.config.ts'
import local from './local.config.ts'

// 复用 local.config.ts 的隔离库校验、本地账号种子与 dev 服务，只换成 harden 的 projects。
export default defineConfig({ ...local, projects: hardenProjects })
