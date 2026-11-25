// 项目自有：模板只创建本文件，之后不再修改（template-release 检查），template-sync 不会在这里冲突。
// 后台重新验证（step-up）的项目扩展点，只在 server function 内调用（service.server.ts）：
//   - stepUpVerificationColumns：写 `verification` 表时追加的列。衍生项目给该表加了必填列
//     （例如多站点的 `site`）时在这里返回；模板写入的列优先，同名键不会覆盖模板列。
//     每次发码或校验在事务前调用一次，可以查库（事务内不会另取连接）。
//   - stepUpEmailBrand：验证码邮件使用的应用名与站点地址，默认取模板配置与 APP_URL；
//     多站点项目可按请求的 Host 或用户所在站点返回对应品牌。
// 例如：
//
//   export async function stepUpVerificationColumns(userId: string, { db }: StepUpProjectContext) {
//     const [row] = await db.select({ site: user.site }).from(user).where(eq(user.id, userId))
//     return { site: row?.site ?? 'main' }
//   }
import type { Database } from '@saas/db'

export interface StepUpProjectContext {
  readonly db: Database
  /** 当前请求（server function 的请求） */
  readonly request: Request
}

export interface StepUpEmailBrand {
  readonly appName: string
  readonly appUrl: string
}

export function stepUpVerificationColumns(
  _userId: string,
  _context: StepUpProjectContext,
): Record<string, unknown> | Promise<Record<string, unknown>> {
  return {}
}

export function stepUpEmailBrand(
  defaults: StepUpEmailBrand,
  _context: StepUpProjectContext,
): StepUpEmailBrand | Promise<StepUpEmailBrand> {
  return defaults
}
