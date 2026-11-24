import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EnvValidationError, loadEnv } from './env.ts'
import {
  definePlugin,
  PluginConfigError,
  type PluginManifest,
  pluginBindingsShape,
  pluginManifestIssues,
  pluginsForTarget,
  resolvePlugins,
} from './plugins.ts'
import { defineTemplateConfig, type TemplateConfigInput } from './template.ts'

const app = { name: 'MyApp', url: 'https://example.com', supportEmail: 'support@example.com' }

const media = definePlugin({
  id: 'media',
  targets: ['cloudflare', 'node'],
  requires: { features: ['billing', 'credits'] },
  config: z.object({ providers: z.array(z.enum(['fal', 'workers-ai'])).default(['fal']) }).strict(),
  bindings: {
    web: [{ name: 'AI_MEDIA_WORKFLOW', kind: 'workflow', className: 'AiMediaWorkflow' }],
  },
})
const agents = definePlugin({
  id: 'agents',
  targets: ['cloudflare'],
  requires: { plugins: ['media'] },
})
const plain = definePlugin({ id: 'plain', targets: ['cloudflare', 'node'] })
const manifests = [media, agents, plain]

function config(input: Omit<TemplateConfigInput, 'app'>) {
  return defineTemplateConfig({ app, ...input })
}

/** 断言抛出 PluginConfigError，返回问题列表 */
function issuesOf(run: () => unknown): readonly string[] {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(PluginConfigError)
    return (error as PluginConfigError).issues
  }
  throw new Error('expected PluginConfigError')
}

describe('resolvePlugins', () => {
  it('returns enabled plugins sorted by id with parsed config sections', () => {
    const resolved = resolvePlugins(config({ plugins: { plain: {}, media: {} } }), manifests)
    expect(resolved.map((plugin) => plugin.manifest.id)).toEqual(['media', 'plain'])
    expect(resolved[0]?.config).toEqual({ providers: ['fal'] })
  })

  it('treats a config without plugins as nothing enabled', () => {
    expect(resolvePlugins(config({ ai: { image: false, video: false } }), manifests)).toEqual([])
  })

  it('rejects unknown plugin ids and lists the available ones', () => {
    expect(
      issuesOf(() => resolvePlugins(config({ plugins: { nope: {}, media: {} } }), manifests)),
    ).toEqual(['plugins.nope: unknown plugin (available: agents, media, plain)'])
  })

  it('rejects a config section that fails the plugin schema', () => {
    expect(
      issuesOf(() =>
        resolvePlugins(
          config({ plugins: { media: { providers: ['openai' as never] } } }),
          manifests,
        ),
      ),
    ).toEqual([expect.stringMatching(/^plugins\.media\.providers\.0: /)])
    expect(
      issuesOf(() =>
        resolvePlugins(config({ plugins: { media: {}, plain: { x: 1 } } }), manifests),
      ),
    ).toEqual(['plugins.plain: this plugin takes no options; use {}'])
  })

  it('rejects a plugin whose plugin dependency is not enabled', () => {
    expect(
      issuesOf(() =>
        resolvePlugins(
          config({ plugins: { agents: {} }, ai: { image: false, video: false } }),
          manifests,
        ),
      ),
    ).toEqual(['plugins.agents requires plugin media; add plugins.media'])
  })

  it('rejects a plugin whose required template switch is off and names the switch', () => {
    const off = config({
      billing: { enabled: false },
      ai: { text: { enabled: false }, image: false, video: false },
      plugins: { media: {} },
    })
    expect(issuesOf(() => resolvePlugins(off, manifests))).toEqual([
      'plugins.media requires billing.enabled to be enabled',
    ])
  })

  it('requires the media plugin when image or video generation is on', () => {
    expect(issuesOf(() => resolvePlugins(config({ ai: { video: false } }), manifests))).toEqual([
      'ai.image / ai.video require the media plugin; add plugins: { media: {} }',
    ])
    // 尚无 media 插件的仓库（迁移前）不强制
    expect(resolvePlugins(config({}), [plain])).toEqual([])
  })

  it('reports every problem at once', () => {
    const issues = issuesOf(() =>
      resolvePlugins(config({ plugins: { agents: {}, ghost: {} } }), manifests),
    )
    expect(issues).toHaveLength(3)
  })

  it('rejects duplicate manifests and manifest shape errors', () => {
    expect(
      issuesOf(() =>
        resolvePlugins(config({ ai: { image: false, video: false } }), [plain, plain]),
      ),
    ).toEqual(['plugin plain: declared by more than one plugin.ts'])
  })
})

