import { useEffect, useState } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, Fingerprint, LockKeyhole, Shield, ShieldCheck } from 'lucide-react'
import QRCode from 'qrcode'
import Dashboard from './App'
import './auth/auth.css'
import NetworkPreview from './components/NetworkPreview'
import { AlertsPage, InvestigationDetailPage, InvestigationListPage, MonitoringPage, NewInvestigationPage, ReportsPage } from './ManualInvestigation'
import { apiRequest, AuthProvider, useAuth } from './auth/AuthContext'

function ProtectedRoute({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <div className="auth-loading"><span className="loading-orbit" />Checking secure session…</div>
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (admin && user.role !== 'ADMINISTRATOR') return <Navigate to="/app" replace />
  return <>{children}</>
}

function LandingPage() {
  return <main className="public-page">
    <header className="public-nav"><Link className="brand" to="/" aria-label="MuleShield home"><span className="brand-mark"><Shield size={17} /></span><span className="brand-name">mule<span>shield</span></span></Link><nav><a href="#capabilities">Capabilities</a><a href="#how-it-works">How it works</a><Link className="public-login" to="/login">Sign in <ArrowUpRight size={14} /></Link></nav></header>
    <section className="public-hero"><motion.div className="public-hero-copy" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .45 }}><div className="eyebrow"><span className="eyebrow-line" /> FINANCIAL CRIME INVESTIGATION</div><h1>See the Network.<br /><span>Stop the Mule.</span></h1><p>Investigate suspicious transaction flows, uncover connected accounts, and turn complex transaction records into explainable financial intelligence.</p><div className="public-actions"><Link className="button-primary" to="/login">Access MuleShield <ArrowRight size={15} /></Link><a className="button-secondary" href="#capabilities">Explore Capabilities</a></div><div className="illustrative-note"><i /> Illustrative network · not financial evidence</div></motion.div><div className="public-visual"><NetworkPreview /></div></section>
    <section className="capabilities" id="capabilities"><div className="capabilities-heading"><div className="card-kicker">INVESTIGATION TOOLKIT</div><h2>Complex flows. Clearer context.</h2><p>Purpose-built workflows to bring transaction records and relationships into view.</p></div><div className="capability-grid"><Capability icon="01" title="Transaction investigations" text="Organize transaction records and context around a focused case." /><Capability icon="02" title="Manual CSV analysis" text="Bring authorized transaction files into a structured review workflow." /><Capability icon="03" title="Real-time monitoring" text="Review an authorized event stream when a live source is configured." /><Capability icon="04" title="Account relationship graphs" text="Explore observed relationships from selected transaction records." /><Capability icon="05" title="Explainable risk alerts" text="Review rule-based signals with supporting records and clear context." /><Capability icon="06" title="Investigation reports" text="Create evidence-linked summaries with coverage and data limitations." /></div></section>
    <section className="public-cta" id="how-it-works"><div><div className="card-kicker">CONTROLLED ACCESS</div><h2>Start with your investigation.</h2><p>Sign in with an account provisioned by your organization.</p></div><Link className="button-primary" to="/login">Access MuleShield <ArrowRight size={15} /></Link></section>
    <footer className="public-footer"><Link className="brand" to="/"><span className="brand-mark"><Shield size={15} /></span><span className="brand-name">mule<span>shield</span></span></Link><span>Transaction intelligence workspace <b>·</b> v0.2.0</span><div><a href="mailto:documentation@example.invalid">Documentation</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div><small>Demo workspace · No external financial data source is connected</small></footer>
  </main>
}
function Capability({ icon, title, text }: { icon: string; title: string; text: string }) { return <article className="capability-card"><span>{icon}</span><div><h3>{title}</h3><p>{text}</p></div><ArrowUpRight size={15} /></article> }

