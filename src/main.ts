import * as THREE from 'three'
import { createProjection, createTileManager, toScene, type Label } from './map-tiles.ts'
import { BLUR_FRAGMENT, COMPOSITE_FRAGMENT, FULLSCREEN_VERTEX } from './ink-shaders.ts'
import { createLabelLayer, PAPER_CSS } from './ink-text.ts'
import { buildGraph, createPeopleLayer } from './people.ts'
import { startIntro } from './intro.ts'
import { buildWallText, createGlyphAtlas, GLYPH_HEIGHT_M, wallTextMaterial, wallTextMesh } from './wall-text.ts'

// raw sRGB everywhere: colors in shaders are the hex values we picked from the film references
THREE.ColorManagement.enabled = false

// canvas text needs the fonts loaded before the first label texture is drawn
await Promise.all(
  ['20px "Marauder Hand"', '20px "Marauder Name"', '20px "Marauder Pen"', '20px "Marauder Title"', '20px "Marauder Italic"', '20px "Marauder Script"'].map((f) => document.fonts.load(f)),
)

const DEFAULT_CENTER = { lat: 51.75, lon: -1.2558 } // Christ Church, Oxford (Hogwarts' Great Hall)
const DEFAULT_CSS_MPP = 0.35
const MIN_CSS_MPP = 0.06
const MAX_CSS_MPP = 3
const WALL_THICKNESS_M = 1.6
const INNER_WALL_LEVEL = 0.8
const LINE_BLUR_SIGMA_PX = 1.4
const PAN_FRICTION_PER_S = 5
const WHEEL_ZOOM_SPEED = 0.0015
const POLL_INTERVAL_MS = 10_000
const REVEAL_DURATION_S = 3.2
const GRAPH_REBUILD_DELAY_MS = 600
const WALL_TEXT_MIN_PX = 3
const WALL_TEXT_FULL_PX = 5.5
const DEFAULT_DEMO_NAMES = ['Harry Potter', 'Hermione Granger', 'Ron Weasley', 'Severus Snape', 'Albus Dumbledore', 'Argus Filch', 'Draco Malfoy']

const params = new URLSearchParams(location.search)
// demo walkers fill the map until the location server reports real people
const forceDemo = params.has('demo')
// ?names=Tommy,Giulia names the demo walkers
const DEMO_NAMES = params.get('names')?.split(',').map((n) => n.trim()).filter(Boolean) ?? DEFAULT_DEMO_NAMES
// ?capture: no animation loop, a recorder steps frames with window.mapCapture.frame(ms)
const capture = params.has('capture')
// ?ui=2 draws lines, names and footprints twice as big, like a 2x screen (used for video frames)
const uiScale = Number(params.get('ui') ?? 1)
const hasStartCenter = params.has('lat') && params.has('lon')
const startCenter = {
  lat: Number(params.get('lat') ?? DEFAULT_CENTER.lat),
  lon: Number(params.get('lon') ?? DEFAULT_CENTER.lon),
}

const projection = createProjection(startCenter)
const k = projection.mercPerMeter

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.outputColorSpace = THREE.LinearSRGBColorSpace
renderer.setClearColor(0x000000, 0)
document.body.appendChild(renderer.domElement)

const view = {
  x: 0,
  y: 0,
  cssMpp: Number(params.get('mpp') ?? DEFAULT_CSS_MPP) * k,
  vx: 0,
  vy: 0,
}

const maskScene = new THREE.Scene()
const overlayScene = new THREE.Scene()
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10)

const targetOptions = { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter }
const maskTarget = new THREE.WebGLRenderTarget(1, 1, { ...targetOptions, samples: 4 })
const tmpTarget = new THREE.WebGLRenderTarget(1, 1, targetOptions)
const smallTarget = new THREE.WebGLRenderTarget(1, 1, targetOptions)
const largeTarget = new THREE.WebGLRenderTarget(1, 1, targetOptions)

const quadScene = new THREE.Scene()
const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
quad.frustumCulled = false
quadScene.add(quad)

const blurMaterial = new THREE.ShaderMaterial({
  uniforms: { uTex: { value: null }, uStep: { value: new THREE.Vector2() }, uSigma: { value: 1 } },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: BLUR_FRAGMENT,
  depthTest: false,
})

const compositeMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uSmall: { value: smallTarget.texture },
    uLarge: { value: largeTarget.texture },
    uResolution: { value: new THREE.Vector2() },
    uCenter: { value: new THREE.Vector2() },
    uMpp: { value: 1 },
    uPx: { value: 1 },
    uTime: { value: 0 },
    uReveal: { value: 0 },
    uBlob: { value: 1 },
    uInnerLevel: { value: INNER_WALL_LEVEL },
    uWallText: { value: 0 },
    uPaperLight: { value: new THREE.Color(PAPER_CSS) },
    uPaperDark: { value: new THREE.Color('#bf9f6a') },
    uStain: { value: new THREE.Color('#8a6a3e') },
    uInk: { value: new THREE.Color('#3a260e') },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: COMPOSITE_FRAGMENT,
  depthTest: false,
})

const tiles = createTileManager({ projection, scene: maskScene })
const labels = createLabelLayer({ scene: overlayScene })
const people = createPeopleLayer({ scene: overlayScene, mercPerMeter: k })
const glyphAtlas = createGlyphAtlas()
const wallMaterial = wallTextMaterial({ atlas: glyphAtlas })
wallMaterial.uniforms.uMask.value = smallTarget.texture
const wallMeshes = new Map<string, THREE.Mesh>()

// one instanced glyph mesh per loaded tile, dropped when the tile is evicted
function syncWallText() {
  for (const [key, mesh] of wallMeshes) {
    if (tiles.tiles.has(key)) continue
    overlayScene.remove(mesh)
    mesh.geometry.dispose()
    wallMeshes.delete(key)
  }
  for (const [key, tile] of tiles.tiles) {
    if (wallMeshes.has(key)) continue
    const [tx, ty] = key.split('/').map(Number)
    const data = buildWallText({ rings: tile.walls, atlas: glyphAtlas, mercPerMeter: k, seed: tx * 31 + ty * 17 + 0.13, bounds: tile.bounds })
    const mesh = wallTextMesh({ data, material: wallMaterial })
    wallMeshes.set(key, mesh)
    overlayScene.add(mesh)
  }
}

let reveal = 0
let revealDirection = 0 // 1 while the ink spreads, -1 while it drains away
const intro = startIntro({
  onOpen: () => {
    revealDirection = 1
  },
  onClose: () => {
    revealDirection = -1
  },
})
if (params.has('open')) intro.open()

// ---------- resize ----------

let dpr = 1
function resize() {
  dpr = Math.min(window.devicePixelRatio, 2)
  renderer.setPixelRatio(dpr)
  renderer.setSize(window.innerWidth, window.innerHeight)
  const w = Math.floor(window.innerWidth * dpr)
  const h = Math.floor(window.innerHeight * dpr)
  for (const t of [maskTarget, tmpTarget, smallTarget, largeTarget]) t.setSize(w, h)
  compositeMaterial.uniforms.uResolution.value.set(w, h)
  compositeMaterial.uniforms.uPx.value = dpr * uiScale
}
window.addEventListener('resize', resize)
resize()

// ---------- pan and zoom ----------

const pointers = new Map<number, { x: number; y: number }>()
let lastPinch = 0
let lastMoveTime = 0

function zoomAt({ cssX, cssY, factor }: { cssX: number; cssY: number; factor: number }) {
  const next = THREE.MathUtils.clamp(view.cssMpp * factor, MIN_CSS_MPP * k, MAX_CSS_MPP * k)
  const ox = cssX - window.innerWidth / 2
  const oy = window.innerHeight / 2 - cssY
  view.x += ox * (view.cssMpp - next)
  view.y += oy * (view.cssMpp - next)
  view.cssMpp = next
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  renderer.domElement.setPointerCapture(e.pointerId)
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  view.vx = 0
  view.vy = 0
})
renderer.domElement.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId)
  if (!prev) return
  const now = performance.now()
  if (pointers.size === 1) {
    const dx = e.clientX - prev.x
    const dy = e.clientY - prev.y
    view.x -= dx * view.cssMpp
    view.y += dy * view.cssMpp
    const dt = Math.max(1, now - lastMoveTime) / 1000
    view.vx = (-dx * view.cssMpp) / dt
    view.vy = (dy * view.cssMpp) / dt
    lastMoveTime = now
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    const dist = Math.hypot(a.x - b.x, a.y - b.y)
    if (lastPinch) zoomAt({ cssX: (a.x + b.x) / 2, cssY: (a.y + b.y) / 2, factor: lastPinch / dist })
    lastPinch = dist
  }
})
const endPointer = (e: PointerEvent) => {
  pointers.delete(e.pointerId)
  lastPinch = 0
  if (performance.now() - lastMoveTime > 80) {
    view.vx = 0
    view.vy = 0
  }
}
renderer.domElement.addEventListener('pointerup', endPointer)
renderer.domElement.addEventListener('pointercancel', endPointer)
renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    zoomAt({ cssX: e.clientX, cssY: e.clientY, factor: Math.exp(e.deltaY * WHEEL_ZOOM_SPEED) })
  },
  { passive: false },
)

