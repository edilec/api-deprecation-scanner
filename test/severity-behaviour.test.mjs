import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NOW, call, cliRun, consumer, current, fixture, operation, operations, raisedRules, withRoot,
} from './support.mjs'

/**
 * Severity, pinned by what actually happens.
 *
 * `test/severity-table.test.mjs` asserts the table against the documented
 * catalog. That is worth having and it is not this: a table, a catalog and a
 * hand-written expected map are three declarations agreeing with each other,
 * and a coordinated edit of all three passes every one of those assertions. A
 * rule quietly demoted from `error` to `warning` would reach exit 0 with the
 * whole suite green.
 *
 * These tests assert the consequence instead. Each case builds a root that
 * isolates one rule, runs the real binary, and pins the rules raised, the
 * report status and the process exit code. A demotion changes the observable
 * outcome -- `fail` becomes `pass`, exit 1 becomes exit 0 -- and no edit to a
 * declaration can satisfy an exit code.
 *
 * The `raised` list on each case is an isolation check, not an expectation
 * about severity: it says the fixture reaches the rule it claims to and
 * nothing else. Every severity assertion below is the literal status string
 * and the literal exit code.
 *
 * Seven error rules can be pinned this way. The other thirty-seven also mark the run
 * `incomplete`, so they exit 2 whatever their severity says, and
 * `test/severity-word.test.mjs` pins those with literal counts and printed
 * words instead.
 */

/** Build the root, run the real binary over it, and report what happened. */
async function audit(files, extraArgs = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--now', NOW, '--json', ...extraArgs])
    return { code: result.code, report: JSON.parse(result.stdout), stderr: result.stderr }
  })
}

const ACTIVE = consumer({ id: 'billing-portal' })
const DORMANT = consumer({ id: 'data-warehouse', calls: [call({ lastSeen: '2026-03-05T02:15:00Z' })] })
const ELSEWHERE = consumer({ id: 'partner-sync', calls: [call({ operationId: 'listInvoices' })] })

/**
 * Every error rule whose severity alone decides the verdict. Demote any one of
 * them and the run below stops exiting 1.
 */
const FAILING = [
  {
    // The headline rule. Demoting this is the exact defect this tool exists to
    // catch: a consumer still calling an endpoint that was supposed to be gone.
    ruleId: 'expired-operation-in-use',
    raised: ['expired-operation-in-use'],
    files: fixture([operation({ 'x-sunset': '2026-05-01T00:00:00Z' }), current()], [ACTIVE]),
  },
  {
    ruleId: 'replacement-unknown-operation',
    raised: ['deprecated-operation-in-use', 'replacement-unknown-operation'],
    files: fixture([operation({ 'x-replacement': 'listInvoicesV3' }), current()], [ACTIVE]),
  },
  {
    ruleId: 'replacement-also-deprecated',
    raised: ['deprecated-operation-in-use', 'deprecated-operation-unused', 'replacement-also-deprecated'],
    files: fixture([
      operation(),
      current({ deprecated: true, 'x-sunset': '2027-01-01T00:00:00Z', 'x-replacement': 'listInvoicesV3' }),
      current({ path: '/v3/invoices', operationId: 'listInvoicesV3' }),
    ], [ACTIVE]),
  },
  {
    ruleId: 'replacement-invalid',
    raised: ['deprecated-operation-in-use', 'replacement-invalid'],
    files: fixture([operation({ 'x-replacement': 42 }), current()], [ACTIVE]),
  },
  {
    ruleId: 'sunset-before-deprecation',
    raised: ['deprecated-operation-in-use', 'sunset-before-deprecation'],
    files: fixture([operation({ 'x-deprecated-since': '2027-01-01' }), current()], [ACTIVE]),
  },
  {
    ruleId: 'call-observed-after-clock',
    raised: ['call-observed-after-clock', 'deprecated-operation-in-use'],
    files: fixture(operations(), [consumer({ calls: [call({ lastSeen: '2026-07-01T00:00:00Z' })] })]),
  },
  {
    ruleId: 'call-outside-coverage-window',
    raised: ['call-outside-coverage-window', 'deprecated-operation-dormant-use'],
    files: fixture(operations(), [consumer({ calls: [call({ lastSeen: '2026-02-01T00:00:00Z' })] })]),
  },
]

for (const { ruleId, raised, files } of FAILING) {
  test(`${ruleId} fails the run, and the CLI exits 1`, async () => {
    const { code, report } = await audit(files)

    assert.deepEqual(raisedRules(report), raised, 'the fixture isolates the rule it claims to')
    assert.equal(report.status, 'fail')
    assert.equal(code, 1)
  })
}

/**
 * Every rule that must *not* fail a run. Promote any one of them to `error`
 * and the run below stops exiting 0.
 */
const PASSING = [
  {
    ruleId: 'deprecated-operation-in-use',
    raised: ['deprecated-operation-in-use'],
    files: fixture(operations(), [ACTIVE]),
  },
  {
    ruleId: 'deprecated-operation-dormant-use',
    raised: ['deprecated-operation-dormant-use'],
    files: fixture(operations(), [DORMANT]),
  },
  {
    ruleId: 'deprecated-operation-unused',
    raised: ['deprecated-operation-unused'],
    files: fixture(operations(), [ELSEWHERE]),
  },
  {
    ruleId: 'expired-operation-dormant-use',
    raised: ['expired-operation-dormant-use'],
    files: fixture([operation({ 'x-sunset': '2026-05-01T00:00:00Z' }), current()], [DORMANT]),
  },
  {
    ruleId: 'expired-operation-unused',
    raised: ['expired-operation-unused'],
    files: fixture([operation({ 'x-sunset': '2026-05-01T00:00:00Z' }), current()], [ELSEWHERE]),
  },
  {
    ruleId: 'sunset-imminent-operation-in-use',
    raised: ['sunset-imminent-operation-in-use'],
    files: fixture([operation({ 'x-sunset': '2026-06-20T00:00:00Z' }), current()], [ACTIVE]),
  },
  {
    ruleId: 'sunset-undeclared',
    raised: ['deprecated-operation-in-use', 'sunset-undeclared'],
    files: fixture([operation({ 'x-sunset': undefined }), current()], [ACTIVE]),
  },
  {
    ruleId: 'sunset-without-deprecation',
    raised: ['no-deprecated-operations', 'sunset-without-deprecation'],
    files: fixture([operation({ deprecated: undefined }), current()], [ACTIVE]),
  },
  {
    ruleId: 'replacement-undeclared',
    raised: ['deprecated-operation-in-use', 'replacement-undeclared'],
    files: fixture([operation({ 'x-replacement': undefined }), current()], [ACTIVE]),
  },
  {
    ruleId: 'no-deprecated-operations',
    raised: ['no-deprecated-operations'],
    files: fixture([current()], [ELSEWHERE]),
  },
]

for (const { ruleId, raised, files } of PASSING) {
  test(`${ruleId} does not fail the run, and the CLI exits 0`, async () => {
    const { code, report } = await audit(files)

    assert.deepEqual(raisedRules(report), raised, 'the fixture isolates the rule it claims to')
    assert.equal(report.status, 'pass')
    assert.equal(code, 0)
  })
}

test('a report with no findings at all still exits 0 on evidence, not on silence', async () => {
  const { code, report } = await audit(fixture([current()], [ELSEWHERE]))

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.consumers, 1)
  assert.equal(report.summary.calls, 1)
  // The one finding is the `info` that says why the run is green: the document
  // was read and nothing in it is deprecated.
  assert.equal(report.findings.length, 1)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
})
