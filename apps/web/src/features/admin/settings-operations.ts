import {
  type Database,
  dbSettingStore,
  getSetting,
  type SettingKey,
  setting,
  settingDefaults,
  templateSettings,
  validateSettingValue,
} from '@saas/db'
import { redact } from '@saas/shared'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AdminActionScope } from './action.ts'

export const OPERATIONS_SETTING_KEYS = [
  'operations.telegramBotToken',
  'operations.telegramChatId',
  'operations.discordWebhookUrl',
] as const satisfies readonly SettingKey[]

export const operationsSettingsInput = z.object({
  // 保留表单协议：省略表示不修改，null 表示清除。
  telegramBotToken: templateSettings['operations.telegramBotToken'].schema
    .refine((value) => value !== '')
    .nullable()
    .optional(),
  telegramChatId: templateSettings['operations.telegramChatId'].schema,
  discordWebhookUrl: templateSettings['operations.discordWebhookUrl'].schema
    .refine((value) => value !== '')
    .nullable()
    .optional(),
})

export async function readOperationsSettings(db: Database) {
  const ctx = { store: dbSettingStore(db) }
  const [token, telegramChatId, webhook] = await Promise.all([
    getSetting(ctx, 'operations.telegramBotToken'),
    getSetting(ctx, 'operations.telegramChatId'),
    getSetting(ctx, 'operations.discordWebhookUrl'),
  ])
  return {
    telegramConfigured: Boolean(token),
    telegramChatId,
    discordConfigured: Boolean(webhook),
  }
}

export async function writeOperationsSettings(
  { tx, audit }: AdminActionScope,
  input: z.infer<typeof operationsSettingsInput>,
) {
  const values = {
    'operations.telegramBotToken': input.telegramBotToken,
    'operations.telegramChatId': input.telegramChatId,
    'operations.discordWebhookUrl': input.discordWebhookUrl,
  }
  for (const key of OPERATIONS_SETTING_KEYS) {
    if (values[key] === undefined) continue // 空表单保留已配置密钥；null 显式清除。
    const value = validateSettingValue(key, values[key] ?? '')
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`setting:${key}`}, 0))`)
    const [before] = await tx
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, key))
      .for('update')
    await tx
      .insert(setting)
      .values({ key, value })
      .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } })
    await audit({
      action: 'setting.updated',
      targetType: 'setting',
      targetId: key,
      meta: {
        key,
        changes: redact({
          [key]: { oldValue: before?.value ?? settingDefaults[key], newValue: value },
        }),
      },
    })
  }
}
