// Location server for the map: serves the built web app and merges every source into one
// list of points.
//
//   iCloud Find My (icloud.ts, polled) ───────────┐
//   OwnTracks app  POST /api/owntracks ───────────┼──▶ latest point per id ──▶ GET /api/locations
//   Overland app   POST /api/overland ────────────┘
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Device } from './icloud.ts'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

export type Point = {
  id: string
  kind: 'person' | 'device' | 'item'
  name: string
  lat: number
  lon: number
  accuracyM?: number
  timestamp: number
  source: 'icloud' | 'owntracks' | 'overland'
  battery?: number
}

const points = new Map<string, Point>()

function log(message: string) {
  process.stderr.write(`${new Date().toLocaleTimeString()} ${message}\n`)
}

function upsert(point: Point) {
  const existing = points.get(point.id)
  if (existing && existing.timestamp >= point.timestamp) return
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return
  points.set(point.id, point)
  log(`${point.source} ${point.name} ${point.lat.toFixed(5)},${point.lon.toFixed(5)}`)
}

// "Tommy’s iPhone" -> "Tommy", so banners show people, not device models
export function ownerName(deviceName: string) {
  const match = deviceName.match(/^(.+?)['’]s\s/)
  return match ? match[1].trim() : deviceName
}

// phones and watches travel with their owner, so they are shown as that person
export function ingestDevices(devices: Device[]) {
  for (const d of devices) {
    const personal = /iPhone|Watch/i.test(d.model)
    upsert({
      id: `icloud:${d.id}`,
      kind: personal ? 'person' : 'device',
      name: personal ? ownerName(d.name) : d.name,
      lat: d.lat,
      lon: d.lon,
      accuracyM: d.accuracyM,
      timestamp: d.timestamp,
      source: 'icloud',
      battery: d.battery,
    })
  }
}

// ---------- HTTP ----------

async function readJson(req: IncomingMessage): Promise<Error | IngestBody> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return new Error('Body too large')
      chunks.push(chunk)
    }
    const parsed: IngestBody | null = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Error('Expected a JSON object')
    return parsed
  } catch (e) {
    return new Error('Invalid request body', { cause: e })
  }
}

function send({ res, status, body }: { res: ServerResponse; status: number; body: object }) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(body))
}

type OwnTracksMessage = { _type?: string; lat?: number; lon?: number; acc?: number; tst?: number; tid?: string; batt?: number }

// https://owntracks.org/booklet/tech/http/ user and device come from the X-Limit-U / X-Limit-D headers
function ingestOwnTracks({ req, msg, url }: { req: IncomingMessage; msg: OwnTracksMessage; url: URL }) {
  if (msg._type !== 'location' || typeof msg.lat !== 'number' || typeof msg.lon !== 'number') return
  const user = String(req.headers['x-limit-u'] ?? url.searchParams.get('u') ?? msg.tid ?? 'owntracks')
  const device = String(req.headers['x-limit-d'] ?? 'phone')
  upsert({
    id: `owntracks:${user}:${device}`,
    kind: 'person',
    name: url.searchParams.get('name') ?? user,
    lat: msg.lat,
    lon: msg.lon,
    accuracyM: msg.acc,
    timestamp: (msg.tst ?? Date.now() / 1000) * 1000,
    source: 'owntracks',
    battery: msg.batt,
  })
}

type OverlandBody = {
  locations?: {
    geometry?: { coordinates?: [number, number] }
    properties?: { timestamp?: string; device_id?: string; horizontal_accuracy?: number; battery_level?: number }
  }[]
}

// both apps post JSON objects; fields are optional and checked before use
type IngestBody = OwnTracksMessage & OverlandBody

// https://github.com/aaronpk/Overland-iOS#api
function ingestOverland({ body, url }: { body: OverlandBody; url: URL }) {
  if (!Array.isArray(body.locations)) return
  for (const loc of body.locations) {
    const [lon, lat] = loc?.geometry?.coordinates ?? []
    if (typeof lat !== 'number' || typeof lon !== 'number') continue
    const device = loc.properties?.device_id ?? 'overland'
    upsert({
      id: `overland:${device}`,
      kind: 'person',
      name: url.searchParams.get('name') ?? device,
      lat,
      lon,
      accuracyM: loc.properties?.horizontal_accuracy,
      timestamp: loc.properties?.timestamp ? Date.parse(loc.properties.timestamp) : Date.now(),
      source: 'overland',
      battery: loc.properties?.battery_level,
    })
  }
}

async function serveStatic({ res, url, distDir }: { res: ServerResponse; url: URL; distDir: string }) {
  const safe = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  const file = path.join(distDir, safe === '/' ? 'index.html' : safe)
  if (!file.startsWith(distDir)) return send({ res, status: 404, body: { error: 'Not found' } })
  const content = await readFile(file).catch(() => undefined)
  // unknown paths fall back to the app, so URLs with query params always load
  const body = content ?? (await readFile(path.join(distDir, 'index.html')).catch(() => undefined))
  if (!body) return send({ res, status: 404, body: { error: 'Web app not built. Run `pnpm build` in the marauders-map folder.' } })
  res.writeHead(200, { 'content-type': MIME[content ? path.extname(file) : '.html'] ?? 'application/octet-stream' })
  res.end(body)
}

export function startServer({ port, distDir }: { port: number; distDir: string }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/api/locations') {
      const now = Date.now()
      return send({ res, status: 200, body: { points: [...points.values()].filter((p) => now - p.timestamp < STALE_AFTER_MS) } })
    }
    if (req.method === 'POST' && (url.pathname === '/api/owntracks' || url.pathname === '/api/overland')) {
      const body = await readJson(req)
      if (body instanceof Error) return send({ res, status: 400, body: { error: body.message } })
      if (url.pathname === '/api/owntracks') {
        ingestOwnTracks({ req, msg: body, url })
        return send({ res, status: 200, body: [] })
      }
      ingestOverland({ body, url })
      return send({ res, status: 200, body: { result: 'ok' } })
    }
    if (req.method === 'GET') return serveStatic({ res, url, distDir })
    send({ res, status: 404, body: { error: 'Not found' } })
  })
  return new Promise<typeof server | Error>((resolve) => {
    server.once('error', (e) => resolve(new Error(`Could not listen on port ${port}`, { cause: e })))
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
