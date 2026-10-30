import { Button } from '@saas/ui'
import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { MarketingShell } from './marketing-shell.tsx'

/** 未匹配的地址都落到这里：给出回到站内的路径，关闭营销站时回到应用区。 */
export function NotFoundPage() {
  const body = (
    <div className="mx-auto grid max-w-xl gap-4 px-4 py-24 text-center">
      <h1 className="font-bold text-4xl tracking-tight">{m.marketing_not_found_title()}</h1>
      <p className="text-muted-foreground">{m.marketing_not_found_body()}</p>
      <div>
        <Button asChild>
          <Link to={templateConfig.marketing.enabled ? '/' : '/app'}>
            {m.marketing_not_found_home()}
          </Link>
        </Button>
      </div>
    </div>
  )
  return templateConfig.marketing.enabled ? (
    <MarketingShell>{body}</MarketingShell>
  ) : (
    <main>{body}</main>
  )
}
