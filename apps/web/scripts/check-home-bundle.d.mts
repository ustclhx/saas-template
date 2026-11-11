export const FORBIDDEN_MARKERS: readonly string[]
export function htmlScripts(html: string): string[]
export function staticClosure(clientDir: string, entries: readonly string[]): string[]
export function checkHomeBundle(clientDir: string): {
  files: string[]
  gzipBytes: number
  violations: { asset: string; marker: string }[]
}
