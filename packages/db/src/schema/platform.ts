import { newId } from '@saas/shared'
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

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
