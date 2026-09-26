import assert from 'node:assert/strict'
import test from 'node:test'

import { parseInstant, scanDeprecations } from '../src/index.mjs'
import {
  NOW, apiReport, call, consumer, coverageOf, current, findingsFor, fixture, inventoryOf,
  operation, operations, raisedRules, specOf,
} from './support.mjs'

/**
 * The fixed bounds, from both sides of each one.
 *
 * `test/limits.test.mjs` does this for the nine configurable limits. These six
 * are not configurable, are not in that table, and each was pinned from one
 * side only -- the side that refuses. A bound checked only from above passes
 * whether it is written `>` or `>=`, and widening it by one starts silently
 * refusing a legitimate input: a team name of exactly two hundred characters,
 * a call count a busy gateway really does reach, a removal date in the last
 * year this tool will reason about. A false refusal is a defect as much as a
 * false pass is, so the value that must still be read is asserted here beside
 * the one that must not be.
 */

const SPEC = specOf(operations())
const under = (document) => apiReport({ 'openapi.json': SPEC, 'usage.json': document })

test('a consumer contact of exactly 200 characters is read, and 201 is refused', async () => {
  const atBound = await under(inventoryOf([consumer({ contact: 'c'.repeat(200) })]))
  assert.deepEqual(raisedRules(atBound), ['deprecated-operation-in-use'])
  assert.equal(findingsFor(atBound, 'deprecated-operation-in-use')[0].evidence.includes('; owner ccc'), true)

  const overBound = await under(inventoryOf([consumer({ contact: 'c'.repeat(201) })]))
  assert.equal(findingsFor(overBound, 'consumer-invalid')[0].location.pointer, '/consumers/0/contact')
})

test('a coverage source of exactly 200 characters is read, and 201 is refused', async () => {
  const inventoryWith = (source) => ({
    schemaVersion: '1',
    coverage: coverageOf({ consumersKnown: 1, source }),
    consumers: [consumer()],
  })

  const atBound = await under(inventoryWith('s'.repeat(200)))
  assert.deepEqual(raisedRules(atBound), ['deprecated-operation-in-use'])

  const overBound = await under(inventoryWith('s'.repeat(201)))
  assert.equal(findingsFor(overBound, 'coverage-invalid')[0].location.pointer, '/coverage/source')
})

test('a consumersKnown of exactly 1000000 is read, and one more is refused', async () => {
  const inventoryWith = (consumersKnown) => ({
    schemaVersion: '1',
    coverage: coverageOf({ consumersKnown }),
    consumers: [consumer()],
  })

  const atBound = await under(inventoryWith(1000000))
  assert.equal(raisedRules(atBound).includes('coverage-invalid'), false)
  assert.equal(
    findingsFor(atBound, 'coverage-consumers-incomplete')[0].message.startsWith('1 of 1000000 known consumer(s) are inventoried'),
    true,
  )

  const overBound = await under(inventoryWith(1000001))
  assert.equal(findingsFor(overBound, 'coverage-invalid')[0].location.pointer, '/coverage/consumersKnown')
  assert.match(findingsFor(overBound, 'coverage-invalid')[0].message, /must be an integer between 0 and 1000000/)
})

test('a call count of exactly 1000000000000 is read, and one more is refused', async () => {
  const atBound = await under(inventoryOf([consumer({ calls: [call({ count: 1000000000000 })] })]))
  assert.deepEqual(raisedRules(atBound), ['deprecated-operation-in-use'])
  assert.equal(findingsFor(atBound, 'deprecated-operation-in-use')[0].evidence.includes('1000000000000 call(s)'), true)

  const overBound = await under(inventoryOf([consumer({ calls: [call({ count: 1000000000001 })] })]))
  assert.equal(findingsFor(overBound, 'call-invalid')[0].location.pointer, '/consumers/0/calls/0/count')
})

test('an input name of exactly 200 characters is read, and 201 is a configuration error', async () => {
  const name = `${'s'.repeat(195)}.json`
  assert.equal(name.length, 200, 'the accepted name stands exactly on the bound')

  const report = await apiReport({ [name]: SPEC, 'usage.json': inventoryOf([consumer()]) }, { spec: name })
  assert.deepEqual(raisedRules(report), ['deprecated-operation-in-use'])
  assert.equal(report.findings[0].location.file, name, 'the whole name reached the report')

  const tooLong = `${'s'.repeat(196)}.json`
  await assert.rejects(
    () => scanDeprecations({ root: '.', now: NOW, spec: tooLong }),
    /--spec must be a relative file name of 1-200 characters/,
  )
  await assert.rejects(
    () => scanDeprecations({ root: '.', now: NOW, inventory: tooLong }),
    /--inventory must be a relative file name of 1-200 characters/,
  )
})

test('a removal date in the year 2100 is read, and 2101 is outside the range this tool reasons about', async () => {
  assert.equal(parseInstant('2100-12-31T23:59:59Z').ok, true)
  assert.equal(parseInstant('2100-12-31T23:59:59Z').canonical, '2100-12-31T23:59:59Z')
  assert.equal(parseInstant('2101-01-01T00:00:00Z').reason, 'out-of-range')

  const atBound = await apiReport(fixture([operation({ 'x-sunset': '2100-12-31T23:59:59Z' }), current()], [consumer()]))
  assert.deepEqual(raisedRules(atBound), ['deprecated-operation-in-use'])

  const overBound = await apiReport(fixture([operation({ 'x-sunset': '2101-01-01T00:00:00Z' }), current()], [consumer()]))
  assert.equal(findingsFor(overBound, 'sunset-invalid')[0].message.includes('(out-of-range)'), true)
})
