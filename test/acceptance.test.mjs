import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NOW, apiReport, call, cliHuman, cliReport, consumer, current, findingsFor, fixture, operation,
  operations, raisedRules,
} from './support.mjs'

/**
 * The two things this tool was built to demonstrate, asserted end to end
 * through the real binary with literal expectations.
 *
 *   1. An active consumer of an expired operation is flagged.
 *   2. Incomplete usage coverage is explicit.
 *
 * Every assertion below is written out inline. Nothing is read from a table, a
 * catalog or a parameterised expectation, so nothing here can be satisfied by
 * editing a declaration somewhere else.
 */

const EXPIRED = operation({ 'x-sunset': '2026-05-01T00:00:00Z' })
const ACTIVE = consumer({ id: 'billing-portal', calls: [call({ lastSeen: '2026-05-30T11:02:00Z' })] })
const DORMANT = consumer({ id: 'data-warehouse', calls: [call({ lastSeen: '2026-03-05T02:15:00Z' })] })

test('an active consumer of an expired operation is flagged, and the CLI exits 1', async () => {
  const { code, report } = await cliReport(fixture([EXPIRED, current()], [ACTIVE]))

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.expired, 1)
  assert.equal(report.summary.links, 1)
  assert.equal(report.summary.expiredLinks, 1)

  const flagged = report.findings.filter((finding) => finding.ruleId === 'expired-operation-in-use')
  assert.equal(flagged.length, 1)
  assert.equal(flagged[0].severity, 'error')
  assert.equal(flagged[0].location.file, 'openapi.json')
  assert.equal(flagged[0].location.pointer, '/paths/~1v1~1invoices/get')
  assert.equal(
    flagged[0].message,
    'Operation "listInvoicesV1" (GET /v1/invoices) passed its announced removal date of 2026-05-01T00:00:00Z; it is still being called.',
  )
  assert.equal(flagged[0].evidence, 'consumer billing-portal; 12 call(s); last seen 2026-05-30T11:02:00Z; owner revenue-platform')
  assert.equal(flagged[0].suggestion, 'Move this consumer to "listInvoices".')
})

test('the human report names the consumer, the removal date and the replacement on one line', async () => {
  const files = fixture([EXPIRED, current()], [ACTIVE])
  const shown = await cliHuman(files)

  assert.equal(shown.code, 1)
  assert.equal(shown.stderr.includes('ERROR   openapi.json/paths/~1v1~1invoices/get expired-operation-in-use'), true)
  assert.equal(shown.stderr.includes('passed its announced removal date of 2026-05-01T00:00:00Z'), true)
  assert.equal(shown.stderr.includes('[consumer billing-portal; 12 call(s); last seen 2026-05-30T11:02:00Z; owner revenue-platform]'), true)

  // The same run with --json says the same thing on stdout and nothing on the
  // human stream, so a pipeline and an operator see one verdict between them.
  const quiet = await cliReport(files)
  assert.equal(quiet.code, 1)
  assert.equal(quiet.stderr.includes('expired-operation-in-use'), false)
})

test('a consumer that stopped calling an expired operation is a different, lesser finding', async () => {
  // "Active" is a decision this tool makes against the injected clock, so it
  // has to be visible in the outcome. It is: a dormant consumer does not turn
  // the run red.
  const { code, report } = await cliReport(fixture([EXPIRED, current()], [DORMANT]))

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.expiredLinks, 0)
  assert.deepEqual(raisedRules(report), ['expired-operation-dormant-use'])
})

test('both consumers of one expired operation are linked to it, not just the first', async () => {
  const { code, report } = await cliReport(fixture([EXPIRED, current()], [ACTIVE, DORMANT]))

  assert.equal(code, 1)
  assert.equal(report.summary.links, 2)
  assert.equal(report.summary.expiredLinks, 1)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.deepEqual(
    report.findings.map((finding) => finding.evidence),
    [
      // The dormant link sorts first because its rule id does: the two findings
      // share a file and a pointer, and "expired-operation-d" precedes
      // "expired-operation-i" by code unit.
      'consumer data-warehouse; 12 call(s); last seen 2026-03-05T02:15:00Z; owner revenue-platform',
      'consumer billing-portal; 12 call(s); last seen 2026-05-30T11:02:00Z; owner revenue-platform',
    ],
  )
})

