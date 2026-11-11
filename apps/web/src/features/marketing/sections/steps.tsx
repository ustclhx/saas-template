import { cn } from '@saas/ui'
import { m } from '../../../paraglide/messages.js'

const steps = [
  { title: m.marketing_step_1_title, body: m.marketing_step_1_body },
  { title: m.marketing_step_2_title, body: m.marketing_step_2_body },
  { title: m.marketing_step_3_title, body: m.marketing_step_3_body },
]

/** 三步流程（openspec add-ui-design-system 8.5）：文案在 messages/<locale>/marketing-blocks.json */
export function Steps() {
  return (
    <section id="steps" aria-labelledby="steps-title" className="py-20">
      <div className="mx-auto grid max-w-6xl gap-10 px-4">
        <div className="grid justify-items-center gap-2 text-center">
          <p className="font-medium text-caption text-muted-foreground">
            {m.marketing_steps_eyebrow()}
          </p>
          <h2 id="steps-title" className="font-bold text-3xl tracking-tight">
            {m.marketing_steps_title()}
          </h2>
        </div>
        <ol className="m-0 grid list-none gap-8 p-0 md:grid-cols-3">
          {steps.map((step, index) => (
            <li key={step.title()} className="grid content-start gap-3">
              <div className="flex items-center gap-3">
                {/* 编号由有序列表语义表达，圆形数字只作视觉 */}
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground text-subtitle"
                >
                  {index + 1}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'hidden h-px flex-1 bg-border md:block',
                    index === steps.length - 1 && 'md:hidden',
                  )}
                />
              </div>
              <h3 className="font-semibold text-title">{step.title()}</h3>
              <p className="text-body text-muted-foreground">{step.body()}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
