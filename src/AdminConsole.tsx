import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Search, Shield, UserPlus } from 'lucide-react'
import { apiRequest, useAuth } from './auth/AuthContext'
import './admin.css'

type AdminUser = { id: string; email: string; name: string; role: 'ANALYST' | 'ADMINISTRATOR'; enabled: number; mfa_enabled: number; created_at: string }
type AuditEvent = { id: string; event_type: string; timestamp: string; actor_id: string | null; object_id: string | null; success: boolean; metadata: Record<string, unknown> }

export default function AdminConsole() {
  const { user, logout } = useAuth()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'ANALYST' | 'ADMINISTRATOR'>('ANALYST')
  const [creating, setCreating] = useState(false)

  async function load() {
    setError('')
    setLoading(true)
    try {
      const [userResult, auditResult] = await Promise.all([
        apiRequest<{ users: AdminUser[] }>('/api/admin/users'),
        apiRequest<{ events: AuditEvent[] }>('/api/admin/audit'),
      ])
      setUsers(userResult.users)
      setEvents(auditResult.events)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Administrator data could not be loaded.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const filteredUsers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? users.filter((item) => `${item.name} ${item.email} ${item.role}`.toLowerCase().includes(normalized)) : users
  }, [users, query])
  const enabledCount = users.filter((item) => item.enabled === 1).length
  const recentSecurityEvents = events.filter((event) => /LOGIN|MFA|ADMIN_USER|PASSWORD|LOGOUT/.test(event.event_type))

  async function createUser(event: React.FormEvent) {
    event.preventDefault()
    setError(''); setNotice(''); setCreating(true)
    try {
      const result = await apiRequest<{ user: AdminUser }>('/api/admin/users', { email, name, password, role })
      setPassword(''); setEmail(''); setName('')
      setNotice(`${result.user.email} was provisioned. They must enroll MFA before accessing the workspace.`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Account could not be provisioned.')
    } finally {
      setCreating(false)
    }
  }

  async function changeUser(item: AdminUser, change: { enabled: boolean } | { role: 'ANALYST' | 'ADMINISTRATOR' }) {
    const description = 'enabled' in change
      ? `${change.enabled ? 'Reactivate' : 'Deactivate'} ${item.email}? This revokes their active sessions.`
      : `Change ${item.email} from ${item.role} to ${change.role}? This revokes their active sessions and changes their permissions.`
    if (!window.confirm(description)) return
    setError(''); setNotice(''); setBusyId(item.id)
    try {
      await apiRequest(`/api/admin/users/${item.id}`, change, 'PATCH')
      setNotice(`${item.email} account updated. Any existing sessions were revoked.`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Account update failed.')
    } finally {
      setBusyId('')
    }
  }

  return <main className="admin-page">
    <header className="admin-header">
      <Link className="brand" to="/app"><span className="brand-mark"><Shield size={17}/></span><span className="brand-name">mule<span>shield</span></span></Link>
      <nav aria-label="Workspace navigation"><Link to="/app">Overview</Link><Link to="/app/investigations">Manual Investigation</Link><Link to="/app/monitoring">Live Monitoring</Link><Link to="/app/cases">Cases</Link><Link to="/app/alerts">Alerts</Link><Link to="/app/reports">Reports</Link><Link aria-current="page" to="/app/admin">Admin</Link></nav>
      <div className="admin-session"><span>{user?.name} · Administrator</span><button onClick={() => void logout()}>Sign out</button></div>
    </header>
    <div className="admin-content">
      <Link className="admin-back" to="/app"><ArrowLeft size={14}/> Overview</Link>
      <div className="admin-title-row"><div><div className="card-kicker">ACCESS CONTROL · AUDITED</div><h1>Administration</h1><p>Manage provisioned accounts and review recent security events.</p></div><button className="button-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={14}/> Refresh</button></div>
      {error&&<div className="admin-feedback error" role="alert">{error}</div>}{notice&&<div className="admin-feedback success" role="status">{notice}</div>}
      <section className="admin-metrics" aria-label="Account and security overview"><article><span>Total accounts</span><strong>{loading?'—':users.length}</strong></article><article><span>Enabled accounts</span><strong>{loading?'—':enabledCount}</strong></article><article><span>Recent security events</span><strong>{loading?'—':recentSecurityEvents.length}</strong></article><article><span>Audit records loaded</span><strong>{loading?'—':events.length}</strong></article></section>
      <div className="admin-layout">
        <section className="admin-panel admin-users"><div className="admin-panel-heading"><div><h2>User directory</h2><p>Role and account state are enforced by the API.</p></div><label className="admin-search"><Search size={15}/><input aria-label="Search users" value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Search name, email, role"/></label></div>
          {loading?<p className="admin-empty">Loading accounts…</p>:filteredUsers.length===0?<p className="admin-empty">{users.length?'No accounts match your search.':'No accounts provisioned.'}</p>:<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>MFA</th><th>Created</th><th>Controls</th></tr></thead><tbody>{filteredUsers.map((item)=><tr key={item.id}><td><strong>{item.name}</strong><small>{item.email}</small></td><td><select aria-label={`Role for ${item.email}`} value={item.role} disabled={busyId===item.id||item.id===user?.id} onChange={(event)=>void changeUser(item,{role:event.target.value as AdminUser['role']})}><option value="ANALYST">Analyst</option><option value="ADMINISTRATOR">Administrator</option></select></td><td><span className={`admin-status ${item.enabled?'active':'inactive'}`}>{item.enabled?'Enabled':'Disabled'}</span></td><td>{item.mfa_enabled?'Enabled':'Required'}</td><td>{new Date(item.created_at).toLocaleDateString()}</td><td><button className="admin-row-action" disabled={busyId===item.id||item.id===user?.id} onClick={()=>void changeUser(item,{enabled:item.enabled!==1})}>{busyId===item.id?'Updating…':item.enabled?'Deactivate':'Reactivate'}</button></td></tr>)}</tbody></table></div>}
        </section>
        <section className="admin-panel admin-create"><div className="admin-panel-heading"><div><h2><UserPlus size={17}/> Provision account</h2><p>Initial password is supplied by the administrator and never returned by the API.</p></div></div><form onSubmit={createUser} className="admin-form"><label>Name<input value={name} onChange={(event)=>setName(event.target.value)} maxLength={120} required autoComplete="off"/></label><label>Email<input type="email" value={email} onChange={(event)=>setEmail(event.target.value)} required autoComplete="off"/></label><label>Initial password<input type="password" value={password} onChange={(event)=>setPassword(event.target.value)} minLength={14} maxLength={128} required autoComplete="new-password"/><small>14–128 characters. Share it through an approved secure channel; the new user must enroll MFA before workspace access.</small></label><label>Role<select value={role} onChange={(event)=>setRole(event.target.value as AdminUser['role'])}><option value="ANALYST">Analyst</option><option value="ADMINISTRATOR">Administrator</option></select></label><button className="button-primary" disabled={creating}>{creating?'Provisioning…':'Create account'}</button></form></section>
      </div>
      <section className="admin-panel admin-audit"><div className="admin-panel-heading"><div><h2>Security and audit events</h2><p>Latest records returned by the Administrator-only audit API (up to 200).</p></div></div>{loading?<p className="admin-empty">Loading audit events…</p>:events.length===0?<p className="admin-empty">No audit events recorded yet.</p>:<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Event</th><th>Time</th><th>Actor ID</th><th>Object ID</th><th>Result</th></tr></thead><tbody>{events.map((event)=><tr key={event.id}><td><strong>{event.event_type}</strong></td><td>{new Date(event.timestamp).toLocaleString()}</td><td>{event.actor_id||'System'}</td><td>{event.object_id||'—'}</td><td>{event.success?'Recorded':'Failed'}</td></tr>)}</tbody></table></div>}</section>
    </div>
  </main>
}
