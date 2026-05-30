import type { AgentConversation, StoredImage, StoredImageThumbnail, TaskRecord } from '../types'
import { backendAgentConversations, backendImages, backendTasks, backendThumbnails } from './backendApi'

const THUMBNAIL_MAX_SIZE = 720
const THUMBNAIL_QUALITY = 0.9
const THUMBNAIL_VERSION = 2

export const CURRENT_THUMBNAIL_VERSION = THUMBNAIL_VERSION

// ===== Tasks =====

export function getAllTasks(): Promise<TaskRecord[]> {
  return backendTasks.list()
}

export async function putTask(task: TaskRecord): Promise<IDBValidKey> {
  await backendTasks.put(task)
  return task.id
}

export function deleteTask(id: string): Promise<void> {
  return backendTasks.delete(id)
}

export function clearTasks(): Promise<void> {
  return backendTasks.clear()
}

// ===== Agent conversations =====

export function getAllAgentConversations(): Promise<AgentConversation[]> {
  return backendAgentConversations.list()
}

export async function putAgentConversation(conversation: AgentConversation): Promise<IDBValidKey> {
  await backendAgentConversations.put(conversation)
  return conversation.id
}

export function deleteAgentConversation(id: string): Promise<void> {
  return backendAgentConversations.delete(id)
}

export function clearAgentConversations(): Promise<void> {
  return backendAgentConversations.clear()
}

export function replaceAgentConversations(conversations: AgentConversation[]): Promise<void> {
  return backendAgentConversations.replace(conversations)
}

// ===== Images =====

export function getImage(id: string): Promise<StoredImage | undefined> {
  return backendImages.get(id)
}

export function getStoredImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  return backendThumbnails.get(id)
}

export async function getStoredFreshImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const thumbnail = await getStoredImageThumbnail(id)
  return thumbnail?.thumbnailVersion === THUMBNAIL_VERSION ? thumbnail : undefined
}

export async function putImageThumbnail(thumbnail: StoredImageThumbnail): Promise<IDBValidKey> {
  await backendThumbnails.put(thumbnail)
  return thumbnail.id
}

export async function getImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const existingThumbnail = await getStoredImageThumbnail(id)
  if (existingThumbnail?.thumbnailVersion === THUMBNAIL_VERSION) return existingThumbnail

  const image = await getImage(id)
  if (!image) return undefined

  const metadata = await safeCreateImageThumbnail(image.dataUrl)
  if (!metadata.thumbnailDataUrl) return undefined
  const thumbnail: StoredImageThumbnail = {
    id,
    thumbnailDataUrl: metadata.thumbnailDataUrl,
    width: metadata.width,
    height: metadata.height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
  await putImageThumbnail(thumbnail)
  if (metadata.width && metadata.height && (image.width !== metadata.width || image.height !== metadata.height)) {
    await putImage({ ...image, width: metadata.width, height: metadata.height })
  }
  return thumbnail
}

export function getAllImages(): Promise<StoredImage[]> {
  return backendImages.list()
}

export function getAllImageIds(): Promise<string[]> {
  return backendImages.ids()
}

export async function putImage(image: StoredImage): Promise<IDBValidKey> {
  await backendImages.put(image)
  return image.id
}

export function deleteImage(id: string): Promise<void> {
  return backendImages.delete(id)
}

export function clearImages(): Promise<void> {
  return backendImages.clear()
}

// ===== Image storage =====

/**
 * Store an image on the backend. Hashing and deduplication are handled server-side
 * via POST /api/images/store. The client only provides thumbnail data generated
 * with Canvas; the backend performs all writes in a single endpoint.
 */
export async function storeImage(dataUrl: string, source: NonNullable<StoredImage['source']> = 'upload'): Promise<string> {
  const thumbnail = await safeCreateImageThumbnail(dataUrl)
  const { id } = await backendImages.store({
    dataUrl,
    source,
    createdAt: Date.now(),
    width: thumbnail.width,
    height: thumbnail.height,
    thumbnail: thumbnail.thumbnailDataUrl
      ? {
          thumbnailDataUrl: thumbnail.thumbnailDataUrl,
          width: thumbnail.width,
          height: thumbnail.height,
          thumbnailVersion: THUMBNAIL_VERSION,
        }
      : undefined,
  })

  return id
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = dataUrl
  })
}

async function createImageThumbnail(dataUrl: string): Promise<Omit<StoredImageThumbnail, 'id'>> {
  const image = await loadImage(dataUrl)
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (width <= 0 || height <= 0) throw new Error('图片尺寸无效')

  const scale = Math.min(1, THUMBNAIL_MAX_SIZE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  return {
    thumbnailDataUrl: canvas.toDataURL('image/webp', THUMBNAIL_QUALITY),
    width,
    height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
}

async function safeCreateImageThumbnail(dataUrl: string): Promise<Partial<Omit<StoredImageThumbnail, 'id'>>> {
  try {
    return await createImageThumbnail(dataUrl)
  } catch {
    return {}
  }
}
