import { canonicalToolResult, normalizeQwen38ToolCall, QWEN38_PROTOCOL_ID } from './qwen38.js'
import { canonicalGlm53ToolResult, GLM53_PROTOCOL_ID, normalizeGlm53ToolCall } from './glm53.js'
import { canonicalKimiK3ToolResult, KIMI_K3_PROTOCOL_ID, normalizeKimiK3ToolCall } from './kimi_k3.js'

const ADAPTERS = {
  qwen38: { id: QWEN38_PROTOCOL_ID, normalizeToolCall: normalizeQwen38ToolCall, canonicalToolResult },
  glm53: { id: GLM53_PROTOCOL_ID, normalizeToolCall: normalizeGlm53ToolCall, canonicalToolResult: canonicalGlm53ToolResult },
  kimi_k3: { id: KIMI_K3_PROTOCOL_ID, normalizeToolCall: normalizeKimiK3ToolCall, canonicalToolResult: canonicalKimiK3ToolResult },
}

export function threeProtocol(name) {
  const adapter = ADAPTERS[name]
  if (adapter === undefined) throw new Error(`INFRASTRUCTURE_ERROR\nunsupported Three.js provider adapter: ${name}`)
  return adapter
}
