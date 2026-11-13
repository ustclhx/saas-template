import { templateConfig } from '../../server/template-config.ts'
import type { RegisteredShareCard, ShareCardDefinition } from './types.ts'

export const defaultShareTokenPattern = /^[A-Za-z0-9_-]{22,64}$/
const registry = new Map<string, RegisteredShareCard<unknown>>()

export function registerShareCard<T>(definition: ShareCardDefinition<T>): RegisteredShareCard<T> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(definition.type)) {
    throw new TypeError('Share card type must use lowercase letters, numbers and hyphens')
  }
  if (registry.has(definition.type)) {
    throw new Error(`Share card type already registered: ${definition.type}`)
  }
  const registered: RegisteredShareCard<T> = {
    ...definition,
    tokenPattern: definition.tokenPattern ?? defaultShareTokenPattern,
    ttlDays:
      definition.ttlDays === undefined
        ? templateConfig.shareCards.defaultTtlDays
        : definition.ttlDays,
    sharePage: definition.sharePage !== false,
  }
  // 注册表擦除各业务数据类型；调用方须把同一定义 resolve 的数据交回该定义。
  registry.set(definition.type, registered as RegisteredShareCard<unknown>)
  return registered
}

export function getShareCard(type: string): RegisteredShareCard<unknown> | undefined {
  return registry.get(type)
}
