import { adminStepUp, type createDb, session } from '@saas/db'
import { newId } from '@saas/shared'
import { inArray } from 'drizzle-orm'

// add-admin-step-up：为直接插入用户的测试准备「已重新验证」的管理员会话。
// 会话外键为 restrict：删除用户前先调用 deleteStepUpSessions。

type Db = ReturnType<typeof createDb>

export interface StepUpSession {
  readonly id: string
  readonly userId: string
}

const created = new Set<string>()

/** 插入一个属于 userId 的会话，并写入有效期 minutes 分钟的 step-up 记录（负数为已过期） */
export async function stepUpSession(
  db: Db,
  userId: string,
  { minutes = 10, verified = true }: { minutes?: number; verified?: boolean } = {},
): Promise<StepUpSession> {
  const id = newId()
  await db.insert(session).values({
    id,
    userId,
    token: `step-up-test-${id}`,
    expiresAt: new Date(Date.now() + 3_600_000),
  })
  created.add(id)
  if (verified)
    await db.insert(adminStepUp).values({
      sessionId: id,
      userId,
      method: 'password',
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + minutes * 60_000),
    })
  return { id, userId }
}

/** 删除本文件创建的会话（step-up 记录随之级联删除） */
export async function deleteStepUpSessions(db: Db) {
  if (created.size === 0) return
  await db.delete(session).where(inArray(session.id, [...created]))
  created.clear()
}
