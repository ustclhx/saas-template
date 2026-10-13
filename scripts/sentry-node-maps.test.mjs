import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { nodeMapTargets, prepareNodeMaps } from './sentry-node-maps.mjs'

test('Node maps use matching release/dist, isolate upload secrets and remove public maps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfhost-c-wire-maps-'))
  const release = '0123456789abcdef0123456789abcdef01234567'
  try {
    for (const target of nodeMapTargets(root)) {
      await mkdir(target.directory, { recursive: true })
      await writeFile(join(target.directory, 'index.mjs.map'), '{}')
      await writeFile(
        join(target.directory, '../node-build.json'),
        JSON.stringify({ release, dist: target.dist }),
      )
    }
    const publicDirectory = join(root, 'apps/web/.output/public')
    await mkdir(publicDirectory, { recursive: true })
    await writeFile(join(publicDirectory, 'client.js.map'), '{}')
    await writeFile(join(publicDirectory, 'client.js'), 'safe asset')
    const calls = []
    const env = {
      PATH: process.env.PATH,
      SENTRY_AUTH_TOKEN: 'fixture-token',
      SENTRY_ORG: 'fixture',
      SENTRY_PROJECT: 'fixture',
    }
    const run = (args, environment) => calls.push({ args, environment })
    await prepareNodeMaps({ root, release, env, run })
    assert.equal(calls.length, 2)
    assert.ok(calls.every(({ environment }) => environment.SENTRY_AUTH_TOKEN === undefined))
    await assert.rejects(readFile(join(publicDirectory, 'client.js.map')), { code: 'ENOENT' })
    assert.equal(await readFile(join(publicDirectory, 'client.js'), 'utf8'), 'safe asset')
    calls.length = 0
    await prepareNodeMaps({ root, release, upload: true, env, run })
    assert.deepEqual(calls[0].args, ['releases', 'new', release])
    assert.deepEqual(calls.at(-1).args, ['releases', 'finalize', release])
    const uploads = calls.filter(({ args }) => args[1] === 'upload')
    assert.equal(uploads.length, 2)
    for (const [index, { args, environment }] of uploads.entries()) {
      assert.ok(args.includes(index === 0 ? 'web-node' : 'jobs-node'))
      assert.ok(args.includes(release))
      assert.ok(args.at(-1).endsWith('/.output/server'))
      assert.ok(!args.join(' ').includes('/dist/'))
      assert.ok(!args.join(' ').includes('fixture-token'))
      assert.equal(environment.SENTRY_AUTH_TOKEN, env.SENTRY_AUTH_TOKEN)
    }
    await assert.rejects(prepareNodeMaps({ root, release: 'bad', env, run }), /full git SHA/)
    await assert.rejects(
      prepareNodeMaps({ root, release, upload: true, env: {}, run }),
      /SENTRY_AUTH_TOKEN/,
    )
    await assert.rejects(
      prepareNodeMaps({ root, release: '1'.repeat(40), env, run }),
      /metadata mismatch/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
