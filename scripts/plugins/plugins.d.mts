import type { PluginManifest, PluginTarget, TemplateConfig } from '@saas/config'

export interface LoadedPlugin {
  readonly manifest: PluginManifest
  /** 插件目录（绝对路径） */
  readonly dir: string
}

export interface EnabledPlugin extends LoadedPlugin {
  /** 经插件 schema 解析后的配置段 */
  readonly config: unknown
}

export interface PhysicalRoute {
  type: 'physical'
  pathPrefix: string
  directory: string
}

export interface PluginRouteConfig {
  type: 'root'
  file: string
  children: PhysicalRoute[]
}

export declare const REPO_ROOT: string
export declare const GENERATED_FILES: {
  readonly web: string
  readonly worker: string
  readonly webNode: string
  readonly styles: string
  readonly stylesNode: string
  readonly jobs: string
  readonly jobsNode: string
}
export declare const NODE_WEB_ALIASES: Readonly<Record<string, string>>

export declare function loadPluginManifests(root?: string): Promise<LoadedPlugin[]>
export declare function loadTemplateConfig(root?: string): Promise<TemplateConfig<string>>
export declare function resolveEnabledPlugins(
  config: TemplateConfig<string>,
  loaded: readonly LoadedPlugin[],
): EnabledPlugin[]
export declare function renderPluginFiles(
  root: string,
  plugins: readonly EnabledPlugin[],
): Record<string, string>
export declare function pluginRouteConfig(
  root: string,
  plugins: readonly EnabledPlugin[],
  target: PluginTarget,
): PluginRouteConfig
export declare function pluginMessageDirs(
  plugins: readonly EnabledPlugin[],
  target: PluginTarget,
): string[]
export declare function generatePlugins(options?: {
  root?: string
  config?: TemplateConfig<string>
  loaded?: readonly LoadedPlugin[]
  write?: boolean
  notify?: (message: string) => void
}): Promise<{ plugins: EnabledPlugin[]; files: Record<string, string>; excluded: EnabledPlugin[] }>
