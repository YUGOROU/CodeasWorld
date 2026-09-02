import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTwoFilesPatch } from 'diff'

export const INITIAL_SCENE = 'import bpy\n\n# CaW editable scene\n'

export class PatchError extends Error {
  constructor(message) {
    super(`PATCH_ERROR\n${message}`)
    this.name = 'PatchError'
  }
}

function sessionId(agent) {
  if (agent?.session?.id === undefined) throw new Error('INFRASTRUCTURE_ERROR\npatch_and_render requires an Agent session')
  return String(agent.session.id)
}

function safeId(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

function userInput(events) {
  const event = events.find(candidate => candidate.type === 'user/message' && candidate.data?.source?.kind === 'user')
  return event?.data ?? null
}

function editPlan(source, edits) {
  if (edits.length === 0) throw new PatchError('edits must contain at least one replacement')
  const ranges = edits.map((edit, index) => {
    if (edit.old.length === 0) throw new PatchError(`edits[${index}].old must not be empty`)
    const first = source.indexOf(edit.old)
    if (first === -1) throw new PatchError(`edits[${index}].old matched 0 locations`)
    if (source.indexOf(edit.old, first + edit.old.length) !== -1) {
      throw new PatchError(`edits[${index}].old matched more than 1 location`)
    }
    return { start: first, end: first + edit.old.length, replacement: edit.new, index }
  }).sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw new PatchError(`edits[${ranges[index].index}] overlaps another replacement`)
    }
  }
  return ranges
}

export function applyAtomicEdits(source, edits) {
  const ranges = editPlan(source, edits)
  let output = source
  for (const range of [...ranges].reverse()) {
    output = output.slice(0, range.start) + range.replacement + output.slice(range.end)
  }
  return output
}

