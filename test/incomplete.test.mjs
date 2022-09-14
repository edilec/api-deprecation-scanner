import assert from 'node:assert/strict'
import { link } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  NOW, apiReport, call, cliRun, consumer, coverageOf, current, findingsFor, fixture, inventoryOf,
  operation, operations, specOf, withRoot,
} from './support.mjs'

/**
 * Every site that marks a run `incomplete`, one test each.
 *
 * A guarantee with no test that fails when it is removed is a guarantee that
 * will quietly stop being true. In this catalog, deleting a single
 * `incomplete = true` once let an entirely unread input report `pass` with the
 * whole suite still green.
 *
 * Each case below isolates one site: no other flag is set by that fixture, so
 * removing the flag changes the observable outcome from `incomplete` / exit 2
 * to `fail` / exit 1, and both assertions here fail. Where a site would be
 * backstopped by another, it does not exist: the declared-versus-compiled
 * checks own the refusals, `no-operations` is confined to a document that
 * declared none, the "unevaluated" coverage reason contributes to the coverage
 * decision without a flag of its own, and the two `...-usage-unknown` rules
 * set no flag at all because they are only reachable once one is already set.
 * That arrangement is deliberate; a flag whose removal changes nothing cannot
 * be caught by any test.
 */

const EXPIRED = operation({ 'x-sunset': '2026-05-01T00:00:00Z' })

async function run(files, extraArgs = [], prepare = null) {
  return withRoot(files, async (root) => {
    if (prepare !== null) await prepare(root)
    const result = await cliRun(['--root', root, '--now', NOW, '--json', ...extraArgs])
    return { code: result.code, report: JSON.parse(result.stdout) }
  })
}

/** Both halves of the claim: the status and the exit code the status produces. */
function assertIncomplete({ code, report }, ruleId) {
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(findingsFor(report, ruleId).length >= 1, true, `${ruleId} is the finding that says why`)
}

test('an input that could not be read leaves the run incomplete', async () => {
  assertIncomplete(await run({ 'openapi.json': specOf(operations()) }, ['--inventory', 'missing.json']), 'input-unreadable')
})

test('an input that is not UTF-8 leaves the run incomplete', async () => {
  assertIncomplete(await run({
    'openapi.json': specOf(operations()),
    'usage.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
  }), 'input-not-utf8')
})

test('an input that is not JSON leaves the run incomplete', async () => {
  assertIncomplete(await run({
    'openapi.json': specOf(operations()),
    'usage.json': '{ "schemaVersion": ',
  }), 'input-not-json')
})

test('an input above the byte limit leaves the run incomplete', async () => {
  assertIncomplete(await run(
    { 'openapi.json': specOf(operations()), 'usage.json': inventoryOf([consumer()], { source: 'x'.repeat(20000) }) },
    ['--max-file-bytes', '5000'],
  ), 'input-too-large')
})

test('an input deeper than the depth limit leaves the run incomplete', async () => {
  let nested = 1
  for (let depth = 0; depth < 60; depth += 1) nested = [nested]
  assertIncomplete(await run({ 'openapi.json': specOf(operations()), 'usage.json': nested }), 'input-too-deep')
})

test('two names for one inode leave the run incomplete', async () => {
  assertIncomplete(
    await run({ 'openapi.json': specOf(operations()) }, [], (root) => link(join(root, 'openapi.json'), join(root, 'usage.json'))),
    'inputs-same-file',
  )
})

test('a document that did not compile at all leaves the run incomplete', async () => {
  assertIncomplete(await run({
    'openapi.json': { openapi: '3.1.0', info: { title: 'Billing API', version: '2.4.0' } },
    'usage.json': inventoryOf([consumer()]),
  }), 'spec-invalid')
})

test('an operation that was refused leaves the run incomplete, through the declared-versus-compiled check', async () => {
  assertIncomplete(await run(fixture([
    operation(),
    current(),
    { path: '/v1/reports', method: 'get', summary: 'no operationId here' },
  ], [consumer()])), 'operation-invalid')
})

test('an unsupported construct leaves the run incomplete', async () => {
  assertIncomplete(await run({
    'openapi.json': specOf(operations(), { webhooks: { invoicePaid: { post: { operationId: 'w', deprecated: true } } } }),
    'usage.json': inventoryOf([consumer()]),
  }), 'spec-construct-unsupported')
})

test('an operation limit that cut the walk short leaves the run incomplete', async () => {
  // This site needs its own flag: the limit stops the walk before a slot is
  // reached, so nothing is refused and the declared-versus-compiled check
  // stays satisfied.
  assertIncomplete(await run(
    fixture([operation({ 'x-replacement': undefined }), current()], [consumer()]),
    ['--max-operations', '1'],
  ), 'too-many-operations')
})

test('an announcement this reader could not interpret leaves the run incomplete', async () => {
  assertIncomplete(await run(fixture([operation({ 'x-sunset': '2026-02-31' }), current()], [consumer()])), 'sunset-invalid')
})

test('a near-miss deprecation extension leaves the run incomplete', async () => {
  assertIncomplete(await run(fixture([operation({ 'x-removal-date': '2026-05-01' }), current()], [consumer()])), 'sunset-extension-unrecognised')
})

test('an inventory that did not compile at all leaves the run incomplete', async () => {
  assertIncomplete(await run({ 'openapi.json': specOf(operations()), 'usage.json': [] }), 'inventory-invalid')
})

test('a consumer that was refused leaves the run incomplete, through the declared-versus-compiled check', async () => {
  assertIncomplete(await run(fixture(
    operations(),
    [consumer(), { id: 'partner-sync', calls: 'all of them' }],
    { consumersKnown: 1 },
  )), 'consumer-invalid')
})

