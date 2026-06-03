import { useMemo, useRef, useState, useEffect } from 'react'
import { ALL_FAVORITES_COLLECTION_ID, getTaskFavoriteCollectionIds, useStore, reuseConfig, editOutputs, removeTask, removeMultipleTasks, loadMoreTasksFromServer, loadBatchTasksFromServer } from '../store'
import type { TaskRecord } from '../types'
import TaskCard from './TaskCard'
import BatchTaskCard from './BatchTaskCard'
import BatchTaskModal from './BatchTaskModal'

export default function TaskGrid() {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const taskNextCursor = useStore((s) => s.taskNextCursor)
  const tasksLoadingMore = useStore((s) => s.tasksLoadingMore)
  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [selectionBox, setSelectionBox] = useState<{ startPageX: number; startPageY: number; currentPageX: number; currentPageY: number } | null>(null)
  const [openBatchGroupId, setOpenBatchGroupId] = useState<string | null>(null)
  const [openBatchTasks, setOpenBatchTasks] = useState<TaskRecord[]>([])
  const [loadedBatchTasks, setLoadedBatchTasks] = useState<Record<string, TaskRecord[]>>({})
  const [batchLoadingGroupId, setBatchLoadingGroupId] = useState<string | null>(null)
  const batchLoadsInFlight = useRef<Set<string>>(new Set())
  const dragStart = useRef<{ pageX: number; pageY: number } | null>(null)
  const lastClientPoint = useRef<{ x: number; y: number } | null>(null)
  const hasDragged = useRef(false)
  const isDragging = useRef(false)
  const dragScrollIntervalRef = useRef<number | null>(null)
  const dragScrollDirectionRef = useRef<-1 | 1 | null>(null)
  const lastToastTimeRef = useRef(0)
  const suppressClickUntil = useRef(0)
  const startedOnCard = useRef(false)
  const startedWithCtrl = useRef(false)
  const initialSelection = useRef<string[]>([])
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  const visibleItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const sorted = [...tasks]
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((t) => {
        if (filterFavorite) {
          if (!t.isFavorite) return false
          if (activeFavoriteCollectionId && activeFavoriteCollectionId !== ALL_FAVORITES_COLLECTION_ID && !getTaskFavoriteCollectionIds(t).includes(activeFavoriteCollectionId)) return false
        }
        const matchStatus = filterStatus === 'all' || t.status === filterStatus
        if (!matchStatus) return false

        if (!q) return true
        const prompt = (t.prompt || '').toLowerCase()
        const paramStr = JSON.stringify(t.params).toLowerCase()
        return prompt.includes(q) || paramStr.includes(q)
      })
    const groups = new Map<string, typeof tasks>()
    const items: Array<{ type: 'task'; task: typeof tasks[0] } | { type: 'batch'; groupId: string; tasks: typeof tasks }> = []
    for (const task of sorted) {
      if (task.batchGroupId && task.batchKind === 'gallery-image-to-image') {
        const group = groups.get(task.batchGroupId) ?? []
        group.push(task)
        groups.set(task.batchGroupId, group)
        continue
      }
      items.push({ type: 'task', task })
    }
    for (const [groupId, groupTasks] of groups) {
      items.push({ type: 'batch', groupId, tasks: groupTasks })
    }
    return items.sort((a, b) => {
      const aTime = a.type === 'task' ? a.task.createdAt : Math.max(...a.tasks.map((task) => task.createdAt))
      const bTime = b.type === 'task' ? b.task.createdAt : Math.max(...b.tasks.map((task) => task.createdAt))
      return bTime - aTime
    })
  }, [tasks, searchQuery, filterStatus, filterFavorite, activeFavoriteCollectionId])
  const visibleTaskIds = useMemo(() => visibleItems.flatMap((item) => item.type === 'task' ? [item.task.id] : item.tasks.map((task) => task.id)), [visibleItems])

  const openBatchGroupIdRef = useRef<string | null>(null)

  useEffect(() => {
    openBatchGroupIdRef.current = openBatchGroupId
  }, [openBatchGroupId])

  const loadCompleteBatch = (groupId: string) => {
    if (batchLoadsInFlight.current.has(groupId)) return
    batchLoadsInFlight.current.add(groupId)
    void loadBatchTasksFromServer(groupId)
      .then((batchTasks) => {
        setLoadedBatchTasks((current) => ({ ...current, [groupId]: batchTasks }))
        setOpenBatchTasks((current) => openBatchGroupIdRef.current === groupId ? batchTasks : current)
      })
      .finally(() => {
        batchLoadsInFlight.current.delete(groupId)
        setBatchLoadingGroupId((current) => current === groupId ? null : current)
      })
  }

  const openBatch = (groupId: string, fallbackTasks: TaskRecord[]) => {
    const completeTasks = loadedBatchTasks[groupId] ?? fallbackTasks
    openBatchGroupIdRef.current = groupId
    setOpenBatchGroupId(groupId)
    setOpenBatchTasks(completeTasks)
    if (!loadedBatchTasks[groupId]) {
      setBatchLoadingGroupId(groupId)
      loadCompleteBatch(groupId)
    }
  }

  useEffect(() => {
    for (const item of visibleItems) {
      if (item.type !== 'batch') continue
      const expectedSize = item.tasks[0]?.batchSize
      const loaded = loadedBatchTasks[item.groupId]
      if (loaded) continue
      if (expectedSize && item.tasks.length >= expectedSize) {
        setLoadedBatchTasks((current) => ({ ...current, [item.groupId]: item.tasks }))
        continue
      }
      loadCompleteBatch(item.groupId)
    }
  }, [visibleItems, loadedBatchTasks])

  // 将 store 中的轮询更新同步到已加载的批量任务缓存和打开的批量弹窗
  useEffect(() => {
    const taskById = new Map(tasks.map((t) => [t.id, t]))
    setLoadedBatchTasks((current) => {
      let next = current
      for (const [groupId, batchTasks] of Object.entries(current)) {
        let updated = batchTasks
        for (let i = 0; i < updated.length; i++) {
          const fresh = taskById.get(updated[i].id)
          if (fresh && fresh !== updated[i]) {
            if (updated === batchTasks) updated = [...updated]
            updated[i] = fresh
          }
        }
        if (updated !== batchTasks) {
          if (next === current) next = { ...current }
          next[groupId] = updated
        }
      }
      return next
    })
    setOpenBatchTasks((current) => {
      if (!openBatchGroupIdRef.current) return current
      let updated = current
      for (let i = 0; i < updated.length; i++) {
        const fresh = taskById.get(updated[i].id)
        if (fresh && fresh !== updated[i]) {
          if (updated === current) updated = [...current]
          updated[i] = fresh
        }
      }
      return updated
    })
  }, [tasks])

  const handleDelete = (task: typeof tasks[0]) => {
    setConfirmDialog({
      title: '删除记录',
      message: '确定要删除这条记录吗？生成结果会从页面隐藏并归档保留，未被其他内容引用的参考图、遮罩和流式临时图会被清理。',
      action: () => {
        void removeTask(task).then(() => {
          setOpenBatchTasks((current) => current.filter((item) => item.id !== task.id))
          setLoadedBatchTasks((current) => {
            if (!task.batchGroupId || !current[task.batchGroupId]) return current
            return {
              ...current,
              [task.batchGroupId]: current[task.batchGroupId].filter((item) => item.id !== task.id),
            }
          })
        })
      },
    })
  }

  const handleDeleteBatch = (groupId: string, fallbackTasks: TaskRecord[]) => {
    void (async () => {
      let batchTasks = loadedBatchTasks[groupId] ?? fallbackTasks
      const expectedSize = batchTasks[0]?.batchSize ?? fallbackTasks[0]?.batchSize
      if (!loadedBatchTasks[groupId] || (expectedSize && batchTasks.length < expectedSize)) {
        setBatchLoadingGroupId(groupId)
        try {
          const completeTasks = await loadBatchTasksFromServer(groupId)
          if (completeTasks.length) {
            batchTasks = completeTasks
            setLoadedBatchTasks((current) => ({ ...current, [groupId]: completeTasks }))
            if (openBatchGroupIdRef.current === groupId) setOpenBatchTasks(completeTasks)
          }
        } catch (error) {
          useStore.getState().showToast(`无法加载完整批量任务：${error instanceof Error ? error.message : String(error)}`, 'error')
          return
        } finally {
          setBatchLoadingGroupId((current) => current === groupId ? null : current)
        }
      }

      const taskIds = batchTasks.map((task) => task.id)
      if (!taskIds.length) return
      const incompleteCount = batchTasks.filter((task) => task.status === 'queued' || task.status === 'running').length
      setConfirmDialog({
        title: '删除批量任务',
        message: `确定要删除这个批量任务的 ${taskIds.length} 条记录吗？生成结果会从页面隐藏并归档保留，未被其他内容引用的参考图、遮罩和流式临时图会被清理。${incompleteCount ? `\n其中 ${incompleteCount} 条仍在排队或生成中，删除会取消对应后端任务。` : ''}`,
        action: () => {
          void removeMultipleTasks(taskIds).then(() => {
            setLoadedBatchTasks((current) => {
              const next = { ...current }
              delete next[groupId]
              return next
            })
            if (openBatchGroupIdRef.current === groupId) {
              openBatchGroupIdRef.current = null
              setOpenBatchGroupId(null)
              setOpenBatchTasks([])
            }
          })
        },
      })
    })()
  }

  const getPagePoint = (clientX: number, clientY: number) => ({
    pageX: clientX + window.scrollX,
    pageY: clientY + window.scrollY,
  })

  const beginSelection = (target: HTMLElement, clientX: number, clientY: number, isCtrl: boolean) => {
    const point = getPagePoint(clientX, clientY)

    startedOnCard.current = Boolean(target.closest('.task-card-wrapper'))
    startedWithCtrl.current = isCtrl
    initialSelection.current = [...useStore.getState().selectedTaskIds]

    isDragging.current = true
    hasDragged.current = false
    dragStart.current = point
    lastClientPoint.current = { x: clientX, y: clientY }
    document.body.classList.add('select-none')
    document.body.classList.add('drag-selecting')
    setSelectionBox({
      startPageX: point.pageX,
      startPageY: point.pageY,
      currentPageX: point.pageX,
      currentPageY: point.pageY,
    })
  }

  const updateSelectionFromPoint = (pageX: number, pageY: number) => {
    const start = dragStart.current
    if (!start || !gridRef.current) return

    const minX = Math.min(start.pageX, pageX)
    const maxX = Math.max(start.pageX, pageX)
    const minY = Math.min(start.pageY, pageY)
    const maxY = Math.max(start.pageY, pageY)

    const cards = gridRef.current.querySelectorAll('.task-card-wrapper')
    const newSelected = new Set(initialSelection.current)
    const initialSelected = new Set(initialSelection.current)

    cards.forEach((card) => {
      const rect = card.getBoundingClientRect()
      const taskIds = (card.getAttribute('data-batch-task-ids') || card.getAttribute('data-task-id') || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
      if (!taskIds.length) return

      const cardLeft = rect.left + window.scrollX
      const cardRight = rect.right + window.scrollX
      const cardTop = rect.top + window.scrollY
      const cardBottom = rect.bottom + window.scrollY

      const isIntersecting =
        minX < cardRight && maxX > cardLeft && minY < cardBottom && maxY > cardTop

      if (isIntersecting) {
        const allInitiallySelected = taskIds.every((taskId) => initialSelected.has(taskId))
        if (allInitiallySelected) {
          for (const taskId of taskIds) newSelected.delete(taskId)
        } else {
          for (const taskId of taskIds) newSelected.add(taskId)
        }
      } else {
        for (const taskId of taskIds) {
          if (!initialSelected.has(taskId)) newSelected.delete(taskId)
        }
      }
    })

    setSelectedTaskIds(Array.from(newSelected))
  }

  useEffect(() => {
    const stopDragScroll = () => {
      if (dragScrollIntervalRef.current) {
        clearInterval(dragScrollIntervalRef.current)
        dragScrollIntervalRef.current = null
      }
      dragScrollDirectionRef.current = null
    }

    const startDragScroll = (direction: -1 | 1) => {
      if (dragScrollIntervalRef.current && dragScrollDirectionRef.current === direction) return
      stopDragScroll()
      dragScrollDirectionRef.current = direction
      dragScrollIntervalRef.current = window.setInterval(() => {
        window.scrollBy({ top: direction * 15, behavior: 'instant' })
      }, 16)
    }

    const endSelection = (clearEmptySurfaceClick = false, suppressClick = false) => {
      if (isDragging.current) {
        document.body.classList.remove('select-none')
        document.body.classList.remove('drag-selecting')
      }
      if (isDragging.current && clearEmptySurfaceClick && !hasDragged.current && !startedOnCard.current && !startedWithCtrl.current) {
        clearSelection()
      }
      if (isDragging.current && suppressClick && hasDragged.current) {
        suppressClickUntil.current = Date.now() + 250
      }
      stopDragScroll()
      isDragging.current = false
      dragStart.current = null
      lastClientPoint.current = null
      setSelectionBox(null)
    }

    const getEventElement = (e: MouseEvent) => {
      if (e.target instanceof Element) return e.target
      return document.elementFromPoint(e.clientX, e.clientY)
    }

    const handleDocumentMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = getEventElement(e)
      if (!target) return
      if (!target.closest('[data-drag-select-surface]')) return
      if (target.closest('[data-input-bar]')) return
      if (target.closest('[data-no-drag-select], [data-lightbox-root]')) return
      if (target.closest('button, a, input, textarea, select')) return

      const isCtrl = isMac ? e.metaKey : e.ctrlKey
      beginSelection(target as HTMLElement, e.clientX, e.clientY, isCtrl)
      e.preventDefault()
    }

    const handleDocumentMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStart.current) return

      const start = dragStart.current
      const point = getPagePoint(e.clientX, e.clientY)
      lastClientPoint.current = { x: e.clientX, y: e.clientY }
      const distance = Math.hypot(point.pageX - start.pageX, point.pageY - start.pageY)
      if (distance < 6 && !hasDragged.current) return

      hasDragged.current = true
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
      e.preventDefault()

      const scrollThreshold = 40
      if (e.clientY < scrollThreshold) {
        startDragScroll(-1)
      } else if (e.clientY > window.innerHeight - scrollThreshold) {
        startDragScroll(1)
      } else {
        stopDragScroll()
      }
    }

    const handleDocumentScroll = () => {
      if (!isDragging.current || !dragStart.current || !lastClientPoint.current || !hasDragged.current) return

      const point = getPagePoint(lastClientPoint.current.x, lastClientPoint.current.y)
      const start = dragStart.current
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
    }

    const handleDocumentWheel = (e: WheelEvent) => {
      if (!isDragging.current) return
      if ((e.buttons & 1) === 0) {
        endSelection()
        return
      }
      if (!hasDragged.current) return
      if (!e.ctrlKey && !e.metaKey) return

      e.preventDefault()
      const now = Date.now()
      if (now - lastToastTimeRef.current > 3000) {
        lastToastTimeRef.current = now
        const keyName = isMac ? '⌘' : 'Ctrl'
        useStore.getState().showToast(`松开 ${keyName} 键使用滚轮，或拖至边缘自动滚动`, 'info')
      }
    }

    const handleDocumentMouseUp = () => {
      endSelection(true, true)
    }

    document.addEventListener('mousedown', handleDocumentMouseDown, true)
    document.addEventListener('mousemove', handleDocumentMouseMove, true)
    document.addEventListener('mouseup', handleDocumentMouseUp, true)
    document.addEventListener('wheel', handleDocumentWheel, { capture: true, passive: false })
    window.addEventListener('scroll', handleDocumentScroll, true)
    return () => {
      stopDragScroll()
      document.removeEventListener('mousedown', handleDocumentMouseDown, true)
      document.removeEventListener('mousemove', handleDocumentMouseMove, true)
      document.removeEventListener('mouseup', handleDocumentMouseUp, true)
      document.removeEventListener('wheel', handleDocumentWheel, true)
      window.removeEventListener('scroll', handleDocumentScroll, true)
    }
  }, [clearSelection, isMac])

  if (!visibleItems.length) {
    return (
      <div className="text-center py-20 text-gray-400 dark:text-gray-500">
        {searchQuery || filterFavorite || filterStatus !== 'all' ? (
          <p className="text-sm">没有找到匹配的任务</p>
        ) : (
          <>
            <svg
              className="w-16 h-16 mx-auto mb-4 text-gray-200 dark:text-gray-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="text-sm">输入提示词开始生成图片</p>
          </>
        )}
      </div>
    )
  }

  return (
    <div 
      ref={rootRef}
      data-task-grid-root
      className="relative min-h-[50vh]"
    >
      <div ref={gridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-10">
        {visibleItems.map((item) => {
          if (item.type === 'batch') {
            const batchTasks = loadedBatchTasks[item.groupId] ?? item.tasks
            const batchTaskIds = batchTasks.map((task) => task.id)
            const selected = batchTaskIds.some((id) => selectedTaskIds.includes(id))
            return (
              <div
                key={item.groupId}
                className="task-card-wrapper"
                data-batch-task-ids={batchTaskIds.join(',')}
              >
                <BatchTaskCard
                  tasks={batchTasks}
                  isSelected={selected}
                  onDelete={() => handleDeleteBatch(item.groupId, batchTasks)}
                  onClick={(e) => {
                    if (Date.now() < suppressClickUntil.current) {
                      e.preventDefault()
                      return
                    }
                    suppressClickUntil.current = 0
                    const isCtrl = isMac ? e.metaKey : e.ctrlKey
                    if (isCtrl) {
                      const ids = batchTaskIds
                      const allSelected = ids.length > 0 && ids.every((id) => selectedTaskIds.includes(id))
                      useStore.getState().setSelectedTaskIds((current) =>
                        allSelected ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])],
                      )
                      return
                    }
                    openBatch(item.groupId, batchTasks)
                  }}
                />
              </div>
            )
          }
          const task = item.task
          return (
            <div key={task.id} className="task-card-wrapper" data-task-id={task.id}>
              <TaskCard
                task={task}
                onClick={(e) => {
                  if (Date.now() < suppressClickUntil.current) {
                    e.preventDefault()
                    return
                  }
                  suppressClickUntil.current = 0
                  const isCtrl = isMac ? e.metaKey : e.ctrlKey
                  if (isCtrl) {
                    useStore.getState().toggleTaskSelection(task.id)
                    return
                  }

                  setDetailTaskId(task.id)
                }}
                onReuse={() => reuseConfig(task)}
                onEditOutputs={() => editOutputs(task)}
                onDelete={() => handleDelete(task)}
                isSelected={selectedTaskIds.includes(task.id)}
              />
            </div>
          )
        })}
      </div>
      {openBatchGroupId && openBatchTasks.length > 0 && (
        <BatchTaskModal
          tasks={openBatchTasks}
          loading={batchLoadingGroupId === openBatchGroupId}
          selectedTaskIds={selectedTaskIds}
          onClose={() => {
            openBatchGroupIdRef.current = null
            setOpenBatchGroupId(null)
            setOpenBatchTasks([])
          }}
          onTaskClick={(task) => setDetailTaskId(task.id)}
          onReuse={(task) => reuseConfig(task)}
          onEditOutputs={(task) => editOutputs(task)}
          onDelete={(task) => handleDelete(task)}
        />
      )}
      {selectionBox && (
        <div
          className="fixed bg-blue-500/20 border border-blue-500/50 pointer-events-none z-[30]"
          style={{
            left: Math.min(selectionBox.startPageX, selectionBox.currentPageX) - window.scrollX,
            top: Math.min(selectionBox.startPageY, selectionBox.currentPageY) - window.scrollY,
            width: Math.abs(selectionBox.currentPageX - selectionBox.startPageX),
            height: Math.abs(selectionBox.currentPageY - selectionBox.startPageY),
          }}
        />
      )}
      {taskNextCursor && (
        <div className="flex justify-center pb-12">
          <button
            type="button"
            disabled={tasksLoadingMore}
            onClick={() => void loadMoreTasksFromServer()}
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            {tasksLoadingMore ? '加载中...' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  )
}
