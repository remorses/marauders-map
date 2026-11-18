// Loads OpenMapTiles vector tiles (OpenFreeMap) and turns them into:
// - flat "mask" meshes (one channel per class) that the ink shader stylizes
// - label candidates (room and corridor names)
// - a walkable path graph used to route footsteps along corridors
import * as THREE from 'three'
import { VectorTile, classifyRings, type VectorTileFeature } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet'
export const TILE_ZOOM = 14
const MERCATOR_HALF_M = 20_037_508.342789244
const EARTH_RADIUS_M = 6_378_137
const MAX_CACHED_TILES = 96
const TILE_RETRY_DELAY_S = 5

// Mask channels: R building, G corridor (road/path), B water, A grounds (parks, grass, wood)
export const CHANNEL = {
  building: new THREE.Vector4(1, 0, 0, 0),
  corridor: new THREE.Vector4(0, 1, 0, 0),
  water: new THREE.Vector4(0, 0, 1, 0),
  grounds: new THREE.Vector4(0, 0, 0, 1),
}

// Corridor half widths in real meters, deliberately wide so streets read as castle corridors
const CORRIDOR_HALF_WIDTH_M = new Map(
  Object.entries({
  motorway: 9,
  trunk: 8,
  primary: 7,
  secondary: 6.5,
  tertiary: 6,
  minor: 5,
  service: 3.5,
  track: 2.5,
  path: 2,
  rail: 0,
  transit: 0,
  }),
)
const WATERWAY_HALF_WIDTH_M = new Map(Object.entries({ river: 9, canal: 6, stream: 2, drain: 1.2, ditch: 1 }))
const GROUNDS_LANDCOVER = new Set(['grass', 'wood', 'farmland', 'wetland'])
const GROUNDS_LANDUSE = new Set(['pitch', 'cemetery', 'playground', 'park', 'garden', 'stadium'])
const WALKABLE = new Set(['path', 'minor', 'service', 'tertiary', 'secondary', 'primary', 'track', 'pedestrian'])

export type Label = {
  id: string
  text: string
  x: number
  y: number
  angle: number
  priority: number
  kind: 'room' | 'corridor' | 'place'
}

export type PathSegment = { ax: number; ay: number; bx: number; by: number }

export type WallRing = { points: { x: number; y: number }[]; hole: boolean }

