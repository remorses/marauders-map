// iCloud web login and Find My devices in plain TypeScript, ported from timlaing/pyicloud
// (https://github.com/timlaing/pyicloud, base.py and services/findmyiphone.py).
//
//   authorize/signin ─▶ signin/init (SRP A) ─▶ signin/complete (SRP M1, M2)
//        200: trusted already            409: two factor code needed
//                                              └─▶ verify/trusteddevice or verify/phone ─▶ 2sv/trust
//   setup accountLogin (session + trust token) ─▶ webservices.findme ─▶ initClient / refreshClient
//
// The session (cookies, session token, trust token) is saved, so a login lasts about two months.
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const AUTH_ENDPOINT = 'https://idmsa.apple.com/appleauth/auth'
const SETUP_ENDPOINT = 'https://setup.icloud.com/setup/ws/1'
const HOME_ENDPOINT = 'https://www.icloud.com'
const WIDGET_KEY = 'd39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15'
const CLIENT_PARAMS = { clientBuildNumber: '2534Project66', clientMasteringNumber: '2534B22' }
const REQUEST_TIMEOUT_MS = 30_000
const HTTP_OK = 200
const HTTP_NO_CONTENT = 204
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_TWO_FACTOR_REQUIRED = 409
const HTTP_REPAIR_REQUIRED = 412
const HTTP_LOGIN_EXPIRED = 421
const HTTP_FIND_MY_REAUTH = 450
const SRP_KEY_LENGTH = 32
const SRP_EPHEMERAL_BYTES = 256

export const DATA_DIR = path.join(os.homedir(), '.marauders-map')
const SESSION_FILE = path.join(DATA_DIR, 'icloud-session.json')

// response headers Apple uses to hand out session state
const SESSION_HEADERS = {
  'x-apple-id-account-country': 'accountCountry',
  'x-apple-id-session-id': 'sessionId',
  'x-apple-auth-attributes': 'authAttributes',
  'x-apple-session-token': 'sessionToken',
  'x-apple-twosv-trust-token': 'trustToken',
  scnt: 'scnt',
} as const

export type ICloudSession = {
  appleId: string
  clientId: string
  cookies: { name: string; value: string; domain: string }[]
  dsid?: string
  findMyUrl?: string
} & Partial<Record<(typeof SESSION_HEADERS)[keyof typeof SESSION_HEADERS], string>>

export type Device = {
  id: string
  name: string
  model: string
  lat: number
  lon: number
  accuracyM?: number
  timestamp: number
  battery?: number
}

export class ICloudError extends Error {
  status?: number
  constructor({ message, status, cause }: { message: string; status?: number; cause?: Error }) {
    super(message, { cause })
    this.name = 'ICloudError'
    this.status = status
  }
}

// ---------- session file ----------

export async function loadSession(): Promise<ICloudSession | undefined> {
  const text = await readFile(SESSION_FILE, 'utf8').catch(() => undefined)
  if (!text) return undefined
  try {
    const session: ICloudSession = JSON.parse(text)
    return session
  } catch {
    return undefined
  }
}

export async function saveSession(session: ICloudSession) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 })
  await chmod(SESSION_FILE, 0o600)
}

export async function deleteSession() {
  await rm(SESSION_FILE, { force: true })
}

export function newSession(appleId: string): ICloudSession {
  return { appleId, clientId: `auth-${crypto.randomUUID().toLowerCase()}`, cookies: [] }
}

// ---------- HTTP with a tiny cookie jar ----------

function cookieHeader({ session, host }: { session: ICloudSession; host: string }) {
  return session.cookies
    .filter((c) => host === c.domain || host.endsWith(`.${c.domain}`))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
}

function storeCookies({ session, res, host }: { session: ICloudSession; res: Response; host: string }) {
  for (const raw of res.headers.getSetCookie()) {
    const [pair, ...attributes] = raw.split(';')
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    const domainAttr = attributes.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith('domain='))
    const domain = (domainAttr ? domainAttr.slice('domain='.length) : host).replace(/^\./, '').toLowerCase()
    const expired = attributes.some((a) => /^\s*max-age=0\b/i.test(a)) || value === '' || value === '""'
    session.cookies = session.cookies.filter((c) => !(c.name === name && c.domain === domain))
    if (!expired) session.cookies.push({ name, value, domain })
  }
}

