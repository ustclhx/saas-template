import { aiModel, type Database, file, notFound, organization, studioWork, user } from '@saas/db'
import { and, desc, eq, inArray, isNotNull, isNull, ne, type SQL, sql } from 'drizzle-orm'
import type { PgSelectBase, SelectedFields } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import type { StudioKind } from '../kinds.ts'

type PublicWorkScope = { site: string; kinds: readonly StudioKind[] }
type QueryDatabase = Pick<Database, 'select'>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

const gallerySort = z.enum(['latest', 'featured'])
const galleryCursor = z.tuple([gallerySort, z.iso.datetime({ precision: 6 }), z.uuid()])
const LAST_NUMBERED_GALLERY_PAGE = 50
// 单个站点地图文件上限 5 万条；第一片还要放各语言的画廊列表页，作品每片留出余量。
export const SITEMAP_PAGE_SIZE = 49_000
// 每站最多收录 49 万件作品，并限制公开查询的最大偏移。
export const LAST_SITEMAP_PAGE = 10

/** 与 studioWork、file、user、organization 的连接使用。所有公开读取都按请求站点重新判定。 */
export function publicWorkPredicate({ site, kinds }: PublicWorkScope) {
  return and(
    eq(studioWork.site, site),
    inArray(studioWork.kind, kinds),
    eq(studioWork.visibility, 'public'),
    inArray(studioWork.moderation, ['pending', 'approved']),
    // 与会话鉴权一致，只有未过期的封禁生效。
    sql`not (${user.banned} is true and (${user.banExpires} is null or ${user.banExpires} > now()))`,
    // 账号删除后的匿名化标记独立于可被管理员变更的封禁状态。
    ne(user.email, sql`'deleted+' || ${user.id}::text || '@invalid'`),
    isNull(organization.deletedAt),
    eq(file.workspaceId, studioWork.workspaceId),
    eq(file.sourceTaskId, studioWork.taskId),
    eq(file.purpose, 'ai_output'),
    eq(file.status, 'ready'),
    isNull(file.deletedAt),
  )
}

function selectWorks<Fields extends SelectedFields>(db: QueryDatabase, fields: Fields) {
  // Fields 必为显式投影，固定 Drizzle 的查询模式以消除泛型条件类型。
  // biome-ignore lint/plugin: 公开查询跨空间，调用方统一使用 publicWorkPredicate。
  const base = db.select(fields).from(studioWork) as PgSelectBase<'studio_work', Fields, 'partial'>
  return base
    .innerJoin(user, eq(studioWork.userId, user.id))
    .innerJoin(organization, eq(studioWork.workspaceId, organization.id))
    .innerJoin(file, eq(studioWork.fileId, file.id))
}

const cardFields = {
  id: studioWork.id,
  slug: studioWork.slug,
  title: studioWork.title,
  kind: studioWork.kind,
  displayName: sql<string>`coalesce(${aiModel.displayName}, ${studioWork.modelKey})`,
  width: studioWork.width,
  height: studioWork.height,
  durationMs: studioWork.durationMs,
  version: studioWork.version,
  publishedAt: studioWork.publishedAt,
  featuredAt: studioWork.featuredAt,
}

