// Walls written in tiny cursive Latin, like the film map: glyphs laid along every
// building outline, instanced per tile. Fades to the plain inked line when zoomed out.
import * as THREE from 'three'
import { INK_CSS } from './ink-text.ts'

const WALL_FONT = '"Marauder Italic", serif'
const ATLAS_CELL_PX = 64
const ATLAS_FONT_PX = 44
const GLYPH_HEIGHT_M = 1.2
const ROW_GAP = 1.3 // rows of text, in glyph heights
const ROWS = 2
const MIN_RING_LENGTH_M = 6
const JITTER_ANGLE_RAD = 0.07

export const WALL_PHRASE =
  'Marauders est hanc omnibus itinerarium ~ I solemnly swear that I am up to no good ~ ' +
  'Messrs Moony Wormtail Padfoot et Prongs ~ Maraudentibus aedificium Hogwarts ~ ' +
  'Mischief managed ~ secretum iter ~ nox et lumos ~ '

export type GlyphAtlas = {
  texture: THREE.CanvasTexture
  glyphs: Map<string, { u: number; v: number; advance: number }>
  cols: number
  rows: number
}

export function createGlyphAtlas(): GlyphAtlas {
  const chars = [...new Set(WALL_PHRASE)].filter((c) => c !== ' ')
  const cols = 16
  const rows = Math.ceil(chars.length / cols)
  const canvas = document.createElement('canvas')
  canvas.width = cols * ATLAS_CELL_PX
  canvas.height = rows * ATLAS_CELL_PX
  const ctx = canvas.getContext('2d')!
  ctx.font = `${ATLAS_FONT_PX}px ${WALL_FONT}`
  ctx.fillStyle = INK_CSS
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const glyphs: GlyphAtlas['glyphs'] = new Map()
  chars.forEach((ch, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    ctx.fillText(ch, col * ATLAS_CELL_PX + ATLAS_CELL_PX / 2, row * ATLAS_CELL_PX + ATLAS_CELL_PX / 2)
    glyphs.set(ch, { u: col, v: row, advance: ctx.measureText(ch).width / ATLAS_FONT_PX })
  })
  glyphs.set(' ', { u: -1, v: -1, advance: ctx.measureText(' ').width / ATLAS_FONT_PX })
  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.anisotropy = 4
  return { texture, glyphs, cols, rows }
}

// positive for counter clockwise rings (y up)
function signedArea(points: { x: number; y: number }[]) {
  let a = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) a += points[j].x * points[i].y - points[i].x * points[j].y
  return a / 2
}

// Lays the phrase along each ring, in rows just inside the building outline.
export function buildWallText({
  rings,
  atlas,
  mercPerMeter,
  seed,
  bounds,
}: {
  rings: { points: { x: number; y: number }[]; hole: boolean }[]
  atlas: GlyphAtlas
  mercPerMeter: number
  seed: number
  // glyphs outside the tile's own area are skipped: tile buffers clip polygons with fake edges
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}) {
  const height = GLYPH_HEIGHT_M * mercPerMeter
  const offsets: number[] = []
  const angles: number[] = []
  const cells: number[] = []
  let phraseIndex = Math.floor(seed) % WALL_PHRASE.length
  let rand = seed % 1 || 0.37
  const random = () => {
    rand = (rand * 9301 + 0.49297) % 1
    return rand
  }
  for (const ring of rings) {
    const pts = ring.points
    if (pts.length < 3) continue
    let perimeter = 0
    for (let i = 0; i < pts.length - 1; i++) perimeter += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
    if (perimeter < MIN_RING_LENGTH_M * mercPerMeter) continue
    // ring is counter clockwise in scene space when area > 0, interior of the area on the left
    const ccw = signedArea(pts) > 0
    const insideLeft = ring.hole ? !ccw : ccw
    const rows = perimeter > 50 * mercPerMeter ? ROWS : 1
    for (let row = 0; row < rows; row++) {
      const inset = height * (0.6 + row * ROW_GAP)
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]
        const b = pts[i + 1]
        const len = Math.hypot(b.x - a.x, b.y - a.y)
        if (len < height * 0.8) continue
        const dx = (b.x - a.x) / len
        const dy = (b.y - a.y) / len
        const nx = insideLeft ? -dy : dy
        const ny = insideLeft ? dx : -dx
        // glyphs read along the wall direction
        const angle = Math.atan2(dy, dx)
        let t = height * 0.3
        while (t < len - height * 0.3) {
          const ch = WALL_PHRASE[phraseIndex]
          phraseIndex = (phraseIndex + 1) % WALL_PHRASE.length
          const glyph = atlas.glyphs.get(ch)
          if (!glyph) continue
          const advance = glyph.advance * height * 1.05
          const wobble = (random() - 0.5) * height * 0.25
          const gx = a.x + dx * (t + advance / 2) + nx * (inset + wobble)
          const gy = a.y + dy * (t + advance / 2) + ny * (inset + wobble)
          const inside = gx >= bounds.minX && gx < bounds.maxX && gy >= bounds.minY && gy < bounds.maxY
          if (glyph.u >= 0 && inside) {
            offsets.push(gx, gy)
            angles.push(angle + (random() - 0.5) * 2 * JITTER_ANGLE_RAD)
            cells.push(glyph.u, glyph.v)
          }
          t += advance
        }
      }
    }
  }
  return { offsets, angles, cells, count: angles.length, height }
}