function runProcess(executable, args, timeoutMs, signal) {
  return new Promise((resolveResult, reject) => {
    execFile(executable, args, { timeout: timeoutMs, signal }, (error, stdout, stderr) => {
      if (error?.name === 'AbortError') {
        reject(error)
        return
      }
      resolveResult({
        exitCode: typeof error?.code === 'number' ? error.code : error === null ? 0 : -1,
        launchErrorCode: typeof error?.code === 'string' ? error.code : '',
        timedOut: error?.killed === true,
        stdout,
        stderr,
        processError: error === null ? '' : error.message,
      })
    })
  })
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export class EpisodeManager {
  constructor(config) {
    this.root = resolve(config.episodesRoot)
    this.blenderExecutable = config.blenderExecutable
    this.blenderTimeoutMs = config.blenderTimeoutMs
    this.observationPath = config.observationPath === undefined ? '' : resolve(config.observationPath)
    this.evaluatorExecutable = config.evaluatorExecutable ?? ''
    this.evaluatorTimeoutMs = config.evaluatorTimeoutMs ?? 300000
    this.driver = fileURLToPath(new URL('./blender/render_driver.py', import.meta.url))
    this.episodes = new Map()
  }

  async ensure(agent) {
    const id = sessionId(agent)
    const existing = this.episodes.get(id)
    if (existing !== undefined) return existing
    const directory = join(this.root, safeId(id))
    const steps = join(directory, 'steps')
    await mkdir(steps, { recursive: true })
    const scenePath = join(directory, 'scene.py')
    await writeFile(scenePath, INITIAL_SCENE, { encoding: 'utf8', flag: 'wx' }).catch(async (error) => {
      if (error?.code !== 'EEXIST') throw error
      const current = await readFile(scenePath, 'utf8')
      if (current !== INITIAL_SCENE) throw new Error(`INFRASTRUCTURE_ERROR\nepisode directory already contains a changed scene: ${directory}`)
    })
    const state = {
      id,
      directory,
      steps,
      scenePath,
      step: 0,
      latestRenderPath: '',
      latestGapScore: null,
      terminated: false,
    }
    await writeFile(join(directory, 'episode.json'), `${JSON.stringify({
      episode_id: id,
      created_at: new Date().toISOString(),
      input: userInput(agent.session.events),
      initial_scene: INITIAL_SCENE,
    }, null, 2)}\n`)
    this.episodes.set(id, state)
    return state
  }

  async record(state, stepId, value) {
    await writeFile(join(state.steps, `${stepId}.json`), `${JSON.stringify(value, null, 2)}\n`)
  }

  async evaluate(renderPath, depthPath, normalPath, outputPath, signal) {
    if (this.evaluatorExecutable === '') return { status: 'DISABLED', score: null, error: '' }
    if (this.observationPath === '') {
      return { status: 'EVALUATOR_ERROR', score: null, error: 'observationPath is not configured' }
    }
    const process = await runProcess(this.evaluatorExecutable, [
      '--observation-rgb', this.observationPath,
      '--render-rgb', renderPath,
      '--render-depth', depthPath,
      '--render-normal', normalPath,
      '--output', outputPath,
    ], this.evaluatorTimeoutMs, signal)
    if (process.timedOut) {
      return { status: 'EVALUATOR_ERROR', score: null, error: `Evaluator exceeded ${this.evaluatorTimeoutMs} ms` }
    }
    if (process.launchErrorCode !== '' || process.exitCode !== 0 || !(await exists(outputPath))) {
      return {
        status: 'EVALUATOR_ERROR',
        score: null,
        error: process.stderr || process.processError || 'Evaluator did not produce a score',
      }
    }
    try {
      const score = JSON.parse(await readFile(outputPath, 'utf8'))
      for (const field of ['total', 'visual', 'object', 'geometry']) {
        if (typeof score[field] !== 'number' || !Number.isFinite(score[field])) {
          throw new Error(`score.${field} must be a finite number`)
        }
      }
      return { status: 'OK', score, error: '' }
    } catch (error) {
      return {
        status: 'EVALUATOR_ERROR',
        score: null,
        error: `invalid evaluator output: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async patchAndRender(agent, edits, signal) {
    const state = await this.ensure(agent)
    if (state.terminated) throw new PatchError('episode is already finished')
    const before = await readFile(state.scenePath, 'utf8')
    let after
    try {
      after = applyAtomicEdits(before, edits)
    } catch (error) {
      await this.record(state, `${String(state.step + 1).padStart(4, '0')}-patch-error`, {
        status: 'PATCH_ERROR',
        edits,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const nextStep = state.step + 1
    const stepId = String(nextStep).padStart(4, '0')
    const temporary = `${state.scenePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, after, 'utf8')
      await rename(temporary, state.scenePath)
    } catch (error) {
      throw new PatchError(`scene.py could not be saved: ${error instanceof Error ? error.message : String(error)}`)
    }
    await writeFile(join(state.steps, `${stepId}.scene.py`), after, 'utf8')
    const renderPath = join(state.steps, `${stepId}.png`)
    const depthPath = join(state.steps, `${stepId}.depth.npy`)
    const normalPath = join(state.steps, `${stepId}.normal.npy`)
    const evaluationPath = join(state.steps, `${stepId}.evaluation.json`)
    const process = await runProcess(
      this.blenderExecutable,
      [
        '--background', '--factory-startup', '--python', this.driver, '--',
        state.scenePath, renderPath, depthPath, normalPath,
      ],
      this.blenderTimeoutMs,
      signal,
    )
    let status = 'OK'
    let error = ''
    if (process.timedOut) {
      status = 'INFRASTRUCTURE_ERROR'
      error = `Blender exceeded ${this.blenderTimeoutMs} ms`
    } else if (process.launchErrorCode !== '') {
      status = 'INFRASTRUCTURE_ERROR'
      error = process.processError
    } else if (
      process.exitCode !== 0
      || !(await exists(renderPath))
      || !(await exists(depthPath))
      || !(await exists(normalPath))
    ) {
      status = 'BLENDER_ERROR'
      error = process.stderr || process.processError || 'Blender did not produce RGB/depth/normal outputs'
    } else {
      state.latestRenderPath = renderPath
    }
    state.step = nextStep
    let evaluation = { status: 'SKIPPED', score: null, error: '' }
    if (status === 'OK') {
      evaluation = await this.evaluate(renderPath, depthPath, normalPath, evaluationPath, signal)
    }
    const scoreBefore = state.latestGapScore?.total ?? null
    const scoreAfter = evaluation.score?.total ?? null
    const delta = scoreBefore === null || scoreAfter === null ? null : scoreAfter - scoreBefore
    const reward = status === 'BLENDER_ERROR' ? -1.0 : delta
    if (evaluation.score !== null) state.latestGapScore = evaluation.score
    const value = {
      episode_id: state.id,
      timestamp: new Date().toISOString(),
      step_id: nextStep,
      status,
      scene_python: after,
      diff: createTwoFilesPatch('scene.py', 'scene.py', before, after),
      render_path: state.latestRenderPath,
      depth_path: status === 'OK' ? depthPath : '',
      normal_path: status === 'OK' ? normalPath : '',
      exit_code: process.exitCode,
      stdout: process.stdout,
      stderr: process.stderr,
      error,
      applied_edits: edits,
      evaluation_status: evaluation.status,
      evaluator_error: evaluation.error,
      gap_score: evaluation.score,
      score_before: scoreBefore,
      score_after: scoreAfter,
      delta,
      reward,
    }
    await this.record(state, stepId, value)
    return value
  }

  async finish(agent) {
    const state = await this.ensure(agent)
    if (state.terminated) throw new PatchError('episode is already finished')
    state.terminated = true
    const value = {
      episode_id: state.id,
      timestamp: new Date().toISOString(),
      status: 'FINISHED',
      scene_python: await readFile(state.scenePath, 'utf8'),
      render_path: state.latestRenderPath,
      gap_score: state.latestGapScore,
      termination: 'finish',
    }
    await writeFile(join(state.directory, 'final.json'), `${JSON.stringify(value, null, 2)}\n`)
    return value
  }
}

export function renderAttachmentName(path) {
  return path === '' ? '' : basename(path)
}
