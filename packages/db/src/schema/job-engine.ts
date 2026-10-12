import { newId } from '@saas/shared'
import { index, integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/** Node 专用持久消息域；业务事务与消息共用同一数据库。 */
export const jobEngineSchema = pgSchema('job_engine')
const time = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow()

export const jobQueue = jobEngineSchema.table('queue', {
  name: text('name').primaryKey(),
  policy: jsonb('policy').notNull(),
})
export const jobBatch = jobEngineSchema.table('batch', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  queue: text('queue')
    .notNull()
    .references(() => jobQueue.name),
  state: text('state').notNull().default('claimed'),
  size: integer('size').notNull(),
  executorId: text('executor_id'),
  executorToken: text('executor_token'),
  createdAt: time('created_at'),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})
export const jobMessage = jobEngineSchema.table(
  'message',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    queue: text('queue')
      .notNull()
      .references(() => jobQueue.name),
    body: jsonb('body').notNull(),
    requestId: text('request_id'),
    idempotencyKey: text('idempotency_key'),
    createdAt: time('created_at'),
    availableAt: time('available_at'),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    batchId: uuid('batch_id').references(() => jobBatch.id),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('job_message_ready_idx').on(t.queue, t.state, t.availableAt),
    index('job_message_batch_idx').on(t.batchId),
  ],
)
export const jobStart = jobEngineSchema.table(
  'start',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    queue: text('queue')
      .notNull()
      .references(() => jobQueue.name),
    messageId: uuid('message_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    attempt: integer('attempt').notNull(),
    startedAt: time('started_at'),
  },
  (t) => [index('job_start_window_idx').on(t.queue, t.startedAt)],
)
export const jobDeadLetter = jobEngineSchema.table('dead_letter', {
  messageId: uuid('message_id')
    .primaryKey()
    .references(() => jobMessage.id),
  queue: text('queue').notNull(),
  attempts: integer('attempts').notNull(),
  code: text('code').notNull(),
  retryable: integer('retryable').notNull(),
  createdAt: time('created_at'),
})