export function wallTextMaterial({ atlas }: { atlas: GlyphAtlas }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas.texture },
      uGrid: { value: new THREE.Vector2(atlas.cols, atlas.rows) },
      uSize: { value: 1 },
      uOpacity: { value: 1 },
      uInk: { value: new THREE.Color(INK_CSS) },
      uReveal: { value: 1 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uMask: { value: null },
    },
    vertexShader: /* glsl */ `
      attribute vec2 iOffset;
      attribute float iAngle;
      attribute vec2 iCell;
      uniform float uSize;
      uniform vec2 uGrid;
      varying vec2 vUv;
      varying float vTint;
      void main() {
        vTint = fract(sin(dot(iOffset, vec2(12.9898, 78.233))) * 43758.5453);
        float c = cos(iAngle);
        float s = sin(iAngle);
        vec2 p = position.xy * uSize * 1.4;
        vec2 world = iOffset + vec2(p.x * c - p.y * s, p.x * s + p.y * c);
        vUv = (iCell + vec2(uv.x, 1.0 - uv.y)) / uGrid;
        vUv.y = 1.0 - vUv.y;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform float uOpacity;
      uniform vec3 uInk;
      uniform float uReveal;
      uniform vec2 uResolution;
      uniform sampler2D uMask;
      varying vec2 vUv;
      varying float vTint;
      void main() {
        float a = texture2D(uAtlas, vUv).a;
        vec2 px = gl_FragCoord.xy;
        // text stays inside buildings, never spills into corridors
        a *= smoothstep(0.3, 0.6, texture2D(uMask, px / uResolution).r);
        // some words in the film are written in a redder, more watery ink
        vec3 ink = mix(uInk, vec3(0.42, 0.25, 0.1), step(0.82, vTint));
        float r = length(px - 0.5 * uResolution) / length(0.5 * uResolution);
        float revealed = 1.0 - smoothstep(uReveal * 1.25 - 0.06, uReveal * 1.25, r);
        gl_FragColor = vec4(ink, a * uOpacity * revealed * (0.8 + 0.2 * vTint));
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
}

const glyphQuad = new THREE.PlaneGeometry(1, 1)

export function wallTextMesh({ data, material }: { data: ReturnType<typeof buildWallText>; material: THREE.ShaderMaterial }) {
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.index = glyphQuad.index
  geometry.setAttribute('position', glyphQuad.getAttribute('position'))
  geometry.setAttribute('uv', glyphQuad.getAttribute('uv'))
  geometry.setAttribute('iOffset', new THREE.InstancedBufferAttribute(new Float32Array(data.offsets), 2))
  geometry.setAttribute('iAngle', new THREE.InstancedBufferAttribute(new Float32Array(data.angles), 1))
  geometry.setAttribute('iCell', new THREE.InstancedBufferAttribute(new Float32Array(data.cells), 2))
  geometry.instanceCount = data.count
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 5
  return mesh
}

export { GLYPH_HEIGHT_M }
