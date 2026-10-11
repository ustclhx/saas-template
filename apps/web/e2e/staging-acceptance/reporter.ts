import type {
  FullResult,
  Reporter,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter'

// 默认 reporter 的 locator/请求诊断可能包含邮箱或请求体；这里只输出固定标题与状态。
export default class AcceptanceReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult) {
    const skip =
      result.status === 'skipped'
        ? test.annotations
            .filter((item) => item.type === 'skip')
            .map((item) => item.description)
            .join('; ')
        : ''
    process.stdout.write(`${result.status}: ${test.title}${skip ? ` (${skip})` : ''}\n`)
    for (const error of result.errors) this.onError(error)
  }
  onError(error: TestError) {
    const frames =
      error.stack?.split('\n').filter((line) => /^\s+at .*\.[cm]?tsx?:\d+:\d+\)?$/.test(line)) ?? []
    process.stdout.write(
      `Failure location: ${frames.slice(0, 3).join('\n') || 'setup/server; inspect locally without exporting logs'}\n`,
    )
  }
  onEnd(result: FullResult) {
    process.stdout.write(`Acceptance suite: ${result.status}\n`)
  }
}
