import type { TaskRecord } from '../types'
import TaskCard from './TaskCard'

interface Props {
  tasks: TaskRecord[]
  loading?: boolean
  onClose: () => void
  onTaskClick: (task: TaskRecord, e: React.MouseEvent | React.TouchEvent) => void
  onReuse: (task: TaskRecord) => void
  onEditOutputs: (task: TaskRecord) => void
  onDelete: (task: TaskRecord) => void
  selectedTaskIds: string[]
}

export default function BatchTaskModal({
  tasks,
  loading = false,
  onClose,
  onTaskClick,
  onReuse,
  onEditOutputs,
  onDelete,
  selectedTaskIds,
}: Props) {
  const sorted = [...tasks].sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0))
  const first = sorted[0]

  return (
    <div data-no-drag-select className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-5xl overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-white/[0.08] dark:bg-gray-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-4 py-3 dark:border-white/[0.08]">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-gray-800 dark:text-gray-100">批量图生图</h2>
            <p className="mt-1 line-clamp-1 text-sm text-gray-500 dark:text-gray-400">{first?.prompt || '(无提示词)'}</p>
            {loading && <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">正在加载完整批次...</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[calc(85vh-4.5rem)] overflow-y-auto p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((task) => (
              <div key={task.id} className="task-card-wrapper" data-task-id={task.id}>
                <TaskCard
                  task={task}
                  onClick={(e) => onTaskClick(task, e)}
                  onReuse={() => onReuse(task)}
                  onEditOutputs={() => onEditOutputs(task)}
                  onDelete={() => onDelete(task)}
                  isSelected={selectedTaskIds.includes(task.id)}
                  disableSwipe
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
