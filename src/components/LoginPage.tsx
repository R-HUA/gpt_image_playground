import { useState, type FormEvent } from 'react'
import { login, type AuthUser } from '../lib/backendApi'

interface LoginPageProps {
  onLogin: (user: AuthUser) => void
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!username.trim() || !password) {
      setError('请输入用户名和密码')
      return
    }

    setLoading(true)
    setError('')
    try {
      const user = await login(username.trim(), password)
      onLogin(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">GPT Image Playground</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">请登录后继续使用</p>
        </div>

        <label className="block space-y-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">用户名</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            className="w-full rounded-xl border border-gray-300 dark:border-white/[0.12] bg-white dark:bg-gray-950 px-3 py-2 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loading}
          />
        </label>

        <label className="block space-y-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">密码</span>
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
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
          {loading ? '登录中...' : '登录'}
        </button>
      </form>
    </main>
  )
}
