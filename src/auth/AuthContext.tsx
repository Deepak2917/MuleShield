import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type User = { id: string; email: string; name: string; role: 'ANALYST' | 'ADMINISTRATOR'; mfaEnabled: boolean; createdAt: string }
type AuthContextValue = {
  user: User | null
  loading: boolean
  error: string | null
  login: (email: string, password: string) => Promise<'mfa' | 'enroll' | 'authenticated' | 'error'>
  verifyMfa: (code: string) => Promise<boolean>
  refresh: () => Promise<void>
  logout: () => Promise<void>
  clearError: () => void
}
const AuthContext = createContext<AuthContextValue | null>(null)

async function request<T>(url: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(result.error || 'The request could not be completed.')
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const result = await request<{ user: User }>('/api/auth/me')
      setUser(result.user)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const login = useCallback(async (email: string, password: string): Promise<'mfa' | 'enroll' | 'authenticated' | 'error'> => {
    setError(null)
    try {
      const result = await request<{ mfaRequired?: boolean; mfaEnrollmentRequired?: boolean; user?: User }>('/api/auth/login', { email, password })
      if (result.mfaRequired) return 'mfa'
      if (result.mfaEnrollmentRequired) return 'enroll'
      if (!result.user) throw new Error('The server did not confirm an authenticated user.')
      setUser(result.user ?? null)
      return 'authenticated'
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign in failed.')
      return 'error'
    }
  }, [])
  const verifyMfa = useCallback(async (code: string) => {
    setError(null)
    try {
      const result = await request<{ user: User }>('/api/auth/mfa/verify', { code })
      setUser(result.user)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Verification failed.')
      return false
    }
  }, [])
  const logout = useCallback(async () => {
    try { await request<void>('/api/auth/logout', {}) } finally { setUser(null) }
  }, [])
  const value = useMemo(() => ({ user, loading, error, login, verifyMfa, refresh, logout, clearError: () => setError(null) }), [user, loading, error, login, verifyMfa, refresh, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
export { request as apiRequest }
