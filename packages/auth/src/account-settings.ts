import type { TemplateConfig } from '@saas/config'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { z } from 'zod'
import {
  localeSchema,
  profileImageSchema,
  profileNameSchema,
  timezoneSchema,
} from './settings-schema.ts'

/**
 * 用户设置（tasks.md 5.2）在 Better Auth 接口上的服务端规则：
 * - `user.locale` / `user.timezone` 经 `/update-user` 写入，值由字段校验器限定（`userSettingsFields`）；
 * - `/update-user` 的 `name` / `image` 在执行前校验（Better Auth 对这两个字段不做校验）；
 * - 修改密码一律吊销该用户的其他会话（specs/user-auth「普通页面的吊销延迟」），不由客户端决定。
 */

/** `createAuth` 中 `user.additionalFields` 的定义：`null` 表示跟随浏览器 / 模板默认值 */
export function userSettingsFields(config: TemplateConfig) {
  return {
    locale: {
      type: 'string',
      required: false,
      validator: { input: localeSchema(config) },
    },
    timezone: {
      type: 'string',
      required: false,
      validator: { input: timezoneSchema },
    },
  } as const
}

const profileBody = z.looseObject({
  name: profileNameSchema.optional(),
  image: profileImageSchema.optional(),
})

export function accountSettings() {
  return {
    id: 'account-settings',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/update-user',
          handler: createAuthMiddleware(async (ctx) => {
            const result = profileBody.safeParse(ctx.body)
            if (!result.success) {
              throw APIError.from('BAD_REQUEST', {
                code: 'VALIDATION_ERROR',
                message: result.error.issues[0]?.message ?? 'Invalid profile',
              })
            }
            // 去掉首尾空白后的名字
            if (result.data.name !== undefined) {
              return { context: { body: { ...ctx.body, name: result.data.name } } }
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/change-password',
          // 无论客户端是否传入，都吊销其他会话；当前会话由 Better Auth 换发新会话
          handler: createAuthMiddleware(async (ctx) => ({
            context: { body: { ...ctx.body, revokeOtherSessions: true } },
          })),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