function LoginPage() {
  const { login, error, clearError } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [validation, setValidation] = useState('')
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); clearError(); setValidation('')
    if (!/^\S+@\S+\.\S+$/.test(email.trim()) || !password) { setValidation('Enter a valid work email and password.'); return }
    setBusy(true)
    const result = await login(email.trim(), password)
    setBusy(false)
    if (result === 'mfa') navigate('/mfa', { replace: true })
    else if (result === 'enroll') navigate('/mfa/enroll', { replace: true })
    else if (result === 'authenticated') navigate((location.state as { from?: string } | null)?.from || '/app', { replace: true })
  }
  return <AuthFrame><div className="auth-brand"><span className="brand-mark"><Shield size={17} /></span><span className="brand-name">mule<span>shield</span></span></div><div className="auth-eyebrow"><LockKeyhole size={13} /> SECURE WORKSPACE ACCESS</div><h1>Welcome back.</h1><p className="auth-description">Sign in using the account provisioned for your organization.</p><form className="auth-form" onSubmit={submit} noValidate><label htmlFor="email">Work email</label><input id="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@organization.com" required /><label htmlFor="password">Password</label><div className="password-field"><input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /><button type="button" onClick={() => setShowPassword((value) => !value)}>{showPassword ? 'Hide' : 'Show'}</button></div><div className="form-aux"><span>Accounts are provisioned by an administrator.</span><span>Forgot password? Contact your administrator.</span></div>{(validation || error) && <div className="form-error" role="alert">{validation || error}</div>}<button className="button-primary auth-submit" type="submit" disabled={busy}>{busy ? <><span className="button-spinner" /> Verifying credentials…</> : <>Sign in securely <ArrowRight size={15} /></>}</button></form><Link className="back-link" to="/">← Back to MuleShield</Link><p className="auth-footnote">Protected workspace · Session cookies are HttpOnly</p></AuthFrame>
}
function MfaPage() {
  const { verifyMfa, error, clearError, user } = useAuth()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [validation, setValidation] = useState('')
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); clearError(); setValidation('')
    if (!/^(\d{6}|[A-Fa-f0-9]{10})$/.test(code.trim())) { setValidation('Enter a six-digit authenticator code or an unused recovery code.'); return }
    setBusy(true); const ok = await verifyMfa(code.trim()); setBusy(false)
    if (ok) navigate('/app', { replace: true })
  }
  useEffect(() => { if (user) navigate('/app', { replace: true }) }, [user, navigate])
  return <AuthFrame><div className="auth-brand"><span className="brand-mark"><Fingerprint size={17} /></span><span className="brand-name">mule<span>shield</span></span></div><div className="auth-eyebrow"><ShieldCheck size={13} /> MULTIFACTOR VERIFICATION</div><h1>Verify it’s you.</h1><p className="auth-description">Enter the current six-digit code from your authenticator app. You may also use an unused recovery code.</p><form className="auth-form" onSubmit={submit}><label htmlFor="totp">Authenticator or recovery code</label><input className="totp-input" id="totp" autoComplete="one-time-code" inputMode="text" maxLength={10} value={code} onChange={(event) => setCode(event.target.value)} placeholder="000000" autoFocus />{(validation || error) && <div className="form-error" role="alert">{validation || error}</div>}<button className="button-primary auth-submit" type="submit" disabled={busy}>{busy ? 'Verifying…' : <>Verify and continue <ArrowRight size={15} /></>}</button></form><Link className="back-link" to="/login">← Return to sign in</Link><p className="auth-footnote">Verification challenges expire after five minutes.</p></AuthFrame>
}
function MfaEnrollmentPage() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [qr, setQr] = useState('')
  const [manualKey, setManualKey] = useState('')
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void apiRequest<{ provisioningUri: string; manualKey: string }>('/api/auth/mfa/enroll/start', {})
      .then(async (result) => {
        const image = await QRCode.toDataURL(result.provisioningUri, { width: 220, margin: 2, color: { dark: '#10211f', light: '#ffffff' } })
        if (active) { setQr(image); setManualKey(result.manualKey) }
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'MFA enrollment could not start.') })
    return () => { active = false }
  }, [])
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      const result = await apiRequest<{ recoveryCodes: string[] }>('/api/auth/mfa/enroll/confirm', { code })
      setRecoveryCodes(result.recoveryCodes)
      await refresh()
      setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'MFA enrollment could not be verified.') }
    finally { setBusy(false) }
  }
  return <AuthFrame><div className="auth-brand"><span className="brand-mark"><Fingerprint size={17} /></span><span className="brand-name">mule<span>shield</span></span></div><div className="auth-eyebrow"><ShieldCheck size={13} /> MFA ENROLLMENT REQUIRED</div><h1>{recoveryCodes.length ? 'MFA is enabled.' : 'Secure your account.'}</h1><p className="auth-description">{recoveryCodes.length ? 'Save these one-time recovery codes somewhere secure. They will not be shown again.' : 'Authenticator enrollment is required before using the workspace. Scan the QR code, then verify a current six-digit code.'}</p>{!recoveryCodes.length&&qr&&<img className="enrollment-qr" src={qr} alt="Authenticator enrollment QR code"/>}{!recoveryCodes.length&&manualKey&&<details><summary>Can’t scan the QR code?</summary><code className="manual-key">{manualKey}</code></details>}{recoveryCodes.length>0?<><div className="recovery-grid">{recoveryCodes.map(item=><code key={item}>{item}</code>)}</div><button className="button-secondary" onClick={()=>void navigator.clipboard.writeText(recoveryCodes.join('\n'))}>Copy recovery codes</button><button className="button-primary auth-submit" onClick={()=>navigate('/app',{replace:true})}>Continue to workspace</button></>:<form className="auth-form" onSubmit={submit}><label htmlFor="enroll-required-code">Authenticator code</label><input id="enroll-required-code" className="totp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event)=>setCode(event.target.value.replace(/\D/g,''))} placeholder="000000" disabled={!qr}/>{error&&<div className="form-error" role="alert">{error}</div>}<button className="button-primary auth-submit" disabled={busy||code.length!==6||!qr}>{busy?'Verifying…':'Verify and enable MFA'}</button></form>}</AuthFrame>
}
function AuthFrame({ children }: { children: React.ReactNode }) { return <main className="auth-page"><div className="auth-decoration"><div className="decoration-ring ring-a" /><div className="decoration-ring ring-b" /><div className="decoration-core"><Shield size={40} /></div><span className="decoration-caption">CONTROLLED ACCESS · AUDITED SESSIONS</span></div><section className="auth-card">{children}</section></main> }

