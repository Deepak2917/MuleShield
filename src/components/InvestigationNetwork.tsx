import { useEffect, useMemo, useRef, useState } from 'react'
import cytoscape from 'cytoscape'
import type { Core, ElementDefinition, LayoutOptions } from 'cytoscape'
import { Network, Search, ZoomIn, ZoomOut, Maximize, RotateCcw, X } from 'lucide-react'
import {
  buildInvestigationNetwork,
  deriveNetworkView,
} from '../investigationNetworkModel'
import type {
  NetworkAccount,
  NetworkFinding,
  NetworkTransaction,
} from '../investigationNetworkModel'

type Props = {
  transactions: NetworkTransaction[]
  findings: NetworkFinding[]
}

type SelectedElement =
  | { type: 'account'; accountId: string }
  | { type: 'transaction'; elementId: string }

type NodeTooltip = { accountId: string; x: number; y: number }

const severityOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']

function networkLayoutOptions(accountCount: number, fit: boolean, randomize: boolean): LayoutOptions {
  return {
    name: 'cose',
    animate: fit,
    animationDuration: 550,
    fit,
    padding: 32,
    nodeRepulsion: 12000,
    nodeOverlap: 45,
    idealEdgeLength: 175,
    edgeElasticity: 70,
    gravity: 0.12,
    numIter: Math.min(1800, 500 + accountCount * 26),
    randomize,
    componentSpacing: 150,
    nodeDimensionsIncludeLabels: true,
  }
}

function accountLabel(accountId: string) {
  return accountId.length > 22 ? `${accountId.slice(0, 9)}…${accountId.slice(-9)}` : accountId
}

function highestSeverity(findings: NetworkFinding[]) {
  return findings.map((finding) => String(finding.severity || '').toUpperCase())
    .sort((left, right) => {
      const leftIndex = severityOrder.indexOf(left)
      const rightIndex = severityOrder.indexOf(right)
      return (leftIndex < 0 ? severityOrder.length : leftIndex) - (rightIndex < 0 ? severityOrder.length : rightIndex)
    })[0] || ''
}

function displayAmount(transaction: NetworkTransaction) {
  if (typeof transaction.amount !== 'number' || !Number.isFinite(transaction.amount)) return 'Not available'
  return `${transaction.amount.toLocaleString()} ${transaction.currency?.trim() || 'Currency not provided'}`
}

function displayTimestamp(timestamp?: string | null) {
  if (!timestamp) return 'Not available'
  const parsed = new Date(timestamp)
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toLocaleString()
}

function currencyTotals(totals: NetworkAccount['incomingTotals']) {
  if (!totals.length) return 'Not available'
  return totals.map(({ currency, amount }) => `${amount.toLocaleString()} ${currency}`).join(' · ')
}

