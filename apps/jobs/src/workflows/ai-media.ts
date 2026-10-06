import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { MEDIA_DONE_EVENT } from '@saas/shared'

/** 启动参数（P4 媒体生成时扩展） */
export interface AiMediaParams {
  taskId: string
}

/** 外部服务商回调后由 web 通过 `instance.sendEvent` 发送的 `MEDIA_DONE_EVENT` 事件负载 */
export interface MediaDonePayload {
  status: 'succeeded' | 'failed'
}

/**
 * AI 媒体生成 Workflow 的空壳（docs/06-ai.md）：一个示例 step + 等待回调事件。
 * 业务逻辑在 P4（add-ai-media-generation）实现。
 */
export class AiMediaWorkflow extends WorkflowEntrypoint<Cloudflare.Env, AiMediaParams> {
  override async run(event: WorkflowEvent<AiMediaParams>, step: WorkflowStep) {
    const submitted = await step.do('submit', async () => {
      console.log(JSON.stringify({ event: 'ai_media.submit', taskId: event.payload.taskId }))
      return { submittedAt: new Date().toISOString() }
    })

    const callback = await step.waitForEvent<MediaDonePayload>('wait for media done', {
      type: MEDIA_DONE_EVENT,
      timeout: '1 hour',
    })

    return { taskId: event.payload.taskId, ...submitted, status: callback.payload.status }
  }
}