function SecurityPage() {
  const { user, refresh, logout } = useAuth()
  const [qr, setQr] = useState('')
  const [manualKey, setManualKey] = useState('')
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  async function beginEnrollment() {
    setError(''); setMessage(''); setBusy(true)
    try { const result = await apiRequest<{ provisioningUri: string; manualKey: string }>('/api/auth/mfa/enroll/start', {}); setManualKey(result.manualKey); setQr(await QRCode.toDataURL(result.provisioningUri, { width: 220, margin: 2, color: { dark: '#10211f', light: '#ffffff' } })) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Enrollment could not start.') }
    finally { setBusy(false) }
  }
  async function confirmEnrollment(event: React.FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    try { const result = await apiRequest<{ recoveryCodes: string[] }>('/api/auth/mfa/enroll/confirm', { code }); setRecoveryCodes(result.recoveryCodes); setMessage('Authenticator enrollment completed. Save your recovery codes now.'); await refresh() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Code verification failed.') }
    finally { setBusy(false) }
  }
  async function changePassword(event: React.FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    try { await apiRequest('/api/auth/password/change', { currentPassword: password, newPassword }); setMessage('Password changed. Your prior sessions have been invalidated; sign in again.'); await logout() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Password update failed.') }
    finally { setBusy(false) }
  }
  return <AccountFrame title="Security settings" subtitle="Manage the protections on your MuleShield account."><div className="settings-panel"><div className="settings-panel-heading"><div className="security-icon"><Fingerprint size={18} /></div><div><strong>Authenticator app</strong><span>Time-based one-time password (TOTP)</span></div><span className={`status-tag ${user?.mfaEnabled ? 'enabled' : 'disabled'}`}>{user?.mfaEnabled ? 'Enabled' : 'Not enabled'}</span></div><p>Connect an authenticator app such as Google Authenticator or Microsoft Authenticator. Codes are verified on the MuleShield server.</p>{user?.mfaEnabled ? <p className="form-success">MFA is enabled on this account.</p> : !qr ? <button className="button-primary" onClick={beginEnrollment} disabled={busy}>{busy ? 'Preparing secure enrollment…' : 'Begin enrollment'} <ArrowRight size={14} /></button> : <form className="enroll-form" onSubmit={confirmEnrollment}><p>Scan this QR code in your authenticator app, then enter its current six-digit code.</p><img className="enrollment-qr" src={qr} alt="Authenticator enrollment QR code" /><details><summary>Can’t scan the QR code?</summary><code className="manual-key">{manualKey}</code></details><label htmlFor="enroll-code">Verification code</label><input id="enroll-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} /><button className="button-primary" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Confirm and enable MFA'}</button></form>}{recoveryCodes.length > 0 && <div className="recovery-box"><strong>Save these recovery codes now</strong><p>Each code works once. They will not be shown again.</p><div className="recovery-grid">{recoveryCodes.map((item) => <code key={item}>{item}</code>)}</div><button className="button-secondary" onClick={() => navigator.clipboard.writeText(recoveryCodes.join('\n'))}>Copy codes</button></div>}</div><div className="settings-panel"><div className="settings-panel-heading"><div className="security-icon"><LockKeyhole size={17} /></div><div><strong>Change password</strong><span>Reauthentication is required</span></div></div><form className="password-change-form" onSubmit={changePassword}><label htmlFor="current-password">Current password</label><input id="current-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /><label htmlFor="new-password">New password</label><input id="new-password" type="password" autoComplete="new-password" minLength={14} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /><small>Use 14–128 characters. Changing your password ends all active sessions.</small><button className="button-secondary" disabled={busy}>Update password</button></form></div>{message && <div className="form-success" role="status">{message}</div>}{error && <div className="form-error" role="alert">{error}</div>}</AccountFrame>
}
function ProfilePage() { const { user } = useAuth(); return <AccountFrame title="Profile" subtitle="Your provisioned identity and access level."><div className="profile-details">{[['Name', user?.name], ['Email', user?.email], ['Assigned role', user?.role], ['Account created', user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'], ['Authenticator MFA', user?.mfaEnabled ? 'Enabled' : 'Not enabled']].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></AccountFrame> }
function AccountFrame({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) { const { user, logout } = useAuth(); return <main className="account-page"><header className="account-header"><Link className="brand" to="/app"><span className="brand-mark"><Shield size={17} /></span><span className="brand-name">mule<span>shield</span></span></Link><div><span>{user?.name} · {user?.role}</span><Link to="/app">Dashboard</Link><button onClick={() => void logout()}>Sign out</button></div></header><section className="account-content"><div className="card-kicker">ACCOUNT & ACCESS</div><h1>{title}</h1><p>{subtitle}</p>{children}</section></main> }

export default function AppRoutes() { return <BrowserRouter><AuthProvider><Routes><Route path="/" element={<LandingPage />} /><Route path="/login" element={<LoginPage />} /><Route path="/mfa" element={<MfaPage />} /><Route path="/mfa/enroll" element={<MfaEnrollmentPage />} /><Route path="/app" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} /><Route path="/app/investigations" element={<ProtectedRoute><InvestigationListPage /></ProtectedRoute>} /><Route path="/app/investigations/new" element={<ProtectedRoute><NewInvestigationPage /></ProtectedRoute>} /><Route path="/app/investigations/:id" element={<ProtectedRoute><InvestigationDetailPage /></ProtectedRoute>} /><Route path="/app/cases" element={<ProtectedRoute><InvestigationListPage title="Cases" /></ProtectedRoute>} /><Route path="/app/alerts" element={<ProtectedRoute><AlertsPage /></ProtectedRoute>} /><Route path="/app/reports" element={<ProtectedRoute><ReportsPage /></ProtectedRoute>} /><Route path="/app/monitoring" element={<ProtectedRoute><MonitoringPage /></ProtectedRoute>} /><Route path="/app/security" element={<ProtectedRoute><SecurityPage /></ProtectedRoute>} /><Route path="/app/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} /><Route path="/app/admin/*" element={<ProtectedRoute admin><AdminNotice /></ProtectedRoute>} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></AuthProvider></BrowserRouter> }
function AdminNotice() {
  const [users, setUsers] = useState<{id:string;email:string;name:string;role:string;enabled:number;mfa_enabled:number}[]>([])
  const [events, setEvents] = useState<{id:string;event_type:string;timestamp:string;actor_id:string|null;success:boolean}[]>([])
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('ANALYST')
  const [userSearch, setUserSearch] = useState('')
  const [auditSearch, setAuditSearch] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [roleChanges, setRoleChanges] = useState<Record<string, string>>({})
  const [changingRole, setChangingRole] = useState<string | null>(null)
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [loadingAudit, setLoadingAudit] = useState(true)
  async function load() {
    setLoadingUsers(true)
    setLoadingAudit(true)
    try {
      const result = await apiRequest<{users:typeof users}>('/api/admin/users')
      setUsers(result.users)
      setRoleChanges(Object.fromEntries(result.users.map(item => [item.id, item.role])))
      setLoadingUsers(false)
      const audit = await apiRequest<{events:typeof events}>('/api/admin/audit')
      setEvents(audit.events)
      setError('')
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Administrator data unavailable.') }
    finally { setLoadingUsers(false); setLoadingAudit(false) }
  }
  useEffect(() => { void load() }, [])
  async function provision(event: React.FormEvent) {
    event.preventDefault(); setError(''); setNotice('')
    try { await apiRequest('/api/admin/users', { email, name, password, role }); setEmail(''); setName(''); setPassword(''); setNotice('Account provisioned. Share the temporary password through an approved secure channel; the user should change it after signing in.'); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Account provisioning failed.') }
  }
  async function setEnabled(id: string, enabled: boolean) {
    const account = users.find(item => item.id === id)
    const action = enabled ? 'reactivate' : 'disable'
    if (!window.confirm(`Are you sure you want to ${action} ${account?.email || 'this account'}?`)) return
    setError('')
    setNotice('')
    try { await apiRequest(`/api/admin/users/${id}`, { enabled }, 'PATCH'); setNotice(`Account ${enabled ? 'reactivated' : 'disabled'}.`); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Account update failed.') }
  }
  async function changeRole(id: string) {
    const role = roleChanges[id]
    if (!role) return
    const account = users.find(item => item.id === id)
    if (!window.confirm(`Change ${account?.email || 'this account'} to ${role === 'ADMINISTRATOR' ? 'Administrator' : 'Analyst'}? Their existing sessions and MFA challenges will be revoked.`)) return
    setError('')
    setNotice('')
    setChangingRole(id)
    try {
      await apiRequest(`/api/admin/users/${id}`, { role }, 'PATCH')
      setNotice(`Role updated. The user's existing sessions and MFA challenges were revoked; they must sign in again.`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Role update failed.')
    } finally {
      setChangingRole(null)
    }
  }
  const normalizedUserSearch = userSearch.trim().toLowerCase()
  const visibleUsers = users.filter(item => `${item.name} ${item.email} ${item.role}`.toLowerCase().includes(normalizedUserSearch))
  const normalizedAuditSearch = auditSearch.trim().toLowerCase()
  const visibleEvents = events.filter(item => `${item.event_type} ${item.actor_id || ''} ${item.success ? 'success' : 'failure'}`.toLowerCase().includes(normalizedAuditSearch))
  const activeUsers = users.filter(item => item.enabled === 1).length
  const failedEvents = events.filter(item => !item.success).length
  const roleEvents = events.filter(item => item.event_type === 'ADMIN_USER_ROLE_CHANGED').length
  return <AccountFrame title="Administrator console" subtitle="Provision accounts and review security audit events.">
    <div className="admin-summary-grid" aria-label="Security overview">
      <article><span>Provisioned accounts</span><strong>{loadingUsers ? '—' : users.length}</strong></article>
      <article><span>Active accounts</span><strong>{loadingUsers ? '—' : activeUsers}</strong></article>
      <article><span>Failed events · latest 200</span><strong>{loadingAudit ? '—' : failedEvents}</strong></article>
      <article><span>Role changes · latest 200</span><strong>{loadingAudit ? '—' : roleEvents}</strong></article>
    </div>
    <div className="settings-panel">
      <h2>Provision account</h2>
      <p>New accounts must enroll MFA before accessing the workspace. Use a unique initial password and share it through an approved secure channel.</p>
      <form className="password-change-form" onSubmit={provision}>
        <label htmlFor="admin-name">Name</label><input id="admin-name" value={name} onChange={event => setName(event.target.value)} required maxLength={120}/>
        <label htmlFor="admin-email">Email</label><input id="admin-email" type="email" value={email} onChange={event => setEmail(event.target.value)} required/>
        <label htmlFor="admin-password">Initial password · 14–128 characters</label><input id="admin-password" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required minLength={14} maxLength={128}/>
        <label htmlFor="admin-role">Role</label><select id="admin-role" value={role} onChange={event => setRole(event.target.value)}><option value="ANALYST">Analyst</option><option value="ADMINISTRATOR">Administrator</option></select>
        <button className="button-primary">Provision account</button>
      </form>
    </div>
    {error&&<div className="form-error" role="alert">{error}</div>}
    {notice&&<div className="form-success" role="status">{notice}</div>}
    <div className="settings-panel">
      <h2>Provisioned accounts</h2>
      <p>Role changes revoke the affected user's existing sessions and MFA challenges. Server-side authorization remains authoritative.</p>
      <label className="admin-search-label" htmlFor="user-search">Search accounts</label>
      <input id="user-search" className="admin-search" type="search" value={userSearch} onChange={event => setUserSearch(event.target.value)} placeholder="Search name, email, or role"/>
      <div className="table-scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>MFA</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {loadingUsers&&<tr><td colSpan={6}>Loading accounts…</td></tr>}
        {!loadingUsers&&visibleUsers.length===0&&<tr><td colSpan={6}>{users.length===0?'No accounts found.':'No accounts match your search.'}</td></tr>}
        {visibleUsers.map(item=><tr key={item.id}>
          <td>{item.name}</td><td>{item.email}</td>
          <td><strong>{item.role==='ADMINISTRATOR'?'Administrator':'Analyst'}</strong><div className="admin-role-controls">
            <select aria-label={`Change role for ${item.email}`} value={roleChanges[item.id]||item.role} disabled={loadingUsers||changingRole!==null} onChange={event=>setRoleChanges(current=>({...current,[item.id]:event.target.value}))}><option value="ANALYST">Analyst</option><option value="ADMINISTRATOR">Administrator</option></select>
            <button className="button-secondary" disabled={loadingUsers||changingRole!==null||roleChanges[item.id]===item.role} onClick={()=>void changeRole(item.id)}>{changingRole===item.id?'Saving role…':'Change role'}</button>
          </div></td>
          <td>{item.mfa_enabled?'Enabled':'Not enabled'}</td><td>{item.enabled===1?'Enabled':'Disabled'}</td>
          <td><button className="button-secondary" disabled={item.enabled===1||changingRole!==null} onClick={()=>void setEnabled(item.id,true)}>Reactivate</button><button className="button-secondary" disabled={item.enabled===0||changingRole!==null} onClick={()=>void setEnabled(item.id,false)}>Disable</button></td>
        </tr>)}
      </tbody></table></div>
    </div>
    <div className="settings-panel">
      <h2>Recent audit events</h2><p>Most recent 200 security events recorded by the local API.</p>
      <label className="admin-search-label" htmlFor="audit-search">Filter audit events</label>
      <input id="audit-search" className="admin-search" type="search" value={auditSearch} onChange={event => setAuditSearch(event.target.value)} placeholder="Search event, actor, or result"/>
      <div className="table-scroll"><table><thead><tr><th>Event</th><th>Timestamp</th><th>Actor ID</th><th>Result</th></tr></thead><tbody>
        {loadingAudit&&<tr><td colSpan={4}>Loading audit events…</td></tr>}
        {!loadingAudit&&visibleEvents.length===0&&<tr><td colSpan={4}>{events.length===0?'No audit events recorded.':'No events match your filter.'}</td></tr>}
        {visibleEvents.map(item=><tr key={item.id}><td>{item.event_type}</td><td>{new Date(item.timestamp).toLocaleString()}</td><td>{item.actor_id||'—'}</td><td>{item.success?'Success':'Failure'}</td></tr>)}
      </tbody></table></div>
    </div>
  </AccountFrame>
}
