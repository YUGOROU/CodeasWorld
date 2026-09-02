import { readFile } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { EpisodeManager, renderAttachmentName } from './runtime.js'

export const name = 'caw-tools'
export const inject = ['attachments', 'tools', 'cawStartup']

export const Config = Schema.object({
  episodesRoot: Schema.string().required(),
  blenderExecutable: Schema.string().required(),
  blenderTimeoutMs: Schema.number().min(1).default(60000),
  observationPath: Schema.string().required(),
  evaluatorExecutable: Schema.string().default(''),
  evaluatorTimeoutMs: Schema.number().min(1).default(300000),
})

const PATCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    episode_id: { type: 'string', required: true },
    timestamp: { type: 'string', required: true },
    step_id: { type: 'integer', required: true },
    status: { type: 'string', required: true },
    scene_python: { type: 'string', required: true },
    diff: { type: 'string', required: true },
    render_path: { type: 'string', required: true },
    depth_path: { type: 'string', required: true },
    normal_path: { type: 'string', required: true },
    exit_code: { type: 'integer', required: true },
    stdout: { type: 'string', required: true },
    stderr: { type: 'string', required: true },
    error: { type: 'string', required: true },
    evaluation_status: { type: 'string', required: true },
    evaluator_error: { type: 'string', required: true },
    gap_score: { type: 'json', required: true },
    score_before: { type: 'json', required: true },
    score_after: { type: 'json', required: true },
    delta: { type: 'json', required: true },
    reward: { type: 'json', required: true },
    applied_edits: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          old: { type: 'string', required: true },
          new: { type: 'string', required: true },
        },
      },
    },
    render_attachment: { type: 'json', required: true },
  },
}

const FINISH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    episode_id: { type: 'string', required: true },
    timestamp: { type: 'string', required: true },
    status: { type: 'string', required: true },
    scene_python: { type: 'string', required: true },
    render_path: { type: 'string', required: true },
    gap_score: { type: 'json', required: true },
    termination: { type: 'string', required: true },
    render_attachment: { type: 'json', required: true },
  },
}

async function withAttachment(ctx, value) {
  if (value.render_path === '') return { ...value, render_attachment: null }
  const attachment = await ctx.attachments.saveImage({
    data: await readFile(value.render_path),
    mediaType: 'image/png',
    name: renderAttachmentName(value.render_path),
  })
  return { ...value, render_attachment: attachment }
}

function observation(value) {
  const blocks = [{
    type: 'text',
    text: [
      `execution_status: ${value.status}`,
      `scene.py:\n${value.scene_python}`,
      value.error === '' || value.error === undefined ? '' : `error:\n${value.error}`,
      value.diff === undefined ? '' : `runtime_diff:\n${value.diff}`,
      value.gap_score === undefined || value.gap_score === null ? '' : [
        `gap_total: ${value.gap_score.total}`,
        `gap_visual: ${value.gap_score.visual}`,
        `gap_object: ${value.gap_score.object}`,
        `gap_geometry: ${value.gap_score.geometry}`,
        value.delta === undefined || value.delta === null ? '' : `score_delta: ${value.delta}`,
        value.reward === undefined || value.reward === null ? '' : `reward: ${value.reward}`,
      ].filter(Boolean).join('\n'),
      value.evaluator_error === undefined || value.evaluator_error === '' ? '' : `evaluator_error:\n${value.evaluator_error}`,
    ].filter(Boolean).join('\n\n'),
  }]
  if (value.render_attachment !== null) blocks.push({ type: 'image', attachment: value.render_attachment })
  return blocks
}

export function apply(ctx, config) {
  const episodes = new EpisodeManager(config)
  ctx.tools.register(defineTool({
    name: 'patch_and_render',
    description: 'Atomically apply exact unique string replacements to the current scene.py, execute Blender once, and observe the updated scene, render, status, and error.',
    parameters: {
      edits: {
        type: 'array',
        required: true,
        description: 'One or more all-or-nothing exact replacements against the current scene.py.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            old: { type: 'string', required: true },
            new: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: PATCH_OUTPUT,
      render: (_args, value) => observation(value),
    },
    async execute(args, exec) {
      return withAttachment(ctx, await episodes.patchAndRender(exec.agent, args.edits, exec.signal))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'finish',
    description: 'Accept the current scene.py as the final scene and terminate the Code as World episode.',
    parameters: {},
    output: {
      schema: FINISH_OUTPUT,
      render: (_args, value) => observation(value),
    },
    async execute(_args, exec) {
      const value = await withAttachment(ctx, await episodes.finish(exec.agent))
      exec.concludeTurn()
      return value
    },
  }))
}
