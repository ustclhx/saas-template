import { FAULT_MODELS, faultScenarioId } from './fault-definitions.ts'
import { withFaultModels } from './fault-models.ts'
import { prepareFaultReadiness } from './fault-readiness.ts'
import { runMediaFaultScenario, runTextFaultScenario } from './fault-support.ts'
import { evidence, test } from './support.ts'

test('Fault acceptance: eleven scenarios with terminal observation', async ({ page }) => {
  test.setTimeout(40 * 60_000)
  const workspace = await prepareFaultReadiness(page)
  await withFaultModels(
    page,
    FAULT_MODELS,
    async () => {
      await evidence('fault-readiness', { ...workspace, modelCount: FAULT_MODELS.length })
      for (const model of FAULT_MODELS) {
        await test.step(faultScenarioId(model), async () => {
          if (model.kind === 'image') await runMediaFaultScenario(page, workspace, model)
          else await runTextFaultScenario(page, workspace, model)
        })
      }
    },
    async (cleanup) => {
      await evidence('fault-cleanup', { cleanup })
    },
  )
})
