import type { LinkGraphResult, LinkingConfig } from './check-links-graph.mjs'

export interface LinkResponse {
  status: number
  header(name: string): string | null
  text(): Promise<string>
  cancel(): Promise<void>
}
export function fetchRequest(url: string): Promise<LinkResponse>
export function hostRequest(
  baseUrl: string,
  hosts: ReadonlySet<string>,
): (url: string) => Promise<LinkResponse>
export function checkLinks(input: {
  baseUrl: string
  templateConfig: {
    app?: { url?: string }
    i18n?: { enabled?: boolean; locales?: readonly string[]; defaultLocale: string }
    seo?: { linking?: unknown }
  }
  mode?: string | undefined
  localize?: ((locale: string) => string) | undefined
}): Promise<{ result: LinkGraphResult; mode: string; config: LinkingConfig }>
