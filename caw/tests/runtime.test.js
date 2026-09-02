import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyAtomicEdits, EpisodeManager, INITIAL_SCENE, PatchError } from '../runtime.js'

const agent = id => ({
  session: {
    id,
    events: [{
      type: 'user/message',
      data: {
        content: [{ type: 'image', attachment: { attachmentId: 'input' } }, { type: 'text', text: 'reconstruct' }],
        source: { kind: 'user' },
      },
    }],
  },
})

test('applies multiple exact replacements against one source atomically', () => {
  assert.equal(
    applyAtomicEdits('a = 1\nb = 2\n', [
      { old: 'a = 1', new: 'a = 3' },
      { old: 'b = 2', new: 'b = 4' },
    ]),
    'a = 3\nb = 4\n',
  )
})

test('rejects zero, duplicate, empty, and overlapping matches', () => {
  assert.throws(() => applyAtomicEdits('a', [{ old: 'x', new: 'y' }]), /matched 0 locations/)
  assert.throws(() => applyAtomicEdits('aa', [{ old: 'a', new: 'b' }]), /more than 1 location/)
  assert.throws(() => applyAtomicEdits('a', [{ old: '', new: 'b' }]), /must not be empty/)
  assert.throws(() => applyAtomicEdits('abc', [
    { old: 'abc', new: 'x' },
    { old: 'bc', new: 'y' },
  ]), /overlaps/)
})

test('does not mutate scene.py when any edit is invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-atomic-'))
  const manager = new EpisodeManager({ episodesRoot: root, blenderExecutable: '/missing', blenderTimeoutMs: 1000 })
  const currentAgent = agent('atomic')
  await manager.ensure(currentAgent)
  await assert.rejects(
    manager.patchAndRender(currentAgent, [
      { old: '# CaW editable scene', new: 'x' },
      { old: 'missing', new: 'y' },
    ], new AbortController().signal),
    PatchError,
  )
  assert.equal(await readFile(join(root, 'atomic', 'scene.py'), 'utf8'), INITIAL_SCENE)
})

test('keeps a Blender error as an observable step and permits correction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-error-'))
  const fakeBlender = join(root, 'fake-blender.sh')
  await writeFile(fakeBlender, '#!/bin/sh\necho "NameError: obj" >&2\nexit 1\n', { mode: 0o755 })
  const manager = new EpisodeManager({ episodesRoot: root, blenderExecutable: fakeBlender, blenderTimeoutMs: 1000 })
  const currentAgent = agent('error')
  const first = await manager.patchAndRender(currentAgent, [
    { old: '# CaW editable scene', new: 'obj.location = (0, 0, 0)' },
  ], new AbortController().signal)
  assert.equal(first.status, 'BLENDER_ERROR')
  assert.equal(first.reward, -1)
  assert.equal(first.evaluation_status, 'SKIPPED')
  assert.match(first.error, /NameError/)
  const second = await manager.patchAndRender(currentAgent, [
    { old: 'obj.location', new: 'bpy.context.object.location' },
  ], new AbortController().signal)
  assert.equal(second.step_id, 2)
  assert.match(second.diff, /bpy\.context\.object\.location/)
})

test('classifies a missing Blender executable as infrastructure failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-infra-'))
  const manager = new EpisodeManager({ episodesRoot: root, blenderExecutable: join(root, 'missing-blender'), blenderTimeoutMs: 1000 })
  const result = await manager.patchAndRender(agent('infra'), [
    { old: '# CaW editable scene', new: 'pass' },
  ], new AbortController().signal)
  assert.equal(result.status, 'INFRASTRUCTURE_ERROR')
  assert.equal(result.reward, null)
  assert.match(result.error, /ENOENT/)
})

