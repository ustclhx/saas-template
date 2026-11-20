import type { SeoLinkingConfig } from '@saas/config'

export type LinkingThresholds = SeoLinkingConfig['thresholds']
export type LinkingConfig = SeoLinkingConfig
export interface ParsedLink {
  href: string
  rel: string[]
  zone: string
  region: string | null
  inNav: boolean
  text: string
  imageOnly: boolean
  imageAltMissing: boolean
  anchor: string
}
export interface ParsedPage {
  lang: string | null
  canonical: string | null
  robots: string | null
  links: ParsedLink[]
  h1: string[]
  groups: string[]
  hasNavZone: boolean
  /** `<link rel="alternate" hreflang>`，按出现顺序 */
  alternates: { hreflang: string; href: string }[]
  /** 服务端 HTML 中带语言提示标记（内置 data-language-prompt／data-locale-suggestion* 与 promptMarkers）的元素数 */
  languagePrompts: number
}
export interface FetchedTarget {
  url: string
  status: number
  canonical?: string | null
  robots?: string | null
}
export interface CheckedPage extends FetchedTarget {
  path: string
  parsed?: ParsedPage | undefined
  setCookies?: string[] | undefined
}
export interface Finding {
  rule: string
  page: string
  target?: string | undefined
  message: string
}
export interface LinkGraphResult {
  failures: Finding[]
  warnings: Finding[]
  stats: { pages: number; links: number; edges: number; maxDepth: number }
  sites?: Record<
    string,
    { pages: number; links: number; maxDepth: number; counts: ReturnType<typeof countByRule> }
  >
}
export type ClassifiedHref =
  | { kind: 'internal'; path: string }
  | { kind: 'external'; host: string; path: string }
  | { kind: 'invalid'; href: string }
  | null

export const LINK_TO_NOINDEX_EXEMPT: ReadonlySet<string>
export const FAILURE_RULES: readonly string[]
export const WARNING_RULES: readonly string[]
export const LANGUAGE_QUERY_PARAMS: readonly string[]
export const LEGACY_LANGUAGE_COOKIES: readonly string[]
export const ACCEPT_LANGUAGE_VARIANTS: readonly string[]
export function resolveLinkingConfig(raw: unknown): LinkingConfig
export function decodeEntities(text: string): string
export const BUILTIN_PROMPT_MARKERS: readonly string[]
export function isPromptMarker(name: string, markers?: readonly string[]): boolean
export function parsePage(
  html: string,
  options?: { promptMarkers?: readonly string[] | undefined },
): ParsedPage
export function normalizePath(pathname: string, search?: string): string
export function classifyHref(
  href: string,
  pageUrl: string,
  internalHosts: Set<string>,
): ClassifiedHref
export function analyzeLinkGraph(input: {
  pages: CheckedPage[]
  targets: Map<string, FetchedTarget>
  indexable: Set<string>
  homes: string[]
  internalHosts: Set<string>
  locales?: readonly string[]
  config: LinkingConfig
  /** 提供时按 xDefaultLocales 检查 x-default 的指向 */
  i18n?: { enabled?: boolean; locales: readonly string[]; defaultLocale: string } | undefined
}): LinkGraphResult
export function countByRule(result: LinkGraphResult): {
  failures: Record<string, number>
  warnings: Record<string, number>
}
export function formatReport(
  result: LinkGraphResult,
  options?: { mode?: string; limit?: number },
): string
export function exitCode(result: LinkGraphResult, mode: string): number
export function sitemapLocations(xml: string): string[]
export interface LinkGraphPlan {
  /** 多站点时为该站点的 previewHost；单站点为 null */
  host: string | null
  origin: string
  homes: string[]
  localePrefixes: string[]
  otherHosts: string[]
  /** 该图以无前缀地址服务的语言；null 表示所有语言都带前缀 */
  defaultLocale: string | null
}
export function planLinkGraphs(input: {
  baseUrl: string
  i18n?: { enabled?: boolean; locales?: readonly string[]; defaultLocale: string } | undefined
  sites?: LinkingConfig['sites']
  localize: (locale: string) => string
}): LinkGraphPlan[]
export function mergeGraphResults(
  entries: { host: string | null; result: LinkGraphResult }[],
): LinkGraphResult
export function languageQuery(href: string, pageUrl: string): string | null
export function normalizeBody(html: string): string
export interface ProbeResponse {
  status: number
  location?: string | null
  body?: string | null
}
export function responseSignature(response: ProbeResponse): {
  status: number
  location: string | null
  lang: string | null
  digest: string | null
}
export function compareAcceptLanguage(
  path: string,
  responses: (ProbeResponse & { acceptLanguage: string })[],
): Finding[]
export function languageCookies(
  setCookies: readonly string[],
  options?: { names?: readonly string[]; locales?: readonly string[] },
): string[]
export function checkDefaultPrefix(input: {
  path: string
  expected: string
  url: string
  status: number
  location: string | null
}): Finding | null
export function acceptLanguagePaths(input: {
  homes: readonly string[]
  indexable: ReadonlySet<string>
  samples: number
}): string[]
export function addFindings(result: LinkGraphResult, findings: readonly Finding[]): LinkGraphResult
