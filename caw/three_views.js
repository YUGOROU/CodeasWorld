export const DEFAULT_VIEW = Object.freeze({ id: 'main', yaw: 0, pitch: 0 })
const MAX_REQUESTED_VIEWS = 3

function number(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`scene_update.views[].${field} must be a finite number`)
  return value
}

export function normalizeViews(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_REQUESTED_VIEWS) throw new Error(`scene_update.views must contain at most ${MAX_REQUESTED_VIEWS} requested views`)
  const ids = new Set()
  return value.map((view, index) => {
    if (view === null || typeof view !== 'object' || Array.isArray(view)) throw new Error(`scene_update.views[${index}] must be an object`)
    if (Object.keys(view).some(key => !['id', 'yaw', 'pitch'].includes(key))) throw new Error(`scene_update.views[${index}] contains an unsupported field`)
    const id = view.id === undefined ? `requested-${index + 1}` : view.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(id) || id === 'main' || ids.has(id)) throw new Error(`scene_update.views[${index}].id is invalid or duplicated`)
    const yaw = view.yaw === undefined ? 0 : number(view.yaw, 'yaw')
    const pitch = view.pitch === undefined ? 0 : number(view.pitch, 'pitch')
    if (yaw < -90 || yaw > 90 || pitch < -45 || pitch > 45) throw new Error(`scene_update.views[${index}] is outside the reconstruction-view safety range`)
    ids.add(id)
    return { id, yaw, pitch }
  })
}

export function canonicalViews(requested) {
  return [DEFAULT_VIEW, ...normalizeViews(requested)]
}
