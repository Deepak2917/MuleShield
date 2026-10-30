import test from 'node:test'
import assert from 'node:assert/strict'
import { buildInvestigationNetwork, deriveNetworkView } from '../src/investigationNetworkModel.ts'

const transactions = [
  { id: 'row-1', transaction_id: 'TX-1', sender_account: 'A', receiver_account: 'B', amount: 10, currency: 'USD', timestamp: '2026-01-01T10:00:00Z' },
  { id: 'row-2', transaction_id: 'TX-2', sender_account: 'A', receiver_account: 'C', amount: 20, currency: 'USD', timestamp: '2026-01-01T11:00:00Z' },
  { id: 'row-3', transaction_id: 'TX-3', sender_account: 'B', receiver_account: 'A', amount: 5, currency: 'EUR', timestamp: '2026-01-01T12:00:00Z' },
  { id: 'row-4', transaction_id: 'TX-4', sender_account: 'A', receiver_account: 'B', amount: 3, currency: 'USD', timestamp: '2026-01-01T13:00:00Z' },
  { id: 'row-5', transaction_id: 'TX-5', sender_account: 'D', receiver_account: 'E', timestamp: null },
  { id: 'row-6', transaction_id: 'TX-6', sender_account: '', receiver_account: 'F', amount: 1, currency: 'USD' },
]

const findings = [
  {
    id: 'finding-medium',
    rule_name: 'Repeated transfers',
    severity: 'MEDIUM',
    explanation: 'Saved rule explanation.',
    account_ids: ['A'],
    supporting_transaction_ids: ['TX-1'],
  },
  {
    id: 'finding-high',
    rule_name: 'High-severity synthetic review',
    severity: 'HIGH',
    explanation: 'Saved high severity explanation.',
    account_ids: ['C'],
    supporting_transaction_ids: ['TX-2'],
  },
  {
    id: 'finding-unlinked',
    rule_name: 'Unlinked stored signal',
    severity: 'LOW',
    explanation: 'This signal has no graph relationship.',
    account_ids: ['not-in-transaction-data'],
    supporting_transaction_ids: ['missing-transaction'],
  },
]

test('network model uses only case records and calculates currency-separated account details', () => {
  const model = buildInvestigationNetwork(transactions, findings)
  assert.deepEqual(model.accounts.map((account) => account.accountId), ['A', 'B', 'C', 'D', 'E'])

  const accountA = model.accounts.find((account) => account.accountId === 'A')
  assert.equal(accountA.sentCount, 3)
  assert.equal(accountA.receivedCount, 1)
  assert.deepEqual(accountA.connectedAccountIds.sort(), ['B', 'C'])
  assert.deepEqual(model.accounts.find((account) => account.accountId === 'D').connectedAccountIds, ['E'])
  assert.deepEqual(model.accounts.find((account) => account.accountId === 'E').connectedAccountIds, ['D'])
  assert.equal(accountA.connectedAccountIds.includes('D'), false)
  assert.deepEqual(accountA.outgoingTotals, [{ currency: 'USD', amount: 33 }])
  assert.deepEqual(accountA.incomingTotals, [{ currency: 'EUR', amount: 5 }])
  assert.deepEqual(accountA.findingIds.sort(), ['finding-high', 'finding-medium'])

  const accountB = model.accounts.find((account) => account.accountId === 'B')
  assert.deepEqual(accountB.findingIds.sort(), ['finding-medium'])
  assert.equal(model.transfers.length, 5)
  assert.equal(model.transfers[0].curveOffset, 0)
  assert.equal(model.transfers[3].curveOffset, 18)
  assert.equal(model.transfers[4].findingIds.length, 0)
  assert.deepEqual(accountA.transactionIds.sort(), ['TX-1', 'TX-2', 'TX-3', 'TX-4'])
})

test('finding selection, related-only, search, severity, and account focus derive case-specific graph views', () => {
  const model = buildInvestigationNetwork(transactions, findings)

  const findingView = deriveNetworkView(model, { findingId: 'finding-medium' })
  assert.deepEqual([...findingView.accountIds].sort(), ['A', 'B'])
  assert.deepEqual([...findingView.transferIds], ['transfer-0'])
  assert.equal(findingView.active, true)

  const severityView = deriveNetworkView(model, { severity: 'HIGH' })
  assert.deepEqual([...severityView.accountIds].sort(), ['A', 'C'])
  assert.deepEqual([...severityView.transferIds], ['transfer-1'])

  const relatedView = deriveNetworkView(model, { relatedOnly: true })
  assert.deepEqual([...relatedView.transferIds].sort(), ['transfer-0', 'transfer-1'])
  assert.ok(relatedView.accountIds.has('A'))
  assert.ok(relatedView.accountIds.has('B'))
  assert.ok(relatedView.accountIds.has('C'))

  const accountSearch = deriveNetworkView(model, { search: 'b' })
  assert.deepEqual([...accountSearch.accountIds], ['B'])
  assert.deepEqual([...accountSearch.transferIds].sort(), ['transfer-0', 'transfer-2', 'transfer-3'])

  const transactionSearch = deriveNetworkView(model, { search: 'tx-3' })
  assert.deepEqual([...transactionSearch.matchedTransferIds], ['transfer-2'])
  assert.deepEqual([...transactionSearch.transferIds], ['transfer-2'])
  assert.deepEqual([...transactionSearch.accountIds].sort(), ['A', 'B'])

  const focusView = deriveNetworkView(model, { focusedAccount: 'C' })
  assert.deepEqual([...focusView.accountIds].sort(), ['A', 'C'])
  assert.deepEqual([...focusView.transferIds], ['transfer-1'])

  const combinedView = deriveNetworkView(model, { severity: 'MEDIUM', search: 'TX-1' })
  assert.deepEqual([...combinedView.transferIds], ['transfer-0'])
  assert.deepEqual([...combinedView.accountIds].sort(), ['A', 'B'])
})

test('network model handles missing records and identifiers without fabricating nodes', () => {
  const model = buildInvestigationNetwork([
    { sender_account: 'one', receiver_account: 'two' },
    { sender_account: null, receiver_account: 'missing-sender' },
  ], [{ severity: null, account_ids: null, supporting_transaction_ids: null }])
  assert.deepEqual(model.accounts.map((account) => account.accountId), ['one', 'two'])
  assert.equal(model.transfers.length, 1)
  assert.deepEqual(model.transfers[0].findingIds, [])
  assert.equal(model.accounts[0].outgoingTotals.length, 0)
})
