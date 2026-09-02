import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeGlm53ToolCall } from '../protocols/glm53.js'
import { normalizeKimiK3ToolCall } from '../protocols/kimi_k3.js'

for (const [name, normalize] of [['GLM', normalizeGlm53ToolCall], ['Kimi', normalizeKimiK3ToolCall]]) {
  test(`${name} normalizes provider JSON tool arguments`, () => {
    assert.deepEqual(normalize({ function: { name: 'scene_update', arguments: '{"code":"scene.add(new THREE.Group())"}' } }), { name: 'scene_update', arguments: { code: 'scene.add(new THREE.Group())' } })
    assert.deepEqual(normalize({ name: 'search_assets', arguments: { query: 'mug', limit: 2 } }), { name: 'search_assets', arguments: { query: 'mug', limit: 2 } })
    assert.deepEqual(normalize({ name: 'finish', arguments: {} }), { name: 'finish', arguments: {} })
    assert.throws(() => normalize({ name: 'other', arguments: {} }), /unsupported/)
  })
}