test('incomplete usage coverage is explicit, and the run is not a pass', async () => {
  // Nine consumers are known to the source; two were inventoried. Nothing in
  // the report may read as evidence about the other seven.
  const { code, report } = await cliReport(fixture(
    [operation(), current()],
    [consumer({ id: 'billing-portal' }), consumer({ id: 'partner-sync', calls: [call({ operationId: 'listInvoices' })] })],
    { consumersKnown: 9 },
  ))

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.coverageGaps, 1)
  assert.equal(report.summary.consumers, 2)

  const gap = report.findings.filter((finding) => finding.ruleId === 'coverage-consumers-incomplete')
  assert.equal(gap.length, 1)
  assert.equal(gap[0].severity, 'error')
  assert.equal(gap[0].location.file, 'usage.json')
  assert.equal(gap[0].location.pointer, '/coverage/consumersKnown')
  assert.equal(
    gap[0].message,
    '2 of 9 known consumer(s) are inventoried, so 7 consumer(s) were never examined. Their absence from a finding is not evidence that they call nothing.',
  )
  assert.equal(gap[0].evidence, 'inventoried: billing-portal, partner-sync')
})

test('an operation nobody is seen calling is unused under complete coverage and unknown under incomplete coverage', async () => {
  // The same operation, the same empty usage, two different answers -- decided
  // entirely by what the inventory says it covers. This is the honesty the
  // tool exists for: silence is only evidence when the coverage says so.
  const quiet = [operation(), current()]
  const users = [consumer({ id: 'partner-sync', calls: [call({ operationId: 'listInvoices' })] })]

  const covered = await apiReport(fixture(quiet, users))
  assert.equal(covered.status, 'pass')
  const unused = findingsFor(covered, 'deprecated-operation-unused')
  assert.equal(unused.length, 1)
  assert.equal(unused[0].severity, 'info')
  assert.equal(unused[0].evidence, 'coverage 2026-03-01T00:00:00Z to 2026-06-01T00:00:00Z from gateway-access-log, all 1 known consumer(s)')
  assert.equal(unused[0].suggestion, 'This covers the declared consumers and window only; usage outside either remains unknown.')

  const short = await apiReport(fixture(quiet, users, { consumersKnown: 40 }))
  assert.equal(short.status, 'incomplete')
  const unknown = findingsFor(short, 'deprecated-operation-usage-unknown')
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].severity, 'error')
  assert.equal(
    unknown[0].message,
    'No inventoried consumer calls "listInvoicesV1", but the coverage of this inventory is incomplete, so that is not evidence that nothing calls it.',
  )
  assert.equal(unknown[0].evidence, 'coverage 2026-03-01T00:00:00Z to 2026-06-01T00:00:00Z from gateway-access-log, 1 of 40 consumer(s)')
})

test('the coverage window and the API version are gaps in their own right', async () => {
  const stale = await apiReport(fixture(
    operations(),
    [consumer({ calls: [call({ lastSeen: '2025-12-01T00:00:00Z' })] })],
    { windowStart: '2025-10-01T00:00:00Z', windowEnd: '2026-01-01T00:00:00Z' },
  ))
  assert.equal(stale.status, 'incomplete')
  assert.equal(stale.summary.coverageGaps, 1)
  assert.equal(findingsFor(stale, 'coverage-window-stale').length, 1)

  const mismatched = await apiReport(fixture(operations(), [consumer()], { apiVersion: '1.9.0' }))
  assert.equal(mismatched.status, 'incomplete')
  assert.equal(mismatched.summary.coverageGaps, 1)
  assert.equal(findingsFor(mismatched, 'coverage-version-mismatch').length, 1)
  assert.equal(
    findingsFor(mismatched, 'coverage-version-mismatch')[0].message,
    'The usage was observed against API version "1.9.0" but the document declares "2.4.0", so this inventory is not evidence about the operations that were scanned.',
  )
})

test('the scan clock is the one that was passed in, not the day the test ran', async () => {
  // Same bytes, two clocks, two different verdicts -- and neither depends on
  // when this test is executed.
  const files = fixture([operation({ 'x-sunset': '2026-05-31T00:00:00Z' }), current()], [ACTIVE])
  const before = await apiReport(files, { now: '2026-05-30T23:59:59Z' })
  const after = await apiReport(files, { now: NOW })

  assert.equal(before.status, 'pass')
  assert.equal(before.summary.expired, 0)
  assert.equal(after.status, 'fail')
  assert.equal(after.summary.expired, 1)
})
