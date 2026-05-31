import type { AgentConversation, AppSettings, ApiProfile, StoredImage, StoredImageThumbnail, TaskParams, TaskRecord } from '../types'
import type { CallApiOptions, CallApiResult } from './imageApiShared'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'

export const SERVER_API_KEY_PLACEHOLDER = '__server_stored_api_key__'

const ACCESS_TOKEN_KEY = 'gpt-image-playground.access-token'
const REFRESH_TOKEN_KEY = 'gpt-image-playground.refresh-token'
const AUTH_USER_KEY = 'gpt-image-playground.auth-user'

export interface AuthUser {
  id: number
  username: string
}

interface AuthResponse {
  accessToken: string
  refreshToken: string
  user: AuthUser
}

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null

export interface TaskPage {
  items: TaskRecord[]
  nextCursor?: string
}

export interface TaskListQuery {
  limit?: number
  cursor?: string
  q?: string
  status?: string
  favorite?: boolean
}

export interface GenerationRequest {
  profile: ApiProfile
  settings?: AppSettings
  prompt: string
  params: TaskParams
  inputImageIds: string[]
  maskImageId?: string | null
  referenceIds?: string[]
  agentBatchItemId?: string
}

function getApiBaseUrl() {
  return ''
}

function isTestRuntime() {
  return typeof process !== 'undefined' && process.env.NODE_ENV === 'test'
}

function readAccessToken() {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(ACCESS_TOKEN_KEY) || ''
}

function readRefreshToken() {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(REFRESH_TOKEN_KEY) || ''
}

function writeAuth(auth: AuthResponse) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(ACCESS_TOKEN_KEY, auth.accessToken)
  localStorage.setItem(REFRESH_TOKEN_KEY, auth.refreshToken)
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(auth.user))
}

export function getStoredAuthUser(): AuthUser | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY)
    return raw ? JSON.parse(raw) as AuthUser : null
  } catch {
    return null
  }
}

export function clearAuthTokens() {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  localStorage.removeItem(AUTH_USER_KEY)
}

export function isBackendAuthenticated() {
  return Boolean(readAccessToken() || readRefreshToken())
}

function apiUrl(path: string) {
  const url = `${getApiBaseUrl()}${path}`
  if (typeof window === 'undefined' && url.startsWith('/')) return `http://localhost${url}`
  return url
}

function shouldBypassBackendProxyForTests(profile: ApiProfile) {
  return typeof localStorage === 'undefined' && isTestRuntime() && !readAccessToken() && !readRefreshToken() && profile.apiKey
}

function buildProviderUrl(profile: ApiProfile, path: string) {
  const defaultBaseUrl = profile.provider === 'fal' ? 'https://fal.run' : 'https://api.openai.com/v1'
  return buildApiUrl(
    profile.baseUrl || defaultBaseUrl,
    path,
    readClientDevProxyConfig(),
    shouldUseApiProxy(Boolean(profile.apiProxy)),
  )
}

