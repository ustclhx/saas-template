import { defineConfig } from 'drizzle-kit'
import { readLocalEnv } from './worktree-env.ts'

// drizzle-kit 一律以 migrator 账号连接（app 账号只有 DML）；没有配置时使用主 checkout 的 saas_dev。
const url =
  readLocalEnv('MIGRATION_DATABASE_URL') ?? 'postgres://migrator:migrator@localhost:5432/saas_dev'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