function captureSessionHeaders({ session, res }: { session: ICloudSession; res: Response }) {
  for (const [header, field] of Object.entries(SESSION_HEADERS)) {
    const value = res.headers.get(header)
    if (value) session[field] = value
  }
}

async function request({
  session,
  url,
  method = 'GET',
  json,
  headers = {},
  params,
  signal,
}: {
  session: ICloudSession
  url: string
  method?: string
  json?: object
  headers?: Record<string, string>
  params?: Record<string, string>
  signal: AbortSignal
}) {
  const target = new URL(url)
  for (const [k, v] of Object.entries(params ?? {})) target.searchParams.set(k, v)
  const res = await fetch(target, {
    method,
    headers: {
      'User-Agent': USER_AGENT,
      Origin: HOME_ENDPOINT,
      Referer: `${HOME_ENDPOINT}/`,
      'Content-Type': 'application/json',
      Cookie: cookieHeader({ session, host: target.hostname }),
      ...headers,
    },
    body: json ? JSON.stringify(json) : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  }).catch((e) => new ICloudError({ message: `Could not reach ${target.hostname}`, cause: e }))
  if (res instanceof Error) return res
  storeCookies({ session, res, host: target.hostname })
  captureSessionHeaders({ session, res })
  return res
}

async function readJson(res: Response): Promise<Record<string, any>> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function authHeaders(session: ICloudSession, overrides: Record<string, string> = {}) {
  const headers = {
    Accept: 'application/json, text/javascript',
    'Content-Type': 'application/json',
    'X-Apple-OAuth-Client-Id': WIDGET_KEY,
    'X-Apple-OAuth-Client-Type': 'firstPartyAuth',
    'X-Apple-OAuth-Redirect-URI': HOME_ENDPOINT,
    'X-Apple-OAuth-Require-Grant-Code': 'true',
    'X-Apple-OAuth-Response-Mode': 'web_message',
    'X-Apple-OAuth-Response-Type': 'code',
    'X-Apple-OAuth-State': session.clientId,
    'X-Apple-Widget-Key': WIDGET_KEY,
    'X-Apple-Frame-Id': session.clientId,
    'X-Apple-FD-Client-Info': JSON.stringify({ U: USER_AGENT, L: 'en-US', Z: 'GMT+00:00', V: '1.1', F: '' }),
    Referer: 'https://idmsa.apple.com',
    scnt: session.scnt ?? '',
    'X-Apple-ID-Session-Id': session.sessionId ?? '',
    'X-Apple-Auth-Attributes': session.authAttributes ?? '',
  }
  // empty values mean "not handed out yet": drop them instead of sending blank headers
  return Object.fromEntries(Object.entries({ ...headers, ...overrides }).filter(([, v]) => v !== ''))
}

// ---------- SRP-6a (RFC 5054, SHA-256, 2048 bit group), same math as python `srp` ----------

const N = BigInt(
  '0xAC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73',
)
const G = 2n

function toBytes(n: bigint) {
  let hex = n.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex, 'hex')
}
const toBigInt = (b: Buffer) => BigInt(`0x${b.toString('hex') || '0'}`)
const pad = (b: Buffer, width: number) => Buffer.concat([Buffer.alloc(Math.max(0, width - b.length)), b])
const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest()
function modPow({ base, exp, mod = N }: { base: bigint; exp: bigint; mod?: bigint }) {
  let result = 1n
  let b = ((base % mod) + mod) % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return result
}

