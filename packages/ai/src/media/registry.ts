import { AppError } from '@saas/shared'
import { createFalMediaProvider } from './fal.ts'
import { createKieMediaProvider, isKieUnifiedModel, KIE_OUTPUT_HOSTS } from './kie.ts'
import type { TaskMediaProvider } from './provider.ts'
import { createWorkersAiMediaProvider, type WorkersAiBinding } from './workers-ai.ts'

export interface MediaProviderEnv {
  readonly FAL_KEY?: string
  readonly AI?: WorkersAiBinding
  readonly MEDIA_WEBHOOK_SECRET?: string
  readonly KIE_API_KEY?: string
  /** kie 设置页的 webhookHmacKey，用于回调验签。 */
  readonly KIE_WEBHOOK_SECRET?: string
}

export interface MediaProviderDefinition {
  readonly id: string
  readonly synchronous: boolean
  readonly supportedKinds: readonly ('image' | 'video')[]
  readonly outputHosts: readonly string[]
  isConfigured(env: MediaProviderEnv): boolean
  create(env: MediaProviderEnv, options: { modelId: string }): TaskMediaProvider
}

export const mediaProviderDefinitions: readonly MediaProviderDefinition[] = [
  {
    id: 'fal',
    synchronous: false,
    supportedKinds: ['image', 'video'],
    // fal 官方 API 示例与现有夹具的主机；只允许精确主机名。
    outputHosts: ['fal.media', 'v3.fal.media', 'v3b.fal.media'],
    isConfigured: (env) => Boolean(env.FAL_KEY),
    create(env, { modelId }) {
      if (!env.FAL_KEY) throw unavailable()
      return createFalMediaProvider({ apiKey: env.FAL_KEY, modelId, fetch: globalThis.fetch })
    },
  },
  {
    id: 'workers-ai',
    synchronous: true,
    supportedKinds: ['image'],
    outputHosts: [],
    isConfigured: (env) => Boolean(env.AI),
    create(env, { modelId }) {
      if (!env.AI) throw unavailable()
      return createWorkersAiMediaProvider({ binding: env.AI, modelId })
    },
  },
  {
    // 默认不在 template.config.ts 启用；条款风险与建议用途见 docs/06-ai.md。
    id: 'kie',
    synchronous: false,
    supportedKinds: ['image', 'video'],
    outputHosts: KIE_OUTPUT_HOSTS,
    // 回调验签密钥缺失时无法区分伪造回调，与 API key 一起视为必需。
    isConfigured: (env) => Boolean(env.KIE_API_KEY && env.KIE_WEBHOOK_SECRET),
    create(env, { modelId }) {
      if (!env.KIE_API_KEY || !env.KIE_WEBHOOK_SECRET) throw unavailable()
      if (!isKieUnifiedModel(modelId))
        throw new AppError('MODEL_UNAVAILABLE', 'kie.ai model is not supported', { status: 404 })
      return createKieMediaProvider({
        apiKey: env.KIE_API_KEY,
        webhookSecret: env.KIE_WEBHOOK_SECRET,
        modelId,
        fetch: globalThis.fetch,
      })
    },
  },
]

function unavailable() {
  return new AppError('AI_PROVIDER_NOT_CONFIGURED', 'Media provider is not configured', {
    status: 503,
  })
}

export function getMediaProviderDefinition(id: string): MediaProviderDefinition | undefined {
  return mediaProviderDefinitions.find((definition) => definition.id === id)
}

export function getMediaOutputHosts(id: string): readonly string[] {
  return getMediaProviderDefinition(id)?.outputHosts ?? []
}

export function requireMediaProviderDefinition(
  id: string,
  env: MediaProviderEnv,
  enabledProviders: readonly string[] = mediaProviderDefinitions.map((definition) => definition.id),
): MediaProviderDefinition {
  const definition = getMediaProviderDefinition(id)
  if (!definition || !enabledProviders.includes(id))
    throw new AppError('MODEL_UNAVAILABLE', 'Media provider is not enabled', { status: 404 })
  if (!definition.isConfigured(env)) throw unavailable()
  return definition
}
