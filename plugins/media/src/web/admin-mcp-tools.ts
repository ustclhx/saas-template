import { aiTask, notFound, scoped } from '@saas/db'
import { definePluginAdminMcpTool, toolResult } from '@web/features/admin/mcp-tool.ts'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

/**
 * 媒体任务的服务商尝试记录（add-media-provider-fallback D4 / spec「后台查看切换记录」）。
 * 只返回状态、主模型、当前服务商与每次尝试的服务商、模型、作业 ID 与失败分类；不含参数、提示词与产出。
 */
export const mediaTask = definePluginAdminMcpTool({
  scope: 'admin:read',
  description:
    'Get a media generation task with its primary model, current provider, and provider attempts (failover history). Parameters and prompts are not returned.',
  input: z.strictObject({ workspaceId: z.uuid(), taskId: z.uuid() }),
  params: {
    workspaceId: 'UUID of the workspace that owns the task.',
    taskId: 'UUID of the media task.',
  },
  async run({ db }, { workspaceId, taskId }) {
    const [task] = await scoped(db, workspaceId)
      .select(aiTask, { where: eq(aiTask.id, taskId) })
      .limit(1)
    if (!task) throw notFound()
    const failover = task.input.failover as
      | { skipped?: { modelKey: string; provider: string; failure: unknown }[] }
      | undefined
    return toolResult({
      task: {
        id: task.id,
        workspaceId: task.workspaceId,
        kind: task.kind,
        status: task.status,
        modelKey: task.modelKey,
        provider: task.provider,
        providerJobId: task.providerJobId,
        providerModelId: String(task.input.providerModelId ?? ''),
        providerAttempts: task.providerAttempts.map((attempt) => ({
          provider: attempt.provider,
          modelKey: attempt.modelKey,
          providerModelId: attempt.providerModelId,
          jobId: attempt.jobId ?? null,
          failure: attempt.failure ?? null,
          at: attempt.at,
        })),
        // 受理时因未配置或参数不兼容而跳过的候选。
        skippedCandidates: (failover?.skipped ?? []).map(({ modelKey, provider, failure }) => ({
          modelKey,
          provider,
          failure,
        })),
        creditsCharged: task.creditsCharged,
        errorCode: task.errorCode,
        errorMessage: task.errorMessage,
        createdAt: task.createdAt.toISOString(),
        finishedAt: task.finishedAt?.toISOString() ?? null,
      },
    })
  },
})
