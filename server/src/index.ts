import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
const GENERATION_CONCURRENCY = Math.max(1, Number.parseInt(process.env.GIP_GENERATION_CONCURRENCY || '1', 10) || 1)
const CUSTOM_POLL_TIMEOUT_SECONDS = Math.max(1, Number.parseInt(process.env.GIP_CUSTOM_POLL_TIMEOUT_SECONDS || '900', 10) || 900)
const ADMIN_API_KEY = process.env.GIP_ADMIN_API_KEY || ''
const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

type JsonRecord = Record<string, unknown>
type AuthUser = { id: number; username: string }
type DbRow = Record<string, unknown>
type ApiProfile = {
  id?: string
  name?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  timeout?: number
  apiMode?: 'images' | 'responses'
  codexCli?: boolean
  responseFormatB64Json?: boolean
  streamImages?: boolean
  streamPartialImages?: number
}
type CustomProviderRequestMethod = 'GET' | 'POST'
type CustomProviderContentType = 'json' | 'multipart'
type CustomProviderFileSource = 'inputImages' | 'mask'
type CustomProviderFileMapping = {
  field: string
  source: CustomProviderFileSource
  array?: boolean
}
type CustomProviderResultMapping = {
  imageUrlPaths?: string[]
  b64JsonPaths?: string[]
}
type CustomProviderSubmitMapping = {
  path: string
  method?: CustomProviderRequestMethod
  contentType?: CustomProviderContentType
  query?: Record<string, string>
  body?: Record<string, unknown>
  files?: CustomProviderFileMapping[]
  taskIdPath?: string
  result?: CustomProviderResultMapping
}
type CustomProviderPollMapping = {
  path: string
  method?: CustomProviderRequestMethod
  query?: Record<string, string>
  intervalSeconds?: number
  timeoutSeconds?: number
  maxAttempts?: number
  statusPath: string
  successValues: string[]
  failureValues: string[]
  errorPath?: string
  result: CustomProviderResultMapping
}
type CustomProviderDefinition = {
  id: string
  name: string
  submit: CustomProviderSubmitMapping
  editSubmit?: CustomProviderSubmitMapping
  poll?: CustomProviderPollMapping
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
  rawResponsePayload?: string
}
type TaskStatus = 'queued' | 'running' | 'done' | 'error'
type StoredImageSource = 'upload' | 'generated' | 'mask'
type TaskRecord = JsonRecord & {
  id: string
  prompt: string
  params: TaskParams
  inputImageIds: string[]
  maskImageId?: string | null
  outputImages: string[]
  status: TaskStatus
  error: string | null
  createdAt: number
  queuedAt?: number
  startedAt?: number
  queuePosition?: number
  finishedAt: number | null
  elapsed: number | null
  actualParams?: Partial<TaskParams>
  actualParamsByImage?: Record<string, Partial<TaskParams>>
  revisedPromptByImage?: Record<string, string>
  rawImageUrls?: string[]
  rawResponsePayload?: string
}
type GenerationJobStatus = 'queued' | 'running' | 'done' | 'error'
type GenerationRequest = {
  profile: ApiProfile
  settings?: JsonRecord
  prompt?: string
  params?: TaskParams
  inputImageIds?: string[]
  maskImageId?: string | null
  referenceIds?: string[]
  agentBatchItemId?: string
}
type GenerationJobRow = {
  id: string
  user_id: number
  task_id: string
  status: GenerationJobStatus
  queued_at: number
  started_at?: number | null
  finished_at?: number | null
  request_json: string
  error?: string | null
}
type ActiveGenerationJob = {
  controller: AbortController
  cancelled: boolean
}
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

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

const LOG_LEVEL_VALUES: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const LOG_LEVEL = parseLogLevel(process.env.GIP_LOG_LEVEL)

function parseLogLevel(value: unknown): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value
  return 'info'
}

function truncateForLog(value: string, maxLength = 1000) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function serializeErrorForLog(err: unknown) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack ? truncateForLog(err.stack, 4000) : undefined,
    }
  }
  return { message: String(err) }
}

function logEvent(level: LogLevel, event: string, fields: JsonRecord = {}) {
  if (LOG_LEVEL_VALUES[level] < LOG_LEVEL_VALUES[LOG_LEVEL]) return
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  }
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

function logDebug(event: string, fields?: JsonRecord) {
  logEvent('debug', event, fields)
}

function logInfo(event: string, fields?: JsonRecord) {
  logEvent('info', event, fields)
}

function logWarn(event: string, fields?: JsonRecord) {
  logEvent('warn', event, fields)
}

function logError(event: string, fields?: JsonRecord) {
  logEvent('error', event, fields)
}

function summarizeProfile(profile: ApiProfile | undefined) {
  return {
    provider: profile?.provider || 'openai',
    profileId: profile?.id,
    profileName: profile?.name,
    apiMode: profile?.apiMode,
    model: profile?.model,
    hasApiKey: Boolean(profile?.apiKey),
  }
}

