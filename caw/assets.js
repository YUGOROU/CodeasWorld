import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export const ASSET_NAMESPACE = 'robocasa:'

function tokens(value) {
  return String(value).toLowerCase().match(/[a-z0-9]+/g) ?? []
}

export function validateCatalog(catalog) {
  if (catalog?.schema_version !== 'codeasworld-robocasa-catalog-1') throw new Error('asset catalog has an unsupported schema_version')
  if (!Array.isArray(catalog.assets) || catalog.assets.length === 0) throw new Error('asset catalog must contain at least one asset')
  const ids = new Set()
  for (const asset of catalog.assets) {
    if (typeof asset?.id !== 'string' || !asset.id.startsWith(ASSET_NAMESPACE)) throw new Error('asset catalog IDs must use the robocasa: namespace')
    if (ids.has(asset.id)) throw new Error(`asset catalog contains duplicate ID: ${asset.id}`)
    if (typeof asset.label !== 'string' || typeof asset.category !== 'string') throw new Error(`asset catalog entry is incomplete: ${asset.id}`)
    if (typeof asset.relative_path !== 'string' || asset.relative_path === '' || isAbsolute(asset.relative_path) || asset.relative_path.split('/').includes('..')) {
      throw new Error(`asset catalog entry has an unsafe relative_path: ${asset.id}`)
    }
    ids.add(asset.id)
  }
  return catalog
}

export async function loadAssetCatalog(path) {
  return validateCatalog(JSON.parse(await readFile(path, 'utf8')))
}

export function searchAssets(catalog, query, limit = 5) {
  if (typeof query !== 'string' || tokens(query).length === 0) throw new Error('search_assets.query must contain at least one keyword')
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('search_assets.limit must be an integer from 1 to 10')
  const terms = tokens(query)
  return catalog.assets
    .map(asset => {
      const primary = `${asset.id} ${asset.label} ${asset.category}`.toLowerCase()
      const keywords = (asset.keywords ?? []).join(' ').toLowerCase()
      const score = terms.reduce((total, term) => total + (primary.includes(term) ? 3 : 0) + (keywords.includes(term) ? 1 : 0), 0)
      return { asset, score }
    })
    .filter(result => result.score > 0)
    .sort((left, right) => right.score - left.score || left.asset.id.localeCompare(right.asset.id))
    .slice(0, limit)
    .map(({ asset }) => ({ id: asset.id, label: asset.label, category: asset.category }))
}

export function resolveAssetFile(catalog, assetRoot, id) {
  const asset = catalog.assets.find(candidate => candidate.id === id)
  if (asset === undefined) throw new Error(`unknown asset ID: ${id}`)
  const root = resolve(assetRoot)
  const path = resolve(root, asset.relative_path)
  if (relative(root, path).startsWith('..')) throw new Error(`asset path escaped configured root: ${id}`)
  return { asset, path }
}
