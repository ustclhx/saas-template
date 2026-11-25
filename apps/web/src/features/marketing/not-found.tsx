import { Button } from '@saas/ui'
import { Link, useRouter, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { isAppAreaPath } from '../i18n/app-area.ts'
import { MarketingShell } from './marketing-shell.tsx'

/** 404 与兜底错误页共用的布局：套营销页头页脚，给出回到站内的路径；关闭营销站或在应用区时回到应用区。 */
function StatusPage({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  const inApp = useRouterState({ select: (state) => isAppAreaPath(state.location.pathname) })
  const marketing = templateConfig.marketing.enabled && !inApp
  const content = (
    <div className="mx-auto grid max-w-xl gap-4 px-4 py-24 text-center">
      <h1 className="font-bold text-4xl tracking-tight">{title}</h1>
      <p className="text-muted-foreground">{body}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild>
          <Link to={marketing ? '/' : '/app'}>{m.marketing_not_found_home()}</Link>
        </Button>
        {action}
      </div>
    </div>
  )
  return templateConfig.marketing.enabled ? (
    <MarketingShell>{content}</MarketingShell>
  ) : (
    <main>{content}</main>
  )
}

/** 未匹配的地址都落到这里。 */
export function NotFoundPage() {
  return <StatusPage title={m.marketing_not_found_title()} body={m.marketing_not_found_body()} />
}

/**
 * 兜底错误界面（public-site-availability「兜底错误界面」）：渲染或数据读取发生未处理错误时代替框架默认错误页，
 * 不显示错误详情（可能含内部信息）；错误已由服务端入口记录与上报。重试会重新执行当前路由的 loader。
 */
export function ErrorPage() {
  const router = useRouter()
  return (
    <StatusPage
      title={m.marketing_error_title()}
      body={m.marketing_error_body()}
      action={
        <Button variant="outline" onClick={() => void router.invalidate()}>
          {m.marketing_error_retry()}
        </Button>
      }
    />
  )
}
