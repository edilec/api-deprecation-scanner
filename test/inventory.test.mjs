import assert from 'node:assert/strict'
import test from 'node:test'

import { CALL_KEYS, CONSUMER_KEYS, COVERAGE_KEYS, INVENTORY_KEYS } from '../src/index.mjs'
import {
  apiReport, call, consumer, coverageOf, findingsFor, fixture, inventoryOf, operations,
  raisedRules, specOf,
} from './support.mjs'

/**
 * Reading the usage inventory.
 *
 * Everything here exists because the inventory is the only evidence about
 * consumers this tool will ever have. A field that is quietly dropped, a
 * duplicate that is quietly merged or a count that is quietly rounded turns
 * the report into a statement about a document nobody wrote.
 */

const SPEC = specOf(operations())
const under = (document) => apiReport({ 'openapi.json': SPEC, 'usage.json': document })

test('an unknown key is refused at every level, not only at the top', async () => {
  for (const [document, pointer] of [
    [{ ...inventoryOf([consumer()]), consumersKnwon: 3 }, '/consumersKnwon'],
    [{ schemaVersion: '1', coverage: { ...coverageOf({ consumersKnown: 1 }), window: 'last month' }, consumers: [consumer()] }, '/coverage/window'],
    [inventoryOf([{ ...consumer(), team: 'revenue' }]), '/consumers/0/team'],
    [inventoryOf([consumer({ calls: [{ ...call(), method: 'GET' }] })]), '/consumers/0/calls/0/method'],
  ]) {
    const report = await under(document)
    const found = findingsFor(report, 'inventory-key-unknown')
    assert.equal(found.length, 1, pointer)
    assert.equal(found[0].location.pointer, pointer)
    assert.equal(report.status, 'incomplete', pointer)
  }
})

test('the known key sets are the documented ones, and the message lists them', async () => {
  const report = await under({ ...inventoryOf([consumer()]), consumersKnwon: 3 })
  assert.equal(
    findingsFor(report, 'inventory-key-unknown')[0].message.startsWith(
      'Unknown inventory key "consumersKnwon". Known keys are consumers, coverage, schemaVersion.',
    ),
    true,
  )
  assert.deepEqual(INVENTORY_KEYS, ['consumers', 'coverage', 'schemaVersion'])
  assert.deepEqual(COVERAGE_KEYS, ['apiVersion', 'consumersKnown', 'source', 'windowEnd', 'windowStart'])
  assert.deepEqual(CONSUMER_KEYS, ['calls', 'contact', 'id'])
  assert.deepEqual(CALL_KEYS, ['count', 'lastSeen', 'operationId'])
})

test('the schema version is required and exact', async () => {
  for (const value of [undefined, 1, '2', '1.0']) {
    const report = await under({ ...inventoryOf([consumer()]), schemaVersion: value })
    assert.equal(findingsFor(report, 'inventory-invalid')[0].location.pointer, '/schemaVersion', String(value))
  }
})

test('consumersKnown accepts zero and refuses a negative, a fraction and a string', async () => {
  const none = await under({ schemaVersion: '1', coverage: coverageOf({ consumersKnown: 0 }), consumers: [] })
  assert.deepEqual(
    raisedRules(none),
    ['deprecated-operation-usage-unknown', 'no-consumers-inventoried'],
    'zero is a legal claim about the world, and an inventory with nobody in it is still no evidence',
  )

  for (const value of [-1, 1.5, '4', undefined, null]) {
    const report = await under({ schemaVersion: '1', coverage: coverageOf({ consumersKnown: value }), consumers: [consumer()] })
    assert.equal(findingsFor(report, 'coverage-invalid')[0].location.pointer, '/coverage/consumersKnown', String(value))
  }
})

test('a call count must be a positive integer, because zero is not a call', async () => {
  for (const value of [0, -3, 1.5, '12', undefined]) {
    const report = await under(inventoryOf([consumer({ calls: [call({ count: value })] })]))
    assert.equal(findingsFor(report, 'call-invalid')[0].location.pointer, '/consumers/0/calls/0/count', String(value))
  }
  const one = await under(inventoryOf([consumer({ calls: [call({ count: 1 })] })]))
  assert.equal(raisedRules(one).includes('call-invalid'), false)
})

