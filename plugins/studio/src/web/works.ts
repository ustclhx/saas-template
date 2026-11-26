import {
  aiModel,
  aiTask,
  type Database,
  file,
  member,
  notFound,
  organization,
  type Scoped,
  scoped,
  studioWork,
  user,
} from '@saas/db'
import { AppError } from '@saas/shared'
import { and, desc, eq, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { StudioKind } from '../kinds.ts'

export const DEFAULT_STUDIO_SITE = 'default'

export type StudioTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface StudioWorkspace {
  workspaceId: string
  kinds: readonly StudioKind[]
}

/** 用户和角色由服务端的空间中间件提供。 */
export interface StudioWorkActor {
  userId: string
  role: string
  workspaceReadOnly: boolean
}

export interface StudioWorkMutation {
  workspaceId: string
  fileId: string
  actor: StudioWorkActor
}

export function assertStudioWritable(actor: StudioWorkActor) {
  if (actor.workspaceReadOnly || !['owner', 'admin', 'member'].includes(actor.role))
    throw new AppError('WORKSPACE_READ_ONLY', 'Workspace writes are disabled', { status: 403 })
}

export async function lockStudioWorkspace(
  tx: StudioTransaction,
  workspaceId: string,
  actor: StudioWorkActor,
) {
  // 与工作空间删除、成员变化及媒体文件清理串行，拿锁后复核权限。
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${workspaceId}`}, 0))`)
  const tenant = scoped(tx, workspaceId)
  const [current] = await tenant
    .select(member, {
      fields: { role: member.role },
      where: eq(member.userId, actor.userId),
    })
    .innerJoin(
      organization,
      and(eq(organization.id, member.organizationId), isNull(organization.deletedAt)),
    )
    .innerJoin(
      user,
      and(
        eq(user.id, member.userId),
        sql`not (coalesce(${user.banned}, false) and
        (${user.banExpires} is null or ${user.banExpires} > now()))`,
      ),
    )
    .limit(1)
  if (!current) throw notFound()
  assertStudioWritable({ ...actor, role: current.role })
  return tenant
}

export function studioOutputTaskJoin(tenant: Scoped, kinds?: readonly StudioKind[]) {
  return tenant.filter(
    aiTask,
    and(
      eq(aiTask.id, file.sourceTaskId),
      eq(aiTask.status, 'succeeded'),
      kinds === undefined ? undefined : inArray(aiTask.kind, kinds),
    ),
  )
}

export interface ListStudioWorksInput extends StudioWorkspace {
  kind?: StudioKind
  visibility?: 'public' | 'private'
  cursor?: string
  limit?: number
}

const workCursor = z.tuple([z.iso.datetime(), z.uuid()])

function beforeCursor(cursor: string | undefined) {
  if (cursor === undefined) return undefined
  const parsed = workCursor.safeParse(cursor.split('/'))
  if (!parsed.success) throw new AppError('INVALID_CURSOR', 'Invalid work cursor')
  const [createdAt, id] = parsed.data
  return sql`(${file.createdAt}, ${file.id}) < (${createdAt}::timestamptz, ${id}::uuid)`
}

/** 只列出本空间已成功生成的可用输出；未发布的文件也属于「私有」。 */
export async function listStudioWorks(db: Database, input: ListStudioWorksInput) {
  const tenant = scoped(db, input.workspaceId)
  const kinds = input.kind ? input.kinds.filter((kind) => kind === input.kind) : input.kinds
  if (input.kind && kinds.length === 0) throw notFound()
  const limit = z
    .int()
    .min(1)
    .max(100)
    .parse(input.limit ?? 24)
  const visibility =
    input.visibility === 'private'
      ? or(eq(studioWork.visibility, 'private'), isNull(studioWork.id))
      : input.visibility === 'public'
        ? eq(studioWork.visibility, 'public')
        : undefined
  const rows = await tenant
    .select(file, {
      fields: {
        fileId: file.id,
        taskId: aiTask.id,
        kind: aiTask.kind,
        modelKey: aiTask.modelKey,
        modelDisplayName: sql<string>`coalesce(${aiModel.displayName}, ${aiTask.modelKey})`,
        mime: file.mime,
        width: file.width,
        height: file.height,
        duration: file.duration,
        createdAt: file.createdAt,
        // Date 只保留毫秒；游标保留数据库微秒，避免同一毫秒内漏行。
        cursorTime: sql<string>`to_char(${file.createdAt} at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        work: {
          id: studioWork.id,
          title: studioWork.title,
          slug: studioWork.slug,
          site: studioWork.site,
          visibility: studioWork.visibility,
          moderation: studioWork.moderation,
          removalReason: studioWork.removalReason,
          showPrompt: studioWork.showPrompt,
          version: studioWork.version,
        },
      },
      where: and(
        eq(file.purpose, 'ai_output'),
        eq(file.status, 'ready'),
        isNull(file.deletedAt),
        visibility,
        beforeCursor(input.cursor),
      ) as SQL,
    })
    .innerJoin(
      organization,
      and(eq(organization.id, file.workspaceId), isNull(organization.deletedAt)),
    )
    .innerJoin(aiTask, studioOutputTaskJoin(tenant, kinds))
    .leftJoin(studioWork, tenant.filter(studioWork, eq(studioWork.fileId, file.id)))
    .leftJoin(aiModel, eq(aiModel.key, aiTask.modelKey))
    .orderBy(desc(file.createdAt), desc(file.id))
    .limit(limit + 1)
  const last = rows.length > limit ? rows[limit - 1] : undefined
  return {
    works: rows.slice(0, limit).map(({ cursorTime: _cursorTime, ...row }) => row),
    nextCursor: last ? `${last.cursorTime}/${last.fileId}` : null,
  }
}

/** 支持旧媒体任务；账号已注销的任务会被现有清理任务移除。 */
export async function readStudioOutput(
  tenant: Scoped,
  fileId: string,
  kinds: readonly StudioKind[],
  lock = false,
) {
  if (!z.uuid().safeParse(fileId).success) throw notFound()
  const query = tenant
    .select(file, {
      fields: {
        taskId: aiTask.id,
        kind: aiTask.kind,
        modelKey: aiTask.modelKey,
        input: aiTask.input,
        width: file.width,
        height: file.height,
        duration: file.duration,
      },
      where: and(
        eq(file.id, fileId),
        eq(file.purpose, 'ai_output'),
        eq(file.status, 'ready'),
        isNull(file.deletedAt),
      ) as SQL,
    })
    .innerJoin(aiTask, studioOutputTaskJoin(tenant, kinds))
    .innerJoin(
      user,
      and(
        eq(user.id, aiTask.userId),
        ne(user.email, sql`'deleted+' || ${user.id}::text || '@invalid'`),
      ),
    )
    .limit(1)
  const [output] = lock ? await query.for('update', { of: file }) : await query
  if (!output) throw notFound()
  return output
}