export type Tile = {
  key: string
  group: THREE.Group
  labels: Label[]
  paths: PathSegment[]
  walls: WallRing[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

// Scene coordinates are Web Mercator meters relative to a fixed origin, so floats stay precise.
export type Projection = {
  originX: number
  originY: number
  // multiply real ground meters by this to get mercator meters at the origin latitude
  mercPerMeter: number
}

export function createProjection({ lat, lon }: { lat: number; lon: number }): Projection {
  const { x, y } = lonLatToMercator({ lat, lon })
  return { originX: x, originY: y, mercPerMeter: 1 / Math.cos((lat * Math.PI) / 180) }
}

export function lonLatToMercator({ lat, lon }: { lat: number; lon: number }) {
  const x = (EARTH_RADIUS_M * lon * Math.PI) / 180
  const y = EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  return { x, y }
}

export function toScene({ projection, lat, lon }: { projection: Projection; lat: number; lon: number }) {
  const m = lonLatToMercator({ lat, lon })
  return { x: m.x - projection.originX, y: m.y - projection.originY }
}

function tileUrlTemplate({ signal }: { signal: AbortSignal }) {
  return fetch(TILEJSON_URL, { signal })
    .then(async (r) => {
      const tilejson: { tiles: string[] } = await r.json()
      return tilejson.tiles[0]
    })
    .catch((e) => new Error('Could not load tilejson', { cause: e }))
}

const channelMaterials = new Map<THREE.Vector4, THREE.ShaderMaterial>()
function channelMaterial(channel: THREE.Vector4) {
  const cached = channelMaterials.get(channel)
  if (cached) return cached
  const material = new THREE.ShaderMaterial({
    uniforms: { uChannel: { value: channel } },
    vertexShader: /* glsl */ `
      void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec4 uChannel;
      void main() { gl_FragColor = uChannel; }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    // per channel max, so overlapping classes keep their own channel
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendEquationAlpha: THREE.MaxEquation,
  })
  channelMaterials.set(channel, material)
  return material
}

type Builder = { positions: number[] }

function addPolygon({ builder, rings }: { builder: Builder; rings: { x: number; y: number }[][] }) {
  const [outer, ...holes] = rings
  if (!outer || outer.length < 3) return
  const contour = outer.map((p) => new THREE.Vector2(p.x, p.y))
  const holeVecs = holes.filter((h) => h.length >= 3).map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)))
  const faces = THREE.ShapeUtils.triangulateShape(contour, holeVecs)
  const all = [...contour, ...holeVecs.flat()]
  for (const face of faces) {
    for (const i of face) builder.positions.push(all[i].x, all[i].y, 0)
  }
}

const CAP_SEGMENTS = 8

// Line ribbon with round joints (a disc at every vertex), so the mask has no gaps at bends
function addRibbon({ builder, line, halfWidth }: { builder: Builder; line: { x: number; y: number }[]; halfWidth: number }) {
  const p = builder.positions
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len === 0) continue
    const nx = (-dy / len) * halfWidth
    const ny = (dx / len) * halfWidth
    p.push(a.x + nx, a.y + ny, 0, a.x - nx, a.y - ny, 0, b.x + nx, b.y + ny, 0)
    p.push(b.x + nx, b.y + ny, 0, a.x - nx, a.y - ny, 0, b.x - nx, b.y - ny, 0)
  }
  for (const v of line) {
    for (let s = 0; s < CAP_SEGMENTS; s++) {
      const t0 = (s / CAP_SEGMENTS) * Math.PI * 2
      const t1 = ((s + 1) / CAP_SEGMENTS) * Math.PI * 2
      p.push(v.x, v.y, 0)
      p.push(v.x + Math.cos(t0) * halfWidth, v.y + Math.sin(t0) * halfWidth, 0)
      p.push(v.x + Math.cos(t1) * halfWidth, v.y + Math.sin(t1) * halfWidth, 0)
    }
  }
}

function meshFrom({ builder, channel, order }: { builder: Builder; channel: THREE.Vector4; order: number }) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(builder.positions, 3))
  geometry.computeBoundingSphere()
  const mesh = new THREE.Mesh(geometry, channelMaterial(channel))
  mesh.renderOrder = order
  mesh.frustumCulled = false
  return mesh
}

function featureName(f: VectorTileFeature) {
  const name = f.properties['name:en'] ?? f.properties.name_en ?? f.properties.name
  if (typeof name !== 'string') return undefined
  // "Christ Church Cathedral, Oxford" reads better on the map without the city
  const short = name.split(',')[0].trim()
  return short || undefined
}

const ROOM_POI_CLASSES = new Set([
  'college',
  'library',
  'school',
  'attraction',
  'castle',
  'museum',
  'place_of_worship',
  'town_hall',
  'theatre',
  'cinema',
  'park',
  'cafe',
  'restaurant',
  'bar',
  'pub',
  'beer',
  'fast_food',
  'hospital',
  'railway',
  'monument',
  'lodging',
  'shop',
  'grocery',
  'clothing_store',
])
const CORRIDOR_LABEL_MIN_LENGTH_M = 40

export async function loadTile({
  x,
  y,
  urlTemplate,
  projection,
  signal,
}: {
  x: number
  y: number
  urlTemplate: string
  projection: Projection
  signal: AbortSignal
}): Promise<Error | Tile> {
  const z = TILE_ZOOM
  const url = urlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
  const buffer = await fetch(url, { signal })
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((e) => new Error(`Tile ${z}/${x}/${y} failed`, { cause: e }))
  if (buffer instanceof Error) return buffer
  const vt = new VectorTile(new PbfReader(new Uint8Array(buffer)))
  const n = 2 ** z
  const k = projection.mercPerMeter

  const project = (extent: number) => (pt: { x: number; y: number }) => ({
    x: ((x + pt.x / extent) / n) * 2 * MERCATOR_HALF_M - MERCATOR_HALF_M - projection.originX,
    y: MERCATOR_HALF_M - ((y + pt.y / extent) / n) * 2 * MERCATOR_HALF_M - projection.originY,
  })

  const buildings: Builder = { positions: [] }
  const corridors: Builder = { positions: [] }
  const water: Builder = { positions: [] }
  const grounds: Builder = { positions: [] }
  const labels: Label[] = []
  const paths: PathSegment[] = []
  const walls: WallRing[] = []

  const eachFeature = (layerName: string, fn: (f: VectorTileFeature, proj: ReturnType<typeof project>) => void) => {
    const layer = vt.layers[layerName]
    if (!layer) return
    const proj = project(layer.extent)
    for (let i = 0; i < layer.length; i++) fn(layer.feature(i), proj)
  }

  const polygons = (f: VectorTileFeature, proj: ReturnType<typeof project>) =>
    classifyRings(f.loadGeometry()).map((poly) => poly.map((ring) => ring.map(proj)))

  eachFeature('building', (f, proj) => {
    if (f.type !== 3) return
    for (const rings of polygons(f, proj)) {
      addPolygon({ builder: buildings, rings })
      rings.forEach((points, i) => walls.push({ points, hole: i > 0 }))
    }
  })
  eachFeature('water', (f, proj) => {
    if (f.type !== 3) return
    for (const rings of polygons(f, proj)) addPolygon({ builder: water, rings })
  })
  eachFeature('waterway', (f, proj) => {
    if (f.type !== 2) return
    const half = (WATERWAY_HALF_WIDTH_M.get(String(f.properties.class)) ?? 1) * k
    for (const line of f.loadGeometry()) addRibbon({ builder: water, line: line.map(proj), halfWidth: half })
  })
  eachFeature('landcover', (f, proj) => {
    if (f.type !== 3 || !GROUNDS_LANDCOVER.has(String(f.properties.class))) return
    for (const rings of polygons(f, proj)) addPolygon({ builder: grounds, rings })
  })
  eachFeature('landuse', (f, proj) => {
    if (f.type !== 3 || !GROUNDS_LANDUSE.has(String(f.properties.class))) return
    for (const rings of polygons(f, proj)) addPolygon({ builder: grounds, rings })
  })
  eachFeature('park', (f, proj) => {
    if (f.type !== 3) return
    for (const rings of polygons(f, proj)) addPolygon({ builder: grounds, rings })
  })
  eachFeature('transportation', (f, proj) => {
    const cls = String(f.properties.class)
    if (f.properties.brunnel === 'tunnel') return
    if (f.type === 3 && (cls === 'path' || cls === 'pier' || cls === 'bridge')) {
      for (const rings of polygons(f, proj)) addPolygon({ builder: corridors, rings })
      return
    }
    if (f.type !== 2) return
    const halfM = CORRIDOR_HALF_WIDTH_M.get(cls) ?? (cls.endsWith('_construction') ? 0 : 3)
    if (halfM === 0) return
    for (const raw of f.loadGeometry()) {
      const line = raw.map(proj)
      addRibbon({ builder: corridors, line, halfWidth: halfM * k })
      if (!WALKABLE.has(cls)) continue
      for (let i = 0; i < line.length - 1; i++) {
        paths.push({ ax: line[i].x, ay: line[i].y, bx: line[i + 1].x, by: line[i + 1].y })
      }
    }
  })
  eachFeature('transportation_name', (f, proj) => {
    const name = featureName(f)
    if (!name || f.type !== 2) return
    for (const raw of f.loadGeometry()) {
      const line = raw.map(proj)
      // label on the longest straight run of the line
      let best = { len: 0, i: 0 }
      for (let i = 0; i < line.length - 1; i++) {
        const len = Math.hypot(line[i + 1].x - line[i].x, line[i + 1].y - line[i].y)
        if (len > best.len) best = { len, i }
      }
      if (best.len < CORRIDOR_LABEL_MIN_LENGTH_M * k) continue
      const a = line[best.i]
      const b = line[best.i + 1]
      let angle = Math.atan2(b.y - a.y, b.x - a.x)
      if (angle > Math.PI / 2) angle -= Math.PI
      if (angle < -Math.PI / 2) angle += Math.PI
      labels.push({
        id: `c:${name}:${Math.round(a.x)}:${Math.round(a.y)}`,
        text: name,
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        angle,
        priority: 2 + Math.min(best.len / k / 100, 3),
        kind: 'corridor',
      })
    }
  })
  eachFeature('poi', (f, proj) => {
    const name = featureName(f)
    if (!name || f.type !== 1) return
    const cls = String(f.properties.class)
    if (!ROOM_POI_CLASSES.has(cls)) return
    const rank = Number(f.properties.rank ?? 10)
    const pt = proj(f.loadGeometry()[0][0])
    labels.push({
      id: `r:${name}:${Math.round(pt.x)}:${Math.round(pt.y)}`,
      text: name,
      x: pt.x,
      y: pt.y,
      angle: 0,
      priority: 6 - Math.min(rank, 5) + (cls === 'college' || cls === 'attraction' || cls === 'castle' ? 3 : 0),
      kind: 'room',
    })
  })
  eachFeature('place', (f, proj) => {
    const name = featureName(f)
    if (!name || f.type !== 1) return
    const pt = proj(f.loadGeometry()[0][0])
    labels.push({ id: `p:${name}`, text: name, x: pt.x, y: pt.y, angle: 0, priority: 1, kind: 'place' })
  })

  const group = new THREE.Group()
  // order matters only for clarity: Max blending makes the result order independent
  if (grounds.positions.length) group.add(meshFrom({ builder: grounds, channel: CHANNEL.grounds, order: 0 }))
  if (water.positions.length) group.add(meshFrom({ builder: water, channel: CHANNEL.water, order: 1 }))
  if (corridors.positions.length) group.add(meshFrom({ builder: corridors, channel: CHANNEL.corridor, order: 2 }))
  if (buildings.positions.length) group.add(meshFrom({ builder: buildings, channel: CHANNEL.building, order: 3 }))
  const corner = project(1)
  const nw = corner({ x: 0, y: 0 })
  const se = corner({ x: 1, y: 1 })
  const bounds = { minX: nw.x, maxX: se.x, minY: se.y, maxY: nw.y }
  return { key: `${x}/${y}`, group, labels, paths, walls, bounds }
}

export function sceneToTile({ projection, x, y }: { projection: Projection; x: number; y: number }) {
  const n = 2 ** TILE_ZOOM
  const mx = x + projection.originX
  const my = y + projection.originY
  return {
    tx: ((mx + MERCATOR_HALF_M) / (2 * MERCATOR_HALF_M)) * n,
    ty: ((MERCATOR_HALF_M - my) / (2 * MERCATOR_HALF_M)) * n,
  }
}

export function createTileManager({ projection, scene }: { projection: Projection; scene: THREE.Object3D }) {
  const tiles = new Map<string, Tile>()
  const loading = new Set<string>()
  const lastUsed = new Map<string, number>()
  const retryAt = new Map<string, number>()
  const controller = new AbortController()
  let urlTemplate: Promise<string | Error> | undefined
  let version = 0

  const evict = () => {
    if (tiles.size <= MAX_CACHED_TILES) return
    const oldest = [...lastUsed].sort((a, b) => a[1] - b[1]).slice(0, tiles.size - MAX_CACHED_TILES)
    for (const [key] of oldest) {
      const tile = tiles.get(key)
      if (!tile) continue
      scene.remove(tile.group)
      tile.group.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose())
      tiles.delete(key)
      lastUsed.delete(key)
      version++
    }
  }

  const update = ({ minX, minY, maxX, maxY, now }: { minX: number; minY: number; maxX: number; maxY: number; now: number }) => {
    const a = sceneToTile({ projection, x: minX, y: maxY })
    const b = sceneToTile({ projection, x: maxX, y: minY })
    const visible: string[] = []
    for (let ty = Math.floor(a.ty); ty <= Math.floor(b.ty); ty++) {
      for (let tx = Math.floor(a.tx); tx <= Math.floor(b.tx); tx++) {
        const key = `${tx}/${ty}`
        visible.push(key)
        lastUsed.set(key, now)
        if (tiles.has(key) || loading.has(key) || now < (retryAt.get(key) ?? 0)) continue
        loading.add(key)
        urlTemplate ??= tileUrlTemplate({ signal: controller.signal })
        const fail = (error: Error) => {
          console.error(error)
          retryAt.set(key, now + TILE_RETRY_DELAY_S)
        }
        void urlTemplate
          .then(async (template) => {
            if (template instanceof Error) {
              // forget the failed tilejson so the next attempt fetches it again
              urlTemplate = undefined
              return fail(template)
            }
            const tile = await loadTile({ x: tx, y: ty, urlTemplate: template, projection, signal: controller.signal }).catch(
              (e) => new Error(`Tile ${tx}/${ty} could not be decoded`, { cause: e }),
            )
            if (tile instanceof Error) return fail(tile)
            retryAt.delete(key)
            tiles.set(key, tile)
            scene.add(tile.group)
            version++
            evict()
          })
          .finally(() => loading.delete(key))
      }
    }
    return visible
  }

  return {
    update,
    tiles,
    get version() {
      return version
    },
    get pending() {
      return loading.size
    },
    dispose: () => controller.abort(),
  }
}