test('records evaluator scores and relative reward without changing the tool surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-evaluator-'))
  const fakeBlender = join(root, 'fake-blender.sh')
  const fakeEvaluator = join(root, 'fake-evaluator.mjs')
  const observationPath = join(root, 'observation.png')
  await writeFile(observationPath, 'observation')
  await writeFile(fakeBlender, [
    '#!/bin/sh',
    'while [ "$#" -gt 4 ]; do shift; done',
    ': > "$2"',
    ': > "$3"',
    ': > "$4"',
  ].join('\n'), { mode: 0o755 })
  await writeFile(fakeEvaluator, [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs'",
    "const output = process.argv[process.argv.indexOf('--output') + 1]",
    "const render = process.argv[process.argv.indexOf('--render-rgb') + 1]",
    "const total = render.includes('0001') ? 0.4 : 0.7",
    "writeFileSync(output, JSON.stringify({ total, visual: total, object: total, geometry: total, details: {} }))",
  ].join('\n'), { mode: 0o755 })
  const manager = new EpisodeManager({
    episodesRoot: root,
    blenderExecutable: fakeBlender,
    blenderTimeoutMs: 1000,
    observationPath,
    evaluatorExecutable: fakeEvaluator,
    evaluatorTimeoutMs: 1000,
  })
  const currentAgent = agent('scored')
  const first = await manager.patchAndRender(currentAgent, [
    { old: '# CaW editable scene', new: 'value = 1' },
  ], new AbortController().signal)
  const second = await manager.patchAndRender(currentAgent, [
    { old: 'value = 1', new: 'value = 2' },
  ], new AbortController().signal)
  assert.equal(first.evaluation_status, 'OK')
  assert.equal(first.reward, null)
  assert.equal(second.evaluation_status, 'OK')
  assert.equal(second.score_before, 0.4)
  assert.equal(second.score_after, 0.7)
  assert.ok(Math.abs(second.delta - 0.3) < 1e-12)
  assert.ok(Math.abs(second.reward - 0.3) < 1e-12)
  const final = await manager.finish(currentAgent)
  assert.equal(final.gap_score.total, 0.7)
})

test('keeps the last valid score across evaluator infrastructure failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caw-evaluator-failure-'))
  const fakeBlender = join(root, 'fake-blender.sh')
  const fakeEvaluator = join(root, 'fake-evaluator.mjs')
  const observationPath = join(root, 'observation.png')
  await writeFile(observationPath, 'observation')
  await writeFile(fakeBlender, [
    '#!/bin/sh',
    'while [ "$#" -gt 4 ]; do shift; done',
    ': > "$2"',
    ': > "$3"',
    ': > "$4"',
  ].join('\n'), { mode: 0o755 })
  await writeFile(fakeEvaluator, [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs'",
    "const output = process.argv[process.argv.indexOf('--output') + 1]",
    "const render = process.argv[process.argv.indexOf('--render-rgb') + 1]",
    "if (render.includes('0002')) { console.error('provider unavailable'); process.exit(2) }",
    "const total = render.includes('0001') ? 0.4 : 0.7",
    "writeFileSync(output, JSON.stringify({ total, visual: total, object: total, geometry: total, details: {} }))",
  ].join('\n'), { mode: 0o755 })
  const manager = new EpisodeManager({
    episodesRoot: root,
    blenderExecutable: fakeBlender,
    blenderTimeoutMs: 1000,
    observationPath,
    evaluatorExecutable: fakeEvaluator,
    evaluatorTimeoutMs: 1000,
  })
  const currentAgent = agent('scored-with-failure')
  const first = await manager.patchAndRender(currentAgent, [
    { old: '# CaW editable scene', new: 'value = 1' },
  ], new AbortController().signal)
  const failed = await manager.patchAndRender(currentAgent, [
    { old: 'value = 1', new: 'value = 2' },
  ], new AbortController().signal)
  const recovered = await manager.patchAndRender(currentAgent, [
    { old: 'value = 2', new: 'value = 3' },
  ], new AbortController().signal)

  assert.equal(first.score_after, 0.4)
  assert.equal(failed.evaluation_status, 'EVALUATOR_ERROR')
  assert.equal(failed.reward, null)
  assert.match(failed.evaluator_error, /provider unavailable/)
  assert.equal(recovered.score_before, 0.4)
  assert.equal(recovered.score_after, 0.7)
  assert.ok(Math.abs(recovered.reward - 0.3) < 1e-12)
})
