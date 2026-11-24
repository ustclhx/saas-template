import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat'
import { log } from '@saas/shared/log'
import { convertToModelMessages, stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { agentsConfig } from './config.ts'
import { createSpikeModel } from './spike-model.ts'

// 每个 agent 对话一个实例（openspec add-ai-agents 决策 1），实例名为 PG ai_conversation.id。
// 当前为技术验证（1.1 / 1.2）留下的最小实现，后续 4.3 在此基础上接入：
// TODO(3.2)：首次请求记住归属（workspaceId、userId），之后逐请求比对 x-saas-* 头。
// TODO(4.1/4.2)：每轮调用前检查、建 ai_agent_turn 与预扣、按 onStepEnd / onEnd 用量结算。
// TODO(4.3)：按 agent 定义组装系统提示词、模型（注册表）与工具集，替换脚本化模型与示例工具。
// SDK 类只出现在 src/worker/（决策 10）；租户状态只放实例字段或实例存储，不放模块级变量（决策 11）。

const { maxSteps, maxPersistedMessages } = agentsConfig

export class AgentConversation extends AIChatAgent<Cloudflare.Env> {
  override maxPersistedMessages = maxPersistedMessages

  // 必须写成类字段：SDK 在每次唤醒时先评估恢复预算，再运行 onStart（见 AIChatAgent.chatRecovery 注释）
  override chatRecovery = {
    maxInterruptedAttempts: 2,
    // 第二次及以后的恢复尝试前调用；返回 false 即停止恢复（reason = recovery_aborted）。
    // TODO(4.3)：按 recoveryRootRequestId 读取本轮已记录的消耗，超过预扣封顶时返回 false。
    shouldKeepRecovering: (ctx: {
      recoveryRootRequestId: string
      attempt: number
      work: number
    }) => {
      const keep = !this.recoveryStopped(ctx.recoveryRootRequestId)
      log.info('agents.recovery.check', {
        conversationId: this.name,
        recoveryRootRequestId: ctx.recoveryRootRequestId,
        attempt: ctx.attempt,
        work: ctx.work,
        keep,
      })
      return keep
    },
    onExhausted: (ctx: { recoveryRootRequestId: string; attempt: number; reason: string }) => {
      // TODO(4.2)：按最后检查点结算本轮
      log.warn('agents.recovery.exhausted', {
        conversationId: this.name,
        recoveryRootRequestId: ctx.recoveryRootRequestId,
        attempt: ctx.attempt,
        reason: ctx.reason,
      })
    },
  }

  override async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const requestId = options?.requestId
    log.info('agents.turn.start', {
      conversationId: this.name,
      requestId,
      continuation: options?.continuation ?? false,
      messageCount: this.messages.length,
    })
    const result = streamText({
      model: createSpikeModel({
        onCall: ({ kind, call }) =>
          log.info('agents.model.call', { conversationId: this.name, requestId, kind, call }),
      }),
      system: 'You are a helpful assistant.',
      messages: await convertToModelMessages(this.messages),
      tools: {
        current_time: tool({
          description: 'Current UTC time',
          inputSchema: z.object({}),
          execute: async () => ({ now: new Date().toISOString() }),
        }),
        spike_write: tool({
          description: 'A side-effecting tool that requires user approval',
          inputSchema: z.object({ note: z.string() }),
          needsApproval: true,
          execute: async ({ note }) => {
            log.info('agents.tool.executed', { conversationId: this.name, requestId, note })
            return { saved: true }
          },
        }),
      },
      stopWhen: stepCountIs(maxSteps),
      ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
      onStepEnd: (step) =>
        log.info('agents.step.end', {
          conversationId: this.name,
          requestId,
          finishReason: step.finishReason,
          usage: step.usage,
        }),
      onEnd: (event) =>
        log.info('agents.turn.end', {
          conversationId: this.name,
          requestId,
          steps: event.steps.length,
          totalUsage: event.totalUsage,
        }),
    })
    return result.toUIMessageStreamResponse()
  }

  /** 技术验证：标记某轮不再恢复，验证 shouldKeepRecovering 生效。TODO(4.3)：改为按账本判断 */
  private recoveryStopped(rootRequestId: string) {
    return this.ctx.storage.kv.get(`spike:stop-recovery:${rootRequestId}`) === true
  }

  /**
   * 仅本地开发（前置处理已拦截其他环境）的验证端点：
   * POST …/spike/abort 重置实例（模拟驱逐 / 部署）；POST …/spike/stop-recovery?root=<id> 让该轮停止恢复。
   * TODO(4.3)：随技术验证代码一起删除。
   */
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname.endsWith('/spike/abort')) {
      log.warn('agents.spike.abort', { conversationId: this.name })
      this.ctx.abort('spike: simulated eviction')
    }
    if (request.method === 'POST' && url.pathname.endsWith('/spike/stop-recovery')) {
      this.ctx.storage.kv.put(`spike:stop-recovery:${url.searchParams.get('root')}`, true)
      return Response.json({ ok: true })
    }
    return new Response('Not found', { status: 404 })
  }

  /** jobs 经 script_name 绑定的 RPC 入口（验证用）；TODO(7.1/8.2)：换成清理与 onTaskDone */
  async spikePing(from: string) {
    log.info('agents.rpc.ping', { conversationId: this.name, from })
    return { name: this.name, messages: this.messages.length }
  }
}
