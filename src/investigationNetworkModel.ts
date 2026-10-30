export type NetworkTransaction = {
  id?: string | null
  transaction_id?: string | null
  sender_account?: string | null
  receiver_account?: string | null
  amount?: number | null
  currency?: string | null
  timestamp?: string | null
  transaction_type?: string | null
  description?: string | null
  status?: string | null
}

export type NetworkFinding = {
  id?: string | null
  rule_name?: string | null
  severity?: string | null
  explanation?: string | null
  supporting_transaction_ids?: string[] | null
  account_ids?: string[] | null
  recommended_next_step?: string | null
}

export type CurrencyTotal = { currency: string; amount: number }

export type NetworkAccount = {
  elementId: string
  accountId: string
  sentCount: number
  receivedCount: number
  connectedAccountIds: string[]
  transactionIds: string[]
  findingIds: string[]
  outgoingTotals: CurrencyTotal[]
  incomingTotals: CurrencyTotal[]
  size: number
}

export type NetworkTransfer = {
  elementId: string
  transaction: NetworkTransaction
  senderAccount: string
  receiverAccount: string
  findingIds: string[]
  curveOffset: number
}

export type InvestigationNetworkModel = {
  accounts: NetworkAccount[]
  transfers: NetworkTransfer[]
  findings: NetworkFinding[]
}

export type NetworkFilters = {
  search?: string
  severity?: string
  rule?: string
  findingId?: string
  relatedOnly?: boolean
  focusedAccount?: string
}

export type NetworkView = {
  accountIds: Set<string>
  transferIds: Set<string>
  matchedAccountIds: Set<string>
  matchedTransferIds: Set<string>
  active: boolean
}