function providerHeaders(profile: ApiProfile, contentType?: string) {
  const headers: Record<string, string> = {}
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`
  if (contentType) headers['Content-Type'] = contentType
  return headers
}

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = readRefreshToken()
  if (!refreshToken) return false

  const response = await fetch(apiUrl('/api/auth/refresh'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ refreshToken }),
  })
  if (!response.ok) {
    clearAuthTokens()
    return false
  }
  writeAuth(await response.json() as AuthResponse)
  return true
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = readAccessToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(input, {
    ...init,
    headers,
    cache: init.cache ?? 'no-store',
  })

  if (response.status === 401 && retry && await refreshAccessToken()) {
    return authFetch(input, init, false)
  }
  if (response.status === 401) clearAuthTokens()
  return response
}

async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json() as { error?: string; message?: string }
    return payload.error || payload.message || `HTTP ${response.status}`
  } catch {
    try {
      return await response.text()
    } catch {
      return `HTTP ${response.status}`
    }
  }
}

export async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authFetch(apiUrl(path), init)
  if (!response.ok) throw new Error(await readErrorMessage(response))
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const response = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok) throw new Error(await readErrorMessage(response))
  const auth = await response.json() as AuthResponse
  writeAuth(auth)
  return auth.user
}

export async function logout() {
  const refreshToken = readRefreshToken()
  try {
    if (refreshToken) {
      await authFetch(apiUrl('/api/auth/logout'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }, false)
    }
  } finally {
    clearAuthTokens()
  }
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  if (!isBackendAuthenticated()) return null
  let response = await authFetch(apiUrl('/api/auth/me'))
  if (response.status === 401 && await refreshAccessToken()) {
    response = await authFetch(apiUrl('/api/auth/me'), {}, false)
  }
  if (!response.ok) return null
  const payload = await response.json() as { user: AuthUser }
  if (typeof localStorage !== 'undefined') localStorage.setItem(AUTH_USER_KEY, JSON.stringify(payload.user))
  return payload.user
}

function jsonInit(method: string, body?: JsonValue): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

export async function loadBackendSettings(): Promise<{ exists: boolean; settings: AppSettings | null }> {
  return jsonRequest('/api/settings')
}

export async function saveBackendSettings(settings: AppSettings): Promise<AppSettings> {
  const payload = await jsonRequest<{ settings: AppSettings }>('/api/settings', jsonInit('PATCH', { settings }))
  return payload.settings
}

export function redactSettingsForLocalStorage(settings: AppSettings): AppSettings {
  return {
    ...settings,
    apiKey: '',
    profiles: settings.profiles.map((profile) => ({ ...profile, apiKey: '' })),
  }
}

export const backendTasks = {
  list: (query: TaskListQuery = {}) => {
    const params = new URLSearchParams()
    if (query.limit != null) params.set('limit', String(query.limit))
    if (query.cursor) params.set('cursor', query.cursor)
    if (query.q) params.set('q', query.q)
    if (query.status && query.status !== 'all') params.set('status', query.status)
    if (query.favorite) params.set('favorite', 'true')
    const suffix = params.toString() ? `?${params.toString()}` : ''
    return jsonRequest<TaskPage>(`/api/tasks${suffix}`)
  },
  get: (id: string) => jsonRequest<TaskRecord | null>(`/api/tasks/${encodeURIComponent(id)}`),
  batch: (batchGroupId: string) => jsonRequest<TaskRecord[]>(`/api/tasks/batch/${encodeURIComponent(batchGroupId)}`),
  incomplete: () => jsonRequest<TaskRecord[]>('/api/tasks/incomplete'),
  put: (task: TaskRecord) => jsonRequest<{ id: string }>(`/api/tasks/${encodeURIComponent(task.id)}`, jsonInit('PUT', { task })),
  delete: (id: string) => jsonRequest<void>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clear: () => jsonRequest<void>('/api/tasks', { method: 'DELETE' }),
}

export const backendGeneration = {
  createTask: (task: TaskRecord, request: GenerationRequest) =>
    jsonRequest<{ task: TaskRecord }>('/api/generation/tasks', jsonInit('POST', { task, request })),
}

export const backendAgentConversations = {
  list: () => jsonRequest<AgentConversation[]>('/api/agent/conversations'),
  put: (conversation: AgentConversation) => jsonRequest<{ id: string }>(`/api/agent/conversations/${encodeURIComponent(conversation.id)}`, jsonInit('PUT', { conversation })),
  replace: (conversations: AgentConversation[]) => jsonRequest<void>('/api/agent/conversations', jsonInit('PUT', { conversations })),
  delete: (id: string) => jsonRequest<void>(`/api/agent/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clear: () => jsonRequest<void>('/api/agent/conversations', { method: 'DELETE' }),
}