test('a duplicate consumer is refused rather than merged, because merging invents usage', async () => {
  const report = await apiReport(fixture(
    operations(),
    [consumer(), consumer({ calls: [call({ count: 5000 })] })],
    { consumersKnown: 1 },
  ))

  assert.equal(findingsFor(report, 'consumer-duplicate').length, 1)
  assert.equal(report.summary.consumers, 1)
  assert.equal(findingsFor(report, 'deprecated-operation-in-use')[0].evidence.includes('12 call(s)'), true, 'the first entry is the one that stands')
})

test('one consumer naming one operation twice is refused, because two counts cannot be reconciled', async () => {
  const report = await under(inventoryOf([consumer({ calls: [call(), call({ count: 5000 })] })]))

  assert.equal(findingsFor(report, 'call-duplicate').length, 1)
  assert.equal(report.summary.calls, 1)
})

test('two consumers naming the same operation are not duplicates, they are the join', async () => {
  const report = await apiReport(fixture(operations(), [
    consumer({ id: 'billing-portal' }),
    consumer({ id: 'mobile-app' }),
  ]))

  assert.equal(raisedRules(report).includes('call-duplicate'), false)
  assert.equal(report.summary.links, 2)
})

test('a contact is optional, bounded, and never an address', async () => {
  const absent = await under(inventoryOf([consumer({ contact: undefined })]))
  assert.equal(absent.status, 'pass')
  assert.equal(findingsFor(absent, 'deprecated-operation-in-use')[0].evidence.includes('owner'), false)

  for (const value of ['team@example.test', '@revenue', 'x'.repeat(201), 42]) {
    const report = await under(inventoryOf([consumer({ contact: value })]))
    assert.equal(findingsFor(report, 'consumer-invalid')[0].location.pointer, '/consumers/0/contact', String(value))
  }
})

test('a consumer whose calls array is empty is read, and counts towards the coverage', async () => {
  const report = await apiReport(fixture(operations(), [consumer({ calls: [] })]))

  assert.equal(report.summary.consumers, 1)
  assert.equal(report.summary.calls, 0)
  assert.equal(report.summary.coverageGaps, 0)
  assert.deepEqual(raisedRules(report), ['deprecated-operation-unused'], 'silence from a covered consumer is evidence')
})

test('the coverage window must be two full instants in the right order', async () => {
  for (const [overrides, pointer] of [
    [{ windowStart: '2026-03-01' }, '/coverage/windowStart'],
    [{ windowEnd: undefined }, '/coverage/windowEnd'],
    [{ windowStart: '2026-06-01T00:00:00Z', windowEnd: '2026-03-01T00:00:00Z' }, '/coverage/windowEnd'],
    [{ windowStart: '2026-03-01T00:00:00Z', windowEnd: '2026-03-01T00:00:00Z' }, '/coverage/windowEnd'],
    [{ apiVersion: undefined }, '/coverage/apiVersion'],
    [{ source: '' }, '/coverage/source'],
  ]) {
    const report = await under({ schemaVersion: '1', coverage: coverageOf({ consumersKnown: 1, ...overrides }), consumers: [consumer()] })
    assert.equal(findingsFor(report, 'coverage-invalid')[0].location.pointer, pointer, JSON.stringify(overrides))
  }
})

test('the source is optional, and its absence is visible in the evidence rather than invented', async () => {
  const report = await apiReport(fixture(
    operations(),
    [consumer({ calls: [call({ operationId: 'listInvoices' })] })],
    { source: undefined },
  ))

  assert.equal(
    findingsFor(report, 'deprecated-operation-unused')[0].evidence,
    'coverage 2026-03-01T00:00:00Z to 2026-06-01T00:00:00Z, all 1 known consumer(s)',
  )
})

test('a consumer or call of the wrong shape is refused without taking the rest with it', async () => {
  const report = await apiReport(fixture(
    operations(),
    [consumer(), 'partner-sync', consumer({ id: 'mobile-app', calls: [call(), 7] })],
    { consumersKnown: 2 },
  ))

  assert.equal(findingsFor(report, 'consumer-invalid')[0].location.pointer, '/consumers/1')
  assert.equal(findingsFor(report, 'call-invalid')[0].location.pointer, '/consumers/2/calls/1')
  assert.equal(report.summary.consumers, 2, 'the two well-formed consumers were still read')
  assert.equal(report.summary.links, 2)
  assert.equal(report.summary.unevaluated, 2)
})