export function srpProof({
  accountName,
  password,
  salt,
  iterations,
  protocol,
  a,
  B,
}: {
  accountName: string
  password: string
  salt: Buffer
  iterations: number
  protocol: 's2k' | 's2k_fo'
  a: bigint
  B: Buffer
}) {
  const width = toBytes(N).length
  const A = modPow({ base: G, exp: a })
  const bigB = toBigInt(B)
  const k = toBigInt(sha256(toBytes(N), pad(toBytes(G), width)))
  const u = toBigInt(sha256(pad(toBytes(A), width), pad(B, width)))
  // Apple stretches the password: PBKDF2 over sha256(password), hex encoded for s2k_fo
  const digest = createHash('sha256').update(password, 'utf8').digest()
  const secret = pbkdf2Sync(protocol === 's2k_fo' ? Buffer.from(digest.toString('hex')) : digest, salt, iterations, SRP_KEY_LENGTH, 'sha256')
  // no username in x: x = H(salt | H(":" | secret))
  const x = toBigInt(sha256(salt, sha256(Buffer.from(':'), secret)))
  const v = modPow({ base: G, exp: x })
  const S = modPow({ base: bigB - k * v, exp: a + u * x })
  const K = sha256(toBytes(S))
  const hN = sha256(toBytes(N))
  const hg = sha256(pad(toBytes(G), width))
  const hNxorg = Buffer.from(hN.map((byte, i) => byte ^ hg[i]))
  const M1 = sha256(hNxorg, sha256(Buffer.from(accountName)), salt, toBytes(A), B, K)
  const M2 = sha256(toBytes(A), M1, K)
  return { A: toBytes(A), M1, M2 }
}

// ---------- login ----------

export type TwoFactorPrompt = (input: {
  phoneNumbers: { id: number; number: string }[]
}) => Promise<{ kind: 'code'; code: string; phoneId?: number } | { kind: 'sms'; phoneId: number } | undefined>

// Full sign in. `askCode` is called when Apple wants a two factor code; it can return a code
// typed from a trusted device, or ask for an SMS to one of the trusted numbers.
export async function login({
  appleId,
  password,
  askCode,
  signal,
}: {
  appleId: string
  password: string
  askCode: TwoFactorPrompt
  signal: AbortSignal
}): Promise<ICloudError | ICloudSession> {
  const previous = await loadSession()
  const session = previous?.appleId === appleId ? { ...previous, dsid: undefined, findMyUrl: undefined } : newSession(appleId)

  const page = await request({
    session,
    url: `${AUTH_ENDPOINT}/authorize/signin`,
    headers: authHeaders(session),
    params: {
      frame_id: session.clientId,
      skVersion: '7',
      iframeid: session.clientId,
      client_id: WIDGET_KEY,
      response_type: 'code',
      redirect_uri: HOME_ENDPOINT,
      response_mode: 'web_message',
      state: session.clientId,
      authVersion: 'latest',
    },
    signal,
  })
  if (page instanceof Error) return page

  const a = toBigInt(randomBytes(SRP_EPHEMERAL_BYTES))
  const A = toBytes(modPow({ base: G, exp: a }))
  const init = await request({
    session,
    url: `${AUTH_ENDPOINT}/signin/init`,
    method: 'POST',
    json: { a: A.toString('base64'), accountName: appleId, protocols: ['s2k', 's2k_fo'] },
    headers: authHeaders(session),
    signal,
  })
  if (init instanceof Error) return init
  if (init.status !== HTTP_OK) return new ICloudError({ message: 'Apple refused to start the sign in. Check the Apple ID.', status: init.status })
  const challenge = await readJson(init)
  const proof = srpProof({
    accountName: appleId,
    password,
    salt: Buffer.from(challenge.salt, 'base64'),
    iterations: challenge.iteration,
    protocol: challenge.protocol,
    a,
    B: Buffer.from(challenge.b, 'base64'),
  })

  const complete = await request({
    session,
    url: `${AUTH_ENDPOINT}/signin/complete`,
    method: 'POST',
    params: { isRememberMeEnabled: 'true' },
    json: {
      accountName: appleId,
      c: challenge.c,
      m1: proof.M1.toString('base64'),
      m2: proof.M2.toString('base64'),
      rememberMe: true,
      trustTokens: session.trustToken ? [session.trustToken] : [],
    },
    headers: authHeaders(session),
    signal,
  })
  if (complete instanceof Error) return complete
  if (complete.status === HTTP_UNAUTHORIZED || complete.status === HTTP_FORBIDDEN) {
    return new ICloudError({ message: 'Wrong Apple ID or password.', status: complete.status })
  }
  if (complete.status === HTTP_TWO_FACTOR_REQUIRED) {
    const verified = await verifyTwoFactor({ session, askCode, signal })
    if (verified instanceof Error) return verified
  } else if (complete.status !== HTTP_OK) {
    const body = await readJson(complete)
    return new ICloudError({ message: `Sign in failed: ${JSON.stringify(body.serviceErrors ?? body).slice(0, 300)}`, status: complete.status })
  }

  const account = await accountLogin({ session, signal })
  if (account instanceof Error) return account
  await saveSession(session)
  return session
}