// ---------- data ----------

const controller = new AbortController()

let livePeople = 0
let centeredOnLive = false
async function pollLocations({ signal }: { signal: AbortSignal }) {
  const res = await fetch('/api/locations', { signal })
    .then(async (r) => {
      if (!r.ok) return undefined
      const body: { points: { id: string; name: string; lat: number; lon: number; timestamp: number; accuracyM?: number }[] } = await r.json()
      return body
    })
    .catch(() => undefined)
  if (!res) return
  livePeople = res.points.length
  if (livePeople && !forceDemo) people.removeWanderers()
  people.keepOnly(new Set(res.points.map((p) => p.id)))
  for (const p of res.points) {
    const { x, y } = toScene({ projection, lat: p.lat, lon: p.lon })
    people.applyFix({ id: p.id, name: p.name, x, y, timestamp: p.timestamp, accuracyM: p.accuracyM })
  }
  if (res.points.length && !centeredOnLive && !hasStartCenter) {
    centeredOnLive = true
    const first = toScene({ projection, lat: res.points[0].lat, lon: res.points[0].lon })
    view.x = first.x
    view.y = first.y
  }
}
if (!forceDemo) {
  void pollLocations({ signal: controller.signal })
  setInterval(() => void pollLocations({ signal: controller.signal }), POLL_INTERVAL_MS)
}

let graphVersion = -1
let graphTimer: ReturnType<typeof setTimeout> | undefined
let demoSpawned = false
function maybeRebuildGraph() {
  if (graphVersion === tiles.version || graphTimer) return
  graphTimer = setTimeout(() => {
    graphTimer = undefined
    graphVersion = tiles.version
    const segments = [...tiles.tiles.values()].flatMap((t) => t.paths)
    people.setGraph(buildGraph(segments))
    if (livePeople && !forceDemo) return
    if (demoSpawned || !segments.length) return
    demoSpawned = true
    DEMO_NAMES.forEach((name, i) => {
      const angle = (i / DEMO_NAMES.length) * Math.PI * 2
      const r = (40 + i * 25) * k
      people.addWanderer({ id: `demo-${i}`, name, x: view.x + Math.cos(angle) * r, y: view.y + Math.sin(angle) * r })
    })
  }, GRAPH_REBUILD_DELAY_MS)
}

// ---------- people list: click a name to fly to them ----------

const FLY_PER_S = 3
const peopleList = document.getElementById('people')!
let flyTarget: { x: number; y: number } | undefined
let listedNames = ''
function syncPeopleList() {
  const names = [...people.walkers.values()].map((w) => `${w.id}\u0000${w.name}`).join('\n')
  if (names === listedNames) return
  listedNames = names
  peopleList.replaceChildren(
    ...[...people.walkers.values()].map((walker) => {
      const row = document.createElement('div')
      row.textContent = walker.name
      row.addEventListener('click', () => {
        const current = people.walkers.get(walker.id)
        if (current) flyTarget = { x: current.x, y: current.y }
      })
      return row
    }),
  )
}

// ---------- render loop ----------

function blur({ from, to, sigma, w, h }: { from: THREE.Texture; to: THREE.WebGLRenderTarget; sigma: number; w: number; h: number }) {
  quad.material = blurMaterial
  blurMaterial.uniforms.uSigma.value = sigma
  blurMaterial.uniforms.uTex.value = from
  blurMaterial.uniforms.uStep.value.set(1 / w, 0)
  renderer.setRenderTarget(tmpTarget)
  renderer.render(quadScene, quadCamera)
  blurMaterial.uniforms.uTex.value = tmpTarget.texture
  blurMaterial.uniforms.uStep.value.set(0, 1 / h)
  renderer.setRenderTarget(to)
  renderer.render(quadScene, quadCamera)
}

