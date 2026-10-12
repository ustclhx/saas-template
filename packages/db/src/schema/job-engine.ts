import { newId } from '@saas/shared'
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

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

/** 序号在实例锁内分配，保证同实例并发发送的提交顺序；不依赖毫秒时间排序。 */
export const jobWorkflowEvent = jobEngineSchema.table(
  'workflow_event',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    sequence: bigserial('sequence', { mode: 'bigint' }).notNull(),
    workflowId: text('workflow_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: time('created_at'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [index('workflow_event_fifo_idx').on(t.workflowId, t.type, t.sequence)],
)

/** 消费结果与事件消费标记同事务写入，native checkpoint 前退出也不会丢事件。 */
export const jobWorkflowWait = jobEngineSchema.table(
  'workflow_wait',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workflowId: text('workflow_id').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    state: text('state').notNull().default('waiting'),
    result: jsonb('result'),
    createdAt: time('created_at'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('workflow_wait_name_idx').on(t.workflowId, t.name)],
)