async function verifyTwoFactor({ session, askCode, signal }: { session: ICloudSession; askCode: TwoFactorPrompt; signal: AbortSignal }) {
  const optionsRes = await request({ session, url: AUTH_ENDPOINT, headers: authHeaders(session, { Accept: 'application/json' }), signal })
  if (optionsRes instanceof Error) return optionsRes
  const options = await readJson(optionsRes)
  const phoneNumbers = trustedPhones(options)

  for (;;) {
    const answer = await askCode({ phoneNumbers })
    if (!answer) return new ICloudError({ message: 'Two factor verification cancelled.' })
    if (answer.kind === 'sms') {
      const sent = await request({
        session,
        url: `${AUTH_ENDPOINT}/verify/phone`,
        method: 'PUT',
        json: { phoneNumber: { id: answer.phoneId }, mode: 'sms' },
        headers: authHeaders(session, { Accept: 'application/json' }),
        signal,
      })
      if (sent instanceof Error) return sent
      if (sent.status !== HTTP_OK) return new ICloudError({ message: 'Apple could not send the SMS code.', status: sent.status })
      continue
    }
    const res =
      answer.phoneId === undefined
        ? await request({
            session,
            url: `${AUTH_ENDPOINT}/verify/trusteddevice/securitycode`,
            method: 'POST',
            json: { securityCode: { code: answer.code } },
            headers: authHeaders(session, { Accept: 'application/json' }),
            signal,
          })
        : await request({
            session,
            url: `${AUTH_ENDPOINT}/verify/phone/securitycode`,
            method: 'POST',
            json: { phoneNumber: { id: answer.phoneId }, securityCode: { code: answer.code }, mode: 'sms' },
            headers: authHeaders(session, { Accept: 'application/json' }),
            signal,
          })
    if (res instanceof Error) return res
    if (await codeAccepted(res)) break
    // wrong code: ask again
  }

  const trust = await request({ session, url: `${AUTH_ENDPOINT}/2sv/trust`, headers: authHeaders(session), signal })
  if (trust instanceof Error) return trust
  if (trust.status >= 400) return new ICloudError({ message: 'Apple did not trust this session.', status: trust.status })
  return undefined
}

type TrustedPhone = { id: number; numberWithDialCode?: string; obfuscatedNumber?: string }

// Apple puts trusted phones in different fields depending on the account and auth flow
function trustedPhones(options: Record<string, any>) {
  const raw: TrustedPhone[] = [
    options.trustedPhoneNumber,
    options.phoneNumberVerification?.trustedPhoneNumber,
    ...(options.phoneNumberVerification?.trustedPhoneNumbers ?? []),
    ...(options.trustedPhoneNumbers ?? []),
  ].filter((p): p is TrustedPhone => typeof p?.id === 'number')
  const unique = new Map(raw.map((p) => [p.id, { id: p.id, number: p.numberWithDialCode ?? p.obfuscatedNumber ?? String(p.id) }]))
  return [...unique.values()]
}