export const backendImages = {
  get: (id: string) => jsonRequest<StoredImage | undefined>(`/api/images/${encodeURIComponent(id)}`),
  list: () => jsonRequest<StoredImage[]>('/api/images'),
  ids: () => jsonRequest<string[]>('/api/images/ids'),
  put: (image: StoredImage) => jsonRequest<{ id: string }>(`/api/images/${encodeURIComponent(image.id)}`, jsonInit('PUT', { image })),
  delete: (id: string) => jsonRequest<void>(`/api/images/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clear: () => jsonRequest<void>('/api/images', { method: 'DELETE' }),
  store: (image: Omit<StoredImage, 'id'> & { thumbnail?: Omit<StoredImageThumbnail, 'id'> }) =>
    jsonRequest<{ id: string; isNew: boolean }>('/api/images/store', jsonInit('POST', image)),
}

export const backendThumbnails = {
  get: (id: string) => jsonRequest<StoredImageThumbnail | undefined>(`/api/thumbnails/${encodeURIComponent(id)}`),
  put: (thumbnail: StoredImageThumbnail) => jsonRequest<{ id: string }>(`/api/thumbnails/${encodeURIComponent(thumbnail.id)}`, jsonInit('PUT', { thumbnail })),
}

function encodeJsonHeader(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export async function providerJsonFetch(
  profile: ApiProfile,
  path: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal,
): Promise<Response> {
  if (shouldBypassBackendProxyForTests(profile)) {
    const useApiProxy = shouldUseApiProxy(Boolean(profile.apiProxy))
    const defaultBaseUrl = profile.provider === 'fal' ? 'https://fal.run' : 'https://api.openai.com/v1'
    if (method === 'GET' && !useApiProxy) {
      return fetch(buildApiUrl(profile.baseUrl || defaultBaseUrl, path), {
        method,
        headers: providerHeaders(profile),
        signal,
        cache: 'no-store',
      })
    }
    return fetch(buildProviderUrl(profile, path), {
      method,
      headers: providerHeaders(profile, method === 'GET' || body === undefined ? undefined : 'application/json'),
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: 'no-store',
    })
  }
  return authFetch(apiUrl('/api/provider/json'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, path, method, body }),
    signal,
  })
}

export async function providerMultipartFetch(
  profile: ApiProfile,
  path: string,
  body: FormData,
  signal?: AbortSignal,
  method = 'POST',
): Promise<Response> {
  if (shouldBypassBackendProxyForTests(profile)) {
    return fetch(buildProviderUrl(profile, path), {
      method,
      headers: providerHeaders(profile),
      body: method === 'GET' ? undefined : body,
      signal,
    })
  }
  return authFetch(apiUrl('/api/provider/multipart'), {
    method: 'POST',
    headers: {
      'X-GIP-Provider-Profile': encodeJsonHeader(profile),
      'X-GIP-Provider-Path': path,
      'X-GIP-Provider-Method': method,
    },
    body,
    signal,
  })
}

export async function fetchRemoteImageAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal): Promise<string> {
  if (url.startsWith('data:')) return url
  const response = await jsonRequest<{ dataUrl: string }>('/api/images/fetch-url', {
    ...jsonInit('POST', { url, fallbackMime }),
    signal,
  })
  return response.dataUrl
}

type NdjsonEvent = Record<string, unknown>

async function readNdjson(response: Response, onEvent: (event: NdjsonEvent) => void | Promise<void>) {
  if (!response.body) throw new Error('后端未返回可读取的流式响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (line) await onEvent(JSON.parse(line) as NdjsonEvent)
      newlineIndex = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) await onEvent(JSON.parse(buffer) as NdjsonEvent)
}

function getNdjsonError(event: NdjsonEvent) {
  return typeof event.error === 'string' && event.error ? event.error : null
}

export async function callBackendFalImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const response = await authFetch(apiUrl('/api/fal/call'), jsonInit('POST', {
    profile,
    prompt: opts.prompt,
    params: opts.params,
    inputImageDataUrls: opts.inputImageDataUrls,
    maskDataUrl: opts.maskDataUrl,
  }))
  if (!response.ok) throw new Error(await readErrorMessage(response))

  let result: CallApiResult | null = null
  await readNdjson(response, (event) => {
    const error = getNdjsonError(event)
    if (error) throw new Error(error)
    if (event.type === 'falEnqueued' && event.request && typeof event.request === 'object') {
      opts.onFalRequestEnqueued?.(event.request as { requestId: string; endpoint: string })
    }
    if (event.type === 'final') result = event.result as CallApiResult
  })
  if (!result) throw new Error('fal.ai 未返回结果')
  return result
}

export async function getBackendFalQueuedImageResult(
  profile: ApiProfile,
  endpoint: string,
  requestId: string,
  params: TaskParams,
): Promise<CallApiResult> {
  const response = await authFetch(apiUrl('/api/fal/result'), jsonInit('POST', { profile, endpoint, requestId, params }))
  if (!response.ok) throw new Error(await readErrorMessage(response))

  let result: CallApiResult | null = null
  await readNdjson(response, (event) => {
    const error = getNdjsonError(event)
    if (error) throw new Error(error)
    if (event.type === 'final') result = event.result as CallApiResult
  })
  if (!result) throw new Error('fal.ai 未返回结果')
  return result
}
