import { cn } from '@saas/ui'
import { m } from '../../../paraglide/messages.js'

export interface StatItem {
  readonly value: string
  readonly label: string
}

/**
 * 数据背书条（openspec add-ui-design-system 8.5，marketing-site「数据背书区块不伪造数据」）：
 * 数值与来源只来自项目配置，没有数值时整个区块不渲染，模板不提供默认数字。
 * 窄屏两列、桌面一行；分隔线按位置计算，不依赖任意值选择器。
 */
export function Stats({ items, source }: { items: readonly StatItem[]; source?: string | null }) {
  if (items.length === 0) return null
  const desktopCols = ['', 'md:grid-cols-1', 'md:grid-cols-2', 'md:grid-cols-3', 'md:grid-cols-4']
  return (
    <section aria-label={m.marketing_stats_label()} className="pb-6">
      <div className="mx-auto grid max-w-6xl gap-2 px-4">
        <dl
          className={cn(
            'm-0 grid grid-cols-2 overflow-hidden rounded-xl bg-card shadow-surface-2',
            items.length === 1 && 'grid-cols-1',
            desktopCols[items.length],
          )}
        >
          {items.map((item, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 配置顺序固定，标签允许重复
              key={index}
              className={cn(
                'flex flex-col-reverse gap-1 border-border px-6 py-5',
                // 窄屏 2 列：第二列画左分隔线，第二行起画上分隔线；桌面单行：除首项外画左分隔线
                index % 2 === 1 && 'border-l',
                index >= 2 && 'border-t',
                'md:border-t-0',
                index > 0 ? 'md:border-l' : 'md:border-l-0',
              )}
            >
              <dt className="text-body text-muted-foreground">{item.label}</dt>
              <dd className="m-0 font-semibold text-display tabular-nums">{item.value}</dd>
            </div>
          ))}
        </dl>
        {source ? (
          <p className="justify-self-end text-caption text-muted-foreground">{source}</p>
        ) : null}
      </div>
    </section>
  )
}
