import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport, call, consumer, current, findingsFor, fixture, inventoryOf, operation, operations,
  raisedRules, specOf,
} from './support.mjs'

/**
 * The join itself: which deprecated operation each consumer is linked to, and
 * what the link says.
 *
 * The unit of the report is one (deprecated operation, consumer) pair. Nothing
 * is aggregated away, because the question the report has to answer is "who do
 * I have to talk to", and a count does not answer it.
 */

const ACTIVE = '2026-05-30T11:02:00Z'
const DORMANT = '2026-03-05T02:15:00Z'
const expired = (overrides = {}) => operation({ 'x-sunset': '2026-05-01T00:00:00Z', ...overrides })
const imminent = (overrides = {}) => operation({ 'x-sunset': '2026-06-20T00:00:00Z', ...overrides })

test('the five link rules cover every combination of phase and activity', async () => {
  const cases = [
    [expired(), ACTIVE, 'expired-operation-in-use'],
    [expired(), DORMANT, 'expired-operation-dormant-use'],
    [imminent(), ACTIVE, 'sunset-imminent-operation-in-use'],
    [imminent(), DORMANT, 'deprecated-operation-dormant-use'],
    [operation(), ACTIVE, 'deprecated-operation-in-use'],
    [operation(), DORMANT, 'deprecated-operation-dormant-use'],
  ]

  for (const [subject, lastSeen, expectedRule] of cases) {
    const report = await apiReport(fixture([subject, current()], [consumer({ calls: [call({ lastSeen })] })]))
    assert.deepEqual(raisedRules(report), [expectedRule], `${subject['x-sunset']} at ${lastSeen}`)
    assert.equal(report.summary.links, 1)
  }
})

test('an operation with no removal date is deprecated, never imminent and never expired', async () => {
  const report = await apiReport(fixture([operation({ 'x-sunset': undefined }), current()], [consumer()]))

  assert.equal(report.summary.expired, 0)
  assert.deepEqual(raisedRules(report), ['deprecated-operation-in-use', 'sunset-undeclared'])
  assert.match(
    findingsFor(report, 'deprecated-operation-in-use')[0].message,
    /is deprecated with no announced removal date; it is still being called\.$/,
  )
})

test('one finding per consumer, located at the operation and naming the consumer in the evidence', async () => {
  const report = await apiReport(fixture([expired(), current()], [
    consumer({ id: 'billing-portal', contact: 'revenue-platform' }),
    consumer({ id: 'mobile-app', contact: 'apps-guild', calls: [call({ count: 7 })] }),
    consumer({ id: 'partner-sync', contact: undefined, calls: [call({ operationId: 'listInvoices' })] }),
  ]))

  const linked = findingsFor(report, 'expired-operation-in-use')
  assert.equal(linked.length, 2, 'the consumer calling the supported operation is not linked')
  for (const finding of linked) assert.equal(finding.location.pointer, '/paths/~1v1~1invoices/get')
  assert.deepEqual(linked.map((finding) => finding.evidence), [
    'consumer billing-portal; 12 call(s); last seen 2026-05-30T11:02:00Z; owner revenue-platform',
    'consumer mobile-app; 7 call(s); last seen 2026-05-30T11:02:00Z; owner apps-guild',
  ])
  assert.equal(report.summary.links, 2)
  assert.equal(report.summary.expiredLinks, 2)
})

test('one consumer calling several deprecated operations is linked to each of them', async () => {
  const report = await apiReport(fixture([
    expired(),
    operation({ path: '/v1/reports', operationId: 'listReportsV1', 'x-replacement': 'listReports' }),
    current(),
    current({ path: '/v2/reports', operationId: 'listReports' }),
  ], [consumer({ calls: [call(), call({ operationId: 'listReportsV1' })] })]))

  assert.equal(report.summary.links, 2)
  assert.deepEqual(raisedRules(report), ['deprecated-operation-in-use', 'expired-operation-in-use'])
})

test('the migration guidance comes from the document, in each of its forms', async () => {
  const bare = await apiReport(fixture([operation({ 'x-replacement': 'listInvoices' }), current()], [consumer()]))
  assert.equal(findingsFor(bare, 'deprecated-operation-in-use')[0].suggestion, 'Move this consumer to "listInvoices".')

  const full = await apiReport(fixture([
    operation({ 'x-replacement': { operationId: 'listInvoices', since: '2.2.0', docs: 'https://docs.example.test/invoices' } }),
    current(),
  ], [consumer()]))
  assert.equal(
    findingsFor(full, 'deprecated-operation-in-use')[0].suggestion,
    'Move this consumer to "listInvoices" (available since 2.2.0). See https://docs.example.test/invoices',
  )

  const none = await apiReport(fixture([operation({ 'x-replacement': undefined })], [consumer()]))
  assert.equal(
    findingsFor(none, 'deprecated-operation-in-use')[0].suggestion,
    'Confirm with this consumer what it needs; operation "listInvoicesV1" names no replacement.',
  )
})

