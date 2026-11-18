// People on the map: inked footprints that walk along corridors and fade behind,
// and a name ribbon that follows the latest step, like the film's Marauder's Map.
import * as THREE from 'three'
import type { PathSegment } from './map-tiles.ts'
import { textVertex } from './ink-text.ts'

const FOOT_INK_CSS = '#5a2e10'

export type Fix = { id: string; name: string; x: number; y: number; timestamp: number; accuracyM?: number }

const FOOT_LENGTH_CSS_PX = 26
const STEP_CADENCE_HZ = 2
const STRIDE = 1.45 // forward distance between prints, in foot lengths
const FOOTPRINT_LIFETIME_S = 2.6
const FOOTPRINT_FADE_IN_S = 0.12
const STANCE_WIDTH = 0.36 // fraction of foot length, distance from the walking line
const RIBBON_FOLLOW_PER_S = 6
const MIN_SPEED_MPS = 0.9
const MAX_SPEED_MPS = 40
const WALK_SPEED_MPS = 1.35
const GRAPH_SNAP_M = 0.8
const MAX_SNAP_DISTANCE_M = 60
const MAX_DETOUR_FACTOR = 2.5
const MAX_DETOUR_EXTRA_M = 40
const CARD_FONT_PX = 24
const CARD_FONT = '"Marauder Pen", cursive'
const CREASES = 11
const CARD_IDLE_FLUTTER = 0
// stop motion: a few hand drawn poses shown at a low frame rate, like the film map
const CARD_FPS = 4
const CARD_POSES = 4
const CARD_FLUTTER_EASE_PER_S = 2.5

// ---------- path graph ----------

type Graph = {
  nodes: { x: number; y: number }[]
  edges: number[][]
}

export function buildGraph(segments: PathSegment[]): Graph {
  const index = new Map<string, number>()
  const nodes: Graph['nodes'] = []
  const edges: number[][] = []
  const nodeAt = (x: number, y: number) => {
    const key = `${Math.round(x / GRAPH_SNAP_M)}:${Math.round(y / GRAPH_SNAP_M)}`
    let i = index.get(key)
    if (i === undefined) {
      i = nodes.length
      index.set(key, i)
      nodes.push({ x, y })
      edges.push([])
    }
    return i
  }
  for (const s of segments) {
    const a = nodeAt(s.ax, s.ay)
    const b = nodeAt(s.bx, s.by)
    if (a === b || edges[a].includes(b)) continue
    edges[a].push(b)
    edges[b].push(a)
  }
  return { nodes, edges }
}

function nearestNode({ graph, x, y }: { graph: Graph; x: number; y: number }) {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < graph.nodes.length; i++) {
    if (graph.edges[i].length === 0) continue
    const d = (graph.nodes[i].x - x) ** 2 + (graph.nodes[i].y - y) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return { node: best, distance: Math.sqrt(bestD) }
}

// A* on the corridor graph. Returns undefined when unreachable.
function route({ graph, from, to }: { graph: Graph; from: number; to: number }) {
  const goal = graph.nodes[to]
  const h = (i: number) => Math.hypot(graph.nodes[i].x - goal.x, graph.nodes[i].y - goal.y)
  const g = new Map<number, number>([[from, 0]])
  const came = new Map<number, number>()
  const open = new Set([from])
  const f = new Map<number, number>([[from, h(from)]])
  let guard = 0
  while (open.size && guard++ < 20_000) {
    let current = -1
    let bestF = Infinity
    for (const i of open) {
      const v = f.get(i)!
      if (v < bestF) {
        bestF = v
        current = i
      }
    }
    if (current === to) {
      const path = [to]
      while (came.has(path[0])) path.unshift(came.get(path[0])!)
      return path.map((i) => graph.nodes[i])
    }
    open.delete(current)
    for (const next of graph.edges[current]) {
      const n = graph.nodes[next]
      const c = graph.nodes[current]
      const tentative = g.get(current)! + Math.hypot(n.x - c.x, n.y - c.y)
      if (tentative >= (g.get(next) ?? Infinity)) continue
      came.set(next, current)
      g.set(next, tentative)
      f.set(next, tentative + h(next))
      open.add(next)
    }
  }
  return undefined
}

