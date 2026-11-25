import { cn } from '@saas/ui'
import type { ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { Bone } from '../shared/bone.tsx'

// 账单页卡片外框与加载骨架单独成文件：路由的 pendingComponent 不参与默认代码分割，
// 与 billing-sections 同模块时会把账单区块、提示与积分领取组件带进每个页面的客户端入口包

export function BillingCard({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('grid content-start gap-2.5 rounded-xl border bg-card px-5 py-4', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export function BillingSkeleton() {
  return (
    <div role="status" aria-label={m.billing_page_loading()} className="grid gap-8">
      <div className="grid gap-2">
        <Bone className="h-7 w-48" />
        <Bone className="h-4 w-full max-w-lg" />
      </div>
      <BillingCard className="px-6 py-5">
        <Bone className="h-5 w-40" />
        <Bone className="h-3 w-full max-w-sm" />
      </BillingCard>
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((key) => (
          <BillingCard key={key}>
            <Bone className="h-4 w-28" />
            <Bone className="h-7 w-24" />
            <Bone className="h-3 w-3/4" />
          </BillingCard>
        ))}
      </div>
    </div>
  )
}
