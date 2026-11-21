// Launch video director. Loaded by the app with `?capture&video`: every frame is a pure function
// of time `t` (seconds). A recorder calls `window.videoFrame(t)` then takes a screenshot.
//
//   ink blooms ─▶ glide over town ─▶ push in on Tommy ─▶ pull back wide ─▶ "made by Opus 5.5"
export type View = { x: number; y: number; cssMpp: number }
type Walker = { name: string; x: number; y: number }
type MapHooks = {
  mapView: View
  mapReveal: (v: number, opening?: boolean) => void
  mapPeople: { walkers: Map<string, Walker> }
  mapCapture: { frame: (ms: number) => void; pendingTiles: () => number }
}

const hooks = window as unknown as MapHooks & Window & { videoFrame: (t: number) => void; videoReady: () => boolean; videoLength: number }

// no music: scene starts in seconds, paced for reading
const SCENE = {
  bloom: 0,
  glide: 1.1,
  push: 4.6,
  latin: 8.6,
  streets: 12.8,
  wide: 17,
  credit: 21,
}
const LENGTH_S = 23.6

const FOCUS_NAME = 'Tommy'
const SECOND_NAME = 'Sofia'
// ?ui=2: frames are 1920 wide but laid out like a 960 wide screen at 2x
const UI = Number(new URLSearchParams(location.search).get('ui') ?? 1)
document.documentElement.style.setProperty('--ui', String(UI))

// ---------- easing ----------
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const expoOut = (v: number) => (v >= 1 ? 1 : 1 - 2 ** (-10 * v))
const easeInOut = (v: number) => (v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2)
const power3In = (v: number) => v * v * v
const progress = (t: number, start: number, duration: number) => clamp01((t - start) / duration)
const lerp = (a: number, b: number, v: number) => a + (b - a) * v

// ---------- overlay DOM ----------
const style = document.createElement('style')
style.textContent = `
  #title, #people, #mischief, #attribution, #cover .hint { display: none !important; }
  #cover { transition: none !important; }
  .v-caption {
    position: fixed; left: 50%; bottom: 9%; transform: translateX(-50%);
    font: calc(40px * var(--ui)) 'Marauder Italic', serif; color: #2b1a0e; white-space: nowrap; pointer-events: none;
    padding: calc(18px * var(--ui)) calc(60px * var(--ui)) calc(22px * var(--ui)); text-shadow: 0 0 18px rgba(236, 222, 186, 0.95), 0 0 6px rgba(236, 222, 186, 0.9);
  }
  .v-caption::before {
    content: ''; position: absolute; inset: -30px -80px; z-index: -1;
    background: radial-gradient(ellipse at center, rgba(232, 214, 172, 0.92) 0%, rgba(232, 214, 172, 0.75) 45%, rgba(232, 214, 172, 0) 72%);
  }
`
document.head.append(style)

const caption = document.createElement('div')
caption.className = 'v-caption'
document.body.append(caption)

document.getElementById('cover')!.style.display = 'none'

const CAPTIONS = [
  { text: 'the Marauder’s Map from Harry Potter', start: SCENE.glide, end: SCENE.push },
  { text: 'with live locations from Apple Find My', start: SCENE.push, end: SCENE.latin },
  { text: 'every wall is written in tiny Latin', start: SCENE.latin, end: SCENE.streets },
  { text: 'footsteps follow the real streets', start: SCENE.streets, end: SCENE.wide },
  { text: 'see your family walking, in real time', start: SCENE.wide, end: SCENE.credit },
  { text: 'made by Opus 5.5', start: SCENE.credit, end: LENGTH_S + 1 },
]

// ink writing: the line appears left to right, each part starts slightly blurred and sharpens
function writeOn({ el, text, t, start, endAt }: { el: HTMLElement; text: string; t: number; start: number; endAt: number }) {
  const write = expoOut(progress(t, start + 0.05, 1.1))
  const leave = power3In(progress(t, endAt - 0.35, 0.35))
  if (el.textContent !== text) el.textContent = text
  el.style.clipPath = `inset(-40px ${(1 - write) * 100}% -40px -40px)`
  el.style.opacity = String(1 - leave)
  // held text creeps upwards a few pixels so it never freezes
  const drift = (t - start) * 6 + leave * 30
  el.style.transform = `translateX(-50%) translateY(${-drift * UI}px)`
  el.style.filter = `blur(${(1 - write) * 3}px)`
}

