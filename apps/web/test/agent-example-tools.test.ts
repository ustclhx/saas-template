import { env } from 'cloudflare:workers'
import { defineAgentTool } from '@saas/ai'
import { createDb, file, organization, scoped, setting, user } from '@saas/db'
import { newId } from '@saas/shared'
import { log } from '@saas/shared/log'
import { eq, inArray, like } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { defineAgent } from '../../../plugins/agents/src/definition.ts'
import { listWorkspaceFiles } from '../../../plugins/agents/src/example-tools.ts'
import { createAgentRegistry } from '../../../plugins/agents/src/registry.ts'
import type { AgentExecutionContext } from '../../../plugins/agents/src/tool-context.ts'
import { templateConfig } from '../src/server/template-config.ts'

it.skipIf(!templateConfig.plugins.agents)(
  '文件列表只返回当前空间中可用文件的名称、类型和大小',
  async () => {
    const db = createDb(env.HYPERDRIVE)
    const userId = newId()
    const workspaceId = newId()
    const otherWorkspaceId = newId()
    const workspaceIds = [workspaceId, otherWorkspaceId]
    const ownFile = newId()
    const otherFile = newId()
    const pendingFile = newId()
    const deletedFile = newId()
    const upload = { userId, purpose: 'upload', mime: 'image/png', size: 1024 } as const
    const context = {
      db,
      workspaceId,
      userId,
      conversationId: newId(),
      idempotencyKey: `${newId()}:list-files`,
      log,
      signal: undefined,
      services: undefined,
    }

    try {
      await db
        .insert(user)
        .values({ id: userId, name: 'Agent test', email: `${userId}@agent.test` })
      await db.insert(organization).values(
        workspaceIds.map((id) => ({
          id,
          name: 'Agent test',
          slug: `agent-test-${id}`,
        })),
      )
      await scoped(db, workspaceId).insert(file, [
        { ...upload, id: ownFile, r2Key: `ws/${workspaceId}/${ownFile}`, status: 'ready' },
        { ...upload, id: pendingFile, r2Key: `ws/${workspaceId}/${pendingFile}` },
        {
          ...upload,
          id: deletedFile,
          r2Key: `ws/${workspaceId}/${deletedFile}`,
          status: 'ready',
          deletedAt: new Date(),
        },
      ])
      // 同一位上传者的其他空间仍按当前空间隔离。
      await scoped(db, otherWorkspaceId).insert(file, {
        ...upload,
        id: otherFile,
        r2Key: `ws/${otherWorkspaceId}/${otherFile}`,
        status: 'ready',
      })

      await expect(listWorkspaceFiles.execute({}, context)).resolves.toEqual([
        { name: ownFile, type: upload.mime, size: upload.size },
      ])
      await expect(
        listWorkspaceFiles.execute({}, { ...context, workspaceId: otherWorkspaceId }),
      ).resolves.toEqual([{ name: otherFile, type: upload.mime, size: upload.size }])
    } finally {
      for (const id of workspaceIds) await scoped(db, id).delete(file, undefined)
      await db.delete(organization).where(inArray(organization.id, workspaceIds))
      await db.delete(user).where(eq(user.id, userId))
    }
  },
)

it.skipIf(!templateConfig.plugins.agents)(
  '同一轮的工具调用重放只写入一次持久副作用并返回原结果',
  async () => {
    const db = createDb(env.HYPERDRIVE)
    const turnId = newId()
    const prefix = 'agent-test-replay:'
    const writeOnce = defineAgentTool({
      name: 'write_once',
      description: 'Record an effect for this test',
      input: z.object({ value: z.string() }),
      needsApproval: true,
      async execute({ value }, { db, idempotencyKey }: AgentExecutionContext) {
        // 测试工具用唯一索引去重，模拟工具已写入但实例还没来得及持久化结果。
        const key = `${prefix}${idempotencyKey}`
        await db.insert(setting).values({ key, value }).onConflictDoNothing({ target: setting.key })
        const [saved] = await db
          .select({ value: setting.value })
          .from(setting)
          .where(eq(setting.key, key))
        return saved?.value
      },
    })
    const definition = defineAgent({
      id: 'writer',
      name: 'Writer',
      description: 'Replay fixture',
      systemPrompt: () => 'Use the allowed tool.',
      tools: [writeOnce.name],
    })
    const context = {
      db,
      turnId,
      workspaceId: newId(),
      userId: newId(),
      conversationId: newId(),
      log,
      signal: undefined,
      services: undefined,
    }
    const resolve = () =>
      createAgentRegistry([definition], [{ id: 'fixture', tools: [writeOnce] }]).resolveAgentTools(
        definition.id,
        context,
      )
    const calls = like(setting.key, `${prefix}${turnId}:%`)
    const call = { toolCallId: 'call-1', messages: [], context: undefined }

    try {
      await expect(resolve().write_once?.execute?.({ value: 'first' }, call)).resolves.toBe('first')
      await expect(resolve().write_once?.execute?.({ value: 'replay' }, call)).resolves.toBe(
        'first',
      )
      expect(await db.select({ key: setting.key }).from(setting).where(calls)).toEqual([
        { key: `${prefix}${turnId}:call-1` },
      ])
    } finally {
      await db.delete(setting).where(calls)
    }
  },
)
