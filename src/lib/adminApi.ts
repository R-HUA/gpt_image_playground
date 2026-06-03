// ===== Admin API 客户端 =====

export type TaskStatus = 'queued' | 'running' | 'done' | 'error'

export interface TaskParams {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
}

export interface TaskRecord {
  id: string
  prompt: string
  params: TaskParams
  inputImageIds: string[]
  outputImages: string[]
  status: TaskStatus
  error: string | null
  createdAt: number
  finishedAt: number | null
  elapsed: number | null
}

export interface GeneratedImageAdminItem {
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
  imageMetadata: Record<string, unknown>
  thumbnailDataUrl?: string
  referenceThumbnails: Array<{ imageId: string; thumbnailDataUrl?: string }>
  imageUrl: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
  task: TaskRecord
}

export interface AdminGeneratedImagesPage {
  items: GeneratedImageAdminItem[]
  nextCursor?: string
}

let currentAdminKey = ''

export function setAdminKey(key: string) {
  currentAdminKey = key
}

export function getAdminKey(): string {
  return currentAdminKey
}

function adminHeaders(): Record<string, string> {
  return currentAdminKey ? { 'x-gip-admin-key': currentAdminKey } : {}
}

async function adminJsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...adminHeaders(),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = `HTTP ${response.status}`
    try {
      const json = JSON.parse(text) as Record<string, unknown>
      if (typeof json.error === 'string') message = json.error
    } catch {
      if (text) message = text
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export interface FetchAdminImagesParams {
  limit?: number
  cursor?: string
  includeActive?: boolean
  includeDeleted?: boolean
}

export function fetchAdminGeneratedImages(params: FetchAdminImagesParams = {}): Promise<AdminGeneratedImagesPage> {
  const searchParams = new URLSearchParams()
  if (params.limit) searchParams.set('limit', String(params.limit))
  if (params.cursor) searchParams.set('cursor', params.cursor)
  if (params.includeActive === false) searchParams.set('includeActive', 'false')
  if (params.includeDeleted === false) searchParams.set('includeDeleted', 'false')
  const suffix = searchParams.toString() ? `?${searchParams.toString()}` : ''
  return adminJsonRequest<AdminGeneratedImagesPage>(`/api/admin/generated-images${suffix}`)
}

/** 构造管理图片 API 路径（不含鉴权参数） */
function buildAdminImagePath(item: { source: 'active' | 'deleted'; userId: number; imageId: string; archiveId?: string }): string {
  const params = new URLSearchParams({ source: item.source })
  if (item.archiveId) params.set('archiveId', item.archiveId)
  return `/api/admin/generated-images/${item.userId}/${encodeURIComponent(item.imageId)}?${params.toString()}`
}

/** 从列表 item 构造其 API 路径 */
export function resolveItemImagePath(item: GeneratedImageAdminItem): string {
  const archiveId = item.source === 'deleted' ? item.id : undefined
  return buildAdminImagePath({ source: item.source, userId: item.userId, imageId: item.imageId, archiveId })
}

/** 通过 fetch + header 鉴权加载图片，返回 Blob URL（调用方需在不再使用时 revokeObjectURL） */
export async function fetchAdminImageBlobUrl(path: string): Promise<string> {
  const response = await fetch(path, { headers: adminHeaders() })
  if (!response.ok) throw new Error(`图片加载失败：HTTP ${response.status}`)
  const blob = await response.blob()
  return URL.createObjectURL(blob)
}

/** 验证 admin key 是否有效 */
export async function verifyAdminKey(): Promise<boolean> {
  try {
    await fetchAdminGeneratedImages({ limit: 1 })
    return true
  } catch {
    return false
  }
}