export async function listPublicWorks(
  db: QueryDatabase,
  input: PublicWorkScope & {
    kind?: StudioKind
    sort?: z.infer<typeof gallerySort>
    page?: number
    cursor?: string
    pageSize: number
  },
) {
  const { kind, sort = 'latest', page = 1, cursor, pageSize } = input
  const offset = (page - 1) * pageSize
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > LAST_NUMBERED_GALLERY_PAGE ||
    pageSize < 1 ||
    !Number.isSafeInteger(pageSize + 1) ||
    !Number.isSafeInteger(offset) ||
    (cursor !== undefined && page !== 1)
  ) {
    throw notFound()
  }

  const orderAt = sort === 'featured' ? studioWork.featuredAt : studioWork.publishedAt
  let beforeCursor: SQL | undefined
  if (cursor !== undefined) {
    const decoded = galleryCursor.safeParse(cursor.split('~'))
    if (!decoded.success || decoded.data[0] !== sort) throw notFound()
    const [, timestamp, id] = decoded.data
    beforeCursor = sql`(${orderAt}, ${studioWork.id}) < (${timestamp}::timestamptz, ${id}::uuid)`
  }

  const rows = await selectWorks(db, {
    ...cardFields,
    // PostgreSQL 保留微秒，不能从精度只有毫秒的 Date 生成游标。
    cursorAt: sql<string>`to_char(${orderAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  })
    .leftJoin(aiModel, eq(studioWork.modelKey, aiModel.key))
    .where(
      and(
        publicWorkPredicate(input),
        kind === undefined ? undefined : eq(studioWork.kind, kind),
        sort === 'featured' ? isNotNull(studioWork.featuredAt) : undefined,
        beforeCursor,
      ),
    )
    .orderBy(desc(orderAt), desc(studioWork.id))
    .limit(pageSize + 1)
    .offset(offset)

  if (page > 1 && rows.length === 0) throw notFound()

  const hasNextPage = rows.length > pageSize
  const works = rows.slice(0, pageSize).map(({ cursorAt, ...work }) => work)
  const last = hasNextPage ? rows[pageSize - 1] : undefined
  return {
    works,
    nextPage:
      hasNextPage && cursor === undefined && page < LAST_NUMBERED_GALLERY_PAGE ? page + 1 : null,
    nextCursor: last ? `${sort}~${last.cursorAt}~${last.id}` : null,
  }
}

export async function getPublicWorkBySlug(
  db: QueryDatabase,
  input: PublicWorkScope & { slug: string; viewerUserId?: string },
) {
  const [work] = await selectWorks(db, {
    ...cardFields,
    modelKey: studioWork.modelKey,
    prompt: sql<string | null>`case when ${studioWork.showPrompt} then ${studioWork.prompt} end`,
    moderation: studioWork.moderation,
    isAuthor: input.viewerUserId
      ? sql<boolean>`${studioWork.userId} = ${input.viewerUserId}`
      : sql<boolean>`false`,
  })
    .leftJoin(aiModel, eq(studioWork.modelKey, aiModel.key))
    .where(and(publicWorkPredicate(input), eq(studioWork.slug, input.slug)))
    .limit(1)
  return work ?? null
}

export async function listRelatedPublicWorks(
  db: QueryDatabase,
  input: PublicWorkScope & { kind: StudioKind; workId: string; limit?: number },
) {
  return selectWorks(db, cardFields)
    .leftJoin(aiModel, eq(studioWork.modelKey, aiModel.key))
    .where(and(publicWorkPredicate(input), ne(studioWork.id, input.workId)))
    .orderBy(
      desc(eq(studioWork.kind, input.kind)),
      desc(studioWork.publishedAt),
      desc(studioWork.id),
    )
    .limit(input.limit ?? 6)
}

export async function listPublicSitemapWorks(
  db: QueryDatabase,
  input: PublicWorkScope & { page: number },
) {
  const { page } = input
  if (!Number.isInteger(page) || page < 1 || page > LAST_SITEMAP_PAGE) throw notFound()

  const rows = await selectWorks(db, { slug: studioWork.slug, lastmod: studioWork.updatedAt })
    .where(and(publicWorkPredicate(input), eq(studioWork.moderation, 'approved')))
    .orderBy(desc(studioWork.publishedAt), desc(studioWork.id))
    .limit(SITEMAP_PAGE_SIZE + 1)
    .offset((page - 1) * SITEMAP_PAGE_SIZE)

  if (page > 1 && rows.length === 0) throw notFound()

  return {
    works: rows.slice(0, SITEMAP_PAGE_SIZE),
    hasNextPage: page < LAST_SITEMAP_PAGE && rows.length > SITEMAP_PAGE_SIZE,
  }
}

/** 本站审核通过的作品数（画廊站点地图据此决定是否输出站点地图索引） */
export async function countPublicSitemapWorks(db: QueryDatabase, input: PublicWorkScope) {
  const [row] = await selectWorks(db, { count: sql<number>`count(*)::int` }).where(
    and(publicWorkPredicate(input), eq(studioWork.moderation, 'approved')),
  )
  return row?.count ?? 0
}

export async function getPublicWorkMedia(
  db: QueryDatabase,
  input: PublicWorkScope & { workId: string; version: number },
) {
  if (
    !z.uuid().safeParse(input.workId).success ||
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    input.version > 2_147_483_647
  )
    return null
  const [media] = await selectWorks(db, { r2Key: file.r2Key, mime: file.mime, size: file.size })
    .where(
      and(
        publicWorkPredicate(input),
        eq(studioWork.id, input.workId),
        eq(studioWork.version, input.version),
      ),
    )
    .limit(1)
  return media ?? null
}

/** 同一事务内锁定作品行，串行化重复举报、阈值更新与审核。空间 ID 仅供内部 scoped 写入。 */
export async function getPublicWorkForReport(
  tx: Transaction,
  input: PublicWorkScope & { workId: string },
) {
  if (!z.uuid().safeParse(input.workId).success) return null
  const [work] = await selectWorks(tx, {
    id: studioWork.id,
    workspaceId: studioWork.workspaceId,
    version: studioWork.version,
    slug: studioWork.slug,
    moderation: studioWork.moderation,
    reportCount: studioWork.reportCount,
  })
    .where(and(publicWorkPredicate(input), eq(studioWork.id, input.workId)))
    .limit(1)
    .for('update', { of: studioWork })
  return work ?? null
}
