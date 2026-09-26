import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiReport, call, consumer, current, findingsFor, fixture, operation, operations, raisedRules,
} from './support.mjs'

/**
 * Coverage: the difference between "nobody calls it" and "nobody I looked at
 * calls it".
 *
 * This is the honesty requirement the tool exists to satisfy, so it gets its
 * own file. Every case below holds the document and the usage constant and
 * changes only what the inventory *claims to cover* -- and that alone decides
 * whether the same silence is read as evidence or as an unknown.
 */

const quiet = [consumer({ id: 'partner-sync', calls: [call({ operationId: 'listInvoices' })] })]
const expired = operation({ 'x-sunset': '2026-05-01T00:00:00Z' })

test('complete coverage licenses the claim, and states its bounds in the evidence', async () => {
  const report = await apiReport(fixture(operations(), quiet))

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.coverageGaps, 0)
  const unused = findingsFor(report, 'deprecated-operation-unused')[0]
  assert.equal(unused.severity, 'info')
  assert.equal(unused.evidence, 'coverage 2026-03-01T00:00:00Z to 2026-06-01T00:00:00Z from gateway-access-log, all 1 inventoried consumer(s), 1 known to the source')
  assert.equal(unused.suggestion, 'This covers the declared consumers and window only; usage outside either remains unknown.')
})

test('each way of being short of complete turns that claim into an unknown', async () => {
  const shortfalls = [
    ['a consumer the source knows about was not inventoried', { consumersKnown: 6 }, 'coverage-consumers-incomplete'],
    ['the window ended too long before the clock', { windowStart: '2025-10-01T00:00:00Z', windowEnd: '2026-01-01T00:00:00Z' }, 'coverage-window-stale'],
    ['the usage was recorded against another API version', { apiVersion: '1.9.0' }, 'coverage-version-mismatch'],
  ]

  for (const [label, coverage, gapRule] of shortfalls) {
    const report = await apiReport(fixture(operations(), quiet, coverage))

    assert.equal(report.status, 'incomplete', label)
    assert.equal(report.summary.coverageGaps, 1, label)
    assert.equal(findingsFor(report, gapRule).length, 1, label)
    assert.equal(findingsFor(report, 'deprecated-operation-usage-unknown').length, 1, label)
    assert.equal(findingsFor(report, 'deprecated-operation-unused').length, 0, label)
  }
})

test('an entry that did not compile is a coverage gap without a second flag of its own', async () => {
  const report = await apiReport(fixture(
    operations(),
    [...quiet, { id: 'mobile-app', calls: 'lots' }],
    { consumersKnown: 1 },
  ))

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.coverageGaps, 1)
  assert.equal(report.summary.unevaluated, 1)
  assert.equal(findingsFor(report, 'deprecated-operation-usage-unknown').length, 1)
})

test('a call naming an operation the document does not declare is a coverage gap too', async () => {
  // That consumer was calling something. It may have been the very operation
  // about to be reported as unused, so the silence is no longer evidence.
  const report = await apiReport(fixture(operations(), [
    consumer({ id: 'partner-sync', calls: [call({ operationId: 'listInvoicesV0' })] }),
  ]))

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(raisedRules(report), ['deprecated-operation-usage-unknown', 'usage-operation-unknown'])
})

test('gaps accumulate, and the summary counts them', async () => {
  const report = await apiReport(fixture(operations(), quiet, {
    consumersKnown: 6,
    apiVersion: '1.9.0',
    windowStart: '2025-10-01T00:00:00Z',
    windowEnd: '2026-01-01T00:00:00Z',
  }))

  assert.equal(report.summary.coverageGaps, 3)
  assert.deepEqual(raisedRules(report).filter((rule) => rule.startsWith('coverage-')), [
    'coverage-consumers-incomplete', 'coverage-version-mismatch', 'coverage-window-stale',
  ])
})

test('an expired operation nobody was seen calling is a different unknown from a merely deprecated one', async () => {
  const covered = await apiReport(fixture([expired, current()], quiet))
  assert.deepEqual(raisedRules(covered), ['expired-operation-unused'])

  const short = await apiReport(fixture([expired, current()], quiet, { consumersKnown: 6 }))
  assert.deepEqual(raisedRules(short), ['coverage-consumers-incomplete', 'expired-operation-usage-unknown'])
  assert.equal(findingsFor(short, 'expired-operation-usage-unknown')[0].severity, 'error')
})

test('a coverage gap does not suppress a link that was actually observed', async () => {
  // Incomplete coverage makes silence meaningless. It does not make the usage
  // that *was* recorded disappear, and an expired operation in use is still
  // reported under its own rule.
  const report = await apiReport(fixture([expired, current()], [consumer()], { consumersKnown: 40 }))

  assert.equal(report.status, 'incomplete')
  assert.equal(findingsFor(report, 'expired-operation-in-use').length, 1)
  assert.equal(report.summary.expiredLinks, 1)
})

test('the inventoried consumers are named, so a reader knows exactly whose silence this is', async () => {
  const report = await apiReport(fixture(operations(), [
    consumer({ id: 'billing-portal', calls: [call({ operationId: 'listInvoices' })] }),
    consumer({ id: 'partner-sync', calls: [call({ operationId: 'listInvoices' })] }),
  ], { consumersKnown: 5 }))

  assert.equal(findingsFor(report, 'coverage-consumers-incomplete')[0].evidence, 'inventoried: billing-portal, partner-sync')
  assert.equal(
    findingsFor(report, 'deprecated-operation-usage-unknown')[0].evidence,
    'coverage 2026-03-01T00:00:00Z to 2026-06-01T00:00:00Z from gateway-access-log, 2 of 5 consumer(s)',
  )
})

test('an inventory listing more consumers than the source claims to know is not a gap', async () => {
  // The comparison is one-sided on purpose: knowing about fewer than you
  // listed is a bookkeeping oddity, not a hole in the evidence.
  const report = await apiReport(fixture(operations(), quiet, { consumersKnown: 0 }))

  assert.equal(report.summary.coverageGaps, 0)
  assert.equal(report.status, 'pass')
  // And the evidence says how many consumers were really examined rather than
  // repeating the source's own number back. One consumer was read here, so
  // "all 0 known consumer(s)" would have understated evidence that was
  // obtained -- on the very field the one-sided comparison lets disagree.
  assert.equal(
    findingsFor(report, 'deprecated-operation-unused')[0].evidence,
    'coverage 2026-03-01T00:00:00Z to 2026-06-01T00:00:00Z from gateway-access-log, all 1 inventoried consumer(s), 0 known to the source',
  )
})