export default function InvestigationNetwork({ transactions, findings }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Core | null>(null)
  const [query, setQuery] = useState('')
  const [severityFilter, setSeverityFilter] = useState('')
  const [ruleFilter, setRuleFilter] = useState('')
  const [findingFilter, setFindingFilter] = useState('')
  const [relatedOnly, setRelatedOnly] = useState(false)
  const [focusedAccount, setFocusedAccount] = useState('')
  const [selection, setSelection] = useState<SelectedElement | null>(null)
  const [nodeTooltip, setNodeTooltip] = useState<NodeTooltip | null>(null)

  const model = useMemo(() => buildInvestigationNetwork(transactions, findings), [transactions, findings])
  const view = useMemo(() => deriveNetworkView(model, {
    search: query,
    severity: severityFilter,
    rule: ruleFilter,
    findingId: findingFilter,
    relatedOnly,
    focusedAccount,
  }), [model, query, severityFilter, ruleFilter, findingFilter, relatedOnly, focusedAccount])
  const accountById = useMemo(() => new Map(model.accounts.map((account) => [account.accountId, account])), [model.accounts])
  const transactionByElementId = useMemo(() => new Map(model.transfers.map((transfer) => [transfer.elementId, transfer])), [model.transfers])
  const findingsById = useMemo(() => new Map(model.findings.map((finding, index) => [finding.id || `finding-${index}`, finding])), [model.findings])
  const availableSeverities = useMemo(() => [...new Set(findings.map((finding) => finding.severity?.toUpperCase()).filter((value): value is string => Boolean(value)))]
    .sort((left, right) => {
      const leftIndex = severityOrder.indexOf(left)
      const rightIndex = severityOrder.indexOf(right)
      return (leftIndex < 0 ? severityOrder.length : leftIndex) - (rightIndex < 0 ? severityOrder.length : rightIndex)
    }), [findings])
  const availableRules = useMemo(() => [...new Set(findings.map((finding) => finding.rule_name).filter((value): value is string => Boolean(value)))].sort(), [findings])
  const elements = useMemo<ElementDefinition[]>(() => {
    const nodes: ElementDefinition[] = model.accounts.map((account) => ({
      group: 'nodes',
      data: {
        id: account.elementId,
        accountId: account.accountId,
        label: accountLabel(account.accountId),
        sentCount: account.sentCount,
        receivedCount: account.receivedCount,
        size: account.size,
        findingSeverity: highestSeverity(account.findingIds.flatMap((id) => {
          const finding = findingsById.get(id)
          return finding ? [finding] : []
        })),
        hasFinding: account.findingIds.length > 0,
      },
    }))
    const edges: ElementDefinition[] = model.transfers.map((transfer) => ({
      group: 'edges',
      data: {
        id: transfer.elementId,
        transactionId: transfer.transaction.transaction_id || transfer.transaction.id || transfer.elementId,
        source: accountById.get(transfer.senderAccount)?.elementId,
        target: accountById.get(transfer.receiverAccount)?.elementId,
        label: transfer.transaction.transaction_id || transfer.transaction.id || 'Transaction',
        curveOffset: transfer.curveOffset,
        findingIds: transfer.findingIds,
      },
    }))
    return [...nodes, ...edges]
  }, [model, accountById, findingsById])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !elements.length) return
    const graph = cytoscape({
      container,
      elements,
      minZoom: 0.18,
      maxZoom: 3,
      wheelSensitivity: 0.18,
      boxSelectionEnabled: true,
      selectionType: 'single',
      style: [
        {
          selector: 'node',
          style: {
            'background-color': '#3b9a91',
            'border-color': '#73cfc3',
            'border-width': 1.5,
            label: 'data(label)',
            color: '#dcebea',
            'font-size': 11,
            'font-family': 'DM Sans, sans-serif',
            'font-weight': 500,
            'text-wrap': 'ellipsis',
            'text-max-width': '160',
            'text-valign': 'bottom',
            'text-margin-y': 9,
            width: 'data(size)',
            height: 'data(size)',
            'text-outline-color': '#0b1216',
            'text-outline-width': 3,
          },
        },
        {
          selector: 'node[?hasFinding]',
          style: { 'background-color': '#bd9142', 'border-color': '#ecd18c', 'border-width': 2 },
        },
        {
          selector: 'node[findingSeverity = "HIGH"], node[findingSeverity = "CRITICAL"]',
          style: { 'background-color': '#b9544c', 'border-color': '#f0a29b', 'border-width': 2.5 },
        },
        {
          selector: 'node:selected',
          style: { 'border-color': '#ffffff', 'border-width': 3.5, 'overlay-color': '#b7eee5', 'overlay-opacity': 0.16, 'overlay-padding': 5 },
        },
        {
          selector: 'node.transaction-endpoint',
          style: { 'border-color': '#f0ca73', 'border-width': 3 },
        },
        {
          selector: 'edge',
          style: {
            width: 1.8,
            'line-color': '#56847f',
            'target-arrow-color': '#8ec2bb',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 1.15,
            'curve-style': 'unbundled-bezier',
            'control-point-distances': 'data(curveOffset)',
            'control-point-weights': 0.5,
            'line-cap': 'round',
            opacity: 0.72,
            label: 'data(label)',
            'font-size': 6,
            color: '#b5c5c3',
            'text-rotation': 'autorotate',
            'text-opacity': 0,
            'text-background-color': '#0b1216',
            'text-background-opacity': 0.85,
            'text-background-padding': '2',
          },
        },
        {
          selector: 'edge:selected',
          style: { width: 4, 'line-color': '#f0ca73', 'target-arrow-color': '#f0ca73', opacity: 1, 'text-opacity': 1, 'arrow-scale': 1.45 },
        },
        { selector: 'edge:active', style: { 'text-opacity': 1 } },
        {
          selector: '.is-dimmed',
          style: { opacity: 0.13, events: 'no' },
        },
        {
          selector: '.is-match',
          style: { 'border-color': '#ffffff', 'border-width': 3.2, opacity: 1 },
        },
        {
          selector: 'edge.is-match',
          style: { width: 3.5, 'line-color': '#f0ca73', 'target-arrow-color': '#f0ca73', opacity: 1, 'arrow-scale': 1.3 },
        },
        {
          selector: '.finding-related',
          style: { 'line-color': '#d2ad63', 'target-arrow-color': '#d2ad63', width: 2, opacity: 0.95 },
        },
      ],
      layout: networkLayoutOptions(model.accounts.length, true, true),
    })
    graphRef.current = graph
    graph.on('tap', 'node', (event) => {
      const accountId = String(event.target.data('accountId'))
      event.target.select()
      setSelection({ type: 'account', accountId })
    })
    graph.on('tap', 'edge', (event) => {
      event.target.select()
      setSelection({ type: 'transaction', elementId: String(event.target.id()) })
    })
    graph.on('tap', (event) => {
      if (event.target === graph) setSelection(null)
    })
    graph.on('mouseover', 'node', (event) => {
      const position = event.renderedPosition
      setNodeTooltip({ accountId: String(event.target.data('accountId')), x: position.x, y: position.y })
    })
    graph.on('mousemove', 'node', (event) => {
      const position = event.renderedPosition
      setNodeTooltip((current) => current
        ? { ...current, x: position.x, y: position.y }
        : { accountId: String(event.target.data('accountId')), x: position.x, y: position.y })
    })
    graph.on('mouseout', 'node', () => setNodeTooltip(null))

    let lastWidth = container.clientWidth
    let lastHeight = container.clientHeight
    let resizeFrame = 0
    const resizeObserver = new ResizeObserver(() => {
      graph.resize()
      const width = container.clientWidth
      const height = container.clientHeight
      if (Math.abs(width - lastWidth) < 2 && Math.abs(height - lastHeight) < 2) return
      lastWidth = width
      lastHeight = height
      window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(() => {
        if (graph.destroyed()) return
        const zoom = graph.zoom()
        const pan = graph.pan()
        graph.layout(networkLayoutOptions(model.accounts.length, false, false)).run()
        graph.zoom(zoom)
        graph.pan(pan)
      })
    })
    resizeObserver.observe(container)
    return () => {
      window.cancelAnimationFrame(resizeFrame)
      resizeObserver.disconnect()
      setNodeTooltip(null)
      graph.destroy()
      if (graphRef.current === graph) graphRef.current = null
    }
  }, [elements, model.accounts.length])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    graph.batch(() => {
      graph.elements().forEach((element) => {
        const isNode = element.isNode()
        const id = String(element.data(isNode ? 'accountId' : 'id'))
        const visible = isNode ? view.accountIds.has(id) : view.transferIds.has(id)
        const matched = isNode ? view.matchedAccountIds.has(id) : view.matchedTransferIds.has(id)
        element.toggleClass('is-dimmed', view.active && !visible)
        element.toggleClass('is-match', matched)
        const relatedToActiveFinding = element.data('findingIds')?.some((id: string) => {
          if (findingFilter) return id === findingFilter
          const finding = findingsById.get(id)
          return (!severityFilter || finding?.severity?.toUpperCase() === severityFilter)
            && (!ruleFilter || finding?.rule_name === ruleFilter)
        })
        element.toggleClass('finding-related', Boolean(relatedToActiveFinding))
        const isSelectedEndpoint = selection?.type === 'transaction'
          && (element.id() === accountById.get(transactionByElementId.get(selection.elementId)?.senderAccount || '')?.elementId
            || element.id() === accountById.get(transactionByElementId.get(selection.elementId)?.receiverAccount || '')?.elementId)
        element.toggleClass('transaction-endpoint', Boolean(isNode && isSelectedEndpoint))
      })
    })
  }, [view, findingFilter, severityFilter, ruleFilter, findingsById, selection, transactionByElementId, accountById])

  const selectedAccount = selection?.type === 'account' ? accountById.get(selection.accountId) : undefined
  const selectedTransfer = selection?.type === 'transaction' ? transactionByElementId.get(selection.elementId) : undefined
  const selectedTransaction = selectedTransfer?.transaction
  const selectedFinding = findingFilter ? findingsById.get(findingFilter) : undefined
  const focusedCounts = view.active
    ? { accounts: model.accounts.filter((account) => view.accountIds.has(account.accountId)).length, transfers: model.transfers.filter((transfer) => view.transferIds.has(transfer.elementId)).length }
    : { accounts: model.accounts.length, transfers: model.transfers.length }
  const resetFilters = () => {
    setQuery('')
    setSeverityFilter('')
    setRuleFilter('')
    setFindingFilter('')
    setRelatedOnly(false)
    setFocusedAccount('')
    setSelection(null)
  }
  const selectFinding = (findingId: string) => {
    setFindingFilter(findingId)
    setRelatedOnly(false)
    setSeverityFilter('')
    setRuleFilter('')
  }
  const zoom = (factor: number) => {
    const graph = graphRef.current
    if (graph) graph.zoom({ level: graph.zoom() * factor, renderedPosition: { x: graph.width() / 2, y: graph.height() / 2 } })
  }
  const selectedFindingIds = selectedAccount?.findingIds || selectedTransfer?.findingIds || []
  const selectedFindings = selectedFindingIds.map((id) => findingsById.get(id)).filter((finding): finding is NetworkFinding => Boolean(finding))

  return (
    <section className="workflow-panel investigation-network-panel" aria-labelledby="transaction-network-title">
      <div className="network-title-row">
        <div><h2 id="transaction-network-title"><Network size={15} /> Transaction network</h2><p>Observed sender-to-receiver relationships from this case. Selecting an element shows saved case details.</p></div>
        <div className="network-live-counts" aria-live="polite">
          <strong>{focusedCounts.accounts} <span>/ {model.accounts.length}</span></strong><small>accounts shown</small>
          <strong>{focusedCounts.transfers} <span>/ {model.transfers.length}</span></strong><small>transactions shown</small>
        </div>
      </div>
      <div className="network-toolbar">
        <label className="network-search"><Search size={14} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search account or transaction ID" aria-label="Search account or transaction ID" /></label>
        <label><span>Severity</span><select value={severityFilter} onChange={(event) => { setSeverityFilter(event.target.value); setFindingFilter('') }} aria-label="Filter by finding severity">
          <option value="">All severities</option>{availableSeverities.map((severity) => <option key={severity}>{severity}</option>)}
        </select></label>
        <label><span>Rule</span><select value={ruleFilter} onChange={(event) => { setRuleFilter(event.target.value); setFindingFilter('') }} aria-label="Filter by finding rule">
          <option value="">All rules</option>{availableRules.map((rule) => <option key={rule}>{rule}</option>)}
        </select></label>
        <label><span>Focus finding</span><select value={findingFilter} onChange={(event) => selectFinding(event.target.value)} aria-label="Focus a saved finding">
          <option value="">All findings</option>{model.findings.map((finding, index) => <option key={finding.id || `finding-${index}`} value={finding.id || `finding-${index}`}>{finding.severity || 'Finding'} · {finding.rule_name || `Finding ${index + 1}`}</option>)}
        </select></label>
        <label className="network-checkbox"><input type="checkbox" checked={relatedOnly} onChange={(event) => setRelatedOnly(event.target.checked)} /> Accounts linked to findings</label>
        <button type="button" className="button-secondary" disabled={!selection || selection.type !== 'account'} onClick={() => setFocusedAccount(selection?.type === 'account' ? selection.accountId : '')} aria-label="Focus selected account and its connections">Focus selected</button>
        <button type="button" className="button-secondary" onClick={resetFilters} aria-label="Reset network filters and selection">Reset filters</button>
        <div className="network-viewport-controls" aria-label="Network viewport controls">
          <button type="button" onClick={() => zoom(1.2)} aria-label="Zoom in"><ZoomIn size={15} /></button>
          <button type="button" onClick={() => zoom(0.83)} aria-label="Zoom out"><ZoomOut size={15} /></button>
          <button type="button" onClick={() => graphRef.current?.fit(graphRef.current.elements(), 32)} aria-label="Fit all network nodes and transactions to screen"><Maximize size={15} /></button>
          <button type="button" onClick={() => graphRef.current?.layout(networkLayoutOptions(model.accounts.length, true, true)).run()} aria-label="Reset network layout"><RotateCcw size={15} /></button>
        </div>
      </div>
      {view.active && <div className="network-filter-status" role="status">Filters active. Highlighted items match your focus; unrelated items remain visible but de-emphasized. <button type="button" onClick={resetFilters}>Clear filters</button></div>}
      <div className={`network-content${selection || selectedFinding ? ' has-selection' : ''}`}>
        <div ref={containerRef} className="cytoscape-network" role="application" aria-label="Interactive directed transaction network">
          {model.accounts.length === 0
            ? <div className="network-empty"><Network size={23} /><strong>No transactions in this case</strong><span>Import saved transaction records to build the observed account network.</span></div>
            : null}
          {nodeTooltip && <div className="network-node-tooltip" style={{
            left: Math.max(8, Math.min(nodeTooltip.x, (containerRef.current?.clientWidth || 0) - 8)),
            top: Math.max(38, nodeTooltip.y),
          }} role="tooltip">{nodeTooltip.accountId}</div>}
        </div>
        {selectedFinding && <aside className="network-details network-finding-details" aria-label={`Finding details for ${selectedFinding.rule_name || 'saved finding'}`}>
          <div className="network-details-heading"><div><span className="detail-eyebrow">SAVED RULE-BASED FINDING</span><h3>{selectedFinding.rule_name || 'Finding'}</h3></div><button type="button" onClick={() => setFindingFilter('')} aria-label="Clear selected finding"><X size={15} /></button></div>
          <p className="network-finding-severity">{selectedFinding.severity || 'Severity not available'}</p>
          <p>{selectedFinding.explanation || 'No explanation is saved.'}</p>
          <div className="network-detail-section"><h4>Associated accounts</h4>
            {selectedFinding.account_ids?.length
              ? <div className="network-chip-list">{selectedFinding.account_ids.map((accountId) => <button type="button" key={accountId} onClick={() => { setSelection({ type: 'account', accountId }); setFocusedAccount('') }}>{accountId}</button>)}</div>
              : <p>No account IDs are saved for this finding.</p>}
          </div>
          <div className="network-detail-section"><h4>Supporting transactions</h4>
            {selectedFinding.supporting_transaction_ids?.length
              ? <div className="network-related-list">{selectedFinding.supporting_transaction_ids.map((id) => {
                const transfer = model.transfers.find((item) => item.transaction.transaction_id === id || item.transaction.id === id)
                return transfer
                  ? <button type="button" key={id} onClick={() => setSelection({ type: 'transaction', elementId: transfer.elementId })}><strong>{id}</strong><span>{transfer.senderAccount} → {transfer.receiverAccount}</span></button>
                  : <span className="network-unlinked-id" key={id}>{id} · no matching saved transaction</span>
              })}</div>
              : <p>No supporting transaction IDs are saved.</p>}
          </div>
        </aside>}
        {selectedAccount && <aside className="network-details" aria-label={`Account details for ${selectedAccount.accountId}`}>
          <div className="network-details-heading"><div><span className="detail-eyebrow">OBSERVED ACCOUNT</span><h3 title={selectedAccount.accountId}>{selectedAccount.accountId}</h3></div><button type="button" onClick={() => setSelection(null)} aria-label="Close account details"><X size={15} /></button></div>
          <dl className="network-account-metrics">
            <div><dt>Outgoing</dt><dd>{selectedAccount.sentCount}</dd></div><div><dt>Incoming</dt><dd>{selectedAccount.receivedCount}</dd></div>
            <div><dt>Connected accounts</dt><dd>{selectedAccount.connectedAccountIds.length}</dd></div><div><dt>Associated findings</dt><dd>{selectedAccount.findingIds.length}</dd></div>
          </dl>
          <div className="network-detail-section"><h4>Outgoing totals by currency</h4><p>{currencyTotals(selectedAccount.outgoingTotals)}</p></div>
          <div className="network-detail-section"><h4>Incoming totals by currency</h4><p>{currencyTotals(selectedAccount.incomingTotals)}</p></div>
          <div className="network-detail-section"><h4>Connected observed accounts</h4>
            {selectedAccount.connectedAccountIds.length ? <div className="network-chip-list">{selectedAccount.connectedAccountIds.map((accountId) => <button type="button" key={accountId} onClick={() => { setSelection({ type: 'account', accountId }); setFocusedAccount('') }}>{accountId}</button>)}</div> : <p>None in saved transactions.</p>}
          </div>
          <div className="network-detail-section"><h4>Related transactions</h4>
            <div className="network-related-list">{model.transfers.filter((transfer) => transfer.senderAccount === selectedAccount.accountId || transfer.receiverAccount === selectedAccount.accountId).map((transfer) => (
              <button type="button" key={transfer.elementId} onClick={() => setSelection({ type: 'transaction', elementId: transfer.elementId })}>
                <strong>{transfer.transaction.transaction_id || transfer.transaction.id || 'Transaction'}</strong>
                <span>{transfer.senderAccount} → {transfer.receiverAccount}</span>
              </button>
            ))}</div>
          </div>
          <div className="network-detail-section"><h4>Associated saved findings</h4>
            {selectedFindings.length ? selectedFindings.map((finding, index) => {
              const findingId = finding.id || `finding-${model.findings.indexOf(finding)}`
              return <button type="button" className="network-finding-card" key={findingId} onClick={() => selectFinding(findingId)}>
                <strong>{finding.severity} · {finding.rule_name || `Finding ${index + 1}`}</strong><span>{finding.explanation || 'No explanation is saved.'}</span>
              </button>
            }) : <p>No saved finding is associated with this account.</p>}
          </div>
        </aside>}
        {selectedTransaction && selectedTransfer && <aside className="network-details" aria-label="Transaction details">
          <div className="network-details-heading"><div><span className="detail-eyebrow">OBSERVED TRANSACTION</span><h3>{selectedTransaction.transaction_id || selectedTransaction.id || 'Transaction'}</h3></div><button type="button" onClick={() => setSelection(null)} aria-label="Close transaction details"><X size={15} /></button></div>
          <dl className="network-transaction-details">
            <div><dt>Sender</dt><dd><button type="button" onClick={() => setSelection({ type: 'account', accountId: selectedTransfer.senderAccount })}>{selectedTransfer.senderAccount}</button></dd></div>
            <div><dt>Receiver</dt><dd><button type="button" onClick={() => setSelection({ type: 'account', accountId: selectedTransfer.receiverAccount })}>{selectedTransfer.receiverAccount}</button></dd></div>
            <div><dt>Amount</dt><dd>{displayAmount(selectedTransaction)}</dd></div>
            <div><dt>Timestamp</dt><dd>{displayTimestamp(selectedTransaction.timestamp)}</dd></div>
            {selectedTransaction.status && <div><dt>Status</dt><dd>{selectedTransaction.status}</dd></div>}
            {selectedTransaction.transaction_type && <div><dt>Type</dt><dd>{selectedTransaction.transaction_type}</dd></div>}
            {selectedTransaction.description && <div><dt>Description</dt><dd>{selectedTransaction.description}</dd></div>}
          </dl>
          <div className="network-detail-section"><h4>Supporting findings</h4>
            {selectedFindings.length ? selectedFindings.map((finding, index) => {
              const findingId = finding.id || `finding-${model.findings.indexOf(finding)}`
              return <button type="button" className="network-finding-card" key={findingId} onClick={() => selectFinding(findingId)}>
                <strong>{finding.severity} · {finding.rule_name || `Finding ${index + 1}`}</strong><span>{finding.explanation || 'No explanation is saved.'}</span>
              </button>
            }) : <p>No saved finding references this transaction ID.</p>}
          </div>
        </aside>}
      </div>
      <div className="network-legend"><span><i className="legend-observed" /> Observed account</span><span><i className="legend-related" /> Associated with saved finding</span><span><i className="legend-high" /> Associated with HIGH/CRITICAL finding</span><span>→ Saved sender to receiver direction</span></div>
      <p className="network-disclaimer">Connections show saved transactions only. Findings are rule-based review signals—not confirmed fraud, account ownership, or a numerical risk score.</p>
    </section>
  )
}
