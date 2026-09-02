import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const [scenePath, renderPath, viewsJson = '[{"id":"main","yaw":0,"pitch":0}]', assetCatalogPath, assetRoot, extractionPath] = process.argv.slice(2)
if (scenePath === undefined || renderPath === undefined) {
  throw new Error('usage: render_driver.mjs SCENE_JS OUTPUT_PNG [VIEWS_JSON ASSET_CATALOG ASSET_ROOT]')
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const threePackage = resolve(packageRoot, 'node_modules', 'three')
const threeBuild = resolve(packageRoot, 'node_modules', 'three', 'build')
const code = await readFile(scenePath, 'utf8')
await mkdir(dirname(resolve(renderPath)), { recursive: true })
const views = JSON.parse(viewsJson)
if (!Array.isArray(views) || views.length === 0) throw new Error('render views must be a non-empty array')
for (const view of views) await mkdir(dirname(resolve(view.output_path)), { recursive: true })
const catalog = assetCatalogPath === undefined ? null : JSON.parse(await readFile(assetCatalogPath, 'utf8'))
const assetById = new Map((catalog?.assets ?? []).map(asset => [asset.id, asset]))

const mimeType = new Map([['.js', 'text/javascript'], ['.map', 'application/json']])
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<!doctype html><html><body style="margin:0"><canvas id="c" width="512" height="512"></canvas></body></html>')
      return
    }
    if (pathname.startsWith('/asset/')) {
      if (assetRoot === undefined) throw new Error('asset root is not configured')
      const id = decodeURIComponent(pathname.slice('/asset/'.length))
      const asset = assetById.get(id)
      if (asset === undefined) throw new Error('unknown asset')
      const root = resolve(assetRoot)
      const candidate = resolve(root, asset.relative_path)
      if (relative(root, candidate).startsWith('..')) throw new Error('asset path escaped configured root')
      response.setHeader('content-type', candidate.endsWith('.glb') ? 'model/gltf-binary' : 'model/gltf+json')
      response.end(await readFile(candidate))
      return
    }
    const sourceRoot = pathname.startsWith('/examples/') ? threePackage : threeBuild
    const candidate = resolve(sourceRoot, `.${decodeURIComponent(pathname)}`)
    if (relative(sourceRoot, candidate).startsWith('..')) throw new Error('outside Three.js package')
    response.setHeader('content-type', mimeType.get(extname(candidate)) ?? 'application/octet-stream')
    const content = await readFile(candidate)
    // Three's addon modules use the bare `three` specifier. The renderer has
    // no import map or external resolver, so bind it to the same-origin build.
    response.end(pathname.startsWith('/examples/') && candidate.endsWith('.js')
      ? content.toString('utf8').replaceAll("from 'three'", "from '/three.module.min.js'").replaceAll('from "three"', 'from "/three.module.min.js"')
      : content)
  } catch {
    response.statusCode = 404
    response.end('not found')
  }
})
await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen)
  server.listen(0, '127.0.0.1', resolveListen)
})
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('Three.js module server did not bind a TCP port')
const threeModuleUrl = `http://127.0.0.1:${address.port}/three.module.min.js`

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 })
  await page.route('**/*', route => route.request().url().startsWith(`http://127.0.0.1:${address.port}/`) ? route.continue() : route.abort())
  await page.goto(`http://127.0.0.1:${address.port}/`)
  let extraction = null
  for (const [viewIndex, view] of views.entries()) {
    const result = await page.evaluate(async ({ sceneCode, moduleUrl, assetBaseUrl, currentView, shouldExtract }) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const THREE = await import(moduleUrl)
    const { GLTFLoader } = await import(moduleUrl.replace('/three.module.min.js', '/examples/jsm/loaders/GLTFLoader.js'))
    const canvas = document.getElementById('c')
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
    renderer.setSize(512, 512, false)
    renderer.setClearColor(0x202020, 1)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
    camera.position.set(3, 3, 3)
    camera.lookAt(0, 0, 0)
    const finiteVec3 = (value, field) => {
      if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > 100)) throw new Error(`${field} must be three finite values within 100m`)
      return value
    }
    const placeAsset = async (id, transform = {}) => {
      if (typeof id !== 'string') throw new Error('asset ID must be a string')
      const loader = new GLTFLoader()
      const gltf = await loader.loadAsync(`${assetBaseUrl}${encodeURIComponent(id)}`)
      const object = gltf.scene.clone(true)
      const position = transform.position ?? [0, 0, 0]
      const rotation = transform.rotation ?? [0, 0, 0]
      const scale = transform.scale ?? [1, 1, 1]
      object.position.fromArray(finiteVec3(position, 'asset position'))
      object.rotation.fromArray(finiteVec3(rotation, 'asset rotation'))
      object.scale.fromArray(finiteVec3(scale, 'asset scale'))
      if (object.scale.x <= 0 || object.scale.y <= 0 || object.scale.z <= 0) throw new Error('asset scale must be positive')
      object.name = `caw:${id}`
      object.userData.cawAsset = id
      scene.add(object)
      return object
    }
    // No Node bridge, exposed network, or browser permissions are provided to
    // scene code. Assets are loaded only through the fixed catalog endpoint.
    const execute = new AsyncFunction('THREE', 'scene', 'camera', 'renderer', 'placeAsset', `'use strict';\n${sceneCode}`)
    await execute(THREE, scene, camera, renderer, placeAsset)
    if (currentView.id !== 'main') {
      const box = new THREE.Box3().setFromObject(scene)
      const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
      const radius = Math.max(1, box.isEmpty() ? camera.position.distanceTo(center) : box.getSize(new THREE.Vector3()).length() * 1.2)
      const offset = camera.position.clone().sub(center).normalize().multiplyScalar(radius)
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), currentView.yaw * Math.PI / 180)
      const horizontal = new THREE.Vector3(offset.x, 0, offset.z).normalize()
      offset.applyAxisAngle(horizontal, -currentView.pitch * Math.PI / 180)
      camera.position.copy(center).add(offset)
      camera.lookAt(center)
    }
    renderer.render(scene, camera)
    await new Promise(resolveAnimation => requestAnimationFrame(resolveAnimation))
    if (!shouldExtract) return null
    scene.updateMatrixWorld(true)
    const entities = []
    let generatedId = 0
    const finite = values => values.map(value => Number(value.toFixed(9)))
    const forbiddenMetadata = new Set(['__proto__', 'constructor', 'prototype'])
    const cleanMetadata = value => {
      if (value === undefined) return {}
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('userData.caw must be an object')
      const allowed = new Set(['id', 'physics', 'collision', 'asset'])
      const result = {}
      for (const [key, item] of Object.entries(value)) {
        if (forbiddenMetadata.has(key) || !allowed.has(key)) throw new Error(`unsupported userData.caw key: ${key}`)
        if (typeof item !== 'string' || item.length === 0 || item.length > 128) throw new Error(`userData.caw.${key} must be a bounded non-empty string`)
        result[key] = item
      }
      return result
    }
    const classifiedPhysics = (object, metadata) => {
      if (metadata.physics !== undefined) {
        if (!['static', 'dynamic', 'ignored'].includes(metadata.physics)) throw new Error(`unsupported physics class: ${metadata.physics}`)
        return metadata.physics
      }
      return /floor|ground|table|counter|wall/i.test(object.name) ? 'static' : 'dynamic'
    }
    scene.traverse(object => {
      if (object === scene || object.isLight || object.isCamera) return
      if (object.parent?.userData?.cawAsset !== undefined) return
      const metadata = cleanMetadata(object.userData?.caw)
      const asset = object.userData?.cawAsset ?? metadata.asset
      const supportedMesh = object.isMesh && ['BoxGeometry', 'SphereGeometry', 'CylinderGeometry'].includes(object.geometry?.type)
      if (asset === undefined && !supportedMesh && Object.keys(metadata).length === 0) return
      const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion(); const scale = new THREE.Vector3()
      object.matrixWorld.decompose(position, quaternion, scale)
      const box = new THREE.Box3().setFromObject(object)
      const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3())
      generatedId += 1
      const id = metadata.id ?? (object.name || `node-${String(generatedId).padStart(4, '0')}`)
      const geometry = { type: asset === undefined ? object.geometry.type : 'asset', bounding_size: finite(size.toArray()) }
      if (object.geometry?.parameters !== undefined) {
        const parameters = object.geometry.parameters
        if (object.geometry.type === 'BoxGeometry') geometry.size = finite([parameters.width * scale.x, parameters.height * scale.y, parameters.depth * scale.z])
        if (object.geometry.type === 'SphereGeometry') geometry.radius = Number((parameters.radius * Math.max(scale.x, scale.y, scale.z)).toFixed(9))
        if (object.geometry.type === 'CylinderGeometry') {
          geometry.radius = Number((Math.max(parameters.radiusTop, parameters.radiusBottom) * Math.max(scale.x, scale.z)).toFixed(9))
          geometry.height = Number((parameters.height * scale.y).toFixed(9))
        }
      }
      entities.push({
        id, name: object.name || '', parent_id: object.parent === scene ? null : (object.parent?.userData?.caw?.id ?? object.parent?.name ?? null),
        physics: classifiedPhysics(object, metadata), collision: metadata.collision ?? (asset === undefined ? 'primitive' : 'box'),
        asset_ref: asset ?? null, transform: { position: finite(position.toArray()), quaternion_xyzw: finite(quaternion.toArray()), scale: finite(scale.toArray()) }, geometry,
      })
    })
    entities.sort((left, right) => left.id.localeCompare(right.id))
    return { schema_version: 'codeasworld-extracted-scene-v1', units: 'meter', source: { scene_code_sha256: null }, entities, warnings: [] }
  }, { sceneCode: code, moduleUrl: threeModuleUrl, assetBaseUrl: `http://127.0.0.1:${address.port}/asset/`, currentView: view, shouldExtract: extractionPath !== undefined && viewIndex === 0 })
    if (result !== null) extraction = result
    await page.screenshot({ path: view.output_path, type: 'png' })
  }
  if (extractionPath !== undefined) {
    if (extraction === null) throw new Error('scene extraction did not produce an artifact')
    const { createHash } = await import('node:crypto')
    extraction.source.scene_code_sha256 = createHash('sha256').update(code, 'utf8').digest('hex')
    await mkdir(dirname(resolve(extractionPath)), { recursive: true })
    await writeFile(extractionPath, `${JSON.stringify(extraction, null, 2)}\n`, 'utf8')
  }
} finally {
  await browser.close()
  await new Promise(resolveClose => server.close(resolveClose))
}
