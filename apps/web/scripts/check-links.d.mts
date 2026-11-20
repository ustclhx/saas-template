import type { LinkGraphResult, LinkingConfig } from './check-links-graph.mjs'

export interface LinkResponse {
  status: number
  header(name: string): string | null
  text(): Promise<string>
  cancel(): Promise<void>
  setCookies(): string[]
}
export function fetchRequest(url: string, headers?: Record<string, string>): Promise<LinkResponse>
export function hostRequest(
  baseUrl: string,
  hosts: ReadonlySet<string>,
): (url: string, headers?: Record<string, string>) => Promise<LinkResponse>
export function checkLinks(input: {
  baseUrl: string
  templateConfig: {
    app?: { url?: string }
    i18n?: { enabled?: boolean; locales?: readonly string[]; defaultLocale: string }
    seo?: { linking?: unknown }
  }
  mode?: string | undefined
  localize?: ((locale: string) => string) | undefined
  /** Paraglide 的 Cookie 名；传入 `localize` 时不加载运行时，需要一并传入 */
  cookieName?: string | undefined
  /** 除语言首页外抽样做 Accept-Language 对比的可索引页数，默认 3 */
  acceptLanguageSamples?: number | undefined
}): Promise<{ result: LinkGraphResult; mode: string; config: LinkingConfig }>
