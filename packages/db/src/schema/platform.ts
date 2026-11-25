import { newId } from '@saas/shared'
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { session, user } from './auth.ts'
import { organization } from './tenancy.ts'

/**
 * 运行时设置（docs/02-project-structure.md「配置体系」）：可在后台修改、不发版生效的项。
 * 每个 key 在代码中都有默认值（见 src/settings.ts），表中缺失时回退到默认值。
 */
export const setting = pgTable('setting', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  key: text('key').notNull().unique(),
  value: jsonb('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})

export type Setting = typeof setting.$inferSelect
export type NewSetting = typeof setting.$inferInsert

/** 平台管理员的 MCP 个人访问令牌，只保存哈希和用于展示的前缀。 */
export const adminApiToken = pgTable(
  'admin_api_token',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('admin_api_token_token_hash_idx').on(t.tokenHash),
    index('admin_api_token_user_id_idx').on(t.userId),
  ],
)

export type AdminApiToken = typeof adminApiToken.$inferSelect
export type NewAdminApiToken = typeof adminApiToken.$inferInsert

/** Postgres bytea；drizzle-orm 0.45 的 pg-core 没有内置列类型。 */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => new Uint8Array(value),
})

/** 敏感后台操作的重新验证方式（add-admin-step-up design.md 决策 3、4）；passkey 为预留项。 */
export const adminStepUpMethods = [
  'passkey',
  'totp',
  'backup_code',
  'email_otp',
  'password',
  'rescue',
] as const
export type AdminStepUpMethod = (typeof adminStepUpMethods)[number]

/**
 * 管理员会话的重新验证状态（add-admin-step-up 决策 4）：每个会话至多一行，成功验证即覆盖。
 * 有效期为绝对时间、不随使用延长；会话被删除（退出、吊销）时级联删除，验证随之失效。
 */
export const adminStepUp = pgTable(
  'admin_step_up',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => session.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    method: text('method', { enum: adminStepUpMethods }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // 最近一次被接受的 TOTP 时间窗编号，同一时间窗内的验证码只接受一次
    lastTotpStep: integer('last_totp_step'),
  },
  (t) => [index('admin_step_up_user_id_idx').on(t.userId)],
)

export type AdminStepUp = typeof adminStepUp.$inferSelect
export type NewAdminStepUp = typeof adminStepUp.$inferInsert

export const adminPendingActionStatuses = [
  'pending',
  'running',
  'done',
  'failed',
  'rejected',
  'expired',
] as const
export type AdminPendingActionStatus = (typeof adminPendingActionStatuses)[number]

/**
 * AI（admin MCP）发起、等待管理员确认的敏感操作（add-admin-step-up 决策 7）。
 * 创建时解析目标并快照现值；确认时只使用 `payload`。密钥参数只以密文保存，
 * 数据密钥存在平台缓存并随有效期失效；终态同事务清空密文。
 */
export const adminPendingAction = pgTable(
  'admin_pending_action',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tool: text('tool').notNull(),
    // 动作登记表（apps/web/src/features/admin/actions.registry.ts）中的动作名
    action: text('action').notNull(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => adminApiToken.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    payload: jsonb('payload').notNull(),
    display: jsonb('display').notNull(),
    secretCiphertext: bytea('secret_ciphertext'),
    status: text('status', { enum: adminPendingActionStatuses }).notNull().default('pending'),
    result: jsonb('result'),
    decidedBy: uuid('decided_by').references(() => user.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admin_pending_action_requested_by_status_idx').on(t.requestedBy, t.status),
    index('admin_pending_action_token_id_status_idx').on(t.tokenId, t.status),
  ],
)

export type AdminPendingAction = typeof adminPendingAction.$inferSelect
export type NewAdminPendingAction = typeof adminPendingAction.$inferInsert

/**
 * 审计日志（docs/03-data-model.md §6）：管理员操作、计费关键变更、成员变更。
 * 只增不改，永久保留；用户删号后 `actor_user_id` 仍指向已匿名化的 user 行（§7）。
 * `actor_user_id` 为空表示系统操作（Cron、Webhook 等）。
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    actorUserId: uuid('actor_user_id').references(() => user.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').references(() => organization.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    index('audit_log_actor_user_id_id_idx').on(t.actorUserId, t.id.desc()),
  ],
)

export type AuditLog = typeof auditLog.$inferSelect
export type NewAuditLog = typeof auditLog.$inferInsert

/** 站内通知（docs/03-data-model.md §6）。`workspace_id` 为空表示与具体空间无关的通知。 */
export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').references(() => organization.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('notification_workspace_id_id_idx').on(t.workspaceId, t.id.desc()),
    // 通知中心按用户列出
    index('notification_user_id_id_idx').on(t.userId, t.id.desc()),
  ],
)

export type Notification = typeof notification.$inferSelect
export type NewNotification = typeof notification.$inferInsert