test('an unknown inventory key leaves the run incomplete', async () => {
  assertIncomplete(await run({
    'openapi.json': specOf(operations()),
    'usage.json': { ...inventoryOf([consumer()]), consumersKnwon: 12 },
  }), 'inventory-key-unknown')
})

test('each coverage gap leaves the run incomplete on its own', async () => {
  assertIncomplete(await run(fixture(operations(), [consumer()], { consumersKnown: 9 })), 'coverage-consumers-incomplete')
  assertIncomplete(await run(fixture(operations(), [consumer()], { apiVersion: '1.9.0' })), 'coverage-version-mismatch')
  assertIncomplete(await run(fixture(
    operations(),
    [consumer({ calls: [call({ lastSeen: '2025-12-01T00:00:00Z' })] })],
    { windowStart: '2025-10-01T00:00:00Z', windowEnd: '2026-01-01T00:00:00Z' },
  )), 'coverage-window-stale')
})

test('a call naming an operation the document does not declare leaves the run incomplete', async () => {
  assertIncomplete(await run(fixture(
    operations(),
    [consumer({ calls: [call({ operationId: 'listInvoicesV9' })] })],
  )), 'usage-operation-unknown')
})

test('a document with no operations at all leaves the run incomplete', async () => {
  assertIncomplete(await run({
    'openapi.json': specOf([]),
    'usage.json': inventoryOf([consumer({ calls: [] })]),
  }), 'no-operations')
})

test('an inventory with no consumers at all leaves the run incomplete', async () => {
  assertIncomplete(await run(fixture(operations(), [])), 'no-consumers-inventoried')
})

test('a truncated report leaves the run incomplete', async () => {
  assertIncomplete(await run(fixture([operation({ 'x-replacement': undefined })], [consumer()]), ['--max-findings', '1']), 'too-many-findings')
})

test('a join that ran out of budget leaves the run incomplete', async () => {
  const many = []
  for (let index = 0; index < 300; index += 1) {
    many.push(consumer({ id: `consumer-${index}`, calls: [call(), call({ operationId: 'listInvoices' })] }))
  }
  assertIncomplete(await run(fixture(operations(), many), ['--max-milliseconds', '1']), 'time-limit-exceeded')
})

/* The invariants that hold across every one of them ------------------------ */

test('an incomplete run always carries an error finding saying why', async () => {
  // This is the property that makes every flag above testable at all: without
  // it, a site whose findings were all warnings would turn exit 2 into exit 0
  // when the flag was removed, and a test asserting only the status would
  // still be the only thing standing in the way.
  const cases = [
    await run({ 'openapi.json': specOf(operations()) }, ['--inventory', 'missing.json']),
    await run({ 'openapi.json': specOf(operations()), 'usage.json': [] }),
    await run(fixture(operations(), [consumer()], { consumersKnown: 9 })),
    await run(fixture(operations(), [])),
    await run(fixture([operation({ 'x-sunset': '2026-02-31' }), current()], [consumer()])),
  ]

  for (const result of cases) {
    assert.equal(result.report.status, 'incomplete')
    assert.equal(result.code, 2)
    assert.equal(result.report.summary.errors >= 1, true, 'an incomplete run names at least one error')
  }
})

test('a pass is never reported with nothing checked', async () => {
  // Two ways to reach a run with no evidence, both refused explicitly.
  const noOperations = await run({ 'openapi.json': specOf([]), 'usage.json': inventoryOf([consumer({ calls: [] })]) })
  assert.equal(noOperations.report.summary.checked, 0)
  assert.equal(noOperations.report.status, 'incomplete')

  const noConsumers = await run(fixture(operations(), []))
  assert.equal(noConsumers.report.summary.consumers, 0)
  assert.equal(noConsumers.report.status, 'incomplete')
})

test('an expired operation still in use is a fail, not an incomplete, when the evidence is whole', async () => {
  // The control for every case above: a run with complete evidence reaches a
  // verdict rather than an "incomplete", so the flag tests are failing on the
  // gap they name and not on something the fixtures all share.
  const { code, report } = await run(fixture([EXPIRED, current()], [consumer()]))

  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.equal(report.summary.coverageGaps, 0)
  assert.equal(report.summary.unevaluated, 0)
})

test('the coverage block is required, so a run cannot silently skip the honesty check', async () => {
  const { code, report } = await run({
    'openapi.json': specOf(operations()),
    'usage.json': { schemaVersion: '1', consumers: [consumer()] },
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.equal(findingsFor(report, 'coverage-invalid').length, 1)
  assert.equal(report.summary.consumers, 0, 'nothing was joined, because there was no coverage to join it under')
})

test('a coverage block whose window is not a real window is refused', async () => {
  const { report } = await run({
    'openapi.json': specOf(operations()),
    'usage.json': { schemaVersion: '1', coverage: coverageOf({ consumersKnown: 1, windowStart: '2026-06-01T00:00:00Z', windowEnd: '2026-03-01T00:00:00Z' }), consumers: [consumer()] },
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(findingsFor(report, 'coverage-invalid')[0].location.pointer, '/coverage/windowEnd')
})

test('the same fixture with one flag-triggering field removed passes, proving the fixtures isolate', async () => {
  const clean = await run(fixture(operations(), [consumer()]))
  assert.equal(clean.report.status, 'pass')
  assert.equal(clean.code, 0)
})

test('the exported API reports the same status as the binary', async () => {
  const report = await apiReport(fixture(operations(), [consumer()], { consumersKnown: 9 }))
  assert.equal(report.status, 'incomplete')
})
