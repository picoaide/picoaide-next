import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

export type EngineModel = ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>

// 客户端一律经服务端网关,不持有上游密钥(架构设计 §3.3.2)
export function createGatewayModel(serverURL: string, token: string, modelID: string): EngineModel {
  return createOpenAICompatible({
    name: 'gateway',
    baseURL: `${serverURL}/v1`,
    apiKey: token,
  }).chatModel(modelID)
}