let last = capture ? 0 : performance.now()
function frame(nowMs: number) {
  const dt = THREE.MathUtils.clamp((nowMs - last) / 1000, 0, 0.1)
  last = nowMs
  const now = nowMs / 1000

  if (flyTarget && pointers.size === 0) {
    const t = 1 - Math.exp(-FLY_PER_S * dt)
    view.x += (flyTarget.x - view.x) * t
    view.y += (flyTarget.y - view.y) * t
    if (Math.hypot(flyTarget.x - view.x, flyTarget.y - view.y) < view.cssMpp) flyTarget = undefined
  }
  if (pointers.size > 0) flyTarget = undefined
  syncPeopleList()
  if (pointers.size === 0) {
    view.x += view.vx * dt
    view.y += view.vy * dt
    const decay = Math.exp(-PAN_FRICTION_PER_S * dt)
    view.vx *= decay
    view.vy *= decay
  }
  reveal = THREE.MathUtils.clamp(reveal + (revealDirection * dt) / REVEAL_DURATION_S, 0, 1)
  if (revealDirection !== 0) compositeMaterial.uniforms.uBlob.value = revealDirection > 0 ? 1 : 0

  const cssW = window.innerWidth
  const cssH = window.innerHeight
  const halfW = (cssW / 2) * view.cssMpp
  const halfH = (cssH / 2) * view.cssMpp
  camera.left = -halfW
  camera.right = halfW
  camera.top = halfH
  camera.bottom = -halfH
  camera.position.set(view.x, view.y, 5)
  camera.updateProjectionMatrix()

  const bounds = { minX: view.x - halfW, maxX: view.x + halfW, minY: view.y - halfH, maxY: view.y + halfH }
  const visibleKeys = tiles.update({ ...bounds, now })
  maybeRebuildGraph()
  syncWallText()

  const w = maskTarget.width
  const h = maskTarget.height
  const deviceMpp = view.cssMpp / dpr

  renderer.setRenderTarget(maskTarget)
  renderer.setClearColor(0x000000, 0)
  renderer.clear()
  renderer.render(maskScene, camera)

  blur({ from: maskTarget.texture, to: smallTarget, sigma: LINE_BLUR_SIGMA_PX * dpr * uiScale, w, h })
  const wallPx = Math.max(2.5 * dpr * uiScale, (WALL_THICKNESS_M * k) / deviceMpp)
  blur({ from: maskTarget.texture, to: largeTarget, sigma: Math.min(wallPx / 0.84, 30 * dpr * uiScale), w, h })

  const u = compositeMaterial.uniforms
  u.uCenter.value.set(view.x, view.y)
  u.uMpp.value = deviceMpp
  u.uTime.value = now
  u.uReveal.value = reveal
  const glyphCssPx = (GLYPH_HEIGHT_M * k) / view.cssMpp / uiScale
  const wallText = THREE.MathUtils.smoothstep(glyphCssPx, WALL_TEXT_MIN_PX, WALL_TEXT_FULL_PX)
  u.uWallText.value = wallText
  wallMaterial.uniforms.uOpacity.value = wallText
  wallMaterial.uniforms.uSize.value = GLYPH_HEIGHT_M * k
  wallMaterial.uniforms.uReveal.value = reveal
  wallMaterial.uniforms.uResolution.value.set(w, h)
  quad.material = compositeMaterial
  renderer.setRenderTarget(null)
  renderer.render(quadScene, quadCamera)

  const visibleLabels: Label[] = []
  for (const key of visibleKeys) {
    const tile = tiles.tiles.get(key)
    if (tile) for (const l of tile.labels) visibleLabels.push(l)
  }
  // same spreading front as the ink shader, so names and steps appear when the ink reaches them
  const halfDiagonal = Math.hypot(cssW / 2, cssH / 2)
  const spread = reveal * 1.35 - 0.05
  const revealAt = (x: number, y: number) => {
    const r = Math.hypot(x - view.x, y - view.y) / view.cssMpp / halfDiagonal
    return 1 - THREE.MathUtils.smoothstep(r, spread - 0.05, spread)
  }
  people.update({ now, dt, cssMpp: view.cssMpp * uiScale, revealAt })
  labels.update({ labels: visibleLabels, view: bounds, cssMpp: view.cssMpp * uiScale, metersPerPx: view.cssMpp / k, dt, revealAt, blockers: people.boxes() })
  renderer.autoClear = false
  renderer.render(overlayScene, camera)
  renderer.autoClear = true

  if (!capture) requestAnimationFrame(frame)
}
if (!capture) requestAnimationFrame(frame)

// debug hooks for screenshots, and frame stepping for video capture
Object.assign(window, {
  mapView: view,
  mapPeople: people,
  mapWall: wallMaterial,
  mapTiles: tiles,
  mapReveal: (v: number, opening = true) => {
    reveal = v
    compositeMaterial.uniforms.uBlob.value = opening ? 1 : 0
  },
  mapCapture: {
    frame: (ms: number) => frame(ms),
    pendingTiles: () => tiles.pending,
  },
})

// launch video director, see video/director.ts
if (capture && params.has('video')) await import('../video/director.ts')