// ---------- camera ----------

let k = 1
let start = { x: 0, y: 0 }

function walkerOffset(name: string) {
  const walkers = [...hooks.mapPeople.walkers.values()]
  const w = walkers.find((w) => w.name === name) ?? walkers[0]
  return w ? { x: (w.x - start.x) / k, y: (w.y - start.y) / k } : { x: 0, y: 0 }
}

// camera keys: (time, x, y, meters per css px). x/y are offsets in meters from the start center
function cameraAt(t: number): View {
  const follow = walkerOffset(FOCUS_NAME)
  const second = walkerOffset(SECOND_NAME)
  const keys = [
    { t: SCENE.bloom, x: 0, y: 0, mpp: 0.36 },
    { t: SCENE.glide + 1.5, x: -40, y: 20, mpp: 0.38 },
    { t: SCENE.push, x: 140, y: 60, mpp: 0.3 },
    { t: SCENE.push + 1.4, x: follow.x, y: follow.y, mpp: 0.13 },
    { t: SCENE.latin, x: follow.x, y: follow.y, mpp: 0.12 },
    { t: SCENE.latin + 1.6, x: follow.x + 14, y: follow.y + 9, mpp: 0.065 },
    { t: SCENE.streets, x: follow.x + 16, y: follow.y + 10, mpp: 0.06 },
    { t: SCENE.streets + 1.8, x: second.x, y: second.y, mpp: 0.11 },
    { t: SCENE.wide, x: second.x, y: second.y, mpp: 0.1 },
    { t: SCENE.wide + 2.2, x: 60, y: -60, mpp: 1.3 },
    { t: LENGTH_S, x: 90, y: -80, mpp: 1.15 },
  ]
  let i = keys.findIndex((key) => key.t > t) - 1
  if (i < 0) i = t < keys[0].t ? 0 : keys.length - 2
  const a = keys[i]
  const b = keys[i + 1]
  const v = easeInOut(progress(t, a.t, b.t - a.t))
  // handheld drift on top, a few meters, never still
  const hx = Math.sin(t * 0.9) * 4 + Math.sin(t * 2.3) * 1.2
  const hy = Math.cos(t * 0.7) * 3 + Math.cos(t * 1.9) * 1
  // zoom interpolates in log space so it feels even
  const mpp = (Math.exp(lerp(Math.log(a.mpp), Math.log(b.mpp), v)) * (1 - t * 0.002)) / UI
  return { x: start.x + (lerp(a.x, b.x, v) + hx * mpp) * k, y: start.y + (lerp(a.y, b.y, v) + hy * mpp) * k, cssMpp: mpp * k }
}

// ---------- frame ----------

let initialized = false

hooks.videoLength = LENGTH_S
hooks.videoReady = () => hooks.mapCapture.pendingTiles() === 0 && hooks.mapPeople.walkers.size > 0

hooks.videoFrame = (t: number) => {
  if (!initialized) {
    initialized = true
    const params = new URLSearchParams(location.search)
    k = hooks.mapView.cssMpp / Number(params.get('mpp') ?? 0.35)
    start = { x: hooks.mapView.x, y: hooks.mapView.y }
  }

  // ink blooms from the center right away, no cover
  hooks.mapReveal(clamp01(easeInOut(progress(t, SCENE.bloom, 2.4)) * 1.05))

  const caption0 = CAPTIONS.find((c) => t >= c.start && t < c.end)
  if (caption0) writeOn({ el: caption, text: caption0.text, t, start: caption0.start, endAt: caption0.end })
  else caption.style.opacity = '0'

  Object.assign(hooks.mapView, cameraAt(t))
  hooks.mapCapture.frame(t * 1000)
}