function providerUrlLogFields(url: string) {
  try {
    const parsed = new URL(url)
    return {
      providerHost: parsed.host,
      providerPath: parsed.pathname,
      hasQuery: Boolean(parsed.search),
    }
  } catch {
    return { providerUrl: truncateForLog(url, 500) }
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

    CREATE TABLE IF NOT EXISTS generation_jobs (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      request_json TEXT NOT NULL,
      error TEXT,
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

    CREATE TABLE IF NOT EXISTS deleted_generated_images (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      image_id TEXT NOT NULL,
      output_index INTEGER NOT NULL,
      mime TEXT NOT NULL,
      archived_file_path TEXT NOT NULL,
      original_file_path TEXT,
      task_json TEXT NOT NULL,
      image_metadata_json TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_generation_jobs_dispatch
      ON generation_jobs (status, queued_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_task
      ON generation_jobs (user_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_deleted_generated_images_deleted_at
      ON deleted_generated_images (deleted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deleted_generated_images_user
      ON deleted_generated_images (user_id, deleted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deleted_generated_images_image
      ON deleted_generated_images (user_id, image_id);
  `)

  const resetStamp = now()
  db.prepare(`
    UPDATE generation_jobs
    SET status = 'queued', started_at = NULL, error = NULL, updated_at = ?
    WHERE status = 'running'
  `).run(resetStamp)
  const resetTasks = db.prepare(`
    SELECT tasks.user_id, tasks.id, tasks.json
    FROM tasks
    WHERE EXISTS (
      SELECT 1
      FROM generation_jobs
      WHERE generation_jobs.user_id = tasks.user_id
        AND generation_jobs.task_id = tasks.id
        AND generation_jobs.status = 'queued'
    )
  `).all()
  const updateTask = db.prepare('UPDATE tasks SET json = ?, updated_at = ? WHERE user_id = ? AND id = ?')
  for (const row of resetTasks) {
    const task = parseJson<JsonRecord>(String(row.json), {})
    if (task.status !== 'running') continue
    updateTask.run(JSON.stringify({ ...task, status: 'queued', startedAt: undefined, error: null }), resetStamp, row.user_id, row.id)
  }
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
    logWarn('users_config_missing', { configPath })
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
    logWarn('users_config_empty', { configPath })
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
      logInfo('user_imported', { username })
      continue
    }

    if (!verifyPassword(password, existing.password_salt, existing.password_hash)) {
      const { salt, hash } = hashPassword(password)
      db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?')
        .run(hash, salt, stamp, existing.id)
      db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(stamp, existing.id)
      logInfo('user_password_updated', { username })
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

function getAdminApiKeyFromRequest(req: IncomingMessage) {
  const explicit = asString(req.headers['x-gip-admin-key'])
  if (explicit) return explicit
  const header = asString(req.headers.authorization)
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : ''
}

function requireAdmin(req: IncomingMessage) {
  if (!ADMIN_API_KEY) throw Object.assign(new Error('管理接口未启用：缺少 GIP_ADMIN_API_KEY'), { statusCode: 404 })
  const provided = getAdminApiKeyFromRequest(req)
  const actual = Buffer.from(provided)
  const expected = Buffer.from(ADMIN_API_KEY)
  if (!provided || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw Object.assign(new Error('管理密钥无效'), { statusCode: 401 })
  }
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
  if (statusCode >= 500) logError('request_unhandled_error', { statusCode, error: serializeErrorForLog(err) })
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

function getJsonRow<T = unknown>(table: string, userId: number, id: string): T | null {
  const row = db.prepare(`SELECT json FROM ${table} WHERE user_id = ? AND id = ?`).get(userId, id)
  return row ? parseJson<T>(String(row.json), null as T) : null
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

function ensureParentSync(path: string) {
  mkdirSync(dirname(path), { recursive: true })
}

function normalizeStoredImageSource(value: unknown): StoredImageSource {
  if (value === 'generated' || value === 'mask') return value
  return 'upload'
}

function imageFileScope(source: StoredImageSource) {
  if (source === 'generated') return 'outputs'
  if (source === 'mask') return 'masks'
  return 'inputs'
}

function sourceIdPrefix(source: StoredImageSource) {
  if (source === 'generated') return 'out'
  if (source === 'mask') return 'mask'
  return 'in'
}

function createStoredImageId(dataUrl: string, source: StoredImageSource) {
  const hash = createHash('sha256').update(dataUrl).digest('hex')
  return `${sourceIdPrefix(source)}_${hash}`
}

function storedFileSource(kind: 'images' | 'thumbnails', userId: number, id: string, record: JsonRecord): StoredImageSource {
  const explicit = record.source
  if (explicit === 'upload' || explicit === 'generated' || explicit === 'mask') return explicit
  if (kind === 'thumbnails') {
    const image = getStoredFileMetadata('images', userId, id)
    return normalizeStoredImageSource(image?.source)
  }
  return 'upload'
}

function userFilePath(userId: number, kind: 'images' | 'thumbnails', id: string, mime: string, source: StoredImageSource = 'upload') {
  const scope = imageFileScope(source)
  const fileName = `${safeSegment(id)}.${mimeToExt(mime)}`
  return kind === 'thumbnails'
    ? join('users', String(userId), 'thumbnails', scope, fileName)
    : join('users', String(userId), scope, fileName)
}

function deletedGeneratedImagePath(userId: number, taskId: string, outputIndex: number, imageId: string, mime: string) {
  const fileName = `${String(outputIndex).padStart(3, '0')}-${safeSegment(imageId)}.${mimeToExt(mime)}`
  return join('users', String(userId), 'deleted', 'outputs', safeSegment(taskId), fileName)
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
  const source = storedFileSource(kind, userId, id, record)
  const relativePath = userFilePath(userId, kind, id, mime, source)
  const absolute = absoluteDataPath(relativePath)
  await ensureParent(absolute)
  writeFileSync(absolute, bytes)

  const table = kind === 'images' ? 'images' : 'thumbnails'
  const previous = db.prepare(`SELECT file_path FROM ${table} WHERE user_id = ? AND id = ?`).get(userId, id)
  if (previous && previous.file_path !== relativePath) removeFileIfExists(previous.file_path)

  const metadata: JsonRecord = { ...record, id, source }
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

type StoredFileRow = {
  id: string
  mime: string
  file_path: string
  metadata_json: string
  created_at: number
  updated_at: number
}

function getStoredFileRow(kind: 'images' | 'thumbnails', userId: number, id: string): StoredFileRow | null {
  const table = kind === 'images' ? 'images' : 'thumbnails'
  const row = db.prepare(`SELECT id, mime, file_path, metadata_json, created_at, updated_at FROM ${table} WHERE user_id = ? AND id = ?`).get(userId, id)
  return row ? {
    id: String(row.id),
    mime: String(row.mime),
    file_path: String(row.file_path),
    metadata_json: String(row.metadata_json),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  } : null
}

async function readTaskImageDataUrl(userId: number, id: string) {
  const image = getStoredFile('images', userId, id)
  const dataUrl = isRecord(image) ? asString(image.dataUrl) : ''
  if (!dataUrl) throw Object.assign(new Error('输入图片已不存在'), { statusCode: 400 })
  return dataUrl
}

async function readTaskImageDataUrls(userId: number, ids: string[]) {
  const dataUrls: string[] = []
  for (const id of ids) dataUrls.push(await readTaskImageDataUrl(userId, id))
  return dataUrls
}

async function storeGeneratedImage(userId: number, dataUrl: string) {
  const source: StoredImageSource = 'generated'
  const id = createStoredImageId(dataUrl, source)
  const existing = getStoredFile('images', userId, id)
  const { mime } = dataUrlToBuffer(dataUrl)
  const filePath = userFilePath(userId, 'images', id, mime, source)
  if (!existing) {
    await putStoredFile('images', userId, id, {
      id,
      dataUrl,
      createdAt: now(),
      source,
    }, 'dataUrl')
  }
  logDebug('generated_image_stored', {
    userId,
    imageId: id,
    filePath,
    isNew: !existing,
  })
  return { id, filePath }
}

function getStoredFileMetadata(kind: 'images' | 'thumbnails', userId: number, id: string) {
  const table = kind === 'images' ? 'images' : 'thumbnails'
  const row = db.prepare(`SELECT metadata_json FROM ${table} WHERE user_id = ? AND id = ?`).get(userId, id)
  return row ? parseJson<JsonRecord>(String(row.metadata_json), {}) : null
}

function updateStoredFileMetadata(kind: 'images' | 'thumbnails', userId: number, id: string, patch: JsonRecord) {
  const table = kind === 'images' ? 'images' : 'thumbnails'
  const metadata = getStoredFileMetadata(kind, userId, id)
  if (!metadata) return false
  db.prepare(`UPDATE ${table} SET metadata_json = ?, updated_at = ? WHERE user_id = ? AND id = ?`)
    .run(JSON.stringify({ ...metadata, ...patch, id }), now(), userId, id)
  return true
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

function dataUrlFromStoredRow(row: Pick<StoredFileRow, 'mime' | 'file_path'>) {
  const absolute = absoluteDataPath(row.file_path)
  if (!absolute.startsWith(dataDir)) throw Object.assign(new Error('非法文件路径'), { statusCode: 500 })
  const bytes = readFileSync(absolute)
  return `data:${row.mime};base64,${bytes.toString('base64')}`
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

function getCustomProviderDefinition(settings: unknown, provider: string | undefined): CustomProviderDefinition | null {
  if (!provider || provider === 'openai' || provider === 'fal' || !isRecord(settings)) return null
  const providers = Array.isArray(settings.customProviders) ? settings.customProviders.filter(isRecord) : []
  const found = providers.find((item) => asString(item.id) === provider)
  return found ? found as CustomProviderDefinition : null
}

function buildProviderUrl(profile: ApiProfile, path: string) {
  const fallbackBase = profile.provider === 'fal' ? DEFAULT_FAL_BASE_URL : DEFAULT_OPENAI_BASE_URL
  const base = (asString(profile.baseUrl).trim().replace(/\/+$/, '') || fallbackBase)
  const cleanPath = path.replace(/^\/+/, '')
  const url = new URL(`${base}/${cleanPath}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Object.assign(new Error('仅支持 HTTP/HTTPS API URL'), { statusCode: 400 })
  return url.toString()
}

const UPSTREAM_USER_AGENT = 'codex_exec/0.134.0 (Debian 12.0.0; x86_64) unknown (codex_exec; 0.134.0)'

function providerHeaders(profile: ApiProfile, contentType?: string) {
  const headers: Record<string, string> = {
    'User-Agent': UPSTREAM_USER_AGENT,
  }
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
  const response = await fetch(url, { cache: 'no-store', headers: { 'User-Agent': UPSTREAM_USER_AGENT } })
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

function taskParams(value: unknown): TaskParams {
  const record = isRecord(value) ? value : {}
  return {
    size: asString(record.size, 'auto'),
    quality: record.quality === 'low' || record.quality === 'medium' || record.quality === 'high' ? record.quality : 'auto',
    output_format: record.output_format === 'jpeg' || record.output_format === 'webp' ? record.output_format : 'png',
    output_compression: typeof record.output_compression === 'number' ? record.output_compression : null,
    moderation: record.moderation === 'low' ? 'low' : 'auto',
    n: Math.max(1, Math.trunc(asNumber(record.n, 1))),
  }
}

function mimeForParams(params: TaskParams) {
  return params.output_format === 'jpeg' ? 'image/jpeg' : `image/${params.output_format || 'png'}`
}

function normalizeBase64DataUrl(value: string, fallbackMime: string) {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function getByPath(source: unknown, path: string | undefined): unknown {
  if (!path) return source
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (current == null) return undefined
    if (/^\d+$/.test(key) && Array.isArray(current)) return current[Number(key)]
    if (typeof current === 'object') return (current as Record<string, unknown>)[key]
    return undefined
  }, source)
}

function getAllByPath(source: unknown, path: string | undefined): unknown[] {
  if (!path) return [source]
  const parts = path.split('.').filter(Boolean)
  let current: unknown[] = [source]

  for (const key of parts) {
    const next: unknown[] = []
    for (const item of current) {
      if (item == null) continue
      if (key === '*') {
        if (Array.isArray(item)) next.push(...item)
        else if (typeof item === 'object') next.push(...Object.values(item as Record<string, unknown>))
        continue
      }
      if (/^\d+$/.test(key) && Array.isArray(item)) {
        next.push(item[Number(key)])
        continue
      }
      if (typeof item === 'object') next.push((item as Record<string, unknown>)[key])
    }
    current = next
  }

  return current.flatMap((item) => Array.isArray(item) ? item : [item]).filter((item) => item != null)
}

function appendQuery(path: string, query?: Record<string, string>) {
  if (!query || !Object.keys(query).length) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) params.set(key, value)
  return `${path}${path.includes('?') ? '&' : '?'}${params.toString()}`
}

function resolveTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) return getByPath(context, value.slice(1))
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, context)).filter((item) => item !== undefined && item !== null)
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, resolveTemplateValue(item, context)] as const)
      .filter(([, item]) => item !== undefined && item !== null && (!Array.isArray(item) || item.length > 0))
    return Object.fromEntries(entries)
  }
  return value
}

