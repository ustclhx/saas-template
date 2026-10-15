import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkRelease } from './check-release.mjs'

const sha = 'a'.repeat(40)

function run(overrides = {}) {
  const lines = []
  const deps = {
    isOnMain: async () => true,
    stagingRuns: async () => [{ head_sha: sha, conclusion: 'success' }],
    write: (line) => lines.push(line),
    ...overrides,
  }
  const target = 'sha' in overrides ? overrides.sha : sha
  return checkRelease(target, deps).then((code) => ({ code, lines }))
}

test('accepts a main commit with a successful staging deployment', async () => {
  const { code, lines } = await run()
  assert.equal(code, 0)
  assert.match(lines[0], /deployed to staging/)
})

test('rejects a commit that is not on main before querying staging runs', async () => {
  let queried = false
  const { code, lines } = await run({
    isOnMain: async () => false,
    stagingRuns: async () => {
      queried = true
      return []
    },
  })
  assert.equal(code, 1)
  assert.equal(queried, false)
  assert.match(lines[0], /not on main/)
})

test('rejects a commit without a successful staging deployment of the same SHA', async () => {
  const other = 'b'.repeat(40)
  for (const runs of [
    [],
    [{ head_sha: sha, conclusion: 'failure' }],
    [{ head_sha: other, conclusion: 'success' }],
  ]) {
    const { code, lines } = await run({ stagingRuns: async () => runs })
    assert.equal(code, 1)
    assert.match(lines[0], /no successful Deploy staging run/)
  }
})

test('rejects abbreviated or malformed SHAs', async () => {
  for (const value of [undefined, '', 'abc1234', 'z'.repeat(40)]) {
    const { code } = await run({ sha: value })
    assert.equal(code, 1)
  }
})
