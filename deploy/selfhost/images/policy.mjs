import assert from 'node:assert/strict'

export const architectures = ['amd64', 'arm64']
export const requiredServices = ['web', 'jobs', 'migrate', 'postgres', 'valkey', 'caddy', 'backup']

export function validateIdentity(sha, namespace) {
  assert.match(sha, /^[a-f0-9]{40}$/, 'source must be a full lowercase git SHA')
  // 显式 namespace；不将用户输入交给 shell，也不默默改写仓库归属。
  assert.match(namespace, /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
}

export function assertCompleteCatalog(catalog) {
  assert.equal(catalog.schemaVersion, 1)
  assert.equal(new Set(catalog.services.map((s) => s.name)).size, catalog.services.length)
  assert.deepEqual(
    catalog.pendingServices ?? [],
    [],
    'pending backup owner delivery blocks publication',
  )
  for (const name of requiredServices) {
    assert(
      catalog.services.some((service) => service.name === name),
      `required image missing: ${name}`,
    )
  }
}

export function assertEvidence(catalog, sha, arch, build, smoke) {
  assert.equal(build.sha, sha)
  assert.equal(smoke.sha, sha)
  assert.equal(build.arch, arch)
  assert.equal(smoke.arch, arch)
  assert.equal(smoke.passed, true)
  for (const { name } of catalog.services) {
    assert(
      build.services.some((service) => service.name === name),
      `build missing: ${name}/${arch}`,
    )
    assert(
      smoke.services.some((service) => service.name === name && service.passed === true),
      `smoke missing: ${name}/${arch}`,
    )
  }
  assert.equal(smoke.nativeSmoke, true)
}

export function assertPlatforms(index) {
  assert.equal(
    index.manifests.length,
    2,
    'release index must contain exactly two runtime manifests',
  )
  const platforms = index.manifests
    .filter((item) => item.platform?.os === 'linux')
    .map((item) => item.platform.architecture)
    .sort()
  assert.deepEqual(
    platforms,
    architectures,
    'image index must contain exactly both Linux architectures',
  )
}

export function hasTrustedCi(runs, sha, repository) {
  return runs.some(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === 'main' &&
      run.head_repository?.full_name === repository &&
      run.event === 'push' &&
      run.status === 'completed' &&
      run.conclusion === 'success',
  )
}
