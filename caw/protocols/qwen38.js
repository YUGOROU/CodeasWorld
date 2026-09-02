import { createHash } from 'node:crypto'
import { normalizeViews } from '../three_views.js'

export const QWEN38_PROTOCOL_ID = 'qwen-native-provider-v1'

export const QWEN38_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_assets',
      description: 'Search the fixed small RoboCasa asset catalog by keywords.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
      },
    },
  },
  {
    type: 'function',
    function: { name: 'preview_scene', description: 'Render the current scene without changing it.', parameters: { type: 'object', additionalProperties: false, properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'scene_update',
      description: 'Replace the complete Three.js scene code, execute it, and render the result.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['code'],
        properties: {
          code: { type: 'string', minLength: 1 },
          views: {
            type: 'array',
            maxItems: 3,
            items: {
              type: 'object', additionalProperties: false,
              properties: { id: { type: 'string' }, yaw: { type: 'number' }, pitch: { type: 'number' } },
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Accept the current scene as the final reconstruction.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
  },
]

function argumentsObject(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      throw new Error('Qwen tool arguments are not valid JSON')
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  throw new Error('Qwen tool arguments must be an object or JSON object string')
}

// HF Inference Providers apply Qwen's official chat template server-side. This
// adapter deliberately normalizes only the provider's structured return value;
// it does not attempt to reproduce Qwen's template or parser locally.
export function normalizeQwen38ToolCall(nativeCall) {
  const functionCall = nativeCall?.function ?? nativeCall
  const name = functionCall?.name
  const argumentsValue = argumentsObject(functionCall?.arguments ?? functionCall?.args ?? {})
  if (name === 'scene_update') {
    if (typeof argumentsValue.code !== 'string' || argumentsValue.code.trim() === '') {
      throw new Error('scene_update.code must be a non-empty string')
    }
    if (Object.keys(argumentsValue).some(key => !['code', 'views'].includes(key))) throw new Error('scene_update accepts only code and optional views')
    const views = normalizeViews(argumentsValue.views)
    return { name, arguments: views.length === 0 ? { code: argumentsValue.code } : { code: argumentsValue.code, views } }
  }
  if (name === 'preview_scene' || name === 'finish') {
    if (Object.keys(argumentsValue).length !== 0) throw new Error('finish accepts no arguments')
    return { name, arguments: {} }
  }
  if (name === 'search_assets') {
    if (typeof argumentsValue.query !== 'string' || argumentsValue.query.trim() === '') throw new Error('search_assets.query must be a non-empty string')
    if (argumentsValue.limit !== undefined && (!Number.isInteger(argumentsValue.limit) || argumentsValue.limit < 1 || argumentsValue.limit > 10)) throw new Error('search_assets.limit must be an integer from 1 to 10')
    if (Object.keys(argumentsValue).some(key => !['query', 'limit'].includes(key))) throw new Error('search_assets accepts only query and optional limit')
    return { name, arguments: argumentsValue.limit === undefined ? { query: argumentsValue.query } : { query: argumentsValue.query, limit: argumentsValue.limit } }
  }
  throw new Error(`unsupported Qwen tool: ${String(name)}`)
}

export function qwen38RequestOptions({ condition = 'B' } = {}) {
  if (!['A', 'B'].includes(condition)) throw new Error(`unsupported A/B condition: ${condition}`)
  const tools = structuredClone(QWEN38_TOOLS.filter(tool => condition === 'B' || tool.function.name !== 'preview_scene'))
  if (condition === 'B') {
    const sceneUpdate = tools.find(tool => tool.function.name === 'scene_update')
    sceneUpdate.function.description = 'Replace and execute the complete Three.js scene code. This returns validation only; use preview_scene to inspect the current scene.'
    sceneUpdate.function.parameters = {
      type: 'object', additionalProperties: false, required: ['code'],
      properties: { code: { type: 'string', minLength: 1 } },
    }
  }
  return {
    tools,
    tool_choice: 'auto',
    // The provider applies this to the official Qwen template. It prevents a
    // reasoning-only response from masking an otherwise valid tool call.
    extra_body: { chat_template_kwargs: { enable_thinking: false } },
  }
}

export function canonicalToolResult(value) {
  return {
    status: value.status,
    render_path: value.render_path,
    extracted_scene_path: value.extracted_scene_path,
    error: value.error,
    evaluation_status: value.evaluation_status,
    gap_score: value.gap_score,
    renders: value.renders,
    code_sha256: value.scene_sha256 ?? createHash('sha256').update(value.scene_code, 'utf8').digest('hex'),
  }
}
