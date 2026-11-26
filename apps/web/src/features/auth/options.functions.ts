import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { authUiOptions, parseLastLoginMethod } from './options.ts'

/**
 * 认证页面的 loader：在服务端读取模板配置与 env，只返回公开的部分。
 * lastMethod 取自本浏览器的「上次登录方式」Cookie，服务端读取使首屏即可标出，避免水合后闪动。
 */
export const getAuthUiOptions = createServerFn({ method: 'GET' }).handler(() => ({
  ...authUiOptions(templateConfig, getWebRuntime().config),
  lastMethod: parseLastLoginMethod(getRequest().headers.get('cookie')),
}))
