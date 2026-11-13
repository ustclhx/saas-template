import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { renderedPromptDigest, renderPrompt, sha256Digest } from '@saas/ai'
import { generationRecordingPath, judgeRecordingPath, writeRecording } from './models.ts'
import { loadSuite } from './suite.ts'

/** 单测夹具：在临时根目录下生成项目套件 `evals/<name>/`，不访问网络 */
const INDEX = resolve(import.meta.dirname, 'index.ts')

export interface TempSuite {
  readonly root: string
  readonly dir: string
  readonly name: string
  cleanup(): void
  /** 写入一条生成录制与（可选）评委录制；评委三项分数按 1–5 */
  record(
    promptVersion: string,
    sampleId: string,
    output: string,
    judge?: readonly [number, number] | string,
  ): Promise<void>
}

export function tempSuite(options: {
  name?: string
  samples?: readonly { id: string; input: unknown; expect?: unknown; tags?: string[] }[]
  /** 追加到 defineSuite({...}) 中的源码片段 */
  extra?: string
  judge?: boolean
  price?: boolean
}): TempSuite {
  const name = options.name ?? 'demo'
  const root = mkdtempSync(join(tmpdir(), 'evals-run-'))
  const dir = join(root, 'evals', name)
  mkdirSync(dir, { recursive: true })
  const price =
    options.price === false ? '' : 'priceUsd: { inputPerMTok: 1000, outputPerMTok: 1000 },'
  writeFileSync(
    join(dir, 'suite.ts'),
    `import { checks, definePrompt, defineSuite } from ${JSON.stringify(INDEX)}
const v1 = definePrompt<{ topic: string }>({
  id: 'demo', version: 'v1', system: 'Write about the topic.',
  user: (input) => 'Topic: ' + input.topic, maxOutputTokens: 100,
  sections: [{ id: 'summary', heading: 'Summary' }],
})
const v2 = definePrompt<{ topic: string }>({
  id: 'demo', version: 'v2', system: 'Write clearly about the topic.',
  user: (input) => 'Topic: ' + input.topic, maxOutputTokens: 100,
  sections: [{ id: 'summary', heading: 'Summary' }],
})
export default defineSuite({
  name: ${JSON.stringify(name)},
  prompts: [v1, v2],
  models: {
    gen: { provider: 'openai', providerModelId: 'gpt-test', ${price} },
    judge: { provider: 'openai', providerModelId: 'gpt-judge', ${price} },
  },
  generator: 'gen',
  ${
    options.judge === false
      ? ''
      : `judge: { model: 'judge', rubric: { version: 'r1', scale: { min: 1, max: 5 }, criteria: [
    { id: 'accuracy', description: 'Accurate', weight: 1 },
    { id: 'clarity', description: 'Clear', weight: 1 },
  ] } },`
  }
  checks: [checks.sections(), checks.length({ min: 5 })],
  ${options.extra ?? ''}
})
`,
  )
  writeFileSync(
    join(dir, 'samples.json'),
    JSON.stringify(
      options.samples ?? [
        { id: 's1', input: { topic: 'tea' }, tags: ['a'] },
        { id: 's2', input: { topic: 'rice' }, tags: ['b'] },
      ],
    ),
  )
  return {
    root,
    dir,
    name,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    async record(promptVersion, sampleId, output, judge) {
      const { suite, samples } = await loadSuite(name, root)
      const prompt = suite.prompts.find((item) => item.promptVersion === promptVersion)
      const sample = samples.find((item) => item.id === sampleId)
      if (!prompt || !sample) throw new Error(`unknown ${promptVersion} / ${sampleId}`)
      const model = { key: 'gen', provider: 'openai', providerModelId: 'gpt-test' }
      writeRecording(generationRecordingPath(dir, promptVersion, 'gen', sampleId), {
        kind: 'generation',
        promptVersion,
        renderedHash: await renderedPromptDigest(renderPrompt(prompt, sample.input)),
        model,
        output,
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 20 },
        recordedAt: '2026-11-14T00:00:00.000Z',
        source: 'constructed',
      })
      if (judge === undefined) return
      const text =
        typeof judge === 'string'
          ? judge
          : JSON.stringify({
              criteria: {
                accuracy: { score: judge[0], reason: 'a' },
                clarity: { score: judge[1], reason: 'c' },
              },
              summary: 's',
            })
      writeRecording(judgeRecordingPath(dir, promptVersion, 'gen', sampleId, 'judge'), {
        kind: 'judge',
        promptVersion,
        rubricVersion: 'r1',
        outputHash: await sha256Digest(output),
        model: { key: 'judge', provider: 'openai', providerModelId: 'gpt-judge' },
        output: text,
        finishReason: 'stop',
        usage: { inputTokens: 30, outputTokens: 40 },
        recordedAt: '2026-11-14T00:00:00.000Z',
        source: 'constructed',
      })
    },
  }
}

export const GOOD = '## Summary\n\nA clear and accurate text.'
