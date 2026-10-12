import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const mainLocalEnv = '/Users/hxlee/workspace/saas-template/.env.local'

export function readLocalAdminCredentials(env = process.env, envFile = mainLocalEnv) {
  let fileEnv: Record<string, string | undefined> = {}
  if (env.LOCAL_ADMIN_EMAIL === undefined || env.LOCAL_ADMIN_PASSWORD === undefined) {
    try {
      fileEnv = parseEnv(readFileSync(envFile, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  // 仅返回本地管理员键，不把主 checkout 的远程目标或其他密钥注入进程。
  const email = (env.LOCAL_ADMIN_EMAIL ?? fileEnv.LOCAL_ADMIN_EMAIL)?.trim().toLowerCase()
  const password = env.LOCAL_ADMIN_PASSWORD ?? fileEnv.LOCAL_ADMIN_PASSWORD
  return email && password ? { email, password } : undefined
}
