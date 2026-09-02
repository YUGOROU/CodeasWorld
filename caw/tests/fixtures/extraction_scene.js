scene.background = new THREE.Color(0x202020)
const table = new THREE.Mesh(
  new THREE.BoxGeometry(1, 0.1, 0.8),
  new THREE.MeshStandardMaterial({ color: 0x806040 }),
)
table.name = 'table'
table.position.set(0, 0.4, 0)
table.userData.caw = { id: 'table', physics: 'static', collision: 'primitive' }
scene.add(table)
const object = new THREE.Mesh(
  new THREE.SphereGeometry(0.03, 16, 16),
  new THREE.MeshStandardMaterial({ color: 0xff0000 }),
)
object.name = 'object'
object.position.set(0, 0.5, 0)
object.userData.caw = { id: 'object', physics: 'dynamic', collision: 'primitive' }
scene.add(object)
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2))
