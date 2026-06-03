import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  type GeneratedImageAdminItem,
  fetchAdminGeneratedImages,
  fetchAdminImageBlobUrl,
  resolveItemImagePath,
  setAdminKey,
  verifyAdminKey,
} from '../lib/adminApi'

type SourceFilter = 'all' | 'active' | 'deleted'

/** 通过 fetch+Blob URL 加载图片的 hook，组件卸载时自动 revoke */
function useAdminImageBlob(path: string | undefined): string | null {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!path) { setBlobUrl(null); return }
    let revoked = false
    let currentUrl: string | null = null
    void fetchAdminImageBlobUrl(path).then((url) => {
      if (revoked) { URL.revokeObjectURL(url); return }
      currentUrl = url
      setBlobUrl(url)
    }).catch(() => {
      if (!revoked) setBlobUrl(null)
    })
    return () => {
      revoked = true
      if (currentUrl) URL.revokeObjectURL(currentUrl)
      setBlobUrl(null)
    }
  }, [path])
  return blobUrl
}

function formatTimestamp(ts: number) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatElapsed(ms: number | null | undefined) {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function statusLabel(status: string) {
  switch (status) {
    case 'done': return '完成'
    case 'error': return '失败'
    case 'running': return '运行中'
    case 'queued': return '排队中'
    default: return status
  }
}

function statusBadgeClass(status: string) {
  switch (status) {
    case 'done': return 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400'
    case 'error': return 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400'
    case 'running': return 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400'
    case 'queued': return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400'
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-500/15 dark:text-gray-400'
  }
}

// ===== 登录界面 =====

function AdminLogin({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!key.trim()) {
      setError('请输入 Admin API Key')
      return
    }
    setLoading(true)
    setError('')
    setAdminKey(key.trim())
    try {
      const valid = await verifyAdminKey()
      if (!valid) {
        setError('密钥无效或服务未启用')
        setAdminKey('')
        return
      }
      onLogin()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setAdminKey('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center px-4 py-12">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 shadow-xl p-6 space-y-5"
      >
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Admin</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">GPT Image Playground 管理后台</p>
        </div>

        <label className="block space-y-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Admin API Key</span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="请输入管理密钥"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-xl border border-gray-300 dark:border-white/[0.12] bg-white dark:bg-gray-950 px-3 py-2 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loading}
          />
        </label>

        {error && (
          <div className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
        >
          {loading ? '验证中...' : '进入管理'}
        </button>

        <div className="text-center">
          <a href="/" className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors">
            返回首页
          </a>
        </div>
      </form>
    </main>
  )
}

// ===== 图片详情弹窗 =====

function AdminDetailModal({ item, onClose }: { item: GeneratedImageAdminItem; onClose: () => void }) {
  const imgPath = resolveItemImagePath(item)
  const imgUrl = useAdminImageBlob(imgPath)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 animate-overlay-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 shadow-2xl animate-modal-in">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {item.username} · #{item.outputIndex}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[0.04] text-gray-500 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-xl overflow-hidden bg-gray-100 dark:bg-gray-800">
            {imgUrl ? (
              <img src={imgUrl} alt="Generated" className="w-full h-auto object-contain max-h-[50vh]" />
            ) : (
              <div className="flex items-center justify-center py-12 text-gray-400">
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-current border-t-transparent" />
                <span className="ml-2 text-sm">加载中...</span>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Prompt</span>
              <p className="mt-1 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">{item.prompt || '(无)'}</p>
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <span className={`px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(item.status)}`}>
                {statusLabel(item.status)}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 dark:bg-white/[0.06] dark:text-gray-400">
                {item.source === 'active' ? '活跃' : '已删除'}
              </span>
              {item.params.size && (
                <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 dark:bg-white/[0.06] dark:text-gray-400">
                  {item.params.size}
                </span>
              )}
              {item.params.quality && (
                <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 dark:bg-white/[0.06] dark:text-gray-400">
                  {item.params.quality}
                </span>
              )}
              {formatElapsed(item.task.elapsed) && (
                <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 dark:bg-white/[0.06] dark:text-gray-400">
                  {formatElapsed(item.task.elapsed)}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 dark:text-gray-400">
              <div>
                <span className="font-medium text-gray-500 dark:text-gray-500">用户：</span>
                {item.username} (ID: {item.userId})
              </div>
              <div>
                <span className="font-medium text-gray-500 dark:text-gray-500">任务 ID：</span>
                <span className="font-mono">{item.taskId.slice(0, 12)}...</span>
              </div>
              <div>
                <span className="font-medium text-gray-500 dark:text-gray-500">创建：</span>
                {formatTimestamp(item.createdAt)}
              </div>
              <div>
                <span className="font-medium text-gray-500 dark:text-gray-500">更新：</span>
                {formatTimestamp(item.updatedAt)}
              </div>
              {item.deletedAt && (
                <div>
                  <span className="font-medium text-gray-500 dark:text-gray-500">删除：</span>
                  {formatTimestamp(item.deletedAt)}
                </div>
              )}
              <div>
                <span className="font-medium text-gray-500 dark:text-gray-500">输出数：</span>
                {item.outputImages.length}
              </div>
            </div>

            {item.task.error && (
              <div className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {item.task.error}
              </div>
            )}

            {item.referenceThumbnails.length > 0 && (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">参考图</span>
                <div className="mt-1.5 flex gap-2 flex-wrap">
                  {item.referenceThumbnails.map((ref) => (
                    <div key={ref.imageId} className="w-14 h-14 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-white/[0.08]">
                      {ref.thumbnailDataUrl ? (
                        <img src={ref.thumbnailDataUrl} alt="Reference" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400 text-[10px]">N/A</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ===== 图片卡片 =====

function AdminImageCard({ item, onClick }: { item: GeneratedImageAdminItem; onClick: () => void }) {
  const imgPath = item.thumbnailDataUrl ? undefined : resolveItemImagePath(item)
  const blobSrc = useAdminImageBlob(imgPath)
  const thumbSrc = item.thumbnailDataUrl || blobSrc || ''

  return (
    <button
      type="button"
      onClick={onClick}
      className="group text-left rounded-2xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 overflow-hidden shadow-sm hover:shadow-md transition-shadow"
    >
      <div className="aspect-square bg-gray-100 dark:bg-gray-800 overflow-hidden">
        <img
          src={thumbSrc}
          alt={item.prompt}
          className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
          loading="lazy"
        />
      </div>
      <div className="p-3 space-y-1.5">
        <p className="text-xs text-gray-700 dark:text-gray-300 line-clamp-2 leading-relaxed min-h-[2rem]">
          {item.prompt || '(无提示词)'}
        </p>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${statusBadgeClass(item.status)}`}>
            {statusLabel(item.status)}
          </span>
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
            item.source === 'active'
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400'
              : 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400'
          }`}>
            {item.source === 'active' ? '活跃' : '已删除'}
          </span>
        </div>
        <div className="flex items-center justify-between text-[10px] text-gray-400 dark:text-gray-500">
          <span className="truncate">{item.username}</span>
          <span>{formatTimestamp(item.deletedAt ?? item.updatedAt)}</span>
        </div>
      </div>
    </button>
  )
}

// ===== 主界面 =====

const PAGE_LIMIT = 48

function AdminDashboard({ onLogout }: { onLogout: () => void }) {
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [items, setItems] = useState<GeneratedImageAdminItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [detailItem, setDetailItem] = useState<GeneratedImageAdminItem | null>(null)
  const loadedCursors = useRef<string[]>([])

  const loadPage = useCallback(async (cursor?: string, append = false) => {
    const isLoadMore = append
    if (isLoadMore) {
      setLoadingMore(true)
    } else {
      setLoading(true)
      setItems([])
      setNextCursor(undefined)
      loadedCursors.current = []
    }
    setError('')
    try {
      const result = await fetchAdminGeneratedImages({
        limit: PAGE_LIMIT,
        cursor,
        includeActive: filter === 'deleted' ? false : true,
        includeDeleted: filter === 'active' ? false : true,
      })
      if (append) {
        setItems((prev) => [...prev, ...result.items])
      } else {
        setItems(result.items)
      }
      setNextCursor(result.nextCursor)
      if (cursor) loadedCursors.current.push(cursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [filter])

  useEffect(() => {
    void loadPage()
  }, [loadPage])

  const handleFilterChange = (next: SourceFilter) => {
    if (next === filter) return
    setFilter(next)
  }

  const handleLogout = () => {
    setAdminKey('')
    onLogout()
  }

  

  const filters: Array<{ key: SourceFilter; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'active', label: '活跃' },
    { key: 'deleted', label: '已删除' },
  ]

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <header className="safe-area-top sticky top-0 z-40 bg-white/80 dark:bg-gray-950/80 backdrop-blur border-b border-gray-200 dark:border-white/[0.08]">
        <div className="safe-area-x max-w-7xl mx-auto flex items-center justify-between" style={{ minHeight: '3.5rem' }}>
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-[17px] sm:text-lg font-bold tracking-tight text-gray-800 dark:text-gray-100 truncate">
              Admin
            </h1>
            <div className="hidden sm:flex items-center gap-1 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-gray-100/70 dark:bg-white/[0.04] p-1">
              {filters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => handleFilterChange(f.key)}
                  className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${
                    filter === f.key
                      ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm font-medium'
                      : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {items.length} 项
            </span>
            <a
              href="/"
              className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            >
              返回首页
            </a>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            >
              退出
            </button>
          </div>
        </div>
        {/* Mobile filter */}
        <div className="safe-area-x sm:hidden pb-2">
          <div className="grid grid-cols-3 gap-1 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-gray-100/70 dark:bg-white/[0.04] p-1">
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => handleFilterChange(f.key)}
                className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${
                  filter === f.key
                    ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm font-medium'
                    : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="safe-area-x max-w-7xl mx-auto pt-4 pb-12">
        {error && (
          <div className="mb-4 rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-400 dark:text-gray-500">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent" />
            <span className="ml-3 text-sm">加载中...</span>
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-24 text-gray-400 dark:text-gray-500">
            <p className="text-sm">暂无生成图数据</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {items.map((item) => (
                <AdminImageCard
                  key={item.id}
                  item={item}
                  onClick={() => setDetailItem(item)}
                />
              ))}
            </div>

            {nextCursor && (
              <div className="flex justify-center mt-8">
                <button
                  type="button"
                  onClick={() => void loadPage(nextCursor, true)}
                  disabled={loadingMore}
                  className="rounded-xl bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08] px-8 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/[0.1] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loadingMore ? (
                    <span className="inline-flex items-center gap-2">
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent" />
                      加载中...
                    </span>
                  ) : (
                    '加载更多'
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {detailItem && (
        <AdminDetailModal item={detailItem} onClose={() => setDetailItem(null)} />
      )}
    </div>
  )
}

// ===== AdminApp 入口 =====

export default function AdminApp() {
  const [authenticated, setAuthenticated] = useState(false)

  if (!authenticated) {
    return <AdminLogin onLogin={() => setAuthenticated(true)} />
  }

  return <AdminDashboard onLogout={() => setAuthenticated(false)} />
}

