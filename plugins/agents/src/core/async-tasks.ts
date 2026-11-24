import { isPendingTaskOutput } from '@saas/ai'
import { aiTask, type Database, scoped } from '@saas/db'
import type { UIMessage } from 'ai'
import { inArray } from 'drizzle-orm'

// 异步工具结果（openspec add-ai-agents 决策 8，任务 8.2），与 Agents SDK 无关。
// 长任务工具返回 `{ taskId, status: 'pending' }`；实例从自己的消息中找出仍为 pending 的工具输出，
// 按 taskId 读取 PG 中的 ai_task，终态时把同一工具调用的输出改写为结果。待完成任务就是消息中的
// pending 输出本身，不另存列表；改写只更新消息，不调用模型，不产生费用（默认不自动续轮）。

/** 首次轮询间隔与上限（秒）：5 秒起逐次加倍，最长 60 秒 */
export const TASK_POLL_INITIAL_SECONDS = 5
export const TASK_POLL_MAX_SECONDS = 60
/** 任务截止时间之后再等多久仍非终态即写入超时结果并停止轮询（与媒体预扣兜底留出余量） */
export const TASK_TIMEOUT_GRACE_MS = 5 * 60_000

export function taskPollDelaySeconds(attempt: number): number {
  return Math.min(TASK_POLL_INITIAL_SECONDS * 2 ** Math.max(0, attempt), TASK_POLL_MAX_SECONDS)
}

export interface PendingTaskRef {
  readonly toolCallId: string
  readonly taskId: string
  readonly kind?: string | undefined
}

type ToolPart = {
  type: string
  toolCallId?: unknown
  state?: unknown
  output?: unknown
}

function isToolPart(part: { type: string }): part is ToolPart & { toolCallId: string } {
  return (
    (part.type.startsWith('tool-') || part.type === 'dynamic-tool') &&
    typeof (part as ToolPart).toolCallId === 'string'
  )
}

/** 消息中仍为 pending 的长任务工具输出（同一 taskId 只取一次） */
export function findPendingTasks(messages: readonly UIMessage[]): PendingTaskRef[] {
  const pending: PendingTaskRef[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (!isToolPart(part) || part.state !== 'output-available') continue
      if (!isPendingTaskOutput(part.output) || seen.has(part.output.taskId)) continue
      seen.add(part.output.taskId)
      pending.push({
        toolCallId: part.toolCallId,
        taskId: part.output.taskId,
        kind: part.output.kind,
      })
    }
  }
  return pending
}

export interface TaskResultFile {
  readonly id: string
  readonly mime: string | null
  readonly downloadUrl: string
}

/** 终态后写回工具调用的输出：模型在后续轮次中也能看到结果 */
export interface TaskResultOutput {
  readonly taskId: string
  readonly kind?: string | undefined
  readonly status: 'succeeded' | 'failed' | 'canceled' | 'timeout'
  readonly files?: readonly TaskResultFile[]
  readonly errorCode?: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * 读取任务状态并给出可写回的结果（toolCallId → 输出）。只按实例记住的空间经 `scoped` 查询，
 * 他人空间或不存在的任务按失败处理；仍在进行且未超时的任务不出现在结果中。
 */
export async function readTaskResults(
  db: Database,
  workspaceId: string,
  pending: readonly PendingTaskRef[],
  now: Date = new Date(),
): Promise<Map<string, TaskResultOutput>> {
  const results = new Map<string, TaskResultOutput>()
  const ids = [...new Set(pending.map((ref) => ref.taskId).filter((id) => UUID.test(id)))]
  const rows =
    ids.length === 0
      ? []
      : await scoped(db, workspaceId).select(aiTask, {
          where: inArray(aiTask.id, ids),
          fields: {
            id: aiTask.id,
            kind: aiTask.kind,
            status: aiTask.status,
            output: aiTask.output,
            errorCode: aiTask.errorCode,
            deadlineAt: aiTask.deadlineAt,
          },
        })
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const ref of pending) {
    const task = byId.get(ref.taskId)
    const base = { taskId: ref.taskId, kind: task?.kind ?? ref.kind }
    if (!task) {
      results.set(ref.toolCallId, { ...base, status: 'failed', errorCode: 'TASK_NOT_FOUND' })
      continue
    }
    if (task.status === 'succeeded') {
      const files = ((task.output as { files?: Record<string, unknown>[] } | null)?.files ?? [])
        .filter((file) => typeof file.id === 'string')
        .map((file) => ({
          id: file.id as string,
          mime: typeof file.mime === 'string' ? file.mime : null,
          downloadUrl: `/api/files/${encodeURIComponent(file.id as string)}?workspaceId=${workspaceId}`,
        }))
      results.set(ref.toolCallId, { ...base, status: 'succeeded', files })
    } else if (task.status === 'failed' || task.status === 'canceled') {
      results.set(ref.toolCallId, { ...base, status: task.status, errorCode: task.errorCode })
    } else if (task.deadlineAt.getTime() + TASK_TIMEOUT_GRACE_MS < now.getTime()) {
      results.set(ref.toolCallId, { ...base, status: 'timeout', errorCode: 'TASK_TIMEOUT' })
    }
  }
  return results
}

/** 把结果写入对应工具调用的输出；没有变化时返回原数组 */
export function applyTaskResults(
  messages: UIMessage[],
  results: ReadonlyMap<string, TaskResultOutput>,
): UIMessage[] {
  if (results.size === 0) return messages
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    let touched = false
    const parts = message.parts.map((part) => {
      if (!isToolPart(part) || part.state !== 'output-available') return part
      const result = results.get(part.toolCallId)
      if (!result || !isPendingTaskOutput(part.output)) return part
      touched = true
      return { ...part, output: result }
    })
    if (!touched) return message
    changed = true
    return { ...message, parts } as UIMessage
  })
  return changed ? next : messages
}
