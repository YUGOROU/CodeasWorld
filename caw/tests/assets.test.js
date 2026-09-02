import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolve } from 'node:path'
import { resolveAssetFile, searchAssets, validateCatalog } from '../assets.js'

const manifestPath = fileURLToPath(new URL('../assets/robocasa_manifest.json', import.meta.url))
const catalog = validateCatalog(JSON.parse(await readFile(manifestPath, 'utf8')))

test('the static RoboCasa catalog uses a namespace and supports deterministic keyword lookup', () => {
  assert.equal(catalog.assets.length, 18)
  const results = searchAssets(catalog, 'black ceramic mug')
  assert.equal(results[0].id, 'robocasa:mug-v0')
  assert.equal(results[0].category, 'mug')
  assert.deepEqual(searchAssets(catalog, 'cookware', 2).map(result => result.id), ['robocasa:pan-v0', 'robocasa:pot-v0'])
  assert.deepEqual(searchAssets(catalog, 'spatula utensil', 2).map(result => result.id), ['robocasa:spatula-v0', 'robocasa:fork-v0'])
})

test('asset paths remain below the configured catalog root and unknown IDs fail closed', () => {
  const entry = resolveAssetFile(catalog, resolve('/tmp', 'catalog-root'), 'robocasa:bowl-v0')
  assert.equal(entry.path, '/tmp/catalog-root/selected/bowl-v0.glb')
  assert.throws(() => resolveAssetFile(catalog, '/tmp/catalog-root', 'objaverse:bowl'), /unknown asset ID/)
})