export function buildInvestigationNetwork(
  transactions: NetworkTransaction[],
  findings: NetworkFinding[],
): InvestigationNetworkModel {
  const accountOrder = new Map<string, number>()
  const accountTransactions = new Map<string, NetworkTransaction[]>()
  const accountConnections = new Map<string, Set<string>>()
  const accountFindingIds = new Map<string, Set<string>>()
  const findingIdsByTransaction = new Map<string, Set<string>>()
  const accountTransactionIds = new Map<string, Set<string>>()
  const outgoingTotals = new Map<string, Map<string, number>>()
  const incomingTotals = new Map<string, Map<string, number>>()
  const outgoingCounts = new Map<string, number>()
  const incomingCounts = new Map<string, number>()

  const getFindingId = (finding: NetworkFinding, index: number) => finding.id || `finding-${index}`
  const getTransactionId = (transaction: NetworkTransaction) => transaction.transaction_id || transaction.id
  for (const [findingIndex, finding] of findings.entries()) {
    const findingId = getFindingId(finding, findingIndex)
    for (const accountId of finding.account_ids || []) {
      if (!accountId) continue
      const current = accountFindingIds.get(accountId) || new Set<string>()
      current.add(findingId)
      accountFindingIds.set(accountId, current)
    }
    for (const transactionId of finding.supporting_transaction_ids || []) {
      if (!transactionId) continue
      const current = findingIdsByTransaction.get(transactionId) || new Set<string>()
      current.add(findingId)
      findingIdsByTransaction.set(transactionId, current)
    }
  }

  const transfers: NetworkTransfer[] = []
  const parallelCounts = new Map<string, number>()
  for (const [index, transaction] of transactions.entries()) {
    const sender = transaction.sender_account?.trim()
    const receiver = transaction.receiver_account?.trim()
    if (!sender || !receiver) continue
    if (!accountOrder.has(sender)) accountOrder.set(sender, accountOrder.size)
    if (!accountOrder.has(receiver)) accountOrder.set(receiver, accountOrder.size)
    for (const accountId of new Set([sender, receiver])) {
      if (!accountConnections.has(accountId)) accountConnections.set(accountId, new Set())
      if (!accountTransactions.has(accountId)) accountTransactions.set(accountId, [])
      accountTransactions.get(accountId)?.push(transaction)
      if (!accountTransactionIds.has(accountId)) accountTransactionIds.set(accountId, new Set())
      const transactionId = getTransactionId(transaction)
      if (transactionId) accountTransactionIds.get(accountId)?.add(transactionId)
    }
    accountConnections.get(sender)?.add(receiver)
    accountConnections.get(receiver)?.add(sender)
    outgoingCounts.set(sender, (outgoingCounts.get(sender) || 0) + 1)
    incomingCounts.set(receiver, (incomingCounts.get(receiver) || 0) + 1)
    if (typeof transaction.amount === 'number' && Number.isFinite(transaction.amount)) {
      const currency = transaction.currency?.trim().toUpperCase() || 'Currency not provided'
      const out = outgoingTotals.get(sender) || new Map<string, number>()
      out.set(currency, (out.get(currency) || 0) + transaction.amount)
      outgoingTotals.set(sender, out)
      const incoming = incomingTotals.get(receiver) || new Map<string, number>()
      incoming.set(currency, (incoming.get(currency) || 0) + transaction.amount)
      incomingTotals.set(receiver, incoming)
    }

    const pairKey = `${sender}\u0000${receiver}`
    const parallelIndex = parallelCounts.get(pairKey) || 0
    parallelCounts.set(pairKey, parallelIndex + 1)
    const offsets = [0, 18, -18, 36, -36, 54, -54]
    const references = [transaction.transaction_id, transaction.id].filter((value): value is string => Boolean(value))
    const associatedFindingIds = new Set(references.flatMap((reference) => [...(findingIdsByTransaction.get(reference) || [])]))
    transfers.push({
      elementId: `transfer-${index}`,
      transaction,
      senderAccount: sender,
      receiverAccount: receiver,
      findingIds: [...associatedFindingIds],
      curveOffset: offsets[parallelIndex % offsets.length],
    })
  }

  for (const transfer of transfers) {
    for (const findingId of transfer.findingIds) {
      for (const accountId of [transfer.senderAccount, transfer.receiverAccount]) {
        const accountFindings = accountFindingIds.get(accountId) || new Set<string>()
        accountFindings.add(findingId)
        accountFindingIds.set(accountId, accountFindings)
      }
    }
  }

  const accounts = [...accountOrder].map(([accountId, index]) => {
    const savedTransactions = accountTransactions.get(accountId) || []
    const findingIds = accountFindingIds.get(accountId) || new Set<string>()
    const transactionIds = [...(accountTransactionIds.get(accountId) || [])]
    return {
      elementId: `account-${index}`,
      accountId,
      sentCount: outgoingCounts.get(accountId) || 0,
      receivedCount: incomingCounts.get(accountId) || 0,
      connectedAccountIds: [...(accountConnections.get(accountId) || [])].filter((id) => id !== accountId),
      transactionIds,
      findingIds: [...findingIds],
      outgoingTotals: [...(outgoingTotals.get(accountId) || [])].map(([currency, amount]) => ({ currency, amount })),
      incomingTotals: [...(incomingTotals.get(accountId) || [])].map(([currency, amount]) => ({ currency, amount })),
      size: Math.min(58, 38 + Math.log2(Math.max(1, savedTransactions.length)) * 4),
    }
  })

  return {
    accounts,
    transfers,
    findings,
  }
}