// ---------- textures ----------

function footprintTexture() {
  const w = 64
  const h = 128
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  // film prints are soft reddish brown blobs: an oval sole and a separate round heel
  ctx.filter = 'blur(2px)'
  ctx.fillStyle = FOOT_INK_CSS
  ctx.beginPath()
  ctx.ellipse(33, 40, 19, 34, 0.06, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(30, 102, 15, 18, 0, 0, Math.PI * 2)
  ctx.fill()
  // darker pooled ink in the middle of each blob
  ctx.filter = 'blur(5px)'
  ctx.fillStyle = 'rgba(40, 18, 6, 0.6)'
  ctx.beginPath()
  ctx.ellipse(34, 36, 10, 20, 0.06, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(30, 103, 7, 9, 0, 0, Math.PI * 2)
  ctx.fill()
  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearMipmapLinearFilter
  return texture
}

function seededRandom(text: string) {
  let h = 2166136261
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1)
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61)
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296
  }
}

// Torn outline of the card: walks the rectangle and pushes every point inwards by a small
// ragged amount, with deeper bites on the torn side (bottom).
function tornOutline({ x, y, w, h, random, ss }: { x: number; y: number; w: number; h: number; random: () => number; ss: number }) {
  const points: { x: number; y: number }[] = []
  const sides = [
    { from: { x, y }, to: { x: x + w, y }, normal: { x: 0, y: 1 }, rough: 1.3 },
    { from: { x: x + w, y }, to: { x: x + w, y: y + h }, normal: { x: -1, y: 0 }, rough: 1.4 },
    { from: { x: x + w, y: y + h }, to: { x, y: y + h }, normal: { x: 0, y: -1 }, rough: 3.2 },
    { from: { x, y: y + h }, to: { x, y }, normal: { x: 1, y: 0 }, rough: 1 },
  ]
  for (const side of sides) {
    const length = Math.hypot(side.to.x - side.from.x, side.to.y - side.from.y)
    const steps = Math.ceil(length / (1.6 * ss))
    let drift = 0
    for (let i = 0; i < steps; i++) {
      const t = i / steps
      // slow drift gives the torn wave, the random term gives the fibers
      drift = Math.max(0, Math.min(side.rough * 2.2 * ss, drift + (random() - 0.5) * side.rough * 1.2 * ss))
      const bite = drift + random() * side.rough * 0.7 * ss
      points.push({
        x: side.from.x + (side.to.x - side.from.x) * t + side.normal.x * bite,
        y: side.from.y + (side.to.y - side.from.y) * t + side.normal.y * bite,
      })
    }
  }
  const path = new Path2D()
  points.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)))
  path.closePath()
  return path
}

