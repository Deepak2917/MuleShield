import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Activity, AlertTriangle, ArrowLeft, ArrowRight, Download, Network, Plus, RefreshCw, ShieldAlert } from 'lucide-react'
import { apiRequest, useAuth } from './auth/AuthContext'
import './workflows.css'
type CaseRow={id:string;title:string;description:string;status:string;created_at:string;updated_at:string}
type Finding={id:string;rule_name:string;severity:string;explanation:string;supporting_transaction_ids:string[];threshold:string;recommended_next_step:string}
type AlertFinding=Finding&{investigation_id:string;investigation_title:string;investigation_status:string;created_at:string}
function Frame({title,children}:{title:string;children:React.ReactNode}){const{user}=useAuth();return <main className="workflow-page"><header className="workflow-header"><Link className="workflow-brand" to="/app">Mule<span>Shield</span></Link><nav aria-label="Workspace navigation"><Link to="/app">Overview</Link><Link to="/app/investigations">Manual Investigation</Link><Link to="/app/monitoring">Live Monitoring</Link><Link to="/app/cases">Cases</Link><Link to="/app/alerts">Alerts</Link><Link to="/app/reports">Reports</Link>{user?.role==='ADMINISTRATOR'&&<Link to="/app/admin">Admin</Link>}<Link to="/app/security">Security</Link></nav></header><section className="workflow-content"><Link className="workflow-back" to="/app"><ArrowLeft size={14}/> Overview</Link><div className="card-kicker">MULESHIELD · INVESTIGATION WORKSPACE</div><h1>{title}</h1>{children}</section></main>}
export function InvestigationListPage({title='Manual investigations'}:{title?:string}){const[cases,setCases]=useState<CaseRow[]>([]);const[error,setError]=useState('');const[loading,setLoading]=useState(true);useEffect(()=>{void apiRequest<{investigations:CaseRow[]}>('/api/investigations').then(x=>setCases(x.investigations)).catch(e=>setError(e.message)).finally(()=>setLoading(false))},[]);return <Frame title={title}><p>Persisted cases are scoped to your account.</p><Link className="button-primary" to="/app/investigations/new"><Plus size={14}/> New investigation</Link>{error&&<div className="workflow-error" role="alert">{error}</div>}{loading?<p>Loading cases…</p>:cases.length===0?<div className="workflow-empty"><Network/><strong>No cases yet</strong><span>Create a case to start a dataset-backed investigation.</span></div>:<div className="case-list">{cases.map(c=><Link className="case-list-row" to={`/app/investigations/${c.id}`} key={c.id}><strong>{c.title}</strong><span>{c.status} · {new Date(c.updated_at).toLocaleString()}</span><ArrowRight size={14}/></Link>)}</div>}</Frame>}
export function AlertsPage(){const[findings,setFindings]=useState<AlertFinding[]>([]);const[error,setError]=useState('');const[loading,setLoading]=useState(true);useEffect(()=>{void apiRequest<{findings:AlertFinding[]}>('/api/alerts').then(result=>setFindings(result.findings)).catch(reason=>setError(reason instanceof Error?reason.message:'Review signals could not be loaded.')).finally(()=>setLoading(false))},[]);return <Frame title="Review signals"><p>Signals are deterministic rules applied only to imported case records. They are review prompts, not proof of fraud or live monitoring alerts.</p>{error&&<div className="workflow-error" role="alert">{error}</div>}{loading?<p>Loading case findings…</p>:findings.length===0?<div className="workflow-empty"><ShieldAlert/><strong>No review signals yet</strong><span>Import transactions into a case and run analysis to produce findings.</span></div>:<div className="settings-panel"><div className="table-scroll"><table><thead><tr><th>Rule</th><th>Severity</th><th>Case</th><th>Explanation</th><th>Supporting records</th><th>Review</th></tr></thead><tbody>{findings.map(item=><tr key={item.id}><td>{item.rule_name}</td><td>{item.severity}</td><td>{item.investigation_title}</td><td className="alert-explanation">{item.explanation}</td><td>{item.supporting_transaction_ids.length}</td><td><Link to={`/app/investigations/${item.investigation_id}`}>Open case</Link></td></tr>)}</tbody></table></div></div>}</Frame>}
export function ReportsPage(){const[cases,setCases]=useState<CaseRow[]>([]);const[error,setError]=useState('');const[loading,setLoading]=useState(true);const[exporting,setExporting]=useState<string|null>(null);useEffect(()=>{void apiRequest<{investigations:CaseRow[]}>('/api/investigations').then(result=>setCases(result.investigations)).catch(reason=>setError(reason instanceof Error?reason.message:'Cases could not be loaded.')).finally(()=>setLoading(false))},[]);async function download(id:string){setError('');setExporting(id);try{const result=await apiRequest<{report:object}>(`/api/investigations/${id}/report`);const url=URL.createObjectURL(new Blob([JSON.stringify(result.report,null,2)],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=`muleshield-report-${id}.json`;anchor.click();URL.revokeObjectURL(url)}catch(reason){setError(reason instanceof Error?reason.message:'Report could not be generated.')}finally{setExporting(null)}}return <Frame title="Investigation reports"><p>Generate evidence-linked JSON reports from persisted case data. Reports identify source coverage and limitations.</p>{error&&<div className="workflow-error" role="alert">{error}</div>}{loading?<p>Loading cases…</p>:cases.length===0?<div className="workflow-empty"><Download/><strong>No reports available</strong><span>Create an investigation to generate its report.</span></div>:<div className="case-list">{cases.map(item=><article className="report-list-row" key={item.id}><div><strong>{item.title}</strong><span>{item.status} · Updated {new Date(item.updated_at).toLocaleString()}</span></div><button className="button-secondary" disabled={exporting!==null} onClick={()=>void download(item.id)}>{exporting===item.id?'Preparing report…':'Download report'} <Download size={14}/></button></article>)}</div>}</Frame>}
export function NewInvestigationPage(){const navigate=useNavigate();const[title,setTitle]=useState('');const[description,setDescription]=useState('');const[error,setError]=useState('');async function submit(e:React.FormEvent){e.preventDefault();try{const r=await apiRequest<{investigation:CaseRow}>('/api/investigations',{title,description,currency:'USD'});navigate(`/app/investigations/${r.investigation.id}`)}catch(x){setError(x instanceof Error?x.message:'Create failed.')}}return <Frame title="Create an investigation"><form className="case-form" onSubmit={submit}><label>Case title<input required minLength={3} maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Description<textarea value={description} onChange={e=>setDescription(e.target.value)} maxLength={4000} rows={4}/></label>{error&&<div className="workflow-error">{error}</div>}<button className="button-primary">Create case <ArrowRight size={14}/></button></form></Frame>}
export { InvestigationDetailPage } from './InvestigationDetailPage'

type MonitoringState={
  status:string
  environment:string
  source:string
  kafka:{configured:boolean;connected:boolean}
  eventsReceived:number
  eventsProcessed:number
  processingErrors:number
  alertsGenerated:number
  recentEvents:unknown[]
  recentAlerts:unknown[]
}
type ApiHealth={status:string;environment:string;liveSourceConfigured:boolean}
export function MonitoringPage(){
  const[state,setState]=useState<MonitoringState|null>(null)
  const[health,setHealth]=useState<ApiHealth|null>(null)
  const[error,setError]=useState('')
  const[notice,setNotice]=useState('')
  const[busy,setBusy]=useState(false)
  useEffect(()=>{
    let active=true
    async function refresh(){
      const results=await Promise.allSettled([
        apiRequest<MonitoringState>('/api/monitoring/status'),
        apiRequest<ApiHealth>('/api/health'),
      ])
      if(!active)return
      if(results[0].status==='fulfilled'){setState(results[0].value);setError('')}
      else setError(results[0].reason instanceof Error?results[0].reason.message:'Monitoring unavailable.')
      if(results[1].status==='fulfilled')setHealth(results[1].value)
    }
    void refresh()
    const timer=window.setInterval(()=>void refresh(),5000)
    return ()=>{active=false;window.clearInterval(timer)}
  },[])
  async function control(action:'start'|'pause'|'resume'|'stop'){
    setError('')
    setNotice('')
    setBusy(true)
    try{
      const result=await apiRequest<{status:string;notice:string}>(`/api/monitoring/${action}`,{})
      setState(current=>current?{...current,status:result.status}:current)
      setNotice(result.notice)
    }catch(reason){
      setError(reason instanceof Error?reason.message:'Monitoring control failed.')
    }finally{
      setBusy(false)
    }
  }
  const status=state?.status||'STOPPED'
  return <Frame title="Real-Time Monitoring">
    {error&&<div className="workflow-error" role="alert">{error}</div>}
    <div className="monitoring-banner">
      <strong>Backend health: {health?.status||'Unavailable'} · {health?.environment||''}</strong>
      <span>Backend source: {state?.source||'Not available'} · Kafka configured: {String(state?.kafka.configured??'unknown')} · connected: {String(state?.kafka.connected??'unknown')}</span>
      <b>{health?.liveSourceConfigured?'LIVE SOURCE CONFIGURED':'NO LIVE SOURCE'}</b>
    </div>
    {notice&&<div className="workflow-notice" role="status">{notice}</div>}
    <section className="workflow-panel">
      <h2><Activity size={14}/> Demo console · {status}</h2>
      <p>Controls update demo state only; no bank, Kafka, or event bus is connected unless the backend reports a configured source.</p>
      <div className="monitoring-controls">
        <button type="button" disabled={busy||status!=='STOPPED'} onClick={()=>void control('start')}>Start</button>
        <button type="button" disabled={busy||status!=='RUNNING'} onClick={()=>void control('pause')}>Pause</button>
        <button type="button" disabled={busy||status!=='PAUSED'} onClick={()=>void control('resume')}>Resume</button>
        <button type="button" disabled={busy||status==='STOPPED'} onClick={()=>void control('stop')}>Stop</button>
      </div>
    </section>
    <div className="workflow-stats">
      <div><strong>{state?.eventsReceived??'—'}</strong><span>Events received</span></div>
      <div><strong>{state?.eventsProcessed??'—'}</strong><span>Events processed</span></div>
      <div><strong>{state?.processingErrors??'—'}</strong><span>Errors</span></div>
      <div><strong>{state?.alertsGenerated??'—'}</strong><span>Alerts</span></div>
    </div>
    <div className="workflow-two-col">
      <div className="workflow-empty"><RefreshCw/><strong>{state?.recentEvents.length?'Backend events available':'No configured event stream or events available'}</strong></div>
      <div className="workflow-empty"><AlertTriangle/><strong>{state?.recentAlerts.length?'Backend alerts available':'No monitoring alerts available'}</strong></div>
    </div>
  </Frame>
}
