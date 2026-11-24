import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@saas/ui'
import { useNavigate } from '@tanstack/react-router'
import { chatErrorMessage } from '@web/features/ai/conversation.ts'
import type { PickerModel } from '@web/features/ai/model-picker.ts'
import { ModelPicker } from '@web/features/ai/model-picker.tsx'
import { m } from '@web/paraglide/messages.js'
import { useId, useState } from 'react'
import { createAgentConversation } from './agents.functions.ts'
import type { AgentOption } from './catalog.ts'
import { useDesktop } from './use-desktop.ts'

const CREATE_ERRORS: Record<string, () => string> = {
  AGENT_NOT_FOUND: () => m.agents_error_agent_not_found(),
}
export const createErrorMessage = (code: string) =>
  CREATE_ERRORS[code]?.() ?? chatErrorMessage(code)

export interface NewAgentDialogProps {
  readonly slug: string
  readonly agents: readonly AgentOption[]
  readonly models: readonly PickerModel[]
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

/** agent 选择：按钮组（aria-pressed），选中项加粗描边（设计稿 List.dc.html 的 pick） */
function AgentPicker({
  agents,
  value,
  onChange,
  withTools,
}: {
  agents: readonly AgentOption[]
  value: string
  onChange: (id: string) => void
  withTools: boolean
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 font-medium text-caption">{m.agents_new_agent()}</legend>
      {agents.map((agent) => {
        const selected = agent.id === value
        return (
          <button
            key={agent.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(agent.id)}
            className={cn(
              'flex min-h-11 flex-col gap-1 rounded-lg px-3.5 py-3 text-left outline-none transition-colors',
              'focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2',
              selected
                ? 'inset-ring-2 inset-ring-foreground'
                : 'inset-ring inset-ring-border hover:bg-hover',
            )}
          >
            <span className="font-medium">{agent.name}</span>
            <span className="text-caption text-muted-foreground">
              {withTools && agent.tools.length
                ? m.agents_new_agent_tools({
                    description: agent.description,
                    tools: agent.tools.join('、'),
                  })
                : agent.description}
            </span>
          </button>
        )
      })}
    </fieldset>
  )
}

/**
 * 新建 agent 对话（设计稿 List.dc.html 的弹窗、ListMobile.dc.html 的底部面板）：选 agent 与模型后
 * 创建对话并进入对话页。模型只列出支持工具调用且当前套餐可用的（`listAgentConversations` 已过滤）。
 */
export function NewAgentDialog({ slug, agents, models, open, onOpenChange }: NewAgentDialogProps) {
  const desktop = useDesktop()
  const navigate = useNavigate()
  const hintId = useId()
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [modelId, setModelId] = useState(models[0]?.id)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const model = models.find((item) => item.id === modelId) ?? models[0]

  async function start() {
    if (!model || !agentId) return
    setPending(true)
    setError(null)
    const result = await createAgentConversation({
      data: { slug, agentId, modelId: model.id },
    })
    if (!result.ok) {
      setError(createErrorMessage(result.error))
      setPending(false)
      return
    }
    await navigate({
      to: '/app/$slug/agents/$conversationId',
      params: { slug, conversationId: result.result.id },
    })
  }

  const body = (
    <>
      <AgentPicker agents={agents} value={agentId} onChange={setAgentId} withTools={desktop} />
      <div className="flex flex-col gap-1.5">
        <ModelPicker models={models} value={model?.id} onChange={setModelId} disabled={pending} />
        <span id={hintId} className="text-caption text-muted-foreground">
          {m.agents_new_model_hint()}
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
    </>
  )
  const startButton = (
    <Button
      type="button"
      disabled={pending || !model || !agentId}
      onClick={() => void start()}
      className={cn(!desktop && 'h-11')}
    >
      {m.agents_new_start()}
    </Button>
  )
  const cancelButton = (
    <Button
      type="button"
      variant="outline"
      onClick={() => onOpenChange(false)}
      className={cn(!desktop && 'h-11')}
    >
      {m.agents_new_cancel()}
    </Button>
  )

  if (desktop)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{m.agents_new_title()}</DialogTitle>
            <DialogDescription>{m.agents_new_description()}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-5">{body}</div>
          <DialogFooter>
            {cancelButton}
            {startButton}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false}>
        <div className="flex flex-col gap-4 px-4 pt-2 pb-6">
          <SheetTitle>{m.agents_new_title()}</SheetTitle>
          <SheetDescription className="sr-only">{m.agents_new_description()}</SheetDescription>
          {body}
          {startButton}
          {cancelButton}
        </div>
      </SheetContent>
    </Sheet>
  )
}
