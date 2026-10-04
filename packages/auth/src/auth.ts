import { apiKey } from '@better-auth/api-key'
import type { TemplateConfig } from '@saas/config'
import type { Database } from '@saas/db'
import * as schema from '@saas/db/schema'
import { newId } from '@saas/shared'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import { admin, emailOTP, magicLink, organization, twoFactor } from 'better-auth/plugins'
import { accountSettings, userSettingsFields } from './account-settings.ts'
import { deletionPlugin } from './deletion.ts'
import type { SendAuthEmail } from './email.ts'
import { emailVerificationOptions } from './email-verification.ts'
import { type AuthEnv, parseAuthEnv } from './env.ts'
import { freshSessionGuard } from './fresh-session.ts'
import { passwordHasher } from './password.ts'
import { personalWorkspaceHooks } from './personal-workspace.ts'
import { authProtection } from './protection.ts'
import { sessionStorageOptions } from './session.ts'
import { type ResolveMaxSeats, teamWorkspaces } from './team-workspaces.ts'
import { verificationReservation } from './verification-reservation.ts'
import { workspaceLifecyclePlugin } from './workspace-lifecycle.ts'

export interface CreateAuthDeps {
  /** 模板配置（`template.config.ts`），决定启用哪些登录方式与插件 */
  readonly config: TemplateConfig
  /** 认证邮件的发送点；由调用方注入（后续接 EMAIL_QUEUE），测试中用假实现 */
  readonly sendEmail: SendAuthEmail
  readonly resolveMaxSeats?: ResolveMaxSeats
}

/**
 * 按请求创建 Better Auth 实例（design.md 决策 1）：每个请求传入该请求的 env 与 `createDb()` 实例，
 * 不要缓存到模块作用域。
 *
 * 登录方式按 `config.auth` 开关（specs/user-auth「可配置的登录方式」）：
 * - 邮箱密码关闭时注册 / 登录 / 找回密码接口返回错误；
 * - `emailOTP`、`magicLink`、`twoFactor` 关闭时不注册对应插件，其接口不存在（404）；
 * - 未启用的 OAuth 提供方不注册，以它发起登录会返回错误。
 * 数据库 schema 始终包含全部插件的表与字段（packages/db/src/schema/auth.ts），开关只影响接口。
 */
