import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { getLocale } from '../../paraglide/runtime.js'
import { resolveHtmlAttributes } from './html-attributes.server.ts'

/** SSR 与预渲染走同一入口；结果由路由器序列化供水合复用，客户端不重新计算。 */
export const getHtmlAttributes = createServerFn({ method: 'GET' })
  .validator(z.object({ pathname: z.string().startsWith('/') }))
  .handler(({ data }) =>
    resolveHtmlAttributes({
      host: new URL(getRequest().url).host,
      locale: getLocale(),
      pathname: data.pathname,
    }),
  )
