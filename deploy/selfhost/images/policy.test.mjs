import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertCompleteCatalog,
  assertEvidence,
  assertPlatforms,
  hasTrustedCi,
  requiredServices,
  validateIdentity,
} from './policy.mjs'
import { Registry } from './registry.mjs'

const sha = 'a'.repeat(40)
const catalog = { schemaVersion: 1, services: requiredServices.map((name) => ({ name })) }

test('完整镜像集要求备份及每个服务的两架构成功证据', () => {
  assert.throws(() => assertCompleteCatalog({ ...catalog, pendingServices: ['backup'] }))
  assert.throws(() =>
    assertCompleteCatalog({ ...catalog, services: catalog.services.slice(0, -1) }),
  )
  assertCompleteCatalog(catalog)
  const build = { sha, arch: 'arm64', services: catalog.services }
  const smoke = {
    sha,
    arch: 'arm64',
    passed: true,
    nativeSmoke: true,
    services: catalog.services.map((s) => ({ ...s, passed: true })),
  }
  assertEvidence(catalog, sha, 'arm64', build, smoke)
  assert.throws(() => assertEvidence(catalog, sha, 'amd64', build, smoke))
  assert.throws(() =>
    assertEvidence(catalog, sha, 'arm64', build, {
      ...smoke,
      services: smoke.services.slice(0, -1),
    }),
  )
  assert.throws(() =>
    assertEvidence(catalog, sha, 'arm64', build, { ...smoke, sha: 'b'.repeat(40) }),
  )
  assert.throws(() =>
    assertPlatforms({ manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }] }),
  )
})

test('正式发布仅接受精确源码 SHA 的同仓 main push 成功 CI', () => {
  validateIdentity(sha, 'ghcr.io/owner/project')
  assert.throws(() => validateIdentity('main', 'ghcr.io/owner/project'))
  assert.throws(() => validateIdentity(sha, 'ghcr.io/owner/project;echo'))
  const run = {
    head_sha: sha,
    head_branch: 'main',
    head_repository: { full_name: 'owner/project' },
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  }
  assert(hasTrustedCi([run], sha, 'owner/project'))
  for (const override of [
    { event: 'pull_request' },
    { conclusion: 'failure' },
    { head_branch: 'feature' },
    { head_repository: { full_name: 'fork/project' } },
    { head_sha: 'b'.repeat(40) },
  ]) {
    assert.equal(hasTrustedCi([{ ...run, ...override }], sha, 'owner/project'), false)
  }
})

test('registry仅接受明确缺失，不把权限或网络失败当成可覆写 SHA', async () => {
  const response = (status, body) => new Response(JSON.stringify(body), { status })
  const registry = (reply) => new Registry('owner/project/web', { request: async () => reply })
  assert.equal(
    await registry(response(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] })).manifest(sha, true),
    null,
  )
  for (const reply of [
    response(403, {}),
    response(500, {}),
    response(404, { errors: [{ code: 'DENIED' }] }),
  ]) {
    await assert.rejects(registry(reply).manifest(sha, true))
  }
  const existing = new Response(JSON.stringify({ manifests: [] }), {
    headers: { 'docker-content-digest': `sha256:${'b'.repeat(64)}` },
  })
  assert.notEqual(await registry(existing).manifest(sha, true), null)
  await assert.rejects(
    new Registry('owner/project/web', {
      request: async () => {
        throw new Error('network failed')
      },
    }).manifest(sha, true),
  )
})

test('registry拒绝将token交给非GHCR挑战地址', async () => {
  let calls = 0
  const registry = new Registry('owner/project/web', {
    username: 'fixture',
    password: 'fixture',
    request: async () => {
      calls++
      return new Response('', {
        status: 401,
        headers: {
          'www-authenticate': 'Bearer realm="https://attacker.example/token",service="ghcr.io"',
        },
      })
    },
  })
  await assert.rejects(registry.manifest(sha, true))
  assert.equal(calls, 1)
})
