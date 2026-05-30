import type { ApiProfile, TaskParams } from '../types'
import { callBackendFalImageApi, getBackendFalQueuedImageResult } from './backendApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

export function getFalErrorMessage(err: unknown): string | null {
  const body = err && typeof err === 'object' && 'body' in err ? (err as { body?: unknown }).body : null
  if (!body || typeof body !== 'object') return null

  const detail = (body as Record<string, unknown>).detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>
          if (typeof record.msg === 'string' && record.msg.trim()) return record.msg
          if (typeof record.message === 'string' && record.message.trim()) return record.message
        }
        return null
      })
      .filter((message): message is string => Boolean(message))
    if (messages.length) return messages.join('\n')
  }

  const message = (body as Record<string, unknown>).message
  return typeof message === 'string' && message.trim() ? message : null
}

export async function getFalQueuedImageResult(
  profile: ApiProfile,
  endpoint: string,
  requestId: string,
  params: TaskParams,
): Promise<CallApiResult> {
  return getBackendFalQueuedImageResult(profile, endpoint, requestId, params)
}

export async function callFalAiImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  return callBackendFalImageApi(opts, profile)
}