function renderQuery(query: Record<string, string> | undefined, context: Record<string, unknown>): Record<string, string> | undefined {
  if (!query) return undefined
  const entries = Object.entries(query)
    .map(([key, value]) => [key, resolveTemplateValue(value, context)] as const)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => [key, String(value)] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function buildTaskPath(path: string, taskId: string) {
  return path
    .replace(/\{task_id\}/g, encodeURIComponent(taskId))
    .replace(/\{taskId\}/g, encodeURIComponent(taskId))
}

function firstActualParams(list: Array<Partial<TaskParams> | undefined> | undefined) {
  return list?.find((item) => item && Object.keys(item).length) ?? undefined
}

function mapActualParamsByImage(outputIds: string[], actualParamsList: Array<Partial<TaskParams> | undefined> | undefined) {
  const entries = outputIds
    .map((id, index) => [id, actualParamsList?.[index]] as const)
    .filter((entry): entry is readonly [string, Partial<TaskParams>] => Boolean(entry[1] && Object.keys(entry[1]).length))
  return entries.length ? Object.fromEntries(entries) : undefined
}

function pickActualParams(source: unknown): Partial<TaskParams> {
  if (!isRecord(source)) return {}
  const actual: Partial<TaskParams> = {}
  if (typeof source.size === 'string') actual.size = source.size
  if (source.quality === 'auto' || source.quality === 'low' || source.quality === 'medium' || source.quality === 'high') actual.quality = source.quality
  if (source.output_format === 'png' || source.output_format === 'jpeg' || source.output_format === 'webp') actual.output_format = source.output_format
  if (typeof source.output_compression === 'number') actual.output_compression = source.output_compression
  if (source.moderation === 'auto' || source.moderation === 'low') actual.moderation = source.moderation
  if (typeof source.n === 'number') actual.n = source.n
  return actual
}

function mergeActualParams(...sources: Array<Partial<TaskParams> | undefined>): Partial<TaskParams> | undefined {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}

function genId(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${randomBytes(5).toString('hex')}`
}

function normalizeTaskForQueue(task: JsonRecord, stamp = now()): TaskRecord {
  const params = taskParams(task.params)
  return {
    ...task,
    id: asString(task.id) || genId('task_'),
    prompt: asString(task.prompt),
    params,
    inputImageIds: Array.isArray(task.inputImageIds) ? task.inputImageIds.filter((id): id is string => typeof id === 'string') : [],
    maskImageId: typeof task.maskImageId === 'string' ? task.maskImageId : null,
    outputImages: Array.isArray(task.outputImages) ? task.outputImages.filter((id): id is string => typeof id === 'string') : [],
    status: 'queued',
    error: null,
    createdAt: asNumber(task.createdAt, stamp),
    queuedAt: asNumber(task.queuedAt, stamp),
    startedAt: undefined,
    finishedAt: null,
    elapsed: null,
  }
}

function insertGenerationJob(userId: number, taskId: string, request: GenerationRequest, queuedAt: number, jobId = genId('job_')) {
  db.prepare(`
    INSERT INTO generation_jobs (user_id, id, task_id, status, queued_at, request_json, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
  `).run(userId, jobId, taskId, queuedAt, JSON.stringify(request), queuedAt, queuedAt)
  logInfo('generation_job_enqueued', {
    userId,
    taskId,
    jobId,
    queuedAt,
    profile: summarizeProfile(request.profile),
    inputImageCount: request.inputImageIds?.length ?? 0,
    hasMask: Boolean(request.maskImageId),
    requestedImages: taskParams(request.params).n,
  })
  return jobId
}

function enqueueGenerationTask(userId: number, task: JsonRecord, request: GenerationRequest) {
  const stamp = now()
  const queuedTask = normalizeTaskForQueue(task, stamp)
  putJsonRow('tasks', userId, queuedTask.id, queuedTask, queuedTask.createdAt, stamp)
  insertGenerationJob(userId, queuedTask.id, request, queuedTask.queuedAt ?? stamp)
  scheduleGenerationWorker()
  return withQueuePosition(userId, queuedTask)
}

function getQueuePosition(userId: number, taskId: string) {
  const row = db.prepare(`
    SELECT id, task_id FROM generation_jobs
    WHERE user_id = ? AND status = 'queued'
    ORDER BY queued_at ASC, created_at ASC
  `).all(userId)
  const index = row.findIndex((item) => String(item.id) === taskId || String(item.task_id) === taskId)
  return index >= 0 ? index + 1 : undefined
}

function withQueuePosition(userId: number, task: TaskRecord): TaskRecord {
  if (task.status !== 'queued') return task
  return { ...task, queuePosition: getQueuePosition(userId, task.id) }
}

function parseTaskCursor(cursor: string | null) {
  if (!cursor) return null
  const decoded = parseJson<JsonRecord>(Buffer.from(cursor, 'base64url').toString('utf8'), {})
  const createdAt = asNumber(decoded.createdAt)
  const id = asString(decoded.id)
  return createdAt && id ? { createdAt, id } : null
}

function encodeTaskCursor(task: TaskRecord) {
  return Buffer.from(JSON.stringify({ createdAt: task.createdAt, id: task.id })).toString('base64url')
}

function listTasksPage(userId: number, url: URL) {
  const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50))
  const q = (url.searchParams.get('q') || '').trim().toLowerCase()
  const status = url.searchParams.get('status') || 'all'
  const favorite = url.searchParams.get('favorite') === 'true'
  const cursor = parseTaskCursor(url.searchParams.get('cursor'))

  const rows = db.prepare('SELECT id, json, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(userId)
  const filtered: TaskRecord[] = []
  let passedCursor = cursor == null
  for (const row of rows) {
    const task = parseJson<TaskRecord>(String(row.json), null as any)
    if (!task) continue
    const createdAt = asNumber(task.createdAt, Number(row.created_at))
    if (!passedCursor) {
      if (createdAt < cursor!.createdAt || (createdAt === cursor!.createdAt && task.id < cursor!.id)) passedCursor = true
      else continue
    }
    if (status !== 'all' && task.status !== status) continue
    if (favorite && !task.isFavorite) continue
    if (q) {
      const haystack = `${task.prompt || ''}\n${JSON.stringify(task.params ?? {})}`.toLowerCase()
      if (!haystack.includes(q)) continue
    }
    filtered.push(withQueuePosition(userId, task))
    if (filtered.length > limit) break
  }

  const items = filtered.slice(0, limit)
  const nextCursor = filtered.length > limit ? encodeTaskCursor(items[items.length - 1]) : undefined
  return { items, ...(nextCursor ? { nextCursor } : {}) }
}

function listIncompleteTasks(userId: number) {
  return db.prepare('SELECT json FROM tasks WHERE user_id = ? ORDER BY created_at DESC').all(userId)
    .map((row) => parseJson<TaskRecord>(String(row.json), null as any))
    .filter((task): task is TaskRecord => Boolean(task && (task.status === 'queued' || task.status === 'running')))
    .map((task) => withQueuePosition(userId, task))
}

function listBatchTasks(userId: number, batchGroupId: string) {
  return db.prepare('SELECT json FROM tasks WHERE user_id = ? ORDER BY created_at DESC').all(userId)
    .map((row) => parseJson<TaskRecord>(String(row.json), null as any))
    .filter((task): task is TaskRecord => Boolean(task && task.batchGroupId === batchGroupId && task.batchKind === 'gallery-image-to-image'))
    .map((task) => withQueuePosition(userId, task))
    .sort((a, b) => {
      const aIndex = typeof a.batchIndex === 'number' ? a.batchIndex : Number.MAX_SAFE_INTEGER
      const bIndex = typeof b.batchIndex === 'number' ? b.batchIndex : Number.MAX_SAFE_INTEGER
      return aIndex - bIndex || a.createdAt - b.createdAt
    })
}

function getActiveTasksForUser(userId: number) {
  return db.prepare('SELECT json FROM tasks WHERE user_id = ? ORDER BY created_at DESC').all(userId)
    .map((row) => parseJson<TaskRecord>(String(row.json), null as any))
    .filter((task): task is TaskRecord => Boolean(task))
}

function getAllActiveTasks() {
  return db.prepare(`
    SELECT tasks.user_id, users.username, tasks.json
    FROM tasks
    JOIN users ON users.id = tasks.user_id
    ORDER BY tasks.created_at DESC, tasks.id DESC
  `).all()
    .map((row) => ({
      userId: Number(row.user_id),
      username: String(row.username),
      task: parseJson<TaskRecord>(String(row.json), null as any),
    }))
    .filter((item): item is { userId: number; username: string; task: TaskRecord } => Boolean(item.task))
}

function imageIdsFromTask(task: TaskRecord, field: 'outputImages' | 'inputImageIds' | 'streamPartialImageIds') {
  const value = task[field]
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
}

function remainingTaskUsesImage(tasks: TaskRecord[], imageId: string) {
  return tasks.some((task) => imageIdsFromTask(task, 'outputImages').includes(imageId))
}

function archiveDeletedTaskOutputs(userId: number, task: TaskRecord, remainingTasks: TaskRecord[], options: { deleteUnreferencedOriginals?: boolean } = {}) {
  const outputImages = imageIdsFromTask(task, 'outputImages')
  if (!outputImages.length) return 0
  const deleteUnreferencedOriginals = options.deleteUnreferencedOriginals !== false
  const deletedAt = now()
  let archivedCount = 0
  for (const [index, imageId] of outputImages.entries()) {
    const imageRow = getStoredFileRow('images', userId, imageId)
    if (!imageRow) continue
    const archiveId = `${userId}:${safeSegment(task.id)}:${index}:${safeSegment(imageId)}`
    const archivePath = deletedGeneratedImagePath(userId, task.id, index, imageId, imageRow.mime)
    const sourcePath = absoluteDataPath(imageRow.file_path)
    const targetPath = absoluteDataPath(archivePath)
    try {
      ensureParentSync(targetPath)
      copyFileSync(sourcePath, targetPath)
    } catch (err) {
      logWarn('task_output_archive_failed', {
        userId,
        taskId: task.id,
        imageId,
        error: serializeErrorForLog(err),
      })
      continue
    }
    db.prepare(`
      INSERT INTO deleted_generated_images (
        id, user_id, task_id, image_id, output_index, mime,
        archived_file_path, original_file_path, task_json, image_metadata_json,
        deleted_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        mime = excluded.mime,
        archived_file_path = excluded.archived_file_path,
        original_file_path = excluded.original_file_path,
        task_json = excluded.task_json,
        image_metadata_json = excluded.image_metadata_json,
        deleted_at = excluded.deleted_at,
        updated_at = excluded.updated_at
    `).run(
      archiveId,
      userId,
      task.id,
      imageId,
      index,
      imageRow.mime,
      archivePath,
      imageRow.file_path,
      JSON.stringify(task),
      imageRow.metadata_json,
      deletedAt,
      imageRow.created_at || deletedAt,
      deletedAt,
    )
    if (deleteUnreferencedOriginals && !remainingTaskUsesImage(remainingTasks, imageId)) {
      removeFileIfExists(imageRow.file_path)
      db.prepare('DELETE FROM images WHERE user_id = ? AND id = ?').run(userId, imageId)
    }
    archivedCount += 1
  }
  logInfo('task_outputs_archived', {
    userId,
    taskId: task.id,
    outputCount: outputImages.length,
    archivedCount,
  })
  return archivedCount
}

function deleteTaskRecord(userId: number, taskId: string) {
  const task = getJsonRow<TaskRecord>('tasks', userId, taskId)
  if (!task) return { task: null, archivedCount: 0 }
  const remainingTasks = getActiveTasksForUser(userId).filter((item) => item.id !== taskId)
  const archivedCount = archiveDeletedTaskOutputs(userId, task, remainingTasks)
  deleteJsonRow('tasks', userId, taskId)
  return { task, archivedCount }
}

function deleteAllTaskRecordsForUser(userId: number) {
  const tasks = getActiveTasksForUser(userId)
  let archivedCount = 0
  const outputImageIds = new Set<string>()
  for (const task of tasks) {
    for (const imageId of imageIdsFromTask(task, 'outputImages')) outputImageIds.add(imageId)
    archivedCount += archiveDeletedTaskOutputs(userId, task, [], { deleteUnreferencedOriginals: false })
  }
  for (const imageId of outputImageIds) deleteStoredFile('images', userId, imageId)
  clearJsonRows('tasks', userId)
  return { taskCount: tasks.length, archivedCount }
}

type GeneratedImageAdminItem = {
  id: string
  source: 'active' | 'deleted'
  userId: number
  username: string
  taskId: string
  imageId: string
  outputIndex: number
  status: TaskStatus
  prompt: string
  params: TaskParams
  inputImageIds: string[]
  outputImages: string[]
  imageMetadata: JsonRecord
  thumbnailDataUrl?: string
  referenceThumbnails: Array<{ imageId: string; thumbnailDataUrl?: string }>
  imageUrl: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
  task: TaskRecord
}

function buildAdminImageUrl(item: { source: 'active' | 'deleted'; userId: number; imageId: string; id?: string }) {
  const params = new URLSearchParams({ source: item.source })
  if (item.id) params.set('archiveId', item.id)
  return `/api/admin/generated-images/${item.userId}/${encodeURIComponent(item.imageId)}?${params.toString()}`
}

function getThumbnailDataUrl(userId: number, imageId: string) {
  const row = getStoredFileRow('thumbnails', userId, imageId)
  if (!row) return undefined
  try {
    return dataUrlFromStoredRow(row)
  } catch {
    return undefined
  }
}

function referenceThumbnailsForTask(userId: number, task: TaskRecord) {
  return imageIdsFromTask(task, 'inputImageIds').map((imageId) => ({
    imageId,
    thumbnailDataUrl: getThumbnailDataUrl(userId, imageId),
  }))
}

function taskImageAdminItem(
  userId: number,
  username: string,
  task: TaskRecord,
  imageId: string,
  outputIndex: number,
  imageRow: StoredFileRow,
): GeneratedImageAdminItem {
  const updatedAt = imageRow?.updated_at || asNumber(task.finishedAt) || asNumber(task.createdAt)
  return {
    id: `${userId}:${task.id}:${outputIndex}:${imageId}`,
    source: 'active',
    userId,
    username,
    taskId: task.id,
    imageId,
    outputIndex,
    status: task.status,
    prompt: task.prompt,
    params: task.params,
    inputImageIds: imageIdsFromTask(task, 'inputImageIds'),
    outputImages: imageIdsFromTask(task, 'outputImages'),
    imageMetadata: parseJson<JsonRecord>(imageRow.metadata_json, {}),
    thumbnailDataUrl: getThumbnailDataUrl(userId, imageId),
    referenceThumbnails: referenceThumbnailsForTask(userId, task),
    imageUrl: buildAdminImageUrl({ source: 'active', userId, imageId }),
    createdAt: asNumber(task.createdAt, imageRow?.created_at || now()),
    updatedAt,
    task,
  }
}

function listActiveGeneratedImageAdminItems() {
  const items: GeneratedImageAdminItem[] = []
  for (const { userId, username, task } of getAllActiveTasks()) {
    imageIdsFromTask(task, 'outputImages').forEach((imageId, outputIndex) => {
      const imageRow = getStoredFileRow('images', userId, imageId)
      if (imageRow) items.push(taskImageAdminItem(userId, username, task, imageId, outputIndex, imageRow))
    })
  }
  return items
}

function listDeletedGeneratedImageAdminItems() {
  return db.prepare(`
    SELECT deleted_generated_images.*, users.username
    FROM deleted_generated_images
    JOIN users ON users.id = deleted_generated_images.user_id
    ORDER BY deleted_generated_images.deleted_at DESC, deleted_generated_images.id DESC
  `).all().map((row) => {
    const task = parseJson<TaskRecord>(String(row.task_json), null as any)
    const userId = Number(row.user_id)
    const imageId = String(row.image_id)
    const outputIndex = Number(row.output_index)
    const deletedAt = Number(row.deleted_at)
    const createdAt = Number(row.created_at)
    const imageMetadata = parseJson<JsonRecord>(String(row.image_metadata_json), {})
    const item: GeneratedImageAdminItem = {
      id: String(row.id),
      source: 'deleted',
      userId,
      username: String(row.username),
      taskId: String(row.task_id),
      imageId,
      outputIndex,
      status: task?.status ?? 'done',
      prompt: task?.prompt ?? '',
      params: task?.params ?? taskParams({}),
      inputImageIds: task ? imageIdsFromTask(task, 'inputImageIds') : [],
      outputImages: task ? imageIdsFromTask(task, 'outputImages') : [imageId],
      imageMetadata,
      thumbnailDataUrl: getThumbnailDataUrl(userId, imageId),
      referenceThumbnails: task ? referenceThumbnailsForTask(userId, task) : [],
      imageUrl: buildAdminImageUrl({ source: 'deleted', userId, imageId, id: String(row.id) }),
      createdAt,
      updatedAt: Number(row.updated_at) || deletedAt,
      deletedAt,
      task: task ?? {
        id: String(row.task_id),
        prompt: '',
        params: taskParams({}),
        inputImageIds: [],
        outputImages: [imageId],
        status: 'done',
        error: null,
        createdAt,
        finishedAt: deletedAt,
        elapsed: null,
      },
    }
    return item
  })
}

function parseAdminCursor(value: string | null) {
  if (!value) return 0
  const numberValue = Number.parseInt(value, 10)
  if (Number.isFinite(numberValue)) return Math.max(0, numberValue)
  try {
    const decoded = parseJson<JsonRecord>(Buffer.from(value, 'base64url').toString('utf8'), {})
    return Math.max(0, asNumber(decoded.offset))
  } catch {
    return 0
  }
}

function encodeAdminCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url')
}

function listAdminGeneratedImages(url: URL) {
  const limit = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50))
  const offset = parseAdminCursor(url.searchParams.get('cursor'))
  const includeActive = url.searchParams.get('includeActive') !== 'false'
  const includeDeleted = url.searchParams.get('includeDeleted') !== 'false'
  const items = [
    ...(includeActive ? listActiveGeneratedImageAdminItems() : []),
    ...(includeDeleted ? listDeletedGeneratedImageAdminItems() : []),
  ].sort((a, b) => {
    const bTime = b.deletedAt ?? b.updatedAt ?? b.createdAt
    const aTime = a.deletedAt ?? a.updatedAt ?? a.createdAt
    return bTime - aTime || b.id.localeCompare(a.id)
  })
  const page = items.slice(offset, offset + limit)
  return {
    items: page,
    nextCursor: offset + limit < items.length ? encodeAdminCursor(offset + limit) : undefined,
  }
}

function sendStoredImageBytes(res: ServerResponse, row: Pick<StoredFileRow, 'mime' | 'file_path'>) {
  const absolute = absoluteDataPath(row.file_path)
  if (!absolute.startsWith(dataDir)) throw Object.assign(new Error('非法文件路径'), { statusCode: 500 })
  const bytes = readFileSync(absolute)
  res.writeHead(200, {
    'Content-Type': row.mime,
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
  })
  res.end(bytes)
}

function sendAdminGeneratedImage(req: IncomingMessage, res: ServerResponse, url: URL, userId: number, imageId: string) {
  assertMethod(req, 'GET')
  const source = url.searchParams.get('source') === 'deleted' ? 'deleted' : 'active'
  if (source === 'active') {
    const row = getStoredFileRow('images', userId, imageId)
    if (!row) throw Object.assign(new Error('图片不存在'), { statusCode: 404 })
    return sendStoredImageBytes(res, row)
  }
  const archiveId = url.searchParams.get('archiveId')
  const row = archiveId
    ? db.prepare('SELECT mime, archived_file_path FROM deleted_generated_images WHERE user_id = ? AND id = ?').get(userId, archiveId)
    : db.prepare('SELECT mime, archived_file_path FROM deleted_generated_images WHERE user_id = ? AND image_id = ? ORDER BY deleted_at DESC LIMIT 1').get(userId, imageId)
  if (!row) throw Object.assign(new Error('归档图片不存在'), { statusCode: 404 })
  return sendStoredImageBytes(res, { mime: String(row.mime), file_path: String(row.archived_file_path) })
}

async function handleAdminApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  requireAdmin(req)
  const pathname = url.pathname
  if (pathname === '/api/admin/generated-images') {
    assertMethod(req, 'GET')
    logInfo('admin_generated_images_list_requested', {
      limit: url.searchParams.get('limit') || undefined,
      cursor: url.searchParams.get('cursor') || undefined,
    })
    return sendJson(res, 200, listAdminGeneratedImages(url))
  }
  if (pathname.startsWith('/api/admin/generated-images/')) {
    const rest = pathname.slice('/api/admin/generated-images/'.length)
    const [userIdText, imageIdText] = rest.split('/')
    const userId = Number.parseInt(userIdText || '', 10)
    const imageId = decodeURIComponent(imageIdText || '')
    if (!userId || !imageId || imageId.includes('/')) throw Object.assign(new Error('Not Found'), { statusCode: 404 })
    return sendAdminGeneratedImage(req, res, url, userId, imageId)
  }
  throw Object.assign(new Error('Not Found'), { statusCode: 404 })
}

function patchTask(userId: number, taskId: string, patch: JsonRecord) {
  const task = getJsonRow<TaskRecord>('tasks', userId, taskId)
  if (!task) return null
  const next = { ...task, ...patch }
  putJsonRow('tasks', userId, taskId, next, asNumber(next.createdAt), now())
  return next as TaskRecord
}

let activeGenerationJobs = 0
let generationWorkerScheduled = false
const activeGenerationJobRegistry = new Map<string, ActiveGenerationJob>()

function generationJobKey(userId: number, jobId: string) {
  return `${userId}:${jobId}`
}

function getActiveGenerationJob(userId: number, jobId: string) {
  return activeGenerationJobRegistry.get(generationJobKey(userId, jobId))
}

function assertGenerationJobActive(userId: number, jobId: string) {
  const active = getActiveGenerationJob(userId, jobId)
  if (active?.cancelled || active?.controller.signal.aborted) {
    throw new DOMException('任务已取消', 'AbortError')
  }
  return active
}

function cancelGenerationJobsForTask(userId: number, taskId: string) {
  const rows = db.prepare(`
    SELECT id FROM generation_jobs
    WHERE user_id = ? AND task_id = ? AND status IN ('queued', 'running')
  `).all(userId, taskId) as Array<{ id: string }>
  for (const row of rows) {
    const active = getActiveGenerationJob(userId, String(row.id))
    if (active) {
      active.cancelled = true
      active.controller.abort()
    }
  }
  db.prepare(`
    UPDATE generation_jobs
    SET status = 'error', error = '任务已取消', finished_at = ?, updated_at = ?
    WHERE user_id = ? AND task_id = ? AND status IN ('queued', 'running')
  `).run(now(), now(), userId, taskId)
  if (rows.length) logInfo('generation_jobs_cancelled_for_task', { userId, taskId, jobCount: rows.length })
}

function cancelAllGenerationJobsForUser(userId: number) {
  const rows = db.prepare(`
    SELECT id FROM generation_jobs
    WHERE user_id = ? AND status IN ('queued', 'running')
  `).all(userId) as Array<{ id: string }>
  for (const row of rows) {
    const active = getActiveGenerationJob(userId, String(row.id))
    if (active) {
      active.cancelled = true
      active.controller.abort()
    }
  }
  db.prepare(`
    UPDATE generation_jobs
    SET status = 'error', error = '任务已取消', finished_at = ?, updated_at = ?
    WHERE user_id = ? AND status IN ('queued', 'running')
  `).run(now(), now(), userId)
  if (rows.length) logInfo('generation_jobs_cancelled_for_user', { userId, jobCount: rows.length })
}

function scheduleGenerationWorker() {
  if (generationWorkerScheduled) return
  generationWorkerScheduled = true
  setTimeout(() => {
    generationWorkerScheduled = false
    void runGenerationWorker()
  }, 0)
}

async function runGenerationWorker() {
  while (activeGenerationJobs < GENERATION_CONCURRENCY) {
    const row = db.prepare(`
      SELECT id, user_id, task_id, status, queued_at, started_at, finished_at, request_json, error
      FROM generation_jobs
      WHERE status = 'queued'
      ORDER BY queued_at ASC, created_at ASC
      LIMIT 1
    `).get() as GenerationJobRow | undefined
    if (!row) return
    activeGenerationJobs += 1
    void executeGenerationJob(row).finally(() => {
      activeGenerationJobs -= 1
      scheduleGenerationWorker()
    })
  }
}

async function executeGenerationJob(job: GenerationJobRow) {
  const startedAt = now()
  const activeJob: ActiveGenerationJob = { controller: new AbortController(), cancelled: false }
  activeGenerationJobRegistry.set(generationJobKey(job.user_id, job.id), activeJob)
  const updated = db.prepare(`
    UPDATE generation_jobs
    SET status = 'running', started_at = ?, error = NULL, updated_at = ?
    WHERE user_id = ? AND id = ? AND status = 'queued'
  `).run(startedAt, startedAt, job.user_id, job.id)
  if (updated.changes === 0) {
    activeGenerationJobRegistry.delete(generationJobKey(job.user_id, job.id))
    return
  }
  patchTask(job.user_id, job.task_id, { status: 'running', startedAt, error: null })
  logInfo('generation_job_started', {
    userId: job.user_id,
    taskId: job.task_id,
    jobId: job.id,
    activeGenerationJobs,
  })

  try {
    assertGenerationJobActive(job.user_id, job.id)
    const request = parseJson<GenerationRequest>(job.request_json, {} as GenerationRequest)
    logDebug('generation_job_request_loaded', {
      userId: job.user_id,
      taskId: job.task_id,
      jobId: job.id,
      profile: summarizeProfile(request.profile),
      inputImageCount: request.inputImageIds?.length ?? 0,
      hasMask: Boolean(request.maskImageId),
      requestedImages: taskParams(request.params).n,
    })
    const result = await executeGenerationRequest(job.user_id, request, activeJob.controller.signal)
    assertGenerationJobActive(job.user_id, job.id)
    logInfo('generation_job_provider_result', {
      userId: job.user_id,
      taskId: job.task_id,
      jobId: job.id,
      imageCount: result.images.length,
      rawImageUrlCount: result.rawImageUrls?.length ?? 0,
      hasRawResponsePayload: Boolean(result.rawResponsePayload),
    })
    if (!result.images.length) {
      const error = result.rawResponsePayload
        ? '接口未返回可识别的图片数据，请查看原始响应内容确认服务商实际返回的数据结构。'
        : '接口未返回图片数据'
      throw Object.assign(new Error(error), { rawResponsePayload: result.rawResponsePayload })
    }

    const outputIds: string[] = []
    const outputFilePaths: string[] = []
    for (const image of result.images) {
      assertGenerationJobActive(job.user_id, job.id)
      const stored = await storeGeneratedImage(job.user_id, image)
      outputIds.push(stored.id)
      outputFilePaths.push(stored.filePath)
    }
    assertGenerationJobActive(job.user_id, job.id)
    const finishedAt = now()
    const actualParamsList = result.actualParamsList?.length ? result.actualParamsList : outputIds.map(() => result.actualParams)
    const revisedPromptByImage = result.revisedPrompts?.reduce<Record<string, string>>((acc, prompt, index) => {
      const imageId = outputIds[index]
      if (imageId && prompt?.trim()) acc[imageId] = prompt
      return acc
    }, {})
    patchTask(job.user_id, job.task_id, {
      outputImages: outputIds,
      rawImageUrls: result.rawImageUrls?.length ? result.rawImageUrls : undefined,
      rawResponsePayload: result.rawResponsePayload,
      actualParams: mergeActualParams(result.actualParams, { n: outputIds.length }),
      actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
      revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length ? revisedPromptByImage : undefined,
      status: 'done',
      error: null,
      finishedAt,
      elapsed: Math.max(0, finishedAt - startedAt),
    })
    db.prepare(`
      UPDATE generation_jobs
      SET status = 'done', finished_at = ?, error = NULL, updated_at = ?
      WHERE user_id = ? AND id = ?
    `).run(finishedAt, finishedAt, job.user_id, job.id)
    logInfo('generation_job_completed', {
      userId: job.user_id,
      taskId: job.task_id,
      jobId: job.id,
      outputImageCount: outputIds.length,
      outputImageIds: outputIds,
      outputFilePaths,
      rawImageUrlCount: result.rawImageUrls?.length ?? 0,
      elapsedMs: Math.max(0, finishedAt - startedAt),
    })
  } catch (err) {
    const finishedAt = now()
    const isCancelled = activeJob.cancelled || (err instanceof DOMException && err.name === 'AbortError')
    const message = isCancelled ? '任务已取消' : err instanceof Error ? err.message : String(err)
    const rawResponsePayload = isRecord(err) && typeof err.rawResponsePayload === 'string' ? err.rawResponsePayload : undefined
    if (!isCancelled || getJsonRow<TaskRecord>('tasks', job.user_id, job.task_id)) {
      patchTask(job.user_id, job.task_id, {
        status: 'error',
        error: message,
        rawResponsePayload,
        finishedAt,
        elapsed: Math.max(0, finishedAt - startedAt),
      })
    }
    db.prepare(`
      UPDATE generation_jobs
      SET status = 'error', finished_at = ?, error = ?, updated_at = ?
      WHERE user_id = ? AND id = ?
    `).run(finishedAt, message, finishedAt, job.user_id, job.id)
    const fields = {
      userId: job.user_id,
      taskId: job.task_id,
      jobId: job.id,
      cancelled: isCancelled,
      elapsedMs: Math.max(0, finishedAt - startedAt),
      message,
      error: serializeErrorForLog(err),
    }
    if (isCancelled) logInfo('generation_job_cancelled', fields)
    else logError('generation_job_failed', fields)
  } finally {
    activeGenerationJobRegistry.delete(generationJobKey(job.user_id, job.id))
  }
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

async function executeFalImageApi(userId: number, request: GenerationRequest, signal?: AbortSignal): Promise<CallApiResult> {
  const profile = resolveProfileForUser(userId, request.profile)
  configureFal(profile)
  const body: JsonRecord = {
    profile,
    prompt: request.prompt,
    params: request.params,
    inputImageDataUrls: await readTaskImageDataUrls(userId, request.inputImageIds ?? []),
    maskDataUrl: request.maskImageId ? await readTaskImageDataUrl(userId, request.maskImageId) : undefined,
  }
  const { input, endpoint, params } = createFalInput(body)
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
  const startedAt = now()
  logInfo('fal_request_started', {
    userId,
    endpoint,
    profile: summarizeProfile(profile),
    inputImageCount: Array.isArray(body.inputImageDataUrls) ? body.inputImageDataUrls.length : 0,
    requestedImages: taskParams(request.params).n,
  })
  const result = await (fal as any).subscribe(endpoint, { input, logs: true })
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
  const parsed = await parseFalResult(result.data as JsonRecord, params)
  logInfo('fal_request_completed', {
    userId,
    endpoint,
    profile: summarizeProfile(profile),
    imageCount: parsed.images.length,
    rawImageUrlCount: parsed.rawImageUrls?.length ?? 0,
    elapsedMs: now() - startedAt,
  })
  return parsed
}

function normalizeImageApiPayload(value: unknown): JsonRecord {
  if (Array.isArray(value)) return { data: value }
  return isRecord(value) ? value : { data: [] }
}

async function parseImagesApiResult(payload: unknown, params: TaskParams): Promise<CallApiResult> {
  const normalized = normalizeImageApiPayload(payload)
  const data = Array.isArray(normalized.data) ? normalized.data : []
  if (!data.length) {
    return { images: [], rawResponsePayload: JSON.stringify(normalized, null, 2) }
  }

  const mime = mimeForParams(params)
  const images: string[] = []
  const rawImageUrls: string[] = []
  const revisedPrompts: Array<string | undefined> = []
  for (const item of data) {
    if (!isRecord(item)) continue
    if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
      images.push(normalizeBase64DataUrl(item.b64_json, mime))
      revisedPrompts.push(asString(item.revised_prompt) || undefined)
      continue
    }
    if (isDataUrl(item.url)) {
      images.push(item.url)
      revisedPrompts.push(asString(item.revised_prompt) || undefined)
      continue
    }
    if (isHttpUrl(item.url)) {
      rawImageUrls.push(item.url)
      images.push(await fetchImageUrlAsDataUrl(item.url, mime))
      revisedPrompts.push(asString(item.revised_prompt) || undefined)
    }
  }
  if (!images.length) return { images: [], rawResponsePayload: JSON.stringify(normalized, null, 2) }
  const actualParams = mergeActualParams(pickActualParams(normalized), { n: images.length })
  return {
    images,
    actualParams,
    actualParamsList: images.map(() => actualParams),
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

function getResponsesImageResultBase64(result: unknown): string | undefined {
  const b64 = typeof result === 'string'
    ? result
    : isRecord(result)
    ? asString(result.b64_json) || asString(result.base64) || asString(result.image) || asString(result.data)
    : ''
  return b64.trim() ? b64 : undefined
}

async function parseResponsesApiResult(payload: unknown, params: TaskParams): Promise<CallApiResult> {
  const response = isRecord(payload) ? payload : {}
  const output = Array.isArray(response.output) ? response.output : []
  const mime = mimeForParams(params)
  const images: string[] = []
  const actualParamsList: Array<Partial<TaskParams> | undefined> = []
  const revisedPrompts: Array<string | undefined> = []
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'image_generation_call') continue
    const b64 = getResponsesImageResultBase64(item.result)
    if (!b64) continue
    images.push(normalizeBase64DataUrl(b64, mime))
    actualParamsList.push(mergeActualParams(pickActualParams(item)))
    revisedPrompts.push(asString(item.revised_prompt) || undefined)
  }
  if (!images.length) return { images: [], rawResponsePayload: JSON.stringify(response, null, 2) }
  return {
    images,
    actualParams: firstActualParams(actualParamsList),
    actualParamsList,
    revisedPrompts,
    rawResponsePayload: JSON.stringify(response, null, 2),
  }
}

function createResponsesInput(prompt: string, inputImageDataUrls: string[], referenceIds?: string[]): unknown {
  const mapping = inputImageDataUrls.length && referenceIds?.length
    ? `Attached reference images correspond to these ids, in order: ${referenceIds.map((id) => `<ref id="${id}" />`).join(', ')}.`
    : ''
  const text = [mapping, `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`].filter(Boolean).join('\n\n')
  if (!inputImageDataUrls.length) return text
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text },
      ...inputImageDataUrls.map((dataUrl) => ({ type: 'input_image', image_url: dataUrl })),
    ],
  }]
}

function createResponsesImageTool(params: TaskParams, isEdit: boolean, profile: ApiProfile, maskDataUrl?: string) {
  const tool: JsonRecord = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }
  if (!profile.codexCli) tool.quality = params.quality
  if (params.output_format !== 'png' && params.output_compression != null) tool.output_compression = params.output_compression
  if (profile.streamImages) tool.partial_images = profile.streamPartialImages ?? 1
  if (maskDataUrl) tool.input_image_mask = { image_url: maskDataUrl }
  return tool
}

async function providerJsonRequest(profile: ApiProfile, path: string, body?: unknown, method = 'POST', signal?: AbortSignal) {
  const startedAt = now()
  const providerUrl = buildProviderUrl(profile, path)
  logInfo('provider_json_request_started', {
    method,
    profile: summarizeProfile(profile),
    ...providerUrlLogFields(providerUrl),
    hasBody: body !== undefined,
  })
  const response = await fetch(providerUrl, {
    method,
    headers: providerHeaders(profile, method === 'GET' || body === undefined ? undefined : 'application/json'),
    body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  logInfo('provider_json_request_completed', {
    method,
    profile: summarizeProfile(profile),
    ...providerUrlLogFields(providerUrl),
    status: response.status,
    ok: response.ok,
    elapsedMs: now() - startedAt,
  })
  if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`)
  return response.json()
}

async function providerMultipartRequest(profile: ApiProfile, path: string, body: FormData, method = 'POST', signal?: AbortSignal) {
  const startedAt = now()
  const providerUrl = buildProviderUrl(profile, path)
  logInfo('provider_multipart_request_started', {
    method,
    profile: summarizeProfile(profile),
    ...providerUrlLogFields(providerUrl),
  })
  const response = await fetch(providerUrl, {
    method,
    headers: providerHeaders(profile),
    body: method === 'GET' ? undefined : body,
    signal,
  })
  logInfo('provider_multipart_request_completed', {
    method,
    profile: summarizeProfile(profile),
    ...providerUrlLogFields(providerUrl),
    status: response.status,
    ok: response.ok,
    elapsedMs: now() - startedAt,
  })
  if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`)
  return response.json()
}

async function executeOpenAICompatibleImageApi(userId: number, request: GenerationRequest, signal?: AbortSignal): Promise<CallApiResult> {
  const profile = resolveProfileForUser(userId, request.profile)
  const params = taskParams(request.params)
  const inputImageDataUrls = await readTaskImageDataUrls(userId, request.inputImageIds ?? [])
  const maskDataUrl = request.maskImageId ? await readTaskImageDataUrl(userId, request.maskImageId) : undefined
  const customProvider = getCustomProviderDefinition(request.settings, profile.provider)
  if (customProvider) {
    return executeCustomHttpImageApi(profile, customProvider, {
      prompt: asString(request.prompt),
      params,
      inputImageDataUrls,
      maskDataUrl,
    }, signal)
  }

  if (profile.apiMode === 'responses') {
    const body: JsonRecord = {
      model: profile.model,
      input: createResponsesInput(asString(request.prompt), inputImageDataUrls, request.referenceIds),
      tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, profile, maskDataUrl)],
      tool_choice: 'required',
    }
    const payload = await providerJsonRequest(profile, 'responses', body, 'POST', signal)
    return parseResponsesApiResult(payload, params)
  }

  if (inputImageDataUrls.length) {
    const formData = new FormData()
    formData.append('model', asString(profile.model))
    formData.append('prompt', profile.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${asString(request.prompt)}` : asString(request.prompt))
    formData.append('size', params.size)
    formData.append('output_format', params.output_format)
    formData.append('moderation', params.moderation)
    if (!profile.codexCli) formData.append('quality', params.quality)
    if (params.output_format !== 'png' && params.output_compression != null) formData.append('output_compression', String(params.output_compression))
    if (params.n > 1) formData.append('n', String(params.n))
    if (profile.responseFormatB64Json) formData.append('response_format', 'b64_json')
    for (let i = 0; i < inputImageDataUrls.length; i++) {
      const { mime, bytes } = dataUrlToBuffer(inputImageDataUrls[i])
      formData.append('image[]', new Blob([bytes], { type: mime }), `input-${i + 1}.${mimeToExt(mime)}`)
    }
    if (maskDataUrl) {
      const { bytes } = dataUrlToBuffer(maskDataUrl)
      formData.append('mask', new Blob([bytes], { type: 'image/png' }), 'mask.png')
    }
    const payload = await providerMultipartRequest(profile, 'images/edits', formData, 'POST', signal)
    return parseImagesApiResult(payload, params)
  }

  const body: JsonRecord = {
    model: profile.model,
    prompt: profile.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${asString(request.prompt)}` : asString(request.prompt),
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }
  if (!profile.codexCli) body.quality = params.quality
  if (params.output_format !== 'png' && params.output_compression != null) body.output_compression = params.output_compression
  if (params.n > 1) body.n = params.n
  if (profile.responseFormatB64Json) body.response_format = 'b64_json'
  const payload = await providerJsonRequest(profile, 'images/generations', body, 'POST', signal)
  return parseImagesApiResult(payload, params)
}

function createCustomProviderContext(opts: { prompt: string; params: TaskParams; inputImageDataUrls: string[]; maskDataUrl?: string }, profile: ApiProfile) {
  return {
    profile,
    prompt: opts.prompt,
    params: opts.params,
    inputImages: {
      dataUrls: opts.inputImageDataUrls.length ? opts.inputImageDataUrls : undefined,
      count: opts.inputImageDataUrls.length,
    },
    mask: {
      dataUrl: opts.maskDataUrl,
    },
  }
}

async function createCustomMultipartBody(
  mapping: CustomProviderSubmitMapping,
  opts: { prompt: string; params: TaskParams; inputImageDataUrls: string[]; maskDataUrl?: string },
  context: Record<string, unknown>,
) {
  const formData = new FormData()
  const body = resolveTemplateValue(mapping.body ?? {}, context)
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        for (const item of value) formData.append(key, String(item))
      } else {
        formData.append(key, String(value))
      }
    }
  }

  const imageParts = opts.inputImageDataUrls.map((dataUrl) => dataUrlToBuffer(dataUrl))
  const maskPart = opts.maskDataUrl ? dataUrlToBuffer(opts.maskDataUrl) : null
  for (const file of mapping.files ?? []) {
    if (file.source === 'inputImages') {
      for (let i = 0; i < imageParts.length; i++) {
        const part = imageParts[i]
        formData.append(file.field, new Blob([part.bytes], { type: part.mime }), `input-${i + 1}.${mimeToExt(part.mime)}`)
      }
    } else if (file.source === 'mask' && maskPart) {
      formData.append(file.field, new Blob([maskPart.bytes], { type: maskPart.mime }), `mask.${mimeToExt(maskPart.mime)}`)
    }
  }
  return formData
}

async function extractCustomImages(payload: unknown, result: CustomProviderResultMapping | undefined, params: TaskParams): Promise<CallApiResult> {
  const mapping = result ?? {}
  const mime = mimeForParams(params)
  const images: string[] = []
  const imageUrls = (mapping.imageUrlPaths ?? []).flatMap((path) =>
    getAllByPath(payload, path).filter((value): value is string => isHttpUrl(value) || isDataUrl(value)),
  )
  const rawImageUrls = imageUrls.filter(isHttpUrl)
  for (const path of mapping.b64JsonPaths ?? []) {
    for (const value of getAllByPath(payload, path)) {
      if (typeof value === 'string' && value.trim()) images.push(normalizeBase64DataUrl(value, mime))
    }
  }
  for (const url of imageUrls) {
    images.push(isDataUrl(url) ? url : await fetchImageUrlAsDataUrl(url, mime))
  }
  if (!images.length) {
    return { images: [], rawResponsePayload: JSON.stringify(payload, null, 2) }
  }
  return { images, actualParams: { n: images.length }, actualParamsList: images.map(() => ({ n: 1 })), ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

function getTaskState(payload: unknown, poll: CustomProviderPollMapping): 'success' | 'failure' | 'pending' {
  const status = getByPath(payload, poll.statusPath)
  const statusText = typeof status === 'string' ? status : String(status ?? '')
  if (poll.successValues.includes(statusText)) return 'success'
  if (poll.failureValues.includes(statusText)) return 'failure'
  return 'pending'
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('任务已取消', 'AbortError'))
      return
    }
    const timer = setTimeout(resolvePromise, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('任务已取消', 'AbortError'))
    }, { once: true })
  })
}

async function pollCustomTaskResult(profile: ApiProfile, poll: CustomProviderPollMapping, taskId: string, params: TaskParams, signal?: AbortSignal): Promise<CallApiResult> {
  let first = true
  let attempts = 0
  const timeoutSeconds = Math.max(1, asNumber(poll.timeoutSeconds, CUSTOM_POLL_TIMEOUT_SECONDS))
  const maxAttempts = asNumber(poll.maxAttempts)
  const deadline = Date.now() + timeoutSeconds * 1000
  const context = { profile, params, taskId }
  while (true) {
    if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
    if (Date.now() > deadline) throw new Error(`自定义异步任务轮询超时（超过 ${timeoutSeconds} 秒）`)
    if (maxAttempts && attempts >= maxAttempts) throw new Error(`自定义异步任务轮询超出最大次数（${maxAttempts} 次）`)
    if (first) first = false
    else await sleep((poll.intervalSeconds ?? 5) * 1000, signal)
    attempts += 1

    const taskPath = appendQuery(buildTaskPath(poll.path, taskId), renderQuery(poll.query, context))
    const payload = await providerJsonRequest(profile, taskPath, undefined, poll.method ?? 'GET', signal)
    const state = getTaskState(payload, poll)
    logInfo('custom_provider_task_poll', {
      profile: summarizeProfile(profile),
      taskId,
      attempts,
      state,
    })
    if (state === 'failure') {
      const message = getByPath(payload, poll.errorPath) || getByPath(payload, 'message') || getByPath(payload, 'error.message')
      throw new Error(typeof message === 'string' && message.trim() ? message : '异步任务失败')
    }
    if (state === 'success') return extractCustomImages(payload, poll.result, params)
  }
}

async function executeCustomHttpImageApi(
  profile: ApiProfile,
  customProvider: CustomProviderDefinition,
  opts: { prompt: string; params: TaskParams; inputImageDataUrls: string[]; maskDataUrl?: string },
  signal?: AbortSignal,
): Promise<CallApiResult> {
  const isEdit = opts.inputImageDataUrls.length > 0
  const mapping = isEdit && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
  const context = createCustomProviderContext(opts, profile)
  const method = mapping.method ?? 'POST'
  const path = appendQuery(mapping.path, renderQuery(mapping.query, context))
  let payload: unknown
  if (method !== 'GET' && (mapping.contentType ?? 'json') === 'multipart') {
    payload = await providerMultipartRequest(profile, path, await createCustomMultipartBody(mapping, opts, context), method, signal)
  } else {
    const body = method === 'GET' ? undefined : resolveTemplateValue(mapping.body ?? {}, context)
    payload = await providerJsonRequest(profile, path, body, method, signal)
  }

  const taskIdValue = mapping.taskIdPath ? getByPath(payload, mapping.taskIdPath) : undefined
  const taskId = typeof taskIdValue === 'string' ? taskIdValue.trim() : String(taskIdValue ?? '').trim()
  if (!taskId) return extractCustomImages(payload, mapping.result, opts.params)
  if (!customProvider.poll) throw new Error('异步接口返回了 task_id，但服务商配置缺少 poll')
  logInfo('custom_provider_task_enqueued', {
    profile: summarizeProfile(profile),
    provider: customProvider.id,
    taskId,
  })
  return pollCustomTaskResult(profile, customProvider.poll, taskId, opts.params, signal)
}

async function executeGenerationRequest(userId: number, request: GenerationRequest, signal?: AbortSignal): Promise<CallApiResult> {
  const profile = resolveProfileForUser(userId, request.profile)
  return profile.provider === 'fal'
    ? executeFalImageApi(userId, { ...request, profile }, signal)
    : executeOpenAICompatibleImageApi(userId, { ...request, profile }, signal)
}

async function handleProviderJson(req: IncomingMessage, res: ServerResponse, user: AuthUser) {
  assertMethod(req, 'POST')
  const body = await readJsonBody<JsonRecord>(req)
  const profile = resolveProfileForUser(user.id, body.profile)
  const method = asString(body.method, 'POST').toUpperCase()
  const providerUrl = buildProviderUrl(profile, asString(body.path))
  const startedAt = now()
  logInfo('proxy_provider_json_started', {
    userId: user.id,
    method,
    profile: summarizeProfile(profile),
    ...providerUrlLogFields(providerUrl),
    hasBody: body.body !== undefined,
  })
  const providerResponse = await fetch(providerUrl, {
    method,
    headers: providerHeaders(profile, method === 'GET' || body.body === undefined ? undefined : 'application/json'),
    body: method === 'GET' || body.body === undefined ? undefined : JSON.stringify(body.body),
  })
  logInfo('proxy_provider_json_completed', {
    userId: user.id,
    method,
    profile: summarizeProfile(profile),
    ...providerUrlLogFields(providerUrl),
    status: providerResponse.status,
    ok: providerResponse.ok,
    elapsedMs: now() - startedAt,
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
  const providerUrl = buildProviderUrl(profile, path)
  const startedAt = now()
  logInfo('proxy_provider_multipart_started', {
    userId: user.id,
    method,
    profile: summarizeProfile(profile),
    ...providerUrlLogFields(providerUrl),
    bodyBytes: rawBody.length,
  })
  const providerResponse = await fetch(providerUrl, {
    method,
    headers: providerHeaders(profile, contentType),
    body: method === 'GET' ? undefined : new Uint8Array(rawBody),
  })
  logInfo('proxy_provider_multipart_completed', {
    userId: user.id,
    method,
    profile: summarizeProfile(profile),
    ...providerUrlLogFields(providerUrl),
    status: providerResponse.status,
    ok: providerResponse.ok,
    elapsedMs: now() - startedAt,
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

  if (pathname.startsWith('/api/admin/')) {
    return handleAdminApi(req, res, url)
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
    if (req.method === 'GET') return sendJson(res, 200, listTasksPage(user.id, url))
    if (req.method === 'DELETE') {
      logInfo('tasks_clear_requested', { userId: user.id })
      cancelAllGenerationJobsForUser(user.id)
      const result = deleteAllTaskRecordsForUser(user.id)
      db.prepare('DELETE FROM generation_jobs WHERE user_id = ?').run(user.id)
      logInfo('tasks_clear_completed', { userId: user.id, ...result })
      return sendNoContent(res)
    }
  }
  if (pathname.startsWith('/api/tasks/batch/')) {
    assertMethod(req, 'GET')
    const batchGroupId = decodeURIComponent(pathname.slice('/api/tasks/batch/'.length))
    return sendJson(res, 200, listBatchTasks(user.id, batchGroupId))
  }
  if (pathname === '/api/tasks/incomplete') {
    assertMethod(req, 'GET')
    return sendJson(res, 200, listIncompleteTasks(user.id))
  }
  if (pathname.startsWith('/api/tasks/')) {
    const id = decodeURIComponent(pathname.slice('/api/tasks/'.length))
    if (req.method === 'GET') {
      const task = getJsonRow<TaskRecord>('tasks', user.id, id)
      return sendJson(res, 200, task ? withQueuePosition(user.id, task) : null)
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody<JsonRecord>(req)
      const task: JsonRecord = isRecord(body.task) ? { ...body.task, id } : { id }
      putJsonRow('tasks', user.id, id, task, asNumber(task.createdAt), asNumber(task.finishedAt) || undefined)
      return sendJson(res, 200, { id })
    }
    if (req.method === 'DELETE') {
      logInfo('task_delete_requested', { userId: user.id, taskId: id })
      cancelGenerationJobsForTask(user.id, id)
      const result = deleteTaskRecord(user.id, id)
      db.prepare('DELETE FROM generation_jobs WHERE user_id = ? AND task_id = ?').run(user.id, id)
      logInfo('task_delete_completed', { userId: user.id, taskId: id, archivedCount: result.archivedCount, existed: Boolean(result.task) })
      return sendNoContent(res)
    }
  }

  if (pathname === '/api/generation/tasks') {
    assertMethod(req, 'POST')
    const body = await readJsonBody<JsonRecord>(req)
    if (!isRecord(body.task)) throw Object.assign(new Error('缺少 task'), { statusCode: 400 })
    if (!isRecord(body.request)) throw Object.assign(new Error('缺少 request'), { statusCode: 400 })
    const task = body.task
    const request = body.request as GenerationRequest
    logInfo('generation_task_create_requested', {
      userId: user.id,
      taskId: asString(task.id),
      batchGroupId: asString(task.batchGroupId) || undefined,
      batchIndex: asNumber(task.batchIndex, -1) >= 0 ? asNumber(task.batchIndex) : undefined,
      batchSize: asNumber(task.batchSize) || undefined,
      profile: summarizeProfile(request.profile),
      inputImageCount: request.inputImageIds?.length ?? 0,
      hasMask: Boolean(request.maskImageId),
      requestedImages: taskParams(request.params).n,
    })
    return sendJson(res, 200, { task: enqueueGenerationTask(user.id, body.task, body.request as GenerationRequest) })
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
    if (!dataUrl) throw Object.assign(new Error('缺少图片数据'), { statusCode: 400 })
    const source = normalizeStoredImageSource(body.source)
    const id = createStoredImageId(dataUrl, source)
    const existing = getStoredFile('images', user.id, id)
    const createdAt = asNumber(body.createdAt, now())
    const thumbnail = isRecord(body.thumbnail) ? body.thumbnail : null
    const thumbnailVersion = asNumber(thumbnail?.thumbnailVersion)
    const existingThumbnail = getStoredFileMetadata('thumbnails', user.id, id)
    const shouldStoreThumbnail = thumbnail && asString(thumbnail.thumbnailDataUrl) && existingThumbnail?.thumbnailVersion !== thumbnailVersion

    if (!existing) {
      await putStoredFile('images', user.id, id, {
        id,
        dataUrl,
        createdAt,
        source,
        width: asNumber(body.width),
        height: asNumber(body.height),
      }, 'dataUrl')
    } else if (asNumber(body.width) || asNumber(body.height)) {
      updateStoredFileMetadata('images', user.id, id, {
        width: asNumber(body.width, asNumber(existing.width)),
        height: asNumber(body.height, asNumber(existing.height)),
      })
    }

    if (shouldStoreThumbnail) {
      await putStoredFile('thumbnails', user.id, id, {
        id,
        thumbnailDataUrl: asString(thumbnail.thumbnailDataUrl),
        createdAt,
        width: asNumber(thumbnail.width, asNumber(body.width)),
        height: asNumber(thumbnail.height, asNumber(body.height)),
        thumbnailVersion,
      }, 'thumbnailDataUrl')
    }

    return sendJson(res, 200, { id, isNew: !existing })
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
    if (!id || id.includes('/')) throw Object.assign(new Error('Not Found'), { statusCode: 404 })
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
    if (!id || id.includes('/')) throw Object.assign(new Error('Not Found'), { statusCode: 404 })
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
scheduleGenerationWorker()

const server = createServer((req, res) => {
  const startedAt = now()
  const requestId = genId('req_')
  void (async () => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    logInfo('request_started', {
      requestId,
      method: req.method,
      path: url.pathname,
    })
    res.once('finish', () => {
      logInfo('request_completed', {
        requestId,
        method: req.method,
        path: url.pathname,
        statusCode: res.statusCode,
        elapsedMs: now() - startedAt,
      })
    })
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
  logInfo('server_listening', {
    port,
    dataDir,
    dbPath,
    generationConcurrency: GENERATION_CONCURRENCY,
    customPollTimeoutSeconds: CUSTOM_POLL_TIMEOUT_SECONDS,
    logLevel: LOG_LEVEL,
  })
})
