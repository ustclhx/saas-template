import type { JobEnginePort } from './contracts-snapshot/test/contracts.ts'
import type { DatabaseTransaction, JsonValue, WorkflowState, WorkflowStep } from './contracts-snapshot/src/index.ts'

// 原型控制面单独保留；业务面只暴露已合入 A 的接口。
interface RawAdapter {
  send(message: {id: string; queue: string; body: JsonValue; delaySeconds?: number}, tx?: DatabaseTransaction): Promise<unknown>
  sendBatch(messages: {id: string; queue: string; body: JsonValue; delaySeconds?: number}[]): Promise<unknown>
  create(options: {id: string; params: JsonValue}): Promise<unknown>
  get(id: string): Promise<WorkflowState>
  sendEvent(id: string, event: {type: string; payload: JsonValue}): Promise<unknown>
  terminate(id: string): Promise<unknown>
}
export function makePlatformPort(raw: RawAdapter, step: WorkflowStep, scheduler: JobEnginePort['scheduler'], health: JobEnginePort['health'], nextId:()=>string): JobEnginePort {
  const instance = (id: string) => ({
    id,
    status: () => raw.get(id),
    terminate: async () => { await raw.terminate(id) },
    sendEvent: async (event: {type: string; payload: JsonValue}) => { await raw.sendEvent(id,event) },
  })
  return {
    queue: {
      async send(body,options) { await raw.send({id:nextId(),queue:'main',body,...options}) },
      async sendBatch(messages) { await raw.sendBatch(messages.map(message=>({id:nextId(),queue:'main',...message}))) },
    },
    transactional: { async enqueue(tx,body) { await raw.send({id:nextId(),queue:'main',body},tx) } },
    workflow: {
      async create({id=nextId(),params}) { await raw.create({id,params});return instance(id) },
      async get(id) { await raw.get(id);return instance(id) },
    },
    step,scheduler,health,
  }
}
