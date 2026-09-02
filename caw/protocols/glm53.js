import { createHash } from 'node:crypto'
import { normalizeViews } from '../three_views.js'

export const GLM53_PROTOCOL_ID = 'glm-5.3-flash-native-provider-v1'

function argumentsObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { throw new Error('GLM tool arguments are not valid JSON') }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  throw new Error('GLM tool arguments must be an object or JSON object string')
}

// The HF provider serializes GLM's native tool format. Keep this adapter to
// validating the structured call DSH receives; do not reimplement a template.
export function normalizeGlm53ToolCall(nativeCall) {
  const functionCall = nativeCall?.function ?? nativeCall
  const name = functionCall?.name
  const args = argumentsObject(functionCall?.arguments ?? functionCall?.args ?? {})
  if (name === 'scene_update') {
    if (typeof args.code !== 'string' || args.code.trim() === '') throw new Error('scene_update.code must be a non-empty string')
    if (Object.keys(args).some(key => !['code', 'views'].includes(key))) throw new Error('scene_update accepts only code and optional views')
    const views = normalizeViews(args.views)
    return { name, arguments: views.length === 0 ? { code: args.code } : { code: args.code, views } }
  }
  if (name === 'preview_scene' || name === 'finish') {
    if (Object.keys(args).length !== 0) throw new Error('finish accepts no arguments')
    return { name, arguments: {} }
  }
  if (name === 'search_assets') {
    if (typeof args.query !== 'string' || args.query.trim() === '') throw new Error('search_assets.query must be a non-empty string')
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 10)) throw new Error('search_assets.limit must be an integer from 1 to 10')
    if (Object.keys(args).some(key => !['query', 'limit'].includes(key))) throw new Error('search_assets accepts only query and optional limit')
    return { name, arguments: args.limit === undefined ? { query: args.query } : { query: args.query, limit: args.limit } }
  }
  throw new Error(`unsupported GLM tool: ${String(name)}`)
}

export function canonicalGlm53ToolResult(value) {
  return { status: value.status, render_path: value.render_path, extracted_scene_path: value.extracted_scene_path, error: value.error, evaluation_status: value.evaluation_status, gap_score: value.gap_score, renders: value.renders, code_sha256: value.scene_sha256 ?? createHash('sha256').update(value.scene_code, 'utf8').digest('hex') }
}
