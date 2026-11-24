import {
  type AgentPendingTaskOutput,
  dbModelStore,
  defineAgentTool,
  listAvailableModels,
  pendingTaskOutput,
} from '@saas/ai'
import { member, organization, scoped } from '@saas/db'
import { getEntitlements } from '@saas/entitlements'
import { AppError } from '@saas/shared'
import type { PluginAgentToolContext } from '@web/features/plugins/contract.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { type MediaHttpEnv, submitWorkspaceMedia } from './media-tasks.ts'

// media 插件贡献的 agent 工具（openspec add-ai-agents 决策 4、8，任务 8.1）。工具只提交媒体任务并立即返回
// `{ taskId, status: 'pending' }`；结果由对话实例按 taskId 拉取 ai_task 后写回，媒体任务与 Workflow
// 不记录也不需要知道 agent。提交沿用站内的权益、限流、配额与预扣（任务自身的积分），按 idempotencyKey
// 去重，恢复重放只产生一个任务。会消耗积分，执行前需要用户确认。

type MediaKind = 'image' | 'video'

const input = z.object({
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('What to generate, written as a detailed visual description'),
})

/** 对话实例中执行：空间与用户来自实例记住的归属，成员资格已由本轮的调用前检查确认 */
async function resolveWorkspace(ctx: PluginAgentToolContext) {
  const [workspace] = await ctx.db
    .select()
    .from(organization)
    .where(and(eq(organization.id, ctx.workspaceId), isNull(organization.deletedAt)))
    .limit(1)
  const [membership] = workspace
    ? await scoped(ctx.db, ctx.workspaceId)
        .select(member, { where: eq(member.userId, ctx.userId) })
        .limit(1)
    : []
  if (!workspace || !membership) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
  if (!templateConfig.tenancy.multiTenant && !workspace.isPersonal)
    throw new AppError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', { status: 403 })
  return { workspace, member: membership }
}

/** 空间权益允许的第一个该类模型（与生成页的默认选择一致，按后台排序） */
async function defaultModelKey(ctx: PluginAgentToolContext, kind: MediaKind, env: MediaHttpEnv) {
  const entitlements = await getEntitlements(ctx.db, ctx.workspaceId, {
    pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
  })
  const [model] = await listAvailableModels(
    { store: dbModelStore(ctx.db), workersAi: Boolean(env.AI) },
    entitlements,
    { kind },
  )
  if (!model)
    throw new AppError('MODEL_UNAVAILABLE', 'No media model is available', { status: 404 })
  return model.key
}

function mediaTool(kind: MediaKind) {
  return defineAgentTool<typeof input, AgentPendingTaskOutput, PluginAgentToolContext>({
    name: kind === 'image' ? 'generate_image' : 'generate_video',
    description:
      kind === 'image'
        ? 'Generate an image from a text prompt. Submits a background task, costs credits and returns immediately with a pending task id; the finished image is added to this conversation automatically.'
        : 'Generate a short video from a text prompt. Submits a background task, costs credits and returns immediately with a pending task id; the finished video is added to this conversation automatically.',
    input,
    needsApproval: true,
    async execute({ prompt }, ctx) {
      const services = ctx.services
      if (!services)
        throw new AppError('AI_UNAVAILABLE', 'Media tools are not available', { status: 503 })
      const env = services.env as MediaHttpEnv
      if (!env.APP_URL)
        throw new AppError('AI_UNAVAILABLE', 'Media tools are not available', { status: 503 })
      const resolved = await resolveWorkspace(ctx)
      const task = await submitWorkspaceMedia(
        {
          modelKey: await defaultModelKey(ctx, kind, env),
          params: { prompt },
          idempotencyKey: ctx.idempotencyKey,
        },
        resolved,
        {
          db: ctx.db,
          env,
          workflow: services.aiWorkflow,
          rateLimiter: services.rateLimiter,
          callbackOrigin: new URL(env.APP_URL).origin,
        },
      )
      ctx.log.info('media.agent_tool.submitted', { taskId: task.id, kind })
      return pendingTaskOutput(task.id, kind)
    },
  })
}

/** 按模板开关提供生图 / 生视频工具 */
export function mediaAgentTools() {
  return [
    ...(templateConfig.ai.image ? [mediaTool('image')] : []),
    ...(templateConfig.ai.video ? [mediaTool('video')] : []),
  ]
}
