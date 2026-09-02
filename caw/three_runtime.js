import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { threeProtocol } from './protocols/three_registry.js'
import { loadAssetCatalog, searchAssets } from './assets.js'
import { canonicalViews } from './three_views.js'

export const INITIAL_THREE_SCENE = '// Replace this complete program with a Three.js scene.\n'

export class SceneUpdateError extends Error {
  constructor(message) {
    super(`SCENE_UPDATE_ERROR\n${message}`)
    this.name = 'SceneUpdateError'
  }
}

function sessionId(agent) {
  if (agent?.session?.id === undefined) throw new Error('INFRASTRUCTURE_ERROR\nscene_update requires an Agent session')
  return String(agent.session.id)
}

function safeId(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

function userInput(events) {
  const event = events.find(candidate => candidate.type === 'user/message' && candidate.data?.source?.kind === 'user')
  return event?.data ?? null
}

function runProcess(executable, args, timeoutMs, signal) {
  return new Promise((resolveResult, reject) => {
    execFile(executable, args, { timeout: timeoutMs, signal }, (error, stdout, stderr) => {
      if (error?.name === 'AbortError') return reject(error)
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
  try { await access(path); return true } catch { return false }
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export class ThreeEpisodeManager {
  constructor(config) {
    this.root = resolve(config.episodesRoot)
    this.nodeExecutable = config.nodeExecutable ?? process.execPath
    this.renderTimeoutMs = config.renderTimeoutMs ?? 60000
    this.maxSteps = config.maxSteps ?? 5
    this.maxPreviews = config.maxPreviews ?? 3
    this.condition = config.condition ?? 'B'
    if (!['A', 'B'].includes(this.condition)) throw new Error(`INFRASTRUCTURE_ERROR\nunsupported A/B condition: ${this.condition}`)
    this.protocol = threeProtocol(config.protocol ?? 'qwen38')
    this.driver = config.renderDriver ?? fileURLToPath(new URL('./three/render_driver.mjs', import.meta.url))
    this.assetCatalogPath = resolve(config.assetCatalogPath ?? fileURLToPath(new URL('./assets/robocasa_manifest.json', import.meta.url)))
    this.assetRoot = resolve(config.assetRoot ?? fileURLToPath(new URL('./assets/robocasa', import.meta.url)))
    this.assetCatalog = null
    this.episodes = new Map()
  }

  async ensure(agent) {
    const id = sessionId(agent)
    const existing = this.episodes.get(id)
    if (existing !== undefined) return existing
    const directory = join(this.root, safeId(id))
    const steps = join(directory, 'steps')
    await mkdir(steps, { recursive: true })
    const scenePath = join(directory, 'scene.js')
    await writeFile(scenePath, INITIAL_THREE_SCENE, { encoding: 'utf8', flag: 'wx' }).catch(async error => {
      if (error?.code !== 'EEXIST') throw error
      if (await readFile(scenePath, 'utf8') !== INITIAL_THREE_SCENE) {
        throw new Error(`INFRASTRUCTURE_ERROR\nepisode directory already contains a changed scene: ${directory}`)
      }
    })
    const state = {
      id, directory, steps, scenePath, step: 0, previewCount: 0, latestRenderPath: '', latestExtractionPath: '', terminated: false,
      trajectory: {
        schema_version: 'codeasworld-canonical-trajectory-1',
        episode_id: id,
        protocol: this.protocol.id,
        observation: userInput(agent.session.events),
        experiment: { condition: this.condition, scene_update_max: this.maxSteps, preview_max: this.condition === 'B' ? this.maxPreviews : 0 },
        tool_calls: [], tool_results: [], final: null,
      },
    }
    await writeFile(join(directory, 'episode.json'), json({
      episode_id: id, created_at: new Date().toISOString(), input: state.trajectory.observation,
      initial_scene: INITIAL_THREE_SCENE, protocol: this.protocol.id,
    }))
    await this.writeTrajectory(state)
    this.episodes.set(id, state)
    return state
  }

  async writeTrajectory(state) {
    await writeFile(join(state.directory, 'canonical_trajectory.json'), json(state.trajectory))
  }

  async catalog() {
    if (this.assetCatalog === null) this.assetCatalog = await loadAssetCatalog(this.assetCatalogPath)
    return this.assetCatalog
  }

  async search(agent, query, limit = 5) {
    const state = await this.ensure(agent)
    if (state.terminated) throw new SceneUpdateError('episode is already finished')
    const value = { query, results: searchAssets(await this.catalog(), query, limit) }
    const timestamp = new Date().toISOString()
    state.trajectory.tool_calls.push({ timestamp, token_usage: null, name: 'search_assets', arguments: { query, limit } })
    state.trajectory.tool_results.push({ timestamp, token_usage: null, name: 'search_assets', result: value })
    await this.writeTrajectory(state)
    return value
  }

  async render(state, stepId, requestedViews, signal, { persist = true } = {}) {
    const renderPath = join(state.steps, `${stepId}.png`)
    const extractionPath = join(state.steps, `${stepId}.extracted-scene.json`)
    const renderedViews = canonicalViews(requestedViews).map(view => ({
      ...view,
      output_path: view.id === 'main' ? renderPath : join(state.steps, `${stepId}.${view.id}.png`),
    }))
    const startedAt = Date.now()
    const process = await runProcess(this.nodeExecutable, [
      this.driver, state.scenePath, renderPath, JSON.stringify(renderedViews), this.assetCatalogPath, this.assetRoot, extractionPath,
    ], this.renderTimeoutMs, signal)
    const allRendersExist = (await Promise.all(renderedViews.map(view => exists(view.output_path)))).every(Boolean)
    let status = 'OK'
    let error = ''
    if (process.timedOut) { status = 'INFRASTRUCTURE_ERROR'; error = `Three.js renderer exceeded ${this.renderTimeoutMs} ms` }
    else if (process.launchErrorCode !== '') { status = 'INFRASTRUCTURE_ERROR'; error = process.processError }
    else if (process.exitCode !== 0 || !allRendersExist || !(await exists(extractionPath))) { status = 'SCENE_ERROR'; error = process.stderr || process.processError || 'Three.js renderer did not produce required render/extraction artifacts' }
    const renders = status === 'OK' && persist ? await Promise.all(renderedViews.map(async view => ({
      view: { id: view.id, yaw: view.yaw, pitch: view.pitch }, path: view.output_path,
      sha256: createHash('sha256').update(await readFile(view.output_path)).digest('hex'),
    }))) : []
    if (!persist) await Promise.all(renderedViews.map(view => unlink(view.output_path).catch(() => {})))
    return { status, error, process, renderPath: status === 'OK' && persist ? renderPath : '', extractionPath: status === 'OK' ? extractionPath : '', renders, runtime_ms: Date.now() - startedAt }
  }

  async update(agent, code, views, signal) {
    if (signal === undefined && views?.aborted !== undefined) {
      signal = views
      views = undefined
    }
    const state = await this.ensure(agent)
    if (state.terminated) throw new SceneUpdateError('episode is already finished')
    if (state.step >= this.maxSteps) throw new SceneUpdateError(`episode reached configured scene_update limit (${this.maxSteps})`)
    const call = this.protocol.normalizeToolCall({ name: 'scene_update', arguments: { code, ...(views === undefined ? {} : { views }) } })
    if (this.condition === 'B' && call.arguments.views !== undefined) throw new SceneUpdateError('B condition scene_update accepts code only; use preview_scene for observation')
    const nextStep = state.step + 1
    const stepId = String(nextStep).padStart(4, '0')
    const before = await readFile(state.scenePath, 'utf8')
    const temporary = `${state.scenePath}.${randomUUID()}.tmp`
    await writeFile(temporary, call.arguments.code, 'utf8')
    await rename(temporary, state.scenePath)
    await writeFile(join(state.steps, `${stepId}.scene.js`), call.arguments.code, 'utf8')
    const rendered = await this.render(state, stepId, this.condition === 'A' ? call.arguments.views : undefined, signal, { persist: this.condition === 'A' })
    if (rendered.status === 'OK' && this.condition === 'A') state.latestRenderPath = rendered.renderPath
    if (rendered.status === 'OK') state.latestExtractionPath = rendered.extractionPath
    state.step = nextStep
    const value = {
      episode_id: state.id, timestamp: new Date().toISOString(), step_id: nextStep, status: rendered.status,
      scene_code: call.arguments.code,
      scene_sha256: createHash('sha256').update(call.arguments.code, 'utf8').digest('hex'),
      render_path: this.condition === 'A' ? rendered.renderPath : '', renders: rendered.renders,
      extracted_scene_path: rendered.extractionPath,
      exit_code: rendered.process.exitCode, stdout: rendered.process.stdout,
      stderr: rendered.process.stderr, error: rendered.error, runtime_ms: rendered.runtime_ms, evaluation_status: 'PENDING', gap_score: null,
    }
    state.trajectory.tool_calls.push({ timestamp: value.timestamp, token_usage: null, step_id: nextStep, ...call })
    state.trajectory.tool_results.push({ timestamp: value.timestamp, token_usage: null, step_id: nextStep, ...this.protocol.canonicalToolResult(value) })
    await writeFile(join(state.steps, `${stepId}.json`), json(value))
    await this.writeTrajectory(state)
    return value
  }

  async preview(agent, signal) {
    const state = await this.ensure(agent)
    if (this.condition !== 'B') throw new SceneUpdateError('preview_scene is available only in B condition')
    if (state.terminated) throw new SceneUpdateError('episode is already finished')
    if (state.previewCount >= this.maxPreviews) throw new SceneUpdateError(`episode reached configured preview_scene limit (${this.maxPreviews})`)
    const before = await readFile(state.scenePath, 'utf8')
    const sceneSha256 = createHash('sha256').update(before, 'utf8').digest('hex')
    const previewId = String(state.previewCount + 1).padStart(4, '0')
    const rendered = await this.render(state, `preview-${previewId}`, undefined, signal)
    const after = await readFile(state.scenePath, 'utf8')
    const stateUnchanged = before === after
    if (!stateUnchanged) throw new Error('INFRASTRUCTURE_ERROR\npreview_scene mutated scene state')
    state.previewCount += 1
    const value = { episode_id: state.id, timestamp: new Date().toISOString(), preview_id: state.previewCount, status: rendered.status,
      scene_sha256: sceneSha256, state_unchanged: stateUnchanged, render_path: rendered.renderPath, renders: rendered.renders,
      extracted_scene_path: rendered.extractionPath,
      exit_code: rendered.process.exitCode, stdout: rendered.process.stdout, stderr: rendered.process.stderr, error: rendered.error,
      runtime_ms: rendered.runtime_ms, evaluation_status: 'PENDING', gap_score: null }
    state.trajectory.tool_calls.push({ timestamp: value.timestamp, token_usage: null, preview_id: state.previewCount, name: 'preview_scene', arguments: {} })
    state.trajectory.tool_results.push({ timestamp: value.timestamp, token_usage: null, preview_id: state.previewCount, ...this.protocol.canonicalToolResult(value) })
    await writeFile(join(state.steps, `preview-${previewId}.json`), json(value))
    await this.writeTrajectory(state)
    return value
  }

  async finish(agent) {
    const state = await this.ensure(agent)
    if (state.terminated) throw new SceneUpdateError('episode is already finished')
    state.terminated = true
    const value = {
      episode_id: state.id, timestamp: new Date().toISOString(), status: 'FINISHED',
      scene_code: await readFile(state.scenePath, 'utf8'), render_path: state.latestRenderPath, extracted_scene_path: state.latestExtractionPath,
      termination: 'finish',
    }
    state.trajectory.final = { termination: 'finish', render_path: state.latestRenderPath, extracted_scene_path: state.latestExtractionPath }
    await writeFile(join(state.directory, 'final.json'), json(value))
    await writeFile(join(state.directory, 'summary.json'), json({
      schema_version: 'codeasworld-preview-scene-ab-summary-v1', episode_id: state.id, condition: this.condition,
      final_score: null, scene_updates: state.step, preview_calls: state.previewCount, total_tokens: null,
      runtime_sec: state.trajectory.tool_results.reduce((total, result) => total + (result.runtime_ms ?? 0), 0) / 1000,
      executable: state.latestRenderPath !== '' || (this.condition === 'B' && state.step > 0),
      quality_status: 'not_evaluated',
    }))
    await this.writeTrajectory(state)
    return value
  }
}

export function renderAttachmentName(path) {
  return path === '' ? '' : basename(path)
}
