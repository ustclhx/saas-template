import { createAuthClient } from 'better-auth/client'
import { inferAdditionalFields, twoFactorClient } from 'better-auth/client/plugins'

// 浏览器端调用 Better Auth 接口（/api/auth/*）。只在事件处理中使用，首次调用时创建。
// TODO(p1-auth-ui 合并后)：与认证页面的 auth client 合并为一个
function create() {
  return createAuthClient({
    basePath: '/api/auth',
    plugins: [
      // user 表的扩展字段（packages/auth 的 userSettingsFields），让 updateUser 接受 locale / timezone
      inferAdditionalFields({
        user: {
          locale: { type: 'string', required: false },
          timezone: { type: 'string', required: false },
        },
      }),
      // 两步验证接口只在模板配置 auth.twoFactor=true 时存在；页面按配置决定是否显示
      twoFactorClient(),
    ],
  })
}

let client: ReturnType<typeof create> | undefined
export function authClient() {
  client ??= create()
  return client
}