describe('definePlugin', () => {
  it('rejects malformed manifests field by field', () => {
    const bad = {
      id: 'Bad_Id',
      targets: [],
      requires: { plugins: ['Bad_Id'], features: ['nope'] },
      routes: { dir: '../routes', mount: '/x' },
      entries: { web: '/abs.ts', other: 'x.ts', jobsNode: 'src/node/jobs.ts' },
      messages: '../messages',
      bindings: {
        web: [
          { name: 'lower', kind: 'kv' },
          { name: 'WF', kind: 'workflow' },
          { name: 'WF', kind: 'kv', className: 'X' },
          { name: 'Q', kind: 'nope' },
        ],
      },
      secrets: ['bad-secret'],
    } as unknown as PluginManifest
    expect(pluginManifestIssues(bad)).toEqual([
      'plugin Bad_Id: id must be lowercase kebab-case',
      'plugin Bad_Id: targets must be a non-empty list of cloudflare / node',
      'plugin Bad_Id: requires.plugins has an invalid plugin id "Bad_Id"',
      'plugin Bad_Id: requires.features has unknown feature "nope" (known: billing, credits, marketing, i18n, ai.text, ai.image, ai.video, publicApi)',
      'plugin Bad_Id: routes.dir must be a relative path',
      "plugin Bad_Id: routes.mount must be '' or a path without leading/trailing slash",
      'plugin Bad_Id: entries.web must be a relative path',
      'plugin Bad_Id: entries has unknown entry other',
      "plugin Bad_Id: entries declares Node entries but targets lacks 'node'",
      'plugin Bad_Id: messages must be a relative path',
      'plugin Bad_Id: bindings.web has an invalid binding name "lower"',
      'plugin Bad_Id: bindings.web WF (workflow) requires className',
      'plugin Bad_Id: bindings.web declares WF more than once',
      'plugin Bad_Id: bindings.web WF (kv) must not set className',
      'plugin Bad_Id: bindings.web Q has unknown kind "nope"',
      'plugin Bad_Id: secrets has an invalid secret name "bad-secret"',
    ])
    expect(() => definePlugin(bad)).toThrow(PluginConfigError)
  })
})

describe('pluginsForTarget', () => {
  it('excludes Cloudflare-only plugins from the Node target', () => {
    const resolved = [{ manifest: agents }, { manifest: plain }]
    expect(pluginsForTarget(resolved, 'node')).toEqual({
      included: [{ manifest: plain }],
      excluded: [{ manifest: agents }],
    })
    expect(pluginsForTarget(resolved, 'cloudflare').excluded).toEqual([])
  })
})

describe('defineTemplateConfig plugins section', () => {
  it('defaults to no plugins and keeps the declared sections', () => {
    expect(config({}).plugins).toEqual({})
    expect(config({ plugins: { media: { providers: ['fal'] } } }).plugins).toEqual({
      media: { providers: ['fal'] },
    })
  })

  it('rejects malformed plugin ids and sections', () => {
    expect(() => config({ plugins: { Media: {} } })).toThrow(
      'plugins.Media is not a valid plugin id',
    )
    expect(() => config({ plugins: { media: true as never } })).toThrow(
      'plugins.media must be an object',
    )
    expect(() => config({ plugins: [] as never })).toThrow('plugins must be an object')
  })
})

describe('pluginBindingsShape', () => {
  const schema = z.object(
    pluginBindingsShape([
      { name: 'AGENT', kind: 'durable_object' },
      { name: 'AI_MEDIA_WORKFLOW', kind: 'workflow' },
      { name: 'AI', kind: 'ai', optional: true },
    ]),
  )
  const fn = () => undefined
  const workflow = { create: fn, get: fn }

  it('reports missing required bindings by name and accepts absent optional ones', () => {
    try {
      loadEnv({ AI_MEDIA_WORKFLOW: workflow }, schema)
      throw new Error('expected EnvValidationError')
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError)
      expect((error as EnvValidationError).missing).toEqual(['AGENT'])
    }
    expect(() =>
      loadEnv({ AGENT: { idFromName: fn, get: fn }, AI_MEDIA_WORKFLOW: workflow }, schema),
    ).not.toThrow()
  })

  it('rejects bindings of the wrong shape, including present optional ones', () => {
    try {
      loadEnv({ AGENT: { get: fn }, AI_MEDIA_WORKFLOW: workflow, AI: {} }, schema)
      throw new Error('expected EnvValidationError')
    } catch (error) {
      expect((error as EnvValidationError).invalid).toEqual(['AGENT', 'AI'])
    }
  })
})
