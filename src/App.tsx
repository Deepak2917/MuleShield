import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  Bell,
  FileText,
  Fingerprint,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Network,
  Shield,
  ShieldAlert,
} from 'lucide-react'
import './App.css'
import NetworkPreview from './components/NetworkPreview'
import { Link } from 'react-router-dom'
import { apiRequest, useAuth } from './auth/AuthContext'

function Dashboard() {
  const { user, logout } = useAuth()
  const [overview, setOverview] = useState<{ investigations: { id: string; title: string; status: string }[]; findings: { id: string; rule_name: string; severity: string; investigation_id: string; investigation_title: string }[] } | null>(null)
  const [overviewError, setOverviewError] = useState('')
  const [overviewLoading, setOverviewLoading] = useState(true)
  useEffect(() => {
    let active = true
    void Promise.all([
      apiRequest<{ investigations: { id: string; title: string; status: string }[] }>('/api/investigations'),
      apiRequest<{ findings: { id: string; rule_name: string; severity: string; investigation_id: string; investigation_title: string }[] }>('/api/alerts'),
    ]).then(([cases, alerts]) => {
      if (active) setOverview({ investigations: cases.investigations, findings: alerts.findings })
    }).catch(reason => {
      if (active) setOverviewError(reason instanceof Error ? reason.message : 'Workspace summary could not be loaded.')
    }).finally(() => {
      if (active) setOverviewLoading(false)
    })
    return () => { active = false }
  }, [])
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="MuleShield home">
          <span className="brand-mark"><Shield size={17} strokeWidth={2.2} /></span>
          <span className="brand-name">mule<span>shield</span></span>
        </a>
        <div className="workspace-switcher">
          <span className="workspace-icon"><Shield size={15} /></span>
          <span className="workspace-copy"><strong>Local demo workspace</strong><small>Imported case data</small></span>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <a className="nav-item active" href="#overview"><LayoutDashboard size={17} /><span>Overview</span></a>
          <Link className="nav-item" to="/app/investigations"><Network size={17} /><span>Manual Investigation</span></Link>
          <Link className="nav-item" to="/app/monitoring"><Fingerprint size={17} /><span>Live Monitoring</span></Link>
          <Link className="nav-item" to="/app/cases"><FolderOpen size={17} /><span>Cases</span></Link>
          <Link className="nav-item" to="/app/alerts"><ShieldAlert size={17} /><span>Alerts</span></Link>
          <Link className="nav-item" to="/app/reports"><FileText size={17} /><span>Reports</span></Link>
          {user?.role === 'ADMINISTRATOR' && <Link className="nav-item" to="/app/admin"><Shield size={17} /><span>Admin</span></Link>}
        </nav>
        <div className="sidebar-bottom">
          <Link className="profile-row" to="/app/profile"><div className="avatar">{user?.name.slice(0, 2).toUpperCase() || 'MS'}</div><span className="profile-copy"><strong>{user?.name}</strong><small>{user?.role}</small></span></Link>
        </div>
      </aside>

      <main className="main-panel" id="home">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>Overview</strong></div>
          <div className="topbar-actions">
            <span className="environment-pill"><i /> DEMO DATA · No live source configured</span>
            <Link className="icon-button" to="/app/profile" aria-label="Account profile"><Fingerprint size={17} /></Link>
            <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void logout()}><LogOut size={16} /></button>
          </div>
        </header>

        <div className="content-wrap" id="overview">
          <motion.section className="welcome-row" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}>
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> FINANCIAL CRIME INTELLIGENCE</div>
              <h1>See the network.<br /><span>Stop the mule.</span></h1>
              <p className="welcome-description">Find the hidden connections behind suspicious activity.<br className="desktop-break" /> One network, a clearer picture.</p>
              <div className="welcome-actions"><Link className="button-primary" to="/app/investigations/new">Start investigation <ArrowRight size={15} /></Link><Link className="button-secondary" to="/app/monitoring">Open monitoring</Link></div>
            </div>
            <div className="hero-stamp" aria-hidden="true"><div className="stamp-orbit orbit-one" /><div className="stamp-orbit orbit-two" /><div className="stamp-core"><Shield size={27} strokeWidth={1.4} /></div><span className="stamp-dot" /></div>
          </motion.section>

          {overviewError&&<div className="dashboard-error" role="alert">{overviewError}</div>}
          <section className="metrics-grid" aria-label="Case-based workspace metrics">
            <MetricCard label="Cases" value={overviewLoading?'—':String(overview?.investigations.length ?? 0)} icon={<FolderOpen size={16} />} tone="cyan" note="Persisted investigations" />
            <MetricCard label="Open cases" value={overviewLoading?'—':String(overview?.investigations.filter(item=>item.status!=='CLOSED').length ?? 0)} icon={<Network size={16} />} tone="teal" note="Not marked closed" />
            <MetricCard label="Review findings" value={overviewLoading?'—':String(overview?.findings.length ?? 0)} icon={<ShieldAlert size={16} />} tone="amber" note="Deterministic, case-derived" />
          </section>

          <section className="operating-modes" aria-label="Choose an operating mode">
            <Link className="mode-card manual-mode" to="/app/investigations"><span className="mode-icon"><Network size={18} /></span><span className="mode-copy"><span className="card-kicker">MODE A · CASE-BASED</span><strong>Manual Investigation</strong><small>Upload transaction records, investigate suspicious flows, and explore connected accounts.</small></span><span className="mode-action">Start Investigation <ArrowRight size={14} /></span></Link>
            <Link className="mode-card realtime-mode" to="/app/monitoring"><span className="mode-icon"><Fingerprint size={18} /></span><span className="mode-copy"><span className="card-kicker">MODE B · EVENT CONSOLE</span><strong>Real-Time Monitoring</strong><small>Review monitoring status. No live banking or Kafka source is currently configured.</small></span><span className="mode-action">Open Monitoring <ArrowRight size={14} /></span></Link>
          </section>

          <section className="lower-grid">
            <div className="network-card" id="network">
              <div className="section-heading"><div><div className="card-kicker">RELATIONSHIP INTELLIGENCE</div><h2>Illustrative network</h2></div><span className="demo-caption">Not transaction evidence</span></div>
              <NetworkPreview />
              <div className="network-footer"><span><i className="legend-dot dot-account" /> Illustrative accounts</span><span><i className="legend-dot dot-transfer" /> Decorative paths</span><span className="demo-caption">Synthetic sample</span></div>
            </div>
            <div className="signal-card" id="monitoring">
              <div className="section-heading signal-heading"><div><div className="card-kicker">CASE REVIEW</div><h2>Recent findings</h2></div><Link className="text-link" to="/app/alerts">View findings <ArrowRight size={13} /></Link></div>
              {overviewLoading?<p className="dashboard-empty">Loading findings…</p>:overview?.findings.length?<div className="signal-list">{overview.findings.slice(0,3).map(item=><Link className="case-list-row" to={`/app/investigations/${item.investigation_id}`} key={item.id}><strong>{item.rule_name}</strong><span>{item.investigation_title} · {item.severity}</span><ArrowRight size={14}/></Link>)}</div>:<p className="dashboard-empty">No case findings yet. Import a dataset and run analysis to create review signals.</p>}
              <div className="signal-disclaimer"><Bell size={13} /> Findings come only from analyzed case uploads; no live feed is connected.</div>
            </div>
          </section>
          <footer className="page-footer"><span><span className="footer-status" /> Systems nominal</span><span>MuleShield <span className="footer-separator">·</span> Demo workspace <span className="footer-separator">·</span> Data shown is synthetic</span></footer>
        </div>
      </main>
    </div>
  )
}

function MetricCard({ label, value, icon, tone, note }: { label: string; value: string; icon: React.ReactNode; tone: string; note: string }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}>{icon}</span></div><div className="metric-bottom"><strong>{value}</strong></div><div className="metric-note">{note}</div></article>
}

export default Dashboard
