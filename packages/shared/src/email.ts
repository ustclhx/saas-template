/** Gmail and Googlemail share one identity; other providers retain dots and tags. */
export function normalizeSignupEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  const parts = normalized.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Invalid signup email')
  let [local, domain] = parts as [string, string]
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    domain = 'gmail.com'
    local = local.split('+')[0]?.replaceAll('.', '') ?? ''
    if (!local) throw new Error('Invalid signup email')
  }
  return `${local}@${domain}`
}
