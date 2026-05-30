import { useCallback, useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { mergeImportedSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, loadCustomProviderSettingsFromUrl } from './lib/customProviderConfigUrl'
import { getCurrentUser, type AuthUser } from './lib/backendApi'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import Header from './components/Header'
import LoginPage from './components/LoginPage'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import { useGlobalClickSuppression } from './lib/clickSuppression'

let customProviderConfigUrlImportStarted = false

type BootStatus = 'checking' | 'login' | 'ready' | 'error'

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const appMode = useStore((s) => s.appMode)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [bootStatus, setBootStatus] = useState<BootStatus>('checking')
  const [bootError, setBootError] = useState('')
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  const applyStartupImports = useCallback(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    const customProviderConfigUrl = getCustomProviderConfigUrl()
    if (customProviderConfigUrl && !customProviderConfigUrlImportStarted) {
      customProviderConfigUrlImportStarted = true
      void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
        .then((importedSettings) => {
          if (!importedSettings) return
          const state = useStore.getState()
          state.setSettings(mergeImportedSettings(state.settings, importedSettings))
        })
        .catch((error) => {
          console.warn('Failed to import custom provider config URL:', error)
        })
    }
  }, [setSettings])

  const initializeAuthenticatedSession = useCallback(async (user: AuthUser) => {
    setAuthUser(user)
    setBootStatus('checking')
    setBootError('')
    try {
      await initStore(user)
      applyStartupImports()
      setBootStatus('ready')
    } catch (error) {
      setBootError(error instanceof Error ? error.message : String(error))
      setBootStatus('error')
    }
  }, [applyStartupImports])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const user = await getCurrentUser()
        if (cancelled) return
        if (!user) {
          setAuthUser(null)
          setBootStatus('login')
          return
        }
        await initializeAuthenticatedSession(user)
      } catch (error) {
        if (cancelled) return
        setBootError(error instanceof Error ? error.message : String(error))
        setBootStatus('error')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [initializeAuthenticatedSession])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  if (bootStatus === 'checking') {
    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center px-4 text-gray-600 dark:text-gray-300">
        正在加载...
      </main>
    )
  }

  if (bootStatus === 'login') {
    return <LoginPage onLogin={(user) => void initializeAuthenticatedSession(user)} />
  }

  if (bootStatus === 'error') {
    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-red-200 dark:border-red-500/30 bg-white dark:bg-gray-900 p-6 shadow-xl space-y-4">
          <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">启动失败</h1>
          <p className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap">{bootError || '未知错误'}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
          >
            重新加载
          </button>
        </div>
      </main>
    )
  }

  if (!authUser) return <LoginPage onLogin={(user) => void initializeAuthenticatedSession(user)} />

  return (
    <>
      <Header />
      {appMode === 'agent' ? (
        <AgentWorkspace />
      ) : (
        <main data-home-main data-drag-select-surface className="pb-48">
          <div className="safe-area-x max-w-7xl mx-auto">
            <SearchBar />
            <TaskGrid />
          </div>
        </main>
      )}
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <SupportPromptModal />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
