import { readFile } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderAttachmentName, ThreeEpisodeManager } from './three_runtime.js'

export const name = 'caw-three-tools'
export const inject = ['attachments', 'tools', 'cawStartup']

export const Config = Schema.object({
  episodesRoot: Schema.string().required(),
  nodeExecutable: Schema.string().default('node'),
  renderTimeoutMs: Schema.number().min(1).default(60000),
  maxSteps: Schema.number().min(1).default(5),
  maxPreviews: Schema.number().min(0).default(3),
  condition: Schema.string().default('B'),
  protocol: Schema.string().default('qwen38'),
  assetCatalogPath: Schema.string().default('./assets/robocasa_manifest.json'),
  assetRoot: Schema.string().default('./assets/robocasa'),
})

const SCENE_OUTPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    episode_id: { type: 'string', required: true }, timestamp: { type: 'string', required: true },
    step_id: { type: 'integer', required: true }, status: { type: 'string', required: true },
    scene_code: { type: 'string', required: true }, scene_sha256: { type: 'string', required: true },
    render_path: { type: 'string', required: true }, exit_code: { type: 'integer', required: true },
    stdout: { type: 'string', required: true }, stderr: { type: 'string', required: true },
    error: { type: 'string', required: true }, runtime_ms: { type: 'integer', required: true }, evaluation_status: { type: 'string', required: true },
    gap_score: { type: 'json', required: true }, renders: { type: 'json', required: true }, render_attachment: { type: 'json', required: true },
  },
}

const FINISH_OUTPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    episode_id: { type: 'string', required: true }, timestamp: { type: 'string', required: true },
    status: { type: 'string', required: true }, scene_code: { type: 'string', required: true },
    render_path: { type: 'string', required: true }, termination: { type: 'string', required: true },
    render_attachment: { type: 'json', required: true },
  },
}

const PREVIEW_OUTPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    episode_id: { type: 'string', required: true }, timestamp: { type: 'string', required: true }, preview_id: { type: 'integer', required: true },
    status: { type: 'string', required: true }, scene_sha256: { type: 'string', required: true }, state_unchanged: { type: 'boolean', required: true },
    render_path: { type: 'string', required: true }, exit_code: { type: 'integer', required: true }, stdout: { type: 'string', required: true }, stderr: { type: 'string', required: true }, error: { type: 'string', required: true }, runtime_ms: { type: 'integer', required: true }, evaluation_status: { type: 'string', required: true }, gap_score: { type: 'json', required: true }, renders: { type: 'json', required: true }, render_attachment: { type: 'json', required: true },
  },
}

async function withAttachment(ctx, value) {
  if (value.render_path === '') return { ...value, render_attachment: null }
  const attachment = await ctx.attachments.saveImage({
    data: await readFile(value.render_path), mediaType: 'image/png', name: renderAttachmentName(value.render_path),
  })
  return { ...value, render_attachment: attachment }
}

function observation(value) {
  const text = [
    `execution_status: ${value.status}`,
    `scene.js:\n${value.scene_code}`,
    value.error === '' ? '' : `error:\n${value.error}`,
    `evaluator_status: ${value.evaluation_status ?? 'PENDING'}`,
  ].filter(Boolean).join('\n\n')
  const blocks = [{ type: 'text', text }]
  if (value.render_attachment !== null) blocks.push({ type: 'image', attachment: value.render_attachment })
  return blocks
}

export function apply(ctx, config) {
  const episodes = new ThreeEpisodeManager(config)
  ctx.tools.register(defineTool({
    name: 'search_assets', description: 'Search the fixed small RoboCasa asset catalog by keywords. This does not access the network or add an asset to the scene.',
    parameters: { query: { type: 'string', required: true }, limit: { type: 'integer', default: 5 } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', required: true }, results: { type: 'json', required: true } } } },
    async execute(args, exec) { return episodes.search(exec.agent, args.query, args.limit ?? 5) },
  }))
  ctx.tools.register(defineTool({
    name: 'scene_update', description: config.condition === 'B' ? 'Replace and execute the complete Three.js scene code. This returns validation only; use preview_scene to inspect the current scene.' : 'Replace the complete Three.js scene code, execute it once, and observe its render or error. Optional views are reconstruction-only self-inspection renders, not new observations.',
    parameters: config.condition === 'B' ? {
      code: { type: 'string', required: true, description: 'Complete executable Three.js program using THREE, scene, camera, renderer, and optional await placeAsset(id, transform).' },
    } : {
      code: { type: 'string', required: true, description: 'Complete executable Three.js program using THREE, scene, camera, renderer, and optional await placeAsset(id, transform).' },
      views: { type: 'array', description: 'At most three requested reconstruction views; each has optional id, yaw (-90..90), and pitch (-45..45). The default response has only the main view.', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, yaw: { type: 'number' }, pitch: { type: 'number' } } } },
    },
    output: { schema: SCENE_OUTPUT, render: (_args, value) => observation(value) },
    async execute(args, exec) { return withAttachment(ctx, await episodes.update(exec.agent, args.code, args.views, exec.signal)) },
  }))
  if (config.condition === 'B') ctx.tools.register(defineTool({
    name: 'preview_scene', description: 'Render the current scene without changing it. This read-only tool has no camera or scene-code arguments.', parameters: {},
    output: { schema: PREVIEW_OUTPUT, render: (_args, value) => observation(value) },
    async execute(_args, exec) { return withAttachment(ctx, await episodes.preview(exec.agent, exec.signal)) },
  }))
  ctx.tools.register(defineTool({
    name: 'finish', description: 'Accept the current Three.js scene and terminate the Code as World episode.', parameters: {},
    output: { schema: FINISH_OUTPUT, render: (_args, value) => observation(value) },
    async execute(_args, exec) {
      const value = await withAttachment(ctx, await episodes.finish(exec.agent))
      exec.concludeTurn()
      return value
    },
  }))
}
