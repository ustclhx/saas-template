import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { EnvValidationError, loadEnv } from './env.ts'
import { type NodeEnv, nodeEnvSchema, nodeEnvSchemaFor, nodeSecretNames } from './node-schema.ts'

import type { TemplateConfig } from './template.ts'

export { type NodeEnv, nodeEnvSchema, nodeEnvSchemaFor, nodeSecretNames } from './node-schema.ts'

export interface NodeEnvOptions {
  templateConfig?: Pick<TemplateConfig, 'auth'>
  /** 默认运行目录的 .env；false 禁止 dotenv 读取，显式路径不可读时失败。 */
  dotenvPath?: string | false
  /** 默认 process.env；只在调用时读取，不修改全局环境。 */
  env?: Readonly<Record<string, string | undefined>>
}

/** 在 listen/处理器启动前调用；抛错让启动入口非零退出，不输出原始驱动/文件错误。 */
export function loadNodeEnv(options: NodeEnvOptions = {}): NodeEnv {
  let dotenv: Record<string, string | undefined> = {}
  if (options.dotenvPath !== false) {
    try {
      dotenv = parseEnv(readFileSync(options.dotenvPath ?? '.env', 'utf8'))
    } catch (error) {
      // 仅默认文件不存在允许省略；显式文件错误必须让部署失败。
      if (options.dotenvPath !== undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new EnvValidationError([], ['DOTENV'])
    }
  }
  const source: Record<string, string | undefined> = { ...dotenv }
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined) source[key] = value
  }
  const invalid: string[] = []
  for (const key of nodeSecretNames) {
    const fileKey = `${key}_FILE`
    if (source[fileKey] === undefined) continue
    if (source[key] !== undefined) {
      invalid.push(key)
      continue
    }
    try {
      // 仅去掉一个文件末尾换行，不 trim 密钥中的空格或多余换行。
      const value = readFileSync(source[fileKey], 'utf8').replace(/\r?\n$/, '')
      if (value.length === 0) invalid.push(key)
      else source[key] = value
    } catch {
      invalid.push(key)
    }
  }
  if (invalid.length) throw new EnvValidationError([], invalid.sort())
  return loadEnv(
    source,
    options.templateConfig ? nodeEnvSchemaFor(options.templateConfig) : nodeEnvSchema,
  )
}
