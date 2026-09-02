import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeQwen38ToolCall, qwen38RequestOptions, QWEN38_PROTOCOL_ID } from '../protocols/qwen38.js'

test('normalizes Qwen provider function calls without reproducing its chat template', () => {
  const call = normalizeQwen38ToolCall({
    function: { name: 'scene_update', arguments: '{"code":"scene.add(new THREE.Group())"}' },
  })
  assert.deepEqual(call, { name: 'scene_update', arguments: { code: 'scene.add(new THREE.Group())' } })
  assert.equal(QWEN38_PROTOCOL_ID, 'qwen-native-provider-v1')
  const options = qwen38RequestOptions()
  assert.equal(options.extra_body.chat_template_kwargs.enable_thinking, false)
  assert.deepEqual(options.tools.map(tool => tool.function.name), ['search_assets', 'preview_scene', 'scene_update', 'finish'])
  assert.deepEqual(options.tools.find(tool => tool.function.name === 'scene_update').function.parameters.properties, { code: { type: 'string', minLength: 1 } })
  assert.deepEqual(qwen38RequestOptions({ condition: 'A' }).tools.map(tool => tool.function.name), ['search_assets', 'scene_update', 'finish'])
  assert.ok('views' in qwen38RequestOptions({ condition: 'A' }).tools.find(tool => tool.function.name === 'scene_update').function.parameters.properties)
})

test('rejects malformed and unsupported Qwen tool calls', () => {
  assert.throws(() => normalizeQwen38ToolCall({ name: 'scene_update', arguments: '{' }), /valid JSON/)
  assert.throws(() => normalizeQwen38ToolCall({ name: 'scene_update', arguments: '{}' }), /non-empty/)
  assert.throws(() => normalizeQwen38ToolCall({ name: 'delete_files', arguments: '{}' }), /unsupported/)
  assert.throws(() => normalizeQwen38ToolCall({ name: 'scene_update', arguments: '{"code":"x","views":[{"yaw":180}]}' }), /safety range/)
})
