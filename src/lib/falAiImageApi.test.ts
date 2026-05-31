import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, DEFAULT_FAL_BASE_URL, DEFAULT_SETTINGS } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'

function ndjsonResponse(lines: unknown[]) {
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}

describe('callFalAiImageApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('submits fal requests to the backend worker proxy endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ndjsonResponse([
      { type: 'falEnqueued', request: { requestId: 'req-1', endpoint: 'fal-ai/imagen4/preview' } },
      { type: 'final', result: { images: ['data:image/png;base64,aW1hZ2U='] } },
    ]))
    const onFalRequestEnqueued = vi.fn()

    const result = await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onFalRequestEnqueued,
    }, createDefaultFalProfile({ apiKey: 'fal-key', baseUrl: DEFAULT_FAL_BASE_URL }))

    expect(fetchMock).toHaveBeenCalledWith('http://localhost/api/fal/call', expect.objectContaining({ method: 'POST' }))
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      profile: expect.objectContaining({ apiKey: 'fal-key', baseUrl: DEFAULT_FAL_BASE_URL }),
      prompt: 'prompt',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
    })
    expect(onFalRequestEnqueued).toHaveBeenCalledWith({ requestId: 'req-1', endpoint: 'fal-ai/imagen4/preview' })
    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U='])
  })

  it('passes custom fal API URL through the backend request payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ndjsonResponse([
      { type: 'final', result: { images: ['data:image/png;base64,aW1hZ2U='] } },
    ]))

    await callFalAiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultFalProfile({
      apiKey: 'fal-key',
      baseUrl: 'https://fal-proxy.example.com/api/fal/',
    }))

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String((init as RequestInit).body)).profile).toMatchObject({
      apiKey: 'fal-key',
      baseUrl: 'https://fal-proxy.example.com/api/fal/',
    })
  })
})