test('a call to an operation that is not deprecated produces no link at all', async () => {
  const report = await apiReport(fixture(operations(), [consumer({ calls: [call({ operationId: 'listInvoices' })] })]))

  assert.equal(report.summary.links, 0)
  assert.deepEqual(raisedRules(report), ['deprecated-operation-unused'])
})

test('the summary counts what the findings say, so the numbers and the list cannot drift apart', async () => {
  const report = await apiReport(fixture([
    expired(),
    imminent({ path: '/v1/reports', operationId: 'listReportsV1', 'x-replacement': 'listReports' }),
    current(),
    current({ path: '/v2/reports', operationId: 'listReports' }),
  ], [
    consumer({ id: 'billing-portal', calls: [call(), call({ operationId: 'listReportsV1' })] }),
    consumer({ id: 'data-warehouse', calls: [call({ lastSeen: DORMANT })] }),
  ]))

  assert.equal(report.summary.checked, 4)
  assert.equal(report.summary.deprecated, 2)
  assert.equal(report.summary.expired, 1)
  assert.equal(report.summary.consumers, 2)
  assert.equal(report.summary.calls, 3)
  assert.equal(report.summary.links, 3)
  assert.equal(report.summary.expiredLinks, 1)

  const linkRules = new Set([
    'expired-operation-in-use', 'expired-operation-dormant-use', 'sunset-imminent-operation-in-use',
    'deprecated-operation-in-use', 'deprecated-operation-dormant-use',
  ])
  assert.equal(report.findings.filter((finding) => linkRules.has(finding.ruleId)).length, report.summary.links)
  assert.equal(
    report.findings.filter((finding) => finding.ruleId === 'expired-operation-in-use').length,
    report.summary.expiredLinks,
  )
})

test('an operation that is deprecated but whose consumers all call something else is reported as unused', async () => {
  const report = await apiReport(fixture([expired(), current()], [
    consumer({ id: 'partner-sync', calls: [call({ operationId: 'listInvoices' })] }),
  ]))

  assert.deepEqual(raisedRules(report), ['expired-operation-unused'])
  assert.match(
    findingsFor(report, 'expired-operation-unused')[0].message,
    /passed its removal date of 2026-05-01T00:00:00Z and no covered consumer called it in the declared window, so it can be removed from the document\.$/,
  )
})

test('a document where nothing is deprecated says so, rather than saying nothing', async () => {
  const report = await apiReport(fixture([current()], [consumer({ calls: [call({ operationId: 'listInvoices' })] })]))

  assert.deepEqual(raisedRules(report), ['no-deprecated-operations'])
  assert.equal(
    findingsFor(report, 'no-deprecated-operations')[0].message,
    'None of the 1 operation(s) read from this document is marked deprecated, so there was nothing to join the inventory to.',
  )
  assert.equal(report.status, 'pass')
})

test('a document whose every operation was refused claims nothing about what is deprecated', async () => {
  // The same rule, from the other end: with nothing examined there is no claim
  // to make. "None of the 0 operation(s) read from this document is marked
  // deprecated" reads as a green answer about a document this run could not
  // read, which is the opposite of what happened.
  const report = await apiReport({
    'openapi.json': specOf([{ path: '/v1/invoices', method: 'get' }]),
    'usage.json': inventoryOf([consumer({ calls: [] })]),
  })

  assert.equal(report.summary.checked, 0)
  assert.deepEqual(raisedRules(report), ['operation-invalid'])
  assert.equal(report.status, 'incomplete')
})

test('the human report prints the evidence beside the message, so the consumer is never lost', async () => {
  const { formatReport } = await import('../src/index.mjs')
  const report = await apiReport(fixture([expired(), current()], [consumer()]))
  const printed = formatReport(report, { spec: 'openapi.json', inventory: 'usage.json', now: '2026-06-05T00:00:00Z' })

  assert.equal(
    printed.split('\n')[3],
    'ERROR   openapi.json/paths/~1v1~1invoices/get expired-operation-in-use ' +
    'Operation "listInvoicesV1" (GET /v1/invoices) passed its announced removal date of 2026-05-01T00:00:00Z; it is still being called. ' +
    '[consumer billing-portal; 12 call(s); last seen 2026-05-30T11:02:00Z; owner revenue-platform]',
  )
})
