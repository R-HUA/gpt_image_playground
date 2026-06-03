import { useEffect, useState } from 'react'
import type { TaskRecord } from '../types'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../store'
import { TrashIcon } from './icons'

interface Props {
  tasks: TaskRecord[]
  onClick: (e: React.MouseEvent | React.TouchEvent) => void
  onDelete?: () => void
  isSelected?: boolean
}

function countStatus(tasks: TaskRecord[], status: TaskRecord['status']) {
  return tasks.filter((task) => task.status === status).length
}

export default function BatchTaskCard({ tasks, onClick, onDelete, isSelected }: Props) {
  const sorted = [...tasks].sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0))
  const first = sorted[0]
  const total = first?.batchSize && first.batchSize > sorted.length ? first.batchSize : sorted.length
  const coverImageId = sorted.find((task) => task.outputImages[0])?.outputImages[0]
  const [thumbSrc, setThumbSrc] = useState('')

  useEffect(() => {
    setThumbSrc('')
    if (!coverImageId) return
    let cancelled = false
    const apply = (thumbnail: { dataUrl: string }) => {
      if (!cancelled) setThumbSrc(thumbnail.dataUrl)
    }
    const unsubscribe = subscribeImageThumbnail(coverImageId, apply)
    ensureImageThumbnailCached(coverImageId).then((thumbnail) => {
      if (thumbnail) apply(thumbnail)
    }).catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [coverImageId])

  const done = countStatus(sorted, 'done')
  const running = countStatus(sorted, 'running')
  const queued = countStatus(sorted, 'queued')
  const error = countStatus(sorted, 'error')

  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-white transition hover:shadow-lg dark:bg-gray-900 ${
        isSelected
          ? 'border-blue-500 shadow-md ring-2 ring-blue-500/50'
          : 'border-gray-200 hover:border-gray-300 dark:border-white/[0.08] dark:hover:border-white/[0.18]'
      }`}
      onClick={onClick}
    >
      <div className="flex h-40 cursor-pointer">
        <div className="relative flex h-full w-40 min-w-[10rem] flex-shrink-0 items-center justify-center overflow-hidden bg-gray-100 dark:bg-black/20">
          {thumbSrc ? (
            <img src={thumbSrc} className="h-full w-full object-cover" alt="" />
          ) : (
            <div className="flex flex-col items-center gap-2 px-3 text-center text-gray-400">
              <svg className="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="text-xs">批量任务</span>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col p-3">
          <div className="mb-2 min-h-0 flex-1 overflow-hidden">
            <p className="line-clamp-3 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
              {first?.prompt || '(无提示词)'}
            </p>
          </div>
          <div className="mt-auto flex h-8 items-center justify-between gap-2 border-t border-gray-100 pt-2 text-xs text-gray-500 dark:border-white/[0.08] dark:text-gray-400">
            <div className="min-w-0 truncate">
              <span className="font-medium text-gray-700 dark:text-gray-200">完成 {done}/{total}</span>
              {running + queued > 0 && <span className="ml-2">进行中 {running + queued}</span>}
              {error > 0 && <span className="ml-2 text-red-500">失败 {error}</span>}
            </div>
            {onDelete && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete()
                }}
                onTouchStart={(e) => e.stopPropagation()}
                onTouchEnd={(e) => e.stopPropagation()}
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-gray-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                title="删除批量任务"
                aria-label="删除批量任务"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