export function deriveNetworkView(model: InvestigationNetworkModel, filters: NetworkFilters = {}): NetworkView {
  const query = filters.search?.trim().toLocaleLowerCase() || ''
  const selectedFindings = model.findings.filter((finding, index) => {
    if (filters.findingId && (finding.id || `finding-${index}`) !== filters.findingId) return false
    if (filters.severity && finding.severity?.toUpperCase() !== filters.severity.toUpperCase()) return false
    if (filters.rule && finding.rule_name !== filters.rule) return false
    return true
  })
  const hasFindingFilter = Boolean(filters.findingId || filters.severity || filters.rule)
  const relatedFindingIds = new Set(selectedFindings.map(getFindingId))
  const relatedAccountIds = new Set(selectedFindings.flatMap((finding) => finding.account_ids || []))
  const relatedTransactionIds = new Set(selectedFindings.flatMap((finding) => finding.supporting_transaction_ids || []))
  const relatedTransferIds = new Set(model.transfers.filter((transfer) => transfer.findingIds.some((id) => relatedFindingIds.has(id))).map((transfer) => transfer.elementId))
  for (const transfer of model.transfers) {
    if (relatedTransferIds.has(transfer.elementId)
      || relatedTransactionIds.has(transfer.transaction.transaction_id || '')
      || relatedTransactionIds.has(transfer.transaction.id || '')) {
      relatedAccountIds.add(transfer.senderAccount)
      relatedAccountIds.add(transfer.receiverAccount)
    }
  }
  const queryAccountIds = new Set(model.accounts
    .filter((account) => account.accountId.toLocaleLowerCase().includes(query))
    .map((account) => account.accountId))
  const queryTransferIds = new Set(model.transfers
    .filter((transfer) => [transfer.transaction.transaction_id, transfer.transaction.id].some((id) => id?.toLocaleLowerCase().includes(query)))
    .map((transfer) => transfer.elementId))
  const focused = model.accounts.find((account) => account.accountId === filters.focusedAccount)
  const focusedAccountIds = new Set<string>()
  if (focused) {
    focusedAccountIds.add(focused.accountId)
    for (const accountId of focused.connectedAccountIds) focusedAccountIds.add(accountId)
  }

  const active = Boolean(query || hasFindingFilter || filters.relatedOnly || filters.focusedAccount)
  const accountIds = new Set(model.accounts.filter((account) => {
    let matches = true
    if (hasFindingFilter) matches = account.findingIds.some((id) => relatedFindingIds.has(id)) || relatedAccountIds.has(account.accountId)
    if (filters.relatedOnly) matches = matches && (account.findingIds.length > 0 || relatedAccountIds.has(account.accountId))
    if (filters.focusedAccount) matches = matches && focusedAccountIds.has(account.accountId)
    if (query) {
      const incidentToMatch = queryTransferIds.size > 0 && model.transfers.some((transfer) =>
        queryTransferIds.has(transfer.elementId) && (transfer.senderAccount === account.accountId || transfer.receiverAccount === account.accountId),
      )
      matches = matches && (queryAccountIds.has(account.accountId) || incidentToMatch)
    }
    return matches
  }).map((account) => account.accountId))

  const transferIds = new Set(model.transfers.filter((transfer) => {
    let matches = true
    if (hasFindingFilter) {
      matches = transfer.findingIds.some((id) => relatedFindingIds.has(id))
        || relatedTransactionIds.has(transfer.transaction.transaction_id || '')
        || relatedTransactionIds.has(transfer.transaction.id || '')
    }
    if (filters.relatedOnly) matches = matches && (transfer.findingIds.length > 0
      || relatedTransactionIds.has(transfer.transaction.transaction_id || '')
      || relatedTransactionIds.has(transfer.transaction.id || ''))
    if (filters.focusedAccount) matches = matches
      && (transfer.senderAccount === filters.focusedAccount || transfer.receiverAccount === filters.focusedAccount)
    if (query) {
      matches = matches && (queryTransferIds.has(transfer.elementId)
        || queryAccountIds.has(transfer.senderAccount)
        || queryAccountIds.has(transfer.receiverAccount))
    }
    if ((hasFindingFilter || filters.relatedOnly) && query && queryTransferIds.size === 0) {
      matches = matches && (accountIds.has(transfer.senderAccount) || accountIds.has(transfer.receiverAccount))
    }
    return matches
  }).map((transfer) => transfer.elementId))

  return {
    accountIds,
    transferIds,
    matchedAccountIds: queryAccountIds,
    matchedTransferIds: queryTransferIds,
    active,
  }
}

function getFindingId(finding: NetworkFinding, index: number): string {
  return finding.id || `finding-${index}`
}
