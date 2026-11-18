// Hand lettered ink text: corridor and room labels that fade in like fresh ink,
// plus canvas helpers for the name ribbons of people.
import * as THREE from 'three'
import type { Label } from './map-tiles.ts'

export const HAND_FONT = '"Marauder Hand", cursive'
export const TITLE_FONT = '"Marauder Title", serif'
export const SCRIPT_FONT = '"Marauder Script", cursive'
export const ITALIC_FONT = '"Marauder Italic", serif'

// the film letters area names as Roman capitals, with V for U: MARAVDERS, AEDIFICIVM
export function romanCapitals(text: string) {
  return text.toUpperCase().replace(/U/g, 'V').replace(/J/g, 'I')
}
export const INK_CSS = '#3a260e'
export const PAPER_CSS = '#dcc69c'

const LABEL_FONT_PX: Record<Label['kind'], number> = { room: 14, corridor: 13, place: 24 }
const TEXT_SUPERSAMPLE = 2
const MAX_VISIBLE_LABELS = 60
const MAX_VISIBLE_LABELS_ZOOMED_OUT = 24
const ZOOMED_OUT_METERS_PER_PX = 0.7
const ZOOMED_OUT_MIN_PRIORITY = 5
const LABEL_FADE_PER_S = 2.2
const LABEL_PADDING_PX = 6

export const textVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
// alpha only textures tinted with ink, with a slow left-to-right "being written" reveal
export const textFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform float uWrite;
  uniform vec3 uInk;
  varying vec2 vUv;
  void main() {
    float a = texture2D(uMap, vUv).a;
    float written = 1.0 - smoothstep(uWrite - 0.08, uWrite, vUv.x);
    gl_FragColor = vec4(uInk, a * uOpacity * written);
  }
`

export function inkMaterial({ texture }: { texture: THREE.Texture }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uOpacity: { value: 0 },
      uWrite: { value: 1.2 },
      uInk: { value: new THREE.Color(INK_CSS) },
    },
    vertexShader: textVertex,
    fragmentShader: textFragment,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
}

export function textCanvas({ text, font, sizePx }: { text: string; font: string; sizePx: number }) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const px = sizePx * TEXT_SUPERSAMPLE
  ctx.font = `${px}px ${font}`
  const width = Math.ceil(ctx.measureText(text).width + px * 0.6)
  const height = Math.ceil(px * 1.6)
  canvas.width = width
  canvas.height = height
  ctx.font = `${px}px ${font}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillStyle = INK_CSS
  ctx.fillText(text, width / 2, height / 2)
  return { canvas, cssWidth: width / TEXT_SUPERSAMPLE, cssHeight: height / TEXT_SUPERSAMPLE }
}

type LabelSprite = {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  cssWidth: number
  cssHeight: number
  opacity: number
  write: number
  label: Label
}

const unitPlane = new THREE.PlaneGeometry(1, 1)

export function createLabelLayer({ scene }: { scene: THREE.Object3D }) {
  const sprites = new Map<string, LabelSprite>()

  const spriteFor = (label: Label) => {
    const existing = sprites.get(label.id)
    if (existing) return existing
    const sizePx = LABEL_FONT_PX[label.kind]
    const font = label.kind === 'corridor' ? ITALIC_FONT : TITLE_FONT
    const text = label.kind === 'corridor' ? label.text : romanCapitals(label.text)
    const { canvas, cssWidth, cssHeight } = textCanvas({ text, font, sizePx })
    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    const mesh = new THREE.Mesh(unitPlane, inkMaterial({ texture }))
    mesh.renderOrder = 10
    mesh.rotation.z = label.angle
    scene.add(mesh)
    const sprite: LabelSprite = { mesh, cssWidth, cssHeight, opacity: 0, write: 0, label }
    sprites.set(label.id, sprite)
    return sprite
  }

  const dispose = (id: string, sprite: LabelSprite) => {
    scene.remove(sprite.mesh)
    sprite.mesh.material.uniforms.uMap.value.dispose()
    sprite.mesh.material.dispose()
    sprites.delete(id)
  }

  // Greedy placement by priority with screen space collision, then ink fades towards the target.
  const update = ({
    labels,
    view,
    cssMpp,
    metersPerPx,
    dt,
    revealAt,
    blockers,
  }: {
    labels: Label[]
    view: { minX: number; minY: number; maxX: number; maxY: number }
    cssMpp: number
    metersPerPx: number
    dt: number
    revealAt: (x: number, y: number) => number
    // screen space already taken, e.g. name banners
    blockers: { minX: number; minY: number; maxX: number; maxY: number }[]
  }) => {
    const placed = [...blockers]
    const zoomedOut = metersPerPx > ZOOMED_OUT_METERS_PER_PX
    const maxLabels = zoomedOut ? MAX_VISIBLE_LABELS_ZOOMED_OUT : MAX_VISIBLE_LABELS
    const visible = new Set<string>()
    const seenText = new Set<string>()
    const candidates = labels
      .filter((l) => l.x > view.minX && l.x < view.maxX && l.y > view.minY && l.y < view.maxY)
      .filter((l) => (l.kind === 'place' ? metersPerPx > 1.2 : metersPerPx < 2.5))
      .filter((l) => !zoomedOut || l.kind === 'place' || l.priority >= ZOOMED_OUT_MIN_PRIORITY)
      .sort((a, b) => b.priority - a.priority)
    for (const label of candidates) {
      if (visible.size >= maxLabels) break
      if (label.kind !== 'corridor' && seenText.has(label.text)) continue
      const sizePx = LABEL_FONT_PX[label.kind]
      const approxW = label.text.length * sizePx * (label.kind === 'corridor' ? 0.5 : 0.75) + LABEL_PADDING_PX
      const approxH = sizePx * 1.2 + LABEL_PADDING_PX
      const c = Math.abs(Math.cos(label.angle))
      const s = Math.abs(Math.sin(label.angle))
      const hw = ((approxW * c + approxH * s) / 2) * cssMpp
      const hh = ((approxW * s + approxH * c) / 2) * cssMpp
      const box = { minX: label.x - hw, maxX: label.x + hw, minY: label.y - hh, maxY: label.y + hh }
      const hit = placed.some((p) => p.minX < box.maxX && p.maxX > box.minX && p.minY < box.maxY && p.maxY > box.minY)
      if (hit) continue
      placed.push(box)
      visible.add(label.id)
      seenText.add(label.text)
    }

    for (const id of visible) spriteFor(labels.find((l) => l.id === id)!)
    for (const [id, sprite] of sprites) {
      const target = visible.has(id) && revealAt(sprite.label.x, sprite.label.y) > 0.5 ? 1 : 0
      sprite.opacity += Math.sign(target - sprite.opacity) * Math.min(Math.abs(target - sprite.opacity), dt * LABEL_FADE_PER_S)
      sprite.write = target ? Math.min(1.2, sprite.write + dt * 1.4) : sprite.write
      if (sprite.opacity <= 0 && !target) {
        dispose(id, sprite)
        continue
      }
      const { mesh } = sprite
      mesh.position.set(sprite.label.x, sprite.label.y, 0)
      mesh.scale.set(sprite.cssWidth * cssMpp, sprite.cssHeight * cssMpp, 1)
      mesh.material.uniforms.uOpacity.value = sprite.opacity
      mesh.material.uniforms.uWrite.value = sprite.write
    }
  }

  return { update }
}
