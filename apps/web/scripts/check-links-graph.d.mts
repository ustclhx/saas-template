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
}
export type ClassifiedHref =
  | { kind: 'internal'; path: string }
  | { kind: 'external'; host: string; path: string }
  | { kind: 'invalid'; href: string }
  | null

export const LINK_TO_NOINDEX_EXEMPT: ReadonlySet<string>
export const FAILURE_RULES: readonly string[]
export const WARNING_RULES: readonly string[]
export function resolveLinkingConfig(raw: unknown): LinkingConfig
export function decodeEntities(text: string): string
export function parsePage(html: string): ParsedPage
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