export function createAuth(env: AuthEnv, db: Database, deps: CreateAuthDeps) {
  const { config, sendEmail } = deps
  const vars = parseAuthEnv(env, config)

  return betterAuth({
    appName: config.app.name,
    baseURL: vars.APP_URL,
    basePath: '/api/auth',
    secret: vars.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    // 会话三层：Cookie 缓存 → KV → 数据库（session.ts）
    ...sessionStorageOptions(env.CACHE),
    advanced: {
      // 主键统一为 UUIDv7（design.md 决策 2），列类型为 uuid
      database: { generateId: () => newId() },
    },
    // 注册即创建个人空间，新会话默认以个人空间为活跃空间（personal-workspace.ts）
    databaseHooks: personalWorkspaceHooks(db),
    user: {
      deleteUser: { enabled: false },
      // 用户设置中的语言与时区（tasks.md 5.2），取值由校验器限定
      additionalFields: userSettingsFields(config),
    },
    emailAndPassword: {
      enabled: config.auth.emailPassword,
      requireEmailVerification: config.auth.requireEmailVerification,
      password: passwordHasher,
      // 经找回密码重置后与修改密码一样吊销全部会话（specs/user-auth「普通页面的吊销延迟」）
      revokeSessionsOnPasswordReset: true,
      // 不提供 sendResetPassword 时找回密码接口返回错误；关闭邮箱密码时找回密码一并关闭
      ...(config.auth.emailPassword && {
        sendResetPassword: async ({ user, url }) => {
          await sendEmail({ type: 'reset-password', to: user.email, url })
        },
      }),
    },
    emailVerification: emailVerificationOptions(config, sendEmail),
    socialProviders: socialProviders(config, vars),
    plugins: [
      // 认证入口防刷：RL_AUTH 限流 + Turnstile（protection.ts）
      authProtection({
        rateLimiter: env.RL_AUTH,
        turnstileSecret: config.auth.turnstile ? (vars.TURNSTILE_SECRET_KEY ?? null) : null,
      }),
      // 敏感接口按数据库实时校验会话与封禁（fresh-session.ts）
      freshSessionGuard(db),
      deletionPlugin(db, env.CACHE, config.tenancy.multiTenant),
      verificationReservation(db),
      workspaceLifecyclePlugin(db, config.tenancy.maxWorkspacesPerUser),
      teamWorkspaces(db, config, sendEmail, deps.resolveMaxSeats),
      // 用户设置：资料校验、修改密码时吊销其他会话（account-settings.ts）
      accountSettings(),
      organization({
        // 团队空间的创建准入由 multiTenant 决定；个人空间由服务端创建（tasks.md 4.1）
        allowUserToCreateOrganization: config.tenancy.multiTenant,
        // organization 只软删、从不物理删除（docs/03-data-model.md §7）
        disableOrganizationDeletion: true,
        organizationHooks: {
          beforeCreateOrganization: async () => {
            throw APIError.from('FORBIDDEN', {
              code: 'USE_WORKSPACE_CREATION',
              message: 'Use authenticated workspace creation',
            })
          },
          // Native server-only addMember cannot skip workspace admission.
          beforeAddMember: async () => {
            throw APIError.from('FORBIDDEN', {
              code: 'USE_WORKSPACE_INVITATION',
              message: 'Use the workspace invitation flow',
            })
          },
        },
        schema: {
          organization: {
            additionalFields: {
              isPersonal: { type: 'boolean', required: true, defaultValue: false, input: false },
              deletedAt: { type: 'date', required: false, input: false },
            },
          },
        },
        sendInvitationEmail: async ({ email, id, role, organization, inviter }) => {
          await sendEmail({
            type: 'invitation',
            to: email,
            invitationId: id,
            workspaceName: organization.name,
            inviterName: inviter.user.name,
            role,
          })
        },
      }),
      admin(),
      ...(config.auth.emailOtp
        ? [
            emailOTP({
              sendVerificationOTP: async ({ email, otp, type }) => {
                await sendEmail({ type: 'otp', to: email, otp, purpose: type })
              },
            }),
          ]
        : []),
      ...(config.auth.magicLink
        ? [
            magicLink({
              sendMagicLink: async ({ email, url }) => {
                await sendEmail({ type: 'magic-link', to: email, url })
              },
            }),
          ]
        : []),
      ...(config.auth.twoFactor ? [twoFactor({ issuer: config.app.name })] : []),
      // 公开 API 的密钥按用户归属，workspace 记在 metadata 中（docs/03-data-model.md §1）
      ...(config.features.publicApi ? [apiKey({ references: 'user' })] : []),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

function socialProviders(config: TemplateConfig, vars: ReturnType<typeof parseAuthEnv>) {
  const providers: {
    google?: { clientId: string; clientSecret: string }
    github?: { clientId: string; clientSecret: string }
  } = {}
  for (const provider of config.auth.oauth) {
    if (provider === 'google' && vars.GOOGLE_CLIENT_ID && vars.GOOGLE_CLIENT_SECRET) {
      providers.google = {
        clientId: vars.GOOGLE_CLIENT_ID,
        clientSecret: vars.GOOGLE_CLIENT_SECRET,
      }
    }
    if (provider === 'github' && vars.GITHUB_CLIENT_ID && vars.GITHUB_CLIENT_SECRET) {
      providers.github = {
        clientId: vars.GITHUB_CLIENT_ID,
        clientSecret: vars.GITHUB_CLIENT_SECRET,
      }
    }
  }
  return providers
}
