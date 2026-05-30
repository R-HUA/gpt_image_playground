import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { fal } from '@fal-ai/client'

const SERVER_API_KEY_PLACEHOLDER = '__server_stored_api_key__'
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_FAL_BASE_URL = 'https://fal.run'
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_FAL_IMAGE_SIZE = { width: 1360, height: 1024 }

type JsonRecord = Record<string, unknown>
type AuthUser = { id: number; username: string }
type DbRow = Record<string, unknown>
type ApiProfile = {
  id?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  timeout?: number
}
type TaskParams = {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
}
type CallApiResult = {
  images: string[]
  actualParams?: Partial<TaskParams>
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  revisedPrompts?: Array<string | undefined>
  rawImageUrls?: string[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '../..')
const dataDir = resolve(process.env.GIP_DATA_DIR || join(projectRoot, 'data'))
const configPath = resolve(process.env.GIP_USERS_CONFIG || join(projectRoot, 'config/users.json'))
const distDir = resolve(projectRoot, 'dist')
const dbPath = join(dataDir, 'app.sqlite')
const secretPath = join(dataDir, 'server-secret')

mkdirSync(dataDir, { recursive: true })
const db = new DatabaseSync(dbPath)

function now() {
  return Date.now()
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJson<T = unknown>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function initDb() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS agent_conversations (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS images (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      mime TEXT NOT NULL,
      file_path TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS thumbnails (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      mime TEXT NOT NULL,
      file_path TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
  `)
}

function getServerSecret() {
  if (existsSync(secretPath)) return readFileSync(secretPath, 'utf8').trim()
  const secret = randomBytes(48).toString('base64url')
  writeFileSync(secretPath, secret, { mode: 0o600 })
  return secret
}

const serverSecret = getServerSecret()

function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: scryptSync(password, salt, 64).toString('hex'),
  }
}

function verifyPassword(password: string, salt: string, expectedHash: string) {
  const actual = Buffer.from(hashPassword(password, salt).hash, 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function getUserByUsername(username: string): (AuthUser & { password_hash: string; password_salt: string }) | null {
  const row = db.prepare('SELECT id, username, password_hash, password_salt FROM users WHERE username = ?').get(username)
  if (!row) return null
  return {
    id: Number(row.id),
    username: String(row.username),
    password_hash: String(row.password_hash),
    password_salt: String(row.password_salt),
  }
}

function getUserById(id: number): AuthUser | null {
  const row = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id)
  return row ? { id: Number(row.id), username: String(row.username) } : null
}

function syncUsersFromConfig() {
  if (!existsSync(configPath)) {
    console.warn(`[server] Users config not found: ${configPath}. Create it from config/users.example.json before logging in.`)
    return
  }

  const raw = readFileSync(configPath, 'utf8')
  const parsed = parseJson<unknown>(raw, null)
  const users = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.users)
    ? parsed.users
    : []

  if (!users.length) {
    console.warn(`[server] Users config contains no users: ${configPath}`)
    return
  }

  for (const item of users) {
    if (!isRecord(item)) continue
    const username = asString(item.username).trim()
    const password = asString(item.password)
    if (!username || !password) continue

    const existing = getUserByUsername(username)
    const stamp = now()
    if (!existing) {
      const { salt, hash } = hashPassword(password)
      db.prepare('INSERT INTO users (username, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(username, hash, salt, stamp, stamp)
      console.log(`[server] Imported user: ${username}`)
      continue
    }

    if (!verifyPassword(password, existing.password_salt, existing.password_hash)) {
      const { salt, hash } = hashPassword(password)
      db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?')
        .run(hash, salt, stamp, existing.id)
      db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(stamp, existing.id)
      console.log(`[server] Updated password for user: ${username}`)
    }
  }
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function signAccessToken(user: AuthUser) {
  const payload = base64UrlJson({ sub: user.id, username: user.username, exp: now() + ACCESS_TOKEN_TTL_MS })
  const signature = createHmac('sha256', serverSecret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function verifyAccessToken(token: string): AuthUser | null {
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null
  const expected = createHmac('sha256', serverSecret).update(payload).digest('base64url')
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null
  const data = parseJson<JsonRecord>(Buffer.from(payload, 'base64url').toString('utf8'), {})
  if (asNumber(data.exp) < now()) return null
  const userId = asNumber(data.sub)
  return userId ? getUserById(userId) : null
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function createRefreshToken(userId: number) {
  const token = randomBytes(48).toString('base64url')
  const stamp = now()
  db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, hashToken(token), stamp + REFRESH_TOKEN_TTL_MS, stamp)
  return token
}

function authResponse(user: AuthUser) {
  return {
    accessToken: signAccessToken(user),
    refreshToken: createRefreshToken(user.id),
    user,
  }
}

function getBearerUser(req: IncomingMessage): AuthUser | null {
  const header = asString(req.headers.authorization)
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? verifyAccessToken(match[1]) : null
}

function requireUser(req: IncomingMessage) {
  const user = getBearerUser(req)
  if (!user) throw Object.assign(new Error('未登录或登录已过期'), { statusCode: 401 })
  return user
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const raw = await readRawBody(req)
  if (raw.length === 0) return {} as T
  return JSON.parse(raw.toString('utf8')) as T
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendNoContent(res: ServerResponse) {
  res.writeHead(204, { 'Cache-Control': 'no-store' })
  res.end()
}

function sendError(res: ServerResponse, err: unknown) {
  const statusCode = isRecord(err) && typeof err.statusCode === 'number' ? err.statusCode : 500
  const message = err instanceof Error ? err.message : String(err)
  if (statusCode >= 500) console.error(err)
  sendJson(res, statusCode, { error: message || '服务器错误' })
}

function assertMethod(req: IncomingMessage, method: string) {
  if (req.method !== method) throw Object.assign(new Error('Method Not Allowed'), { statusCode: 405 })
}

function tableJsonRows(table: string, userId: number, orderBy: string) {
  return db.prepare(`SELECT json FROM ${table} WHERE user_id = ? ORDER BY ${orderBy}`).all(userId)
    .map((row) => parseJson(String(row.json), null))
    .filter((value) => value != null)
}

function putJsonRow(table: string, userId: number, id: string, value: unknown, createdAt?: number, updatedAt?: number) {
  const stamp = now()
  db.prepare(`
    INSERT INTO ${table} (user_id, id, json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(userId, id, JSON.stringify(value), createdAt ?? stamp, updatedAt ?? stamp)
}

function deleteJsonRow(table: string, userId: number, id: string) {
  db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND id = ?`).run(userId, id)
}

function clearJsonRows(table: string, userId: number) {
  db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId)
}

function getRawSettings(userId: number): JsonRecord | null {
  const row = db.prepare('SELECT json FROM settings WHERE user_id = ?').get(userId)
  return row ? parseJson<JsonRecord>(String(row.json), {}) : null
}

function redactApiKeys(settings: JsonRecord): JsonRecord {
  const copy = structuredClone(settings) as JsonRecord
  if (typeof copy.apiKey === 'string' && copy.apiKey) copy.apiKey = SERVER_API_KEY_PLACEHOLDER
  if (Array.isArray(copy.profiles)) {
    copy.profiles = copy.profiles.map((profile) => {
      if (!isRecord(profile)) return profile
      return {
        ...profile,
        apiKey: typeof profile.apiKey === 'string' && profile.apiKey ? SERVER_API_KEY_PLACEHOLDER : '',
      }
    })
  }
  return copy
}

function mergeSettingsSecrets(incoming: JsonRecord, previous: JsonRecord | null): JsonRecord {
  const next = structuredClone(incoming) as JsonRecord
  const previousProfiles = Array.isArray(previous?.profiles) ? previous.profiles.filter(isRecord) : []
  if (next.apiKey === SERVER_API_KEY_PLACEHOLDER) next.apiKey = asString(previous?.apiKey)

  if (Array.isArray(next.profiles)) {
    next.profiles = next.profiles.map((profile) => {
      if (!isRecord(profile)) return profile
      const id = asString(profile.id)
      const previousProfile = previousProfiles.find((item) => asString(item.id) === id)
      if (profile.apiKey === SERVER_API_KEY_PLACEHOLDER) {
        return { ...profile, apiKey: asString(previousProfile?.apiKey) }
      }
      return profile
    })
  }
  return next
}

function saveSettings(userId: number, settings: JsonRecord) {
  const stamp = now()
  const previous = getRawSettings(userId)
  const merged = mergeSettingsSecrets(settings, previous)
  db.prepare(`
    INSERT INTO settings (user_id, json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(merged), stamp, stamp)
  return merged
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file'
}

function mimeToExt(mime: string) {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/svg+xml') return 'svg'
  return 'png'
}

function dataUrlToBuffer(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
  if (!match) throw Object.assign(new Error('无效的 data URL'), { statusCode: 400 })
  const mime = match[1] || 'application/octet-stream'
  const isBase64 = Boolean(match[2])
  const payload = match[3] || ''
  const bytes = isBase64 ? Buffer.from(payload.replace(/\s/g, ''), 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  return { mime, bytes }
}

async function ensureParent(path: string) {
  await mkdir(dirname(path), { recursive: true })
}

function userFilePath(userId: number, kind: 'images' | 'thumbnails', id: string, mime: string) {
  return join('users', String(userId), kind, `${safeSegment(id)}.${mimeToExt(mime)}`)
}

function absoluteDataPath(relativePath: string) {
  return resolve(dataDir, relativePath)
}

function removeFileIfExists(relativePath: unknown) {
  if (typeof relativePath !== 'string' || !relativePath) return
  const absolute = absoluteDataPath(relativePath)
  if (!absolute.startsWith(dataDir)) return
  try {
    unlinkSync(absolute)
  } catch {
    // ignore missing files
  }
}

async function putStoredFile(kind: 'images' | 'thumbnails', userId: number, id: string, record: JsonRecord, dataUrlField: string) {
  const dataUrl = asString(record[dataUrlField])
  if (!dataUrl) throw Object.assign(new Error('缺少图片数据'), { statusCode: 400 })
  const { mime, bytes } = dataUrlToBuffer(dataUrl)
  const relativePath = userFilePath(userId, kind, id, mime)
  const absolute = absoluteDataPath(relativePath)
  await ensureParent(absolute)
  writeFileSync(absolute, bytes)

  const table = kind === 'images' ? 'images' : 'thumbnails'
  const previous = db.prepare(`SELECT file_path FROM ${table} WHERE user_id = ? AND id = ?`).get(userId, id)
  if (previous && previous.file_path !== relativePath) removeFileIfExists(previous.file_path)

  const metadata: JsonRecord = { ...record, id }
  delete metadata[dataUrlField]
  const stamp = now()
  db.prepare(`
    INSERT INTO ${table} (user_id, id, mime, file_path, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      mime = excluded.mime,
      file_path = excluded.file_path,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(userId, id, mime, relativePath, JSON.stringify(metadata), asNumber(record.createdAt, stamp), stamp)
}

function rowToDataUrl(row: DbRow, dataUrlField: string) {
  const metadata = parseJson<JsonRecord>(String(row.metadata_json), {})
  const absolute = absoluteDataPath(String(row.file_path))
  const bytes = readFileSync(absolute)
  return {
    ...metadata,
    id: String(row.id),
    [dataUrlField]: `data:${String(row.mime)};base64,${bytes.toString('base64')}`,
  }
}

function getStoredFile(kind: 'images' | 'thumbnails', userId: number, id: string) {
  const table = kind === 'images' ? 'images' : 'thumbnails'
  const field = kind === 'images' ? 'dataUrl' : 'thumbnailDataUrl'
  const row = db.prepare(`SELECT id, mime, file_path, metadata_json FROM ${table} WHERE user_id = ? AND id = ?`).get(userId, id)
  return row ? rowToDataUrl(row, field) : null
}

function listStoredFiles(kind: 'images' | 'thumbnails', userId: number) {
  const table = kind === 'images' ? 'images' : 'thumbnails'
  const field = kind === 'images' ? 'dataUrl' : 'thumbnailDataUrl'
  return db.prepare(`SELECT id, mime, file_path, metadata_json FROM ${table} WHERE user_id = ? ORDER BY created_at DESC`).all(userId)
    .map((row) => rowToDataUrl(row, field))
}

function deleteStoredFile(kind: 'images' | 'thumbnails', userId: number, id: string) {
  const table = kind === 'images' ? 'images' : 'thumbnails'
  const row = db.prepare(`SELECT file_path FROM ${table} WHERE user_id = ? AND id = ?`).get(userId, id)
  if (row) removeFileIfExists(row.file_path)
  db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND id = ?`).run(userId, id)
}

function clearStoredFiles(kind: 'images' | 'thumbnails', userId: number) {
  const table = kind === 'images' ? 'images' : 'thumbnails'
  const rows = db.prepare(`SELECT file_path FROM ${table} WHERE user_id = ?`).all(userId)
  for (const row of rows) removeFileIfExists(row.file_path)
  db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId)
}

function resolveProfileForUser(userId: number, input: unknown): ApiProfile {
  const profile = isRecord(input) ? input as ApiProfile : {}
  const apiKey = asString(profile.apiKey)
  if (apiKey && apiKey !== SERVER_API_KEY_PLACEHOLDER) return profile

  const settings = getRawSettings(userId)
  const profiles = Array.isArray(settings?.profiles) ? settings.profiles.filter(isRecord) : []
  const stored = profiles.find((item) => asString(item.id) === asString(profile.id))
  return {
    ...profile,
    apiKey: asString(stored?.apiKey) || asString(settings?.apiKey),
  }
}

function buildProviderUrl(profile: ApiProfile, path: string) {
  const fallbackBase = profile.provider === 'fal' ? DEFAULT_FAL_BASE_URL : DEFAULT_OPENAI_BASE_URL
  const base = (asString(profile.baseUrl).trim().replace(/\/+$/, '') || fallbackBase)
  const cleanPath = path.replace(/^\/+/, '')
  const url = new URL(`${base}/${cleanPath}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Object.assign(new Error('仅支持 HTTP/HTTPS API URL'), { statusCode: 400 })
  return url.toString()
}

function providerHeaders(profile: ApiProfile, contentType?: string) {
  const headers: Record<string, string> = {}
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`
  if (contentType) headers['Content-Type'] = contentType
  return headers
}

function copyResponseHeaders(providerResponse: Response) {
  const headers: Record<string, string> = {}
  providerResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (['connection', 'content-encoding', 'content-length', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(lower)) return
    headers[key] = value
  })
  headers['Cache-Control'] = 'no-store'
  return headers
}

async function pipeFetchResponse(providerResponse: Response, res: ServerResponse) {
  res.writeHead(providerResponse.status, copyResponseHeaders(providerResponse))
  if (!providerResponse.body) {
    res.end()
    return
  }
  await new Promise<void>((resolvePromise, reject) => {
    Readable.fromWeb(providerResponse.body as any)
      .on('error', reject)
      .on('end', resolvePromise)
      .pipe(res)
  })
}

function decodeJsonHeader(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown
}

async function fetchImageUrlAsDataUrl(url: string, fallbackMime = 'image/png') {
  if (url.startsWith('data:')) return url
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  return `data:${response.headers.get('content-type') || fallbackMime};base64,${bytes.toString('base64')}`
}

function normalizeBase64Image(value: string, fallbackMime: string) {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:')
}

function mapFalEndpoint(model: string, isEdit: boolean) {
  const normalizedModel = model.trim().replace(/^\/+/, '').replace(/\/+$/, '') || 'openai/gpt-image-2'
  return isEdit && !normalizedModel.endsWith('/edit') ? `${normalizedModel}/edit` : normalizedModel
}

function mapFalImageSize(size: string) {
  const match = size.match(/^(\d+)x(\d+)$/)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : DEFAULT_FAL_IMAGE_SIZE
}

function mapFalQuality(quality: TaskParams['quality']) {
  return quality === 'auto' ? 'high' : quality
}

function configureFal(profile: ApiProfile) {
  const baseUrl = asString(profile.baseUrl).trim().replace(/\/+$/, '') || DEFAULT_FAL_BASE_URL
  const config: JsonRecord = {
    credentials: asString(profile.apiKey),
    suppressLocalCredentialsWarning: true,
  }
  if (baseUrl !== DEFAULT_FAL_BASE_URL) config.proxyUrl = baseUrl
  ;(fal as any).config(config)
}

function createFalInput(body: JsonRecord) {
  const params = body.params as TaskParams
  const inputImageDataUrls = Array.isArray(body.inputImageDataUrls) ? body.inputImageDataUrls.filter((item): item is string => typeof item === 'string') : []
  const isEdit = inputImageDataUrls.length > 0
  const input: JsonRecord = {
    prompt: asString(body.prompt),
    image_size: isEdit && params.size === 'auto' ? 'auto' : mapFalImageSize(params.size),
    quality: mapFalQuality(params.quality),
    num_images: Math.min(4, Math.max(1, params.n || 1)),
    output_format: params.output_format,
  }
  if (isEdit) input.image_urls = inputImageDataUrls
  if (typeof body.maskDataUrl === 'string' && body.maskDataUrl) input.mask_url = body.maskDataUrl
  return { input, endpoint: mapFalEndpoint(asString((body.profile as ApiProfile).model), isEdit), params }
}

function readFalImageValue(value: unknown, fallbackMime: string): string | null {
  if (typeof value === 'string') {
    if (isHttpUrl(value) || isDataUrl(value)) return value
    return normalizeBase64Image(value, fallbackMime)
  }
  if (!isRecord(value)) return null
  if (isHttpUrl(value.url) || isDataUrl(value.url)) return value.url
  for (const key of ['b64_json', 'base64', 'data']) {
    if (typeof value[key] === 'string') return normalizeBase64Image(value[key], fallbackMime)
  }
  return null
}

function readFalImageSize(value: unknown): Partial<TaskParams> | undefined {
  if (!isRecord(value)) return undefined
  const width = asNumber(value.width)
  const height = asNumber(value.height)
  return width && height ? { size: `${Math.round(width)}x${Math.round(height)}` } : undefined
}

async function parseFalResult(payload: JsonRecord, params: TaskParams): Promise<CallApiResult> {
  const mime = params.output_format === 'jpeg' ? 'image/jpeg' : `image/${params.output_format || 'png'}`
  const candidates: unknown[] = []
  if (Array.isArray(payload.images)) candidates.push(...payload.images)
  if (payload.image) candidates.push(payload.image)
  if (payload.url) candidates.push(payload.url)

  const results: Array<{ image: string; actualParams?: Partial<TaskParams>; rawImageUrl?: string }> = []
  for (const candidate of candidates) {
    const value = readFalImageValue(candidate, mime)
    if (!value) continue
    results.push({
      image: isHttpUrl(value) ? await fetchImageUrlAsDataUrl(value, mime) : value,
      actualParams: readFalImageSize(candidate),
      rawImageUrl: isHttpUrl(value) ? value : undefined,
    })
  }
  if (!results.length) throw new Error('fal.ai 未返回可用图片数据')
  return {
    images: results.map((item) => item.image),
    actualParams: results[0]?.actualParams,
    actualParamsList: results.map((item) => item.actualParams),
    revisedPrompts: results.map(() => undefined),
    rawImageUrls: results.map((item) => item.rawImageUrl).filter((item): item is string => Boolean(item)),
  }
}

function writeNdjson(res: ServerResponse, event: unknown) {
  res.write(`${JSON.stringify(event)}\n`)
}

async function handleFalCall(req: IncomingMessage, res: ServerResponse, user: AuthUser) {
  assertMethod(req, 'POST')
  const body = await readJsonBody<JsonRecord>(req)
  const profile = resolveProfileForUser(user.id, body.profile)
  body.profile = profile
  configureFal(profile)
  const { input, endpoint, params } = createFalInput(body)
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' })
  try {
    const result = await (fal as any).subscribe(endpoint, {
      input,
      logs: true,
      onEnqueue: (requestId: string) => writeNdjson(res, { type: 'falEnqueued', request: { requestId, endpoint } }),
    })
    writeNdjson(res, { type: 'falEnqueued', request: { requestId: result.requestId, endpoint } })
    writeNdjson(res, { type: 'final', result: await parseFalResult(result.data as JsonRecord, params) })
  } catch (err) {
    writeNdjson(res, { type: 'error', error: err instanceof Error ? err.message : String(err) })
  } finally {
    res.end()
  }
}

async function handleFalResult(req: IncomingMessage, res: ServerResponse, user: AuthUser) {
  assertMethod(req, 'POST')
  const body = await readJsonBody<JsonRecord>(req)
  const profile = resolveProfileForUser(user.id, body.profile)
  configureFal(profile)
  const endpoint = asString(body.endpoint)
  const requestId = asString(body.requestId)
  const params = body.params as TaskParams
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' })
  try {
    await (fal as any).queue.subscribeToStatus(endpoint, { requestId, logs: true })
    const result = await (fal as any).queue.result(endpoint, { requestId })
    writeNdjson(res, { type: 'final', result: await parseFalResult(result.data as JsonRecord, params) })
  } catch (err) {
    writeNdjson(res, { type: 'error', error: err instanceof Error ? err.message : String(err) })
  } finally {
    res.end()
  }
}

async function handleProviderJson(req: IncomingMessage, res: ServerResponse, user: AuthUser) {
  assertMethod(req, 'POST')
  const body = await readJsonBody<JsonRecord>(req)
  const profile = resolveProfileForUser(user.id, body.profile)
  const method = asString(body.method, 'POST').toUpperCase()
  const providerResponse = await fetch(buildProviderUrl(profile, asString(body.path)), {
    method,
    headers: providerHeaders(profile, method === 'GET' || body.body === undefined ? undefined : 'application/json'),
    body: method === 'GET' || body.body === undefined ? undefined : JSON.stringify(body.body),
  })
  await pipeFetchResponse(providerResponse, res)
}

async function handleProviderMultipart(req: IncomingMessage, res: ServerResponse, user: AuthUser) {
  assertMethod(req, 'POST')
  const rawBody = await readRawBody(req)
  const profile = resolveProfileForUser(user.id, decodeJsonHeader(asString(req.headers['x-gip-provider-profile'])))
  const path = asString(req.headers['x-gip-provider-path'])
  const method = asString(req.headers['x-gip-provider-method'], 'POST').toUpperCase()
  const contentType = asString(req.headers['content-type'])
  const providerResponse = await fetch(buildProviderUrl(profile, path), {
    method,
    headers: providerHeaders(profile, contentType),
    body: method === 'GET' ? undefined : new Uint8Array(rawBody),
  })
  await pipeFetchResponse(providerResponse, res)
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const pathname = url.pathname

  if (pathname === '/api/auth/login') {
    assertMethod(req, 'POST')
    const body = await readJsonBody<JsonRecord>(req)
    const username = asString(body.username).trim()
    const password = asString(body.password)
    const user = username ? getUserByUsername(username) : null
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      throw Object.assign(new Error('用户名或密码错误'), { statusCode: 401 })
    }
    sendJson(res, 200, authResponse({ id: user.id, username: user.username }))
    return
  }

  if (pathname === '/api/auth/refresh') {
    assertMethod(req, 'POST')
    const body = await readJsonBody<JsonRecord>(req)
    const refreshToken = asString(body.refreshToken)
    const tokenHash = hashToken(refreshToken)
    const row = db.prepare('SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?').get(tokenHash)
    if (!row || row.revoked_at || Number(row.expires_at) < now()) throw Object.assign(new Error('刷新令牌无效'), { statusCode: 401 })
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(now(), row.id)
    const user = getUserById(Number(row.user_id))
    if (!user) throw Object.assign(new Error('用户不存在'), { statusCode: 401 })
    sendJson(res, 200, authResponse(user))
    return
  }

  const user = requireUser(req)

  if (pathname === '/api/auth/logout') {
    assertMethod(req, 'POST')
    const body = await readJsonBody<JsonRecord>(req)
    const refreshToken = asString(body.refreshToken)
    if (refreshToken) db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?').run(now(), hashToken(refreshToken))
    sendNoContent(res)
    return
  }

  if (pathname === '/api/auth/me') {
    assertMethod(req, 'GET')
    sendJson(res, 200, { user })
    return
  }

  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      const settings = getRawSettings(user.id)
      sendJson(res, 200, { exists: Boolean(settings), settings: settings ? redactApiKeys(settings) : null })
      return
    }
    if (req.method === 'PATCH') {
      const body = await readJsonBody<JsonRecord>(req)
      if (!isRecord(body.settings)) throw Object.assign(new Error('缺少 settings'), { statusCode: 400 })
      const saved = saveSettings(user.id, body.settings)
      sendJson(res, 200, { settings: redactApiKeys(saved) })
      return
    }
  }

  if (pathname === '/api/tasks') {
    if (req.method === 'GET') return sendJson(res, 200, tableJsonRows('tasks', user.id, 'created_at DESC'))
    if (req.method === 'DELETE') {
      clearJsonRows('tasks', user.id)
      return sendNoContent(res)
    }
  }
  if (pathname.startsWith('/api/tasks/')) {
    const id = decodeURIComponent(pathname.slice('/api/tasks/'.length))
    if (req.method === 'PUT') {
      const body = await readJsonBody<JsonRecord>(req)
      const task: JsonRecord = isRecord(body.task) ? { ...body.task, id } : { id }
      putJsonRow('tasks', user.id, id, task, asNumber(task.createdAt), asNumber(task.finishedAt) || undefined)
      return sendJson(res, 200, { id })
    }
    if (req.method === 'DELETE') {
      deleteJsonRow('tasks', user.id, id)
      return sendNoContent(res)
    }
  }

  if (pathname === '/api/agent/conversations') {
    if (req.method === 'GET') return sendJson(res, 200, tableJsonRows('agent_conversations', user.id, 'updated_at DESC'))
    if (req.method === 'PUT') {
      const body = await readJsonBody<JsonRecord>(req)
      const conversations = Array.isArray(body.conversations) ? body.conversations.filter(isRecord) : []
      db.exec('BEGIN')
      try {
        clearJsonRows('agent_conversations', user.id)
        for (const conversation of conversations) {
          const id = asString(conversation.id)
          if (id) putJsonRow('agent_conversations', user.id, id, conversation, asNumber(conversation.createdAt), asNumber(conversation.updatedAt))
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      return sendNoContent(res)
    }
    if (req.method === 'DELETE') {
      clearJsonRows('agent_conversations', user.id)
      return sendNoContent(res)
    }
  }
  if (pathname.startsWith('/api/agent/conversations/')) {
    const id = decodeURIComponent(pathname.slice('/api/agent/conversations/'.length))
    if (req.method === 'PUT') {
      const body = await readJsonBody<JsonRecord>(req)
      const conversation: JsonRecord = isRecord(body.conversation) ? { ...body.conversation, id } : { id }
      putJsonRow('agent_conversations', user.id, id, conversation, asNumber(conversation.createdAt), asNumber(conversation.updatedAt))
      return sendJson(res, 200, { id })
    }
    if (req.method === 'DELETE') {
      deleteJsonRow('agent_conversations', user.id, id)
      return sendNoContent(res)
    }
  }

  if (pathname === '/api/images/fetch-url') {
    assertMethod(req, 'POST')
    const body = await readJsonBody<JsonRecord>(req)
    return sendJson(res, 200, { dataUrl: await fetchImageUrlAsDataUrl(asString(body.url), asString(body.fallbackMime, 'image/png')) })
  }
  if (pathname === '/api/images/store') {
    assertMethod(req, 'POST')
    const body = await readJsonBody<JsonRecord>(req)
    const dataUrl = asString(body.dataUrl)
    const id = createHash('sha256').update(dataUrl).digest('hex')
    await putStoredFile('images', user.id, id, { id, dataUrl, createdAt: now(), source: asString(body.source, 'upload') }, 'dataUrl')
    return sendJson(res, 200, { id })
  }
  if (pathname === '/api/images') {
    if (req.method === 'GET') return sendJson(res, 200, listStoredFiles('images', user.id))
    if (req.method === 'DELETE') {
      clearStoredFiles('images', user.id)
      return sendNoContent(res)
    }
  }
  if (pathname === '/api/images/ids') {
    assertMethod(req, 'GET')
    return sendJson(res, 200, db.prepare('SELECT id FROM images WHERE user_id = ? ORDER BY created_at DESC').all(user.id).map((row) => String(row.id)))
  }
  if (pathname.startsWith('/api/images/')) {
    const id = decodeURIComponent(pathname.slice('/api/images/'.length))
    if (req.method === 'GET') return sendJson(res, 200, getStoredFile('images', user.id, id))
    if (req.method === 'PUT') {
      const body = await readJsonBody<JsonRecord>(req)
      if (!isRecord(body.image)) throw Object.assign(new Error('缺少 image'), { statusCode: 400 })
      await putStoredFile('images', user.id, id, body.image, 'dataUrl')
      return sendJson(res, 200, { id })
    }
    if (req.method === 'DELETE') {
      deleteStoredFile('images', user.id, id)
      return sendNoContent(res)
    }
  }

  if (pathname.startsWith('/api/thumbnails/')) {
    const id = decodeURIComponent(pathname.slice('/api/thumbnails/'.length))
    if (req.method === 'GET') return sendJson(res, 200, getStoredFile('thumbnails', user.id, id))
    if (req.method === 'PUT') {
      const body = await readJsonBody<JsonRecord>(req)
      if (!isRecord(body.thumbnail)) throw Object.assign(new Error('缺少 thumbnail'), { statusCode: 400 })
      await putStoredFile('thumbnails', user.id, id, body.thumbnail, 'thumbnailDataUrl')
      return sendJson(res, 200, { id })
    }
  }

  if (pathname === '/api/provider/json') return handleProviderJson(req, res, user)
  if (pathname === '/api/provider/multipart') return handleProviderMultipart(req, res, user)
  if (pathname === '/api/fal/call') return handleFalCall(req, res, user)
  if (pathname === '/api/fal/result') return handleFalResult(req, res, user)

  throw Object.assign(new Error('Not Found'), { statusCode: 404 })
}

const staticMime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

async function serveStatic(res: ServerResponse, pathname: string) {
  let filePath = normalize(join(distDir, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)))
  if (!filePath.startsWith(distDir)) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })

  try {
    const fileStat = await stat(filePath)
    if (fileStat.isDirectory()) filePath = join(filePath, 'index.html')
  } catch {
    filePath = extname(filePath) ? filePath : join(distDir, 'index.html')
  }

  try {
    const bytes = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': staticMime[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': bytes.length,
      'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    res.end(bytes)
  } catch {
    sendJson(res, 404, { error: 'Not Found' })
  }
}

initDb()
syncUsersFromConfig()
rmSync(join(dataDir, 'tmp'), { recursive: true, force: true })

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }
    await serveStatic(res, url.pathname)
  })().catch((err) => {
    if (!res.headersSent) sendError(res, err)
    else res.end()
  })
})

const port = Number(process.env.PORT || 3000)
server.listen(port, () => {
  console.log(`[server] GPT Image Playground listening on http://localhost:${port}`)
})
