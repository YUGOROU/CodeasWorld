import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ThreeEpisodeManager } from '../three_runtime.js'

const agent = id => ({ session: { id, events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'reconstruct' }], source: { kind: 'user' } } }] } })

async function fakeRenderer(root) {
  const path = join(root, 'fake-renderer.mjs')
  await writeFile(path, "import { writeFile } from 'node:fs/promises'\nconst [scene, output, views, catalog, assetRoot, extraction] = process.argv.slice(2)\nconst code = await (await import('node:fs/promises')).readFile(scene, 'utf8')\nif (code.includes('throw')) { console.error('scene failure'); process.exit(2) }\nawait writeFile(output, 'png')\nfor (const view of JSON.parse(views ?? '[]')) await writeFile(view.output_path, 'png')\nawait writeFile(extraction, JSON.stringify({schema_version:'codeasworld-extracted-scene-v1',units:'meter',source:{scene_code_sha256:'fixture'},entities:[],warnings:[]}))\n")
  return path
}

test('records a canonical trajectory for a successful scene update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-three-'))
  const manager = new ThreeEpisodeManager({ episodesRoot: root, renderDriver: await fakeRenderer(root), renderTimeoutMs: 1000, condition: 'A' })
  const currentAgent = agent('three')
  const value = await manager.update(currentAgent, 'scene.add(new THREE.Group())', new AbortController().signal)
  assert.equal(value.status, 'OK')
  assert.equal(value.evaluation_status, 'PENDING')
  const trajectory = JSON.parse(await readFile(join(root, 'three', 'canonical_trajectory.json'), 'utf8'))
  assert.deepEqual(trajectory.tool_calls[0].step_id, 1)
  assert.equal(trajectory.tool_calls[0].name, 'scene_update')
  assert.equal(trajectory.tool_calls[0].token_usage, null)
  assert.deepEqual(trajectory.tool_calls[0].arguments, { code: 'scene.add(new THREE.Group())' })
  assert.equal(trajectory.tool_results[0].status, 'OK')
  assert.match(trajectory.tool_results[0].extracted_scene_path, /extracted-scene\.json$/)
  const final = await manager.finish(currentAgent)
  assert.equal(final.status, 'FINISHED')
  const finishedTrajectory = JSON.parse(await readFile(join(root, 'three', 'canonical_trajectory.json'), 'utf8'))
  assert.equal(finishedTrajectory.final.termination, 'finish')
  assert.match(finishedTrajectory.final.extracted_scene_path, /extracted-scene\.json$/)
})

test('keeps an executable scene failure observable and accepts a correction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-three-error-'))
  const manager = new ThreeEpisodeManager({ episodesRoot: root, renderDriver: await fakeRenderer(root), renderTimeoutMs: 1000, condition: 'A' })
  const currentAgent = agent('three-error')
  const failed = await manager.update(currentAgent, 'throw new Error("bad scene")', new AbortController().signal)
  assert.equal(failed.status, 'SCENE_ERROR')
  assert.match(failed.error, /scene failure/)
  const corrected = await manager.update(currentAgent, 'scene.add(new THREE.Group())', new AbortController().signal)
  assert.equal(corrected.step_id, 2)
  assert.equal(corrected.status, 'OK')
})

test('records the configured provider protocol and enforces the scene update limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-three-glm-'))
  const manager = new ThreeEpisodeManager({ episodesRoot: root, renderDriver: await fakeRenderer(root), renderTimeoutMs: 1000, protocol: 'glm53', maxSteps: 1, condition: 'A' })
  const currentAgent = agent('three-glm')
  await manager.update(currentAgent, 'scene.add(new THREE.Group())', new AbortController().signal)
  await assert.rejects(() => manager.update(currentAgent, 'scene.add(new THREE.Group())', new AbortController().signal), /scene_update limit/)
  const trajectory = JSON.parse(await readFile(join(root, 'three-glm', 'canonical_trajectory.json'), 'utf8'))
  assert.equal(trajectory.protocol, 'glm-5.3-flash-native-provider-v1')
})