// Apple sometimes accepts a code with a 409 (body says valid) or a 412 account repair
async function codeAccepted(res: Response) {
  if (res.status === HTTP_OK || res.status === HTTP_NO_CONTENT) return true
  if (res.status === HTTP_REPAIR_REQUIRED) return Boolean(res.headers.get('x-apple-repair-session-token'))
  if (res.status !== HTTP_TWO_FACTOR_REQUIRED) return false
  const body = await readJson(res)
  return body.securityCode?.valid === true
}

// Turns the session token into iCloud cookies and the map of web services
async function accountLogin({ session, signal }: { session: ICloudSession; signal: AbortSignal }) {
  if (!session.sessionToken) return new ICloudError({ message: 'Not logged in. Run `marauders-map login`.' })
  const res = await request({
    session,
    url: `${SETUP_ENDPOINT}/accountLogin`,
    method: 'POST',
    json: {
      accountCountryCode: session.accountCountry,
      dsWebAuthToken: session.sessionToken,
      extended_login: true,
      trustToken: session.trustToken ?? '',
    },
    signal,
  })
  if (res instanceof Error) return res
  if (res.status !== HTTP_OK) {
    return new ICloudError({ message: 'The iCloud login expired. Run `marauders-map login` again.', status: res.status })
  }
  const data = await readJson(res)
  if (!data.hsaTrustedBrowser) return new ICloudError({ message: 'This session is not trusted yet. Run `marauders-map login` again.' })
  session.dsid = String(data.dsInfo?.dsid ?? '')
  session.findMyUrl = data.webservices?.findme?.url
  if (!session.findMyUrl) return new ICloudError({ message: 'Find My is not enabled for this Apple ID.' })
  return data
}

// ---------- Find My ----------

// Polls Find My for own and Family Sharing devices. Never asks devices for a fresh GPS fix:
// that wakes them up and drains the battery.
export function createFindMy({ session }: { session: ICloudSession }) {
  let serverContext: object | undefined

  const call = async ({ signal }: { signal: AbortSignal }) => {
    if (!session.findMyUrl || !session.dsid) {
      const account = await accountLogin({ session, signal })
      if (account instanceof Error) return account
      await saveSession(session)
    }
    const endpoint = serverContext ? 'refreshClient' : 'initClient'
    return request({
      session,
      url: `${session.findMyUrl}/fmipservice/client/web/${endpoint}`,
      method: 'POST',
      params: { ...CLIENT_PARAMS, clientId: session.clientId, dsid: session.dsid! },
      json: {
        clientContext: {
          appName: 'iCloud Find (Web)',
          appVersion: '2.0',
          apiVersion: '3.0',
          deviceListVersion: 1,
          fmly: true,
          timezone: 'US/Pacific',
          inactiveTime: 0,
        },
        serverContext,
      },
      signal,
    })
  }

  const devices = async ({ signal }: { signal: AbortSignal }): Promise<ICloudError | Device[]> => {
    let res = await call({ signal })
    if (res instanceof Error) return res
    // expired web cookies: log in again with the saved tokens, once
    if ([HTTP_UNAUTHORIZED, HTTP_FORBIDDEN, HTTP_LOGIN_EXPIRED, HTTP_FIND_MY_REAUTH].includes(res.status)) {
      session.findMyUrl = undefined
      serverContext = undefined
      res = await call({ signal })
      if (res instanceof Error) return res
    }
    if (res.status !== HTTP_OK) return new ICloudError({ message: `Find My answered ${res.status}`, status: res.status })
    const body = await readJson(res)
    serverContext = body.serverContext
    await saveSession(session)
    const content: any[] = body.content ?? []
    return content.flatMap((d) => {
      const loc = d.location
      if (!loc || typeof loc.latitude !== 'number') return []
      const device: Device = {
        id: String(d.id ?? d.name),
        name: String(d.name),
        model: String(d.deviceDisplayName ?? d.deviceClass ?? ''),
        lat: loc.latitude,
        lon: loc.longitude,
        accuracyM: loc.horizontalAccuracy,
        timestamp: loc.timeStamp ?? Date.now(),
        battery: typeof d.batteryLevel === 'number' ? d.batteryLevel : undefined,
      }
      return [device]
    })
  }

  return { devices }
}