// A small crumpled paper card with torn edges, taped onto the map, name written in ink.
function nameCardCanvas(name: string) {
  const ss = 3
  const random = seededRandom(name)
  const fontPx = CARD_FONT_PX * ss
  const font = `${fontPx}px ${CARD_FONT}`
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font
  const textW = measure.measureText(name).width
  const w = textW + fontPx * 1.3
  const h = fontPx * 1.75
  const margin = fontPx * 0.7
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(w + margin * 2)
  canvas.height = Math.ceil(h + margin * 2)
  const ctx = canvas.getContext('2d')!
  const x0 = margin
  const y0 = margin
  const card = tornOutline({ x: x0, y: y0, w, h, random, ss })
  // torn paper shows its lighter fibrous core just outside the printed face
  const rim = tornOutline({ x: x0 - 1.2 * ss, y: y0 - 1.2 * ss, w: w + 2.4 * ss, h: h + 2.4 * ss, random, ss })

  // soft shadow: the card lifts a little off the map where it is crumpled
  ctx.save()
  ctx.filter = `blur(${3 * ss}px)`
  ctx.translate(1.5 * ss, 2.5 * ss)
  ctx.fillStyle = 'rgba(35, 20, 6, 0.5)'
  ctx.fill(rim)
  ctx.restore()

  ctx.fillStyle = '#f6eed8'
  ctx.fill(rim)

  ctx.save()
  ctx.clip(card)
  const face = ctx.createLinearGradient(x0, y0, x0 + w * 0.3, y0 + h)
  face.addColorStop(0, '#efe2bf')
  face.addColorStop(1, '#e2cfa3')
  ctx.fillStyle = face
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  // age spots
  for (let i = 0; i < 5; i++) {
    const cx = x0 + random() * w
    const cy = y0 + random() * h
    const r = (0.3 + random() * 0.8) * h
    const spot = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    spot.addColorStop(0, 'rgba(150, 105, 50, 0.13)')
    spot.addColorStop(1, 'rgba(150, 105, 50, 0)')
    ctx.fillStyle = spot
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  // name in ink, slightly tilted like it was written in a hurry
  ctx.save()
  ctx.translate(x0 + w / 2, y0 + h * 0.56)
  ctx.rotate((random() - 0.5) * 0.06)
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(43, 26, 14, 0.25)'
  ctx.filter = `blur(${0.6 * ss}px)`
  ctx.fillText(name, 0, 0)
  ctx.filter = 'none'
  ctx.fillStyle = '#2b1a0e'
  ctx.fillText(name, 0, 0)
  ctx.restore()

  // darker, dirtier edges
  ctx.filter = `blur(${2.5 * ss}px)`
  ctx.lineWidth = 3 * ss
  ctx.strokeStyle = 'rgba(120, 80, 35, 0.4)'
  ctx.stroke(card)
  ctx.filter = 'none'
  ctx.restore()

  // crumpled paper: every crease is a fold line, the card height is a sum of tents around
  // them, so the surface breaks into flat facets lit from the top left. Paper grain on top.
  const creases = Array.from({ length: CREASES }, () => {
    const angle = random() * Math.PI
    return {
      cx: x0 + random() * w,
      cy: y0 + random() * h,
      dx: Math.cos(angle),
      dy: Math.sin(angle),
      length: (0.25 + random() * 0.6) * w,
      slope: (random() < 0.5 ? -1 : 1) * (0.05 + random() * 0.09),
    }
  })
  const LIGHT_X = -0.6
  const LIGHT_Y = -0.8
  const creaseWidth = 0.9 * ss
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  for (let py = 0; py < canvas.height; py++) {
    for (let px = 0; px < canvas.width; px++) {
      const i = (py * canvas.width + px) * 4
      if (image.data[i + 3] < 250) continue
      let gx = 0
      let gy = 0
      let line = 0
      for (const c of creases) {
        const ox = px - c.cx
        const oy = py - c.cy
        const along = ox * c.dx + oy * c.dy
        const d = -ox * c.dy + oy * c.dx
        const fade = Math.exp(-((along / c.length) ** 2))
        const side = d < 0 ? -1 : 1
        gx += -c.dy * side * c.slope * fade
        gy += c.dx * side * c.slope * fade
        line += Math.exp(-Math.abs(d) / creaseWidth) * fade * Math.sign(c.slope)
      }
      const facet = Math.max(-0.14, Math.min(0.08, 1.1 * (gx * LIGHT_X + gy * LIGHT_Y)))
      const shade = 1 + facet + line * 0.08 + (random() - 0.5) * 0.05
      image.data[i] *= shade
      image.data[i + 1] *= shade
      image.data[i + 2] *= shade
    }
  }
  ctx.putImageData(image, 0, 0)

  // a strip of old tape holding the card on the map
  ctx.save()
  const tapeW = Math.min(w * 0.4, fontPx * 2.4)
  const tapeH = fontPx * 0.62
  ctx.translate(x0 + w * (0.3 + random() * 0.4), y0 + 0.5 * ss)
  ctx.rotate((random() - 0.5) * 0.35)
  const tape = new Path2D()
  tape.moveTo(-tapeW / 2, -tapeH / 2)
  tape.lineTo(tapeW / 2, -tapeH / 2)
  for (let i = 0; i <= 6; i++) tape.lineTo(tapeW / 2 + (i % 2 ? 1.5 : -1) * ss, -tapeH / 2 + (tapeH * i) / 6)
  tape.lineTo(-tapeW / 2, tapeH / 2)
  for (let i = 6; i >= 0; i--) tape.lineTo(-tapeW / 2 + (i % 2 ? -1.5 : 1) * ss, -tapeH / 2 + (tapeH * i) / 6)
  tape.closePath()
  ctx.fillStyle = 'rgba(226, 210, 160, 0.7)'
  ctx.fill(tape)
  ctx.strokeStyle = 'rgba(140, 115, 70, 0.35)'
  ctx.lineWidth = 0.6 * ss
  ctx.stroke(tape)
  ctx.restore()

  return {
    canvas,
    cssWidth: canvas.width / ss,
    cssHeight: canvas.height / ss,
    // bottom left corner of the card sits next to the feet
    anchor: { x: (x0 + w * 0.12) / canvas.width, y: (y0 + h) / canvas.height },
    tilt: (random() - 0.5) * 0.12,
  }
}

// ---------- walkers ----------

type Footprint = {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  x: number
  y: number
  angle: number
  left: boolean
  born: number
  standing: boolean
}

type Walker = {
  id: string
  name: string
  x: number
  y: number
  heading: number
  path: { x: number; y: number }[]
  speed: number
  sinceStep: number
  leftNext: boolean
  steps: Footprint[]
  ribbon: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  ribbonSize: { w: number; h: number }
  ribbonAnchor: { x: number; y: number }
  ribbonPos: { x: number; y: number } | undefined
  tilt: number
  flutter: number
  lastFixTimestamp: number
  wander: boolean
}

const unitPlane = new THREE.PlaneGeometry(1, 1)
// cards bend, so they need enough vertices along the free torn edge
const cardPlane = new THREE.PlaneGeometry(1, 1, 32, 8)

export function createPeopleLayer({ scene, mercPerMeter }: { scene: THREE.Object3D; mercPerMeter: number }) {
  const walkers = new Map<string, Walker>()
  const footTexture = footprintTexture()
  // paper colored footprint material reuses the ink shader so steps share the ink look
  let graph: Graph = { nodes: [], edges: [] }

  const makeWalker = ({ id, name, x, y, wander }: { id: string; name: string; x: number; y: number; wander: boolean }) => {
    const { canvas, cssWidth, cssHeight, anchor, tilt } = nameCardCanvas(name)
    // the card is drawn at 3x, mipmaps keep the shrunk creases and torn fibers smooth
    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.LinearMipmapLinearFilter
    const ribbon = new THREE.Mesh(cardPlane, cardMaterial(texture))
    ribbon.renderOrder = 30
    ribbon.rotation.z = tilt
    scene.add(ribbon)
    const walker: Walker = {
      id,
      name,
      x,
      y,
      heading: Math.PI / 2,
      path: [],
      speed: WALK_SPEED_MPS * mercPerMeter,
      sinceStep: 0,
      leftNext: true,
      steps: [],
      ribbon,
      ribbonSize: { w: cssWidth, h: cssHeight },
      ribbonAnchor: anchor,
      ribbonPos: undefined,
      tilt,
      flutter: 0,
      lastFixTimestamp: 0,
      wander,
    }
    walkers.set(id, walker)
    return walker
  }

  const addStep = ({ walker, now, cssMpp, standing }: { walker: Walker; now: number; cssMpp: number; standing: boolean }) => {
    const footLen = FOOT_LENGTH_CSS_PX * cssMpp
    const side = walker.leftNext ? 1 : -1
    const nx = -Math.sin(walker.heading)
    const ny = Math.cos(walker.heading)
    const mesh = new THREE.Mesh(unitPlane, paintMaterial(footTexture))
    mesh.renderOrder = 20
    scene.add(mesh)
    walker.steps.push({
      mesh,
      x: walker.x + nx * side * footLen * STANCE_WIDTH,
      y: walker.y + ny * side * footLen * STANCE_WIDTH,
      angle: walker.heading - Math.PI / 2,
      left: walker.leftNext,
      born: now,
      standing,
    })
    walker.leftNext = !walker.leftNext
  }

  const routeTo = ({ walker, x, y }: { walker: Walker; x: number; y: number }) => {
    const target = { x, y }
    const start = nearestNode({ graph, x: walker.x, y: walker.y })
    const end = nearestNode({ graph, x, y })
    const maxSnap = MAX_SNAP_DISTANCE_M * mercPerMeter
    if (start.node < 0 || end.node < 0 || start.distance > maxSnap || end.distance > maxSnap) return [target]
    const path = route({ graph, from: start.node, to: end.node })
    if (!path) return [target]
    // a detour much longer than the straight line means the corridors are not connected here
    let length = Math.hypot(path[0].x - walker.x, path[0].y - walker.y)
    for (let i = 1; i < path.length; i++) length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
    const straight = Math.hypot(x - walker.x, y - walker.y)
    if (length > straight * MAX_DETOUR_FACTOR + MAX_DETOUR_EXTRA_M * mercPerMeter) return [target]
    return [...path, target]
  }

  const pickWanderPath = (walker: Walker) => {
    const start = nearestNode({ graph, x: walker.x, y: walker.y })
    if (start.node < 0) return []
    const path: { x: number; y: number }[] = [graph.nodes[start.node]]
    let prev = -1
    let current = start.node
    for (let i = 0; i < 12; i++) {
      const options = graph.edges[current].filter((n) => n !== prev)
      const next = options.length ? options[Math.floor(Math.random() * options.length)] : prev
      if (next < 0) break
      path.push(graph.nodes[next])
      prev = current
      current = next
    }
    return path
  }

  const applyFix = (fix: Fix) => {
    const existing = walkers.get(fix.id)
    if (!existing) {
      makeWalker({ id: fix.id, name: fix.name, x: fix.x, y: fix.y, wander: false })
      walkers.get(fix.id)!.lastFixTimestamp = fix.timestamp
      return
    }
    if (fix.timestamp <= existing.lastFixTimestamp) return
    const elapsedS = Math.max(1, (fix.timestamp - existing.lastFixTimestamp) / 1000)
    existing.lastFixTimestamp = fix.timestamp
    existing.path = routeTo({ walker: existing, x: fix.x, y: fix.y })
    // arrive roughly when the next fix is expected
    let length = 0
    let px = existing.x
    let py = existing.y
    for (const p of existing.path) {
      length += Math.hypot(p.x - px, p.y - py)
      px = p.x
      py = p.y
    }
    const speedMps = Math.min(MAX_SPEED_MPS, Math.max(MIN_SPEED_MPS, length / mercPerMeter / elapsedS))
    existing.speed = speedMps * mercPerMeter
  }

  const addWanderer = ({ id, name, x, y }: { id: string; name: string; x: number; y: number }) => {
    if (walkers.has(id)) return
    const walker = makeWalker({ id, name, x, y, wander: true })
    walker.speed = WALK_SPEED_MPS * mercPerMeter * (0.85 + Math.random() * 0.3)
  }

  const update = ({ now, dt, cssMpp, revealAt }: { now: number; dt: number; cssMpp: number; revealAt: (x: number, y: number) => number }) => {
    const footLen = FOOT_LENGTH_CSS_PX * cssMpp
    for (const walker of walkers.values()) {
      if (walker.wander && walker.path.length === 0) {
        walker.path = pickWanderPath(walker)
        if (walker.path.length) {
          walker.x = walker.path[0].x
          walker.y = walker.path[0].y
        }
      }
      // move along the path. Slow real movement is shown at least at a walking pace on
      // screen, so the person arrives early and then stands, like in the film.
      const minDisplaySpeed = footLen * STRIDE * STEP_CADENCE_HZ
      let budget = Math.max(walker.speed, minDisplaySpeed) * dt
      const wasMoving = walker.path.length > 0
      while (budget > 0 && walker.path.length) {
        const target = walker.path[0]
        const dx = target.x - walker.x
        const dy = target.y - walker.y
        const d = Math.hypot(dx, dy)
        if (d > 1e-6) walker.heading = Math.atan2(dy, dx)
        const travel = Math.min(d, budget)
        walker.x += d > 1e-6 ? (dx / d) * travel : 0
        walker.y += d > 1e-6 ? (dy / d) * travel : 0
        budget -= travel
        walker.sinceStep += travel
        if (walker.sinceStep >= footLen * STRIDE) {
          walker.sinceStep = 0
          addStep({ walker, now, cssMpp, standing: false })
        }
        if (travel >= d) walker.path.shift()
      }
      const moving = walker.path.length > 0
      if (moving) for (const s of walker.steps) s.standing = false
      if (wasMoving && !moving) {
        // arrived: both feet side by side, they stay until the person moves again
        for (const s of walker.steps) s.standing = false
        walker.leftNext = true
        addStep({ walker, now, cssMpp, standing: true })
        addStep({ walker, now, cssMpp, standing: true })
      }
      if (!wasMoving && !moving && walker.steps.length === 0) {
        addStep({ walker, now, cssMpp, standing: true })
        addStep({ walker, now, cssMpp, standing: true })
      }

      walker.steps = walker.steps.filter((step) => {
        const age = now - step.born
        const life = step.standing ? Infinity : FOOTPRINT_LIFETIME_S
        if (age > life) {
          scene.remove(step.mesh)
          step.mesh.material.dispose()
          return false
        }
        const fadeIn = Math.min(1, age / FOOTPRINT_FADE_IN_S)
        const fadeOut = step.standing ? 1 : 1 - Math.max(0, (age - life * 0.45) / (life * 0.55))
        step.mesh.position.set(step.x, step.y, 0)
        step.mesh.rotation.z = step.angle
        step.mesh.scale.set(footLen * 0.5 * (step.left ? 1 : -1), footLen, 1)
        step.mesh.material.uniforms.uOpacity.value = fadeIn * fadeOut * 0.92 * revealAt(step.x, step.y)
        return true
      })

      // the name card sits up and to the right of the feet
      const { ribbon, ribbonSize, ribbonAnchor } = walker
      const w = ribbonSize.w * cssMpp
      const h = ribbonSize.h * cssMpp
      const anchorX = walker.x + footLen * 0.6
      const anchorY = walker.y + footLen * 0.9
      const target = { x: anchorX - (ribbonAnchor.x - 0.5) * w, y: anchorY - (0.5 - ribbonAnchor.y) * h }
      walker.ribbonPos ??= target
      const follow = 1 - Math.exp(-RIBBON_FOLLOW_PER_S * dt)
      walker.ribbonPos.x += (target.x - walker.ribbonPos.x) * follow
      walker.ribbonPos.y += (target.y - walker.ribbonPos.y) * follow
      ribbon.position.set(walker.ribbonPos.x, walker.ribbonPos.y, 0)
      ribbon.scale.set(w, h, 1)
      ribbon.material.uniforms.uOpacity.value = revealAt(walker.ribbonPos.x, walker.ribbonPos.y)
      // the card flaps while its person walks and settles when they stop
      walker.flutter += ((moving ? 1 : CARD_IDLE_FLUTTER) - walker.flutter) * (1 - Math.exp(-CARD_FLUTTER_EASE_PER_S * dt))
      ribbon.material.uniforms.uFlutter.value = walker.flutter
      // each card has its own frame offset and pose order, so cards never flap in sync
      const seed = Math.abs(walker.tilt) * 1e4
      const frame = Math.floor(now * CARD_FPS + seed)
      const pose = Math.floor(Math.abs(Math.sin(frame * 12.9898 + seed) * 43758.5453) % CARD_POSES)
      ribbon.material.uniforms.uTime.value = pose * 1.7 + seed
      ribbon.rotation.z = walker.tilt + (pose - (CARD_POSES - 1) / 2) * 0.012 * walker.flutter
    }
  }

  const removeWalker = (walker: Walker) => {
    for (const step of walker.steps) {
      scene.remove(step.mesh)
      step.mesh.material.dispose()
    }
    scene.remove(walker.ribbon)
    walker.ribbon.material.uniforms.uMap.value.dispose()
    walker.ribbon.material.dispose()
    walkers.delete(walker.id)
  }

  const removeWanderers = () => {
    for (const walker of [...walkers.values()]) if (walker.wander) removeWalker(walker)
  }

  // real people missing from the latest server response went offline or got stale
  const keepOnly = (ids: Set<string>) => {
    for (const walker of [...walkers.values()]) if (!walker.wander && !ids.has(walker.id)) removeWalker(walker)
  }

  const boxes = () =>
    [...walkers.values()].flatMap((w) => {
      const r = w.ribbon
      if (!w.ribbonPos) return []
      return [{ minX: r.position.x - r.scale.x / 2, maxX: r.position.x + r.scale.x / 2, minY: r.position.y - r.scale.y / 2, maxY: r.position.y + r.scale.y / 2 }]
    })

  return {
    update,
    boxes,
    applyFix,
    removeWanderers,
    keepOnly,
    addWanderer,
    setGraph: (next: Graph) => {
      graph = next
    },
    walkers,
  }
}

// Name card held by tape at the top: the torn bottom edge lifts and ripples in waves, the
// bent paper catches more or less light, and its soft shadow (baked in the texture) stays put.
function cardMaterial(texture: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uOpacity: { value: 0 },
      uTime: { value: 0 },
      uFlutter: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uFlutter;
      varying vec2 vUv;
      varying float vBend;
      float lift(vec2 p) {
        // the tape holds the top, the free bottom edge moves the most
        float free = pow(1.0 - p.y, 1.6);
        float wave = sin(p.x * 7.0 - uTime * 7.5) * 0.6 + sin(p.x * 15.0 + uTime * 11.0) * 0.25 + sin(uTime * 3.1 + p.x * 2.0) * 0.4;
        return free * wave * uFlutter;
      }
      void main() {
        vUv = uv;
        float l = lift(uv);
        vBend = (lift(uv + vec2(0.02, 0.0)) - l) / 0.02;
        vec3 p = position;
        p.y += l * 0.08;
        p.x += sin(uTime * 2.7 + uv.y * 3.0) * pow(1.0 - uv.y, 2.0) * 0.008 * uFlutter;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uOpacity;
      varying vec2 vUv;
      varying float vBend;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        // light from the top left: slopes facing it brighten, the others darken
        float shade = 1.0 - clamp(vBend * 0.08, -0.08, 0.12);
        gl_FragColor = vec4(t.rgb * shade, t.a * uOpacity);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

// painted canvas textures (banners, footprints) keep their own colors
function paintMaterial(texture: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uOpacity: { value: 0 },
    },
    vertexShader: textVertex,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        gl_FragColor = vec4(t.rgb, t.a * uOpacity);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}
