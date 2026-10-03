import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

// 集成测试前以 migrator 账号把迁移应用到本 worktree 的数据库（已应用的迁移会跳过）。
export default async function setup() {
  const url = process.env.MIGRATION_DATABASE_URL
  if (!url) throw new Error('MIGRATION_DATABASE_URL 未设置')
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(sql), {
      migrationsFolder: new URL('../migrations', import.meta.url).pathname,
    })
  } finally {
    await sql.end()
  }
}
