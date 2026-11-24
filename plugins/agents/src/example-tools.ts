import { defineAgentTool } from '@saas/ai'
import { file, scoped } from '@saas/db'
import { toUtcIso, utcNow } from '@saas/shared'
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { AgentExecutionContext } from './tool-context.ts'

const WORKSPACE_FILE_LIMIT = 20

const currentTime = defineAgentTool({
  name: 'current_time',
  description: 'Get the current time in UTC as an ISO 8601 timestamp.',
  input: z.strictObject({}),
  execute: async () => ({ time: toUtcIso(utcNow()) }),
})

export const listWorkspaceFiles = defineAgentTool({
  name: 'list_workspace_files',
  description: `List up to ${WORKSPACE_FILE_LIMIT} recent files in the current workspace, with their display names, MIME types, and sizes in bytes.`,
  input: z.strictObject({}),
  async execute(_input, { db, workspaceId }: AgentExecutionContext) {
    return scoped(db, workspaceId)
      .select(file, {
        // 文件表不保存原始文件名，使用文件 ID 作为稳定的显示名称。
        fields: { name: file.id, type: file.mime, size: file.size },
        where: and(eq(file.status, 'ready'), isNull(file.deletedAt)) as SQL,
      })
      .orderBy(desc(file.id))
      .limit(WORKSPACE_FILE_LIMIT)
  },
})

export const exampleTools = [currentTime, listWorkspaceFiles] as const