test('records a bounded requested reconstruction view separately from the default render', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-three-views-'))
  const manager = new ThreeEpisodeManager({ episodesRoot: root, renderDriver: await fakeRenderer(root), renderTimeoutMs: 1000, condition: 'A' })
  const value = await manager.update(agent('three-views'), 'scene.add(new THREE.Group())', [{ id: 'right', yaw: 35, pitch: -10 }], new AbortController().signal)
  assert.deepEqual(value.renders.map(render => render.view), [{ id: 'main', yaw: 0, pitch: 0 }, { id: 'right', yaw: 35, pitch: -10 }])
  const trajectory = JSON.parse(await readFile(join(root, 'three-views', 'canonical_trajectory.json'), 'utf8'))
  assert.deepEqual(trajectory.tool_calls[0].arguments.views, [{ id: 'right', yaw: 35, pitch: -10 }])
  assert.equal(trajectory.tool_results[0].renders.length, 2)
})

test('catalog search is observable and invalid reconstruction views fail before rendering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-three-assets-'))
  const manager = new ThreeEpisodeManager({ episodesRoot: root, renderDriver: await fakeRenderer(root), renderTimeoutMs: 1000, condition: 'A' })
  const currentAgent = agent('three-assets')
  const found = await manager.search(currentAgent, 'ceramic mug')
  assert.equal(found.results[0].id, 'robocasa:mug-v0')
  await assert.rejects(() => manager.update(currentAgent, 'scene.add(new THREE.Group())', [{ id: 'ceiling', yaw: 91 }], new AbortController().signal), /safety range/)
})

test('B separates mutation validation from a bounded read-only preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-three-preview-b-'))
  const manager = new ThreeEpisodeManager({ episodesRoot: root, renderDriver: await fakeRenderer(root), renderTimeoutMs: 1000, condition: 'B', maxSteps: 5, maxPreviews: 1 })
  const currentAgent = agent('three-preview-b')
  const updated = await manager.update(currentAgent, 'scene.add(new THREE.Group())', new AbortController().signal)
  assert.equal(updated.status, 'OK')
  assert.equal(updated.render_path, '')
  assert.deepEqual(updated.renders, [])
  const preview = await manager.preview(currentAgent, new AbortController().signal)
  assert.equal(preview.status, 'OK')
  assert.equal(preview.state_unchanged, true)
  assert.equal(preview.renders.length, 1)
  await assert.rejects(() => manager.preview(currentAgent, new AbortController().signal), /preview_scene limit/)
  const trajectory = JSON.parse(await readFile(join(root, 'three-preview-b', 'canonical_trajectory.json'), 'utf8'))
  assert.equal(trajectory.experiment.condition, 'B')
  assert.deepEqual(trajectory.tool_calls.map(call => call.name), ['scene_update', 'preview_scene'])
  assert.equal(trajectory.tool_results[1].code_sha256, preview.scene_sha256)
})

test('uses the B contract by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-three-default-b-'))
  const manager = new ThreeEpisodeManager({ episodesRoot: root, renderDriver: await fakeRenderer(root), renderTimeoutMs: 1000 })
  const currentAgent = agent('three-default-b')
  const updated = await manager.update(currentAgent, 'scene.add(new THREE.Group())', new AbortController().signal)
  assert.equal(updated.render_path, '')
  const preview = await manager.preview(currentAgent, new AbortController().signal)
  assert.equal(preview.state_unchanged, true)
  const trajectory = JSON.parse(await readFile(join(root, 'three-default-b', 'canonical_trajectory.json'), 'utf8'))
  assert.deepEqual(trajectory.experiment, { condition: 'B', scene_update_max: 5, preview_max: 3 })
})

test('B rejects the old inline reconstruction-view argument', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-three-preview-views-'))
  const manager = new ThreeEpisodeManager({ episodesRoot: root, renderDriver: await fakeRenderer(root), renderTimeoutMs: 1000, condition: 'B' })
  await assert.rejects(() => manager.update(agent('three-preview-views'), 'scene.add(new THREE.Group())', [{ id: 'right' }], new AbortController().signal), /B condition/)
})
