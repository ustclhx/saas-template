import { getSettingDefinition, type JsonValue } from '@saas/db'
import { isSensitiveKey, REDACTED } from '@saas/shared'

// 历史审计可能把设置值记在通用 oldValue/newValue 字段下，需结合设置定义脱敏。
function redactAuditMeta(meta: JsonValue, secretSetting: boolean, depth = 0): JsonValue {
  if (depth >= 8) return '[Truncated]'
  if (Array.isArray(meta))
    return meta.map((item) => redactAuditMeta(item, secretSetting, depth + 1))
  if (meta === null || typeof meta !== 'object') return meta
  const secret =
    secretSetting ||
    (typeof meta.key === 'string' && getSettingDefinition(meta.key)?.secret === true)
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => {
      const hide =
        isSensitiveKey(key) ||
        key.toLowerCase().replace(/[-_]/g, '') === 'tokenhash' ||
        getSettingDefinition(key)?.secret ||
        (secret && (key === 'oldValue' || key === 'newValue' || key === 'value'))
      return [key, hide ? REDACTED : redactAuditMeta(value, secret, depth + 1)]
    }),
  )
}

/**
 * audit.list 的返回行：只脱敏 `log.meta`，其余字段原样保留。项目的 listAuditLogs 可在行上附加字段
 * （如多站点项目的 `site`），这里不能按模板字段重建行而把它们丢掉。
 */
export function auditRows<
  Row extends {
    log: { targetType: string | null; targetId: string | null; meta: JsonValue | unknown }
  },
>(rows: readonly Row[]): Row[] {
  return rows.map((row) => {
    const { log } = row
    const secret =
      log.targetType === 'setting' &&
      log.targetId !== null &&
      getSettingDefinition(log.targetId)?.secret === true
    return { ...row, log: { ...log, meta: redactAuditMeta(log.meta as JsonValue, secret) } }
  })
}
