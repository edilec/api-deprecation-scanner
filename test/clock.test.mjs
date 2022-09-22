import assert from 'node:assert/strict'
import test from 'node:test'

import { apiReport, call, consumer, current, fixture, operation, operations, raisedRules } from './support.mjs'

/**
 * The injected clock, at every boundary it decides.
 *
 * "Expired", "imminent", "active" and "stale" are all comparisons against
 * `now`, and `now` is a parameter. That is what makes these tests possible at
 * all: an operation can be stood one millisecond either side of its own
 * removal date without waiting for a calendar, and the answer is the same on
 * every machine on every day.
 */

const SUNSET = '2026-05-01T00:00:00Z'
const expiring = [operation({ 'x-sunset': SUNSET }), current()]

const rulesAt = async (now, files) => raisedRules(await apiReport(files, { now }))

test('an operation is expired at its removal instant, and not one millisecond before', async () => {
  const files = fixture(expiring, [consumer({ calls: [call({ lastSeen: '2026-03-05T00:00:00Z' })] })])

  assert.deepEqual(await rulesAt('2026-05-01T00:00:00Z', files), ['expired-operation-dormant-use'])
  assert.deepEqual(await rulesAt('2026-04-30T23:59:59.999Z', files), ['deprecated-operation-dormant-use'])
})

test('a removal date written as a calendar day means the first instant of that day', async () => {
  const files = fixture([operation({ 'x-sunset': '2026-05-01' }), current()], [consumer({ calls: [call({ lastSeen: '2026-03-05T00:00:00Z' })] })])

  assert.deepEqual(await rulesAt('2026-05-01T00:00:00Z', files), ['expired-operation-dormant-use'])
  assert.deepEqual(await rulesAt('2026-04-30T23:59:59.999Z', files), ['deprecated-operation-dormant-use'])
})

test('a consumer is active at the activity boundary, and dormant one millisecond earlier', async () => {
  // The window is 2592000 seconds, so the boundary is exactly thirty days
  // before the clock.
  const onBoundary = fixture(expiring, [consumer({ calls: [call({ lastSeen: '2026-05-06T00:00:00Z' })] })])
  const justOutside = fixture(expiring, [consumer({ calls: [call({ lastSeen: '2026-05-05T23:59:59.999Z' })] })])

  assert.deepEqual(await rulesAt('2026-06-05T00:00:00Z', onBoundary), ['expired-operation-in-use'])
  assert.deepEqual(await rulesAt('2026-06-05T00:00:00Z', justOutside), ['expired-operation-dormant-use'])
})

test('an operation is imminent at the far edge of the window, and merely deprecated one millisecond past it', async () => {
  const onBoundary = fixture([operation({ 'x-sunset': '2026-07-05T00:00:00Z' }), current()], [consumer()])
  const justOutside = fixture([operation({ 'x-sunset': '2026-07-05T00:00:00.001Z' }), current()], [consumer()])

  assert.deepEqual(await rulesAt('2026-06-05T00:00:00Z', onBoundary), ['sunset-imminent-operation-in-use'])
  assert.deepEqual(await rulesAt('2026-06-05T00:00:00Z', justOutside), ['deprecated-operation-in-use'])
})

test('coverage is stale at one millisecond past the allowance, and fresh on it', async () => {
  const files = fixture(operations(), [consumer()])

  // windowEnd is 2026-06-01T00:00:00Z and the allowance is 604800 seconds.
  assert.deepEqual(await rulesAt('2026-06-08T00:00:00Z', files), ['deprecated-operation-in-use'])
  assert.deepEqual(
    await rulesAt('2026-06-08T00:00:00.001Z', files),
    ['coverage-window-stale', 'deprecated-operation-in-use'],
  )
})

test('the policy windows move the boundaries, and nothing else does', async () => {
  const files = fixture(expiring, [consumer({ calls: [call({ lastSeen: '2026-05-06T00:00:00Z' })] })])

  assert.deepEqual(await rulesAt('2026-06-05T00:00:00Z', files), ['expired-operation-in-use'])
  assert.deepEqual(
    raisedRules(await apiReport(files, { now: '2026-06-05T00:00:00Z', policy: { activeWithinSeconds: 2591999 } })),
    ['expired-operation-dormant-use'],
  )
})

test('the clock is required, and a clock that is not a real instant is a configuration error', async () => {
  const files = fixture(operations(), [consumer()])
  for (const now of [undefined, null, '2026-06-05', '2026-02-31T00:00:00Z', 'now', 1780000000000]) {
    await assert.rejects(() => apiReport(files, { now }), /now must be a full ISO-8601 UTC instant/, String(now))
  }
})

test('the same bytes at two clocks give two verdicts, and each is stable', async () => {
  // The removal date falls between the two clocks and the consumer is active
  // at both, so the only thing that changes is which side of the date we are
  // standing on.
  const files = fixture([operation({ 'x-sunset': '2026-05-31T00:00:00Z' }), current()], [consumer()])

  const before = await apiReport(files, { now: '2026-05-30T12:00:00Z' })
  const after = await apiReport(files, { now: '2026-06-05T00:00:00Z' })

  assert.equal(before.status, 'pass')
  assert.equal(after.status, 'fail')
  assert.equal(JSON.stringify(await apiReport(files, { now: '2026-05-30T12:00:00Z' })), JSON.stringify(before))
  assert.equal(JSON.stringify(await apiReport(files, { now: '2026-06-05T00:00:00Z' })), JSON.stringify(after))
})

test('a call observed after the clock is a contradiction, reported rather than accommodated', async () => {
  const report = await apiReport(fixture(operations(), [consumer({ calls: [call({ lastSeen: '2026-06-05T00:00:00.001Z' })] })]))

  assert.deepEqual(raisedRules(report), ['call-observed-after-clock', 'deprecated-operation-in-use'])
  assert.equal(report.status, 'fail')
  // The observation is still used: something did call the operation, and
  // discarding that because the clock disagrees would lose the finding that
  // matters.
  assert.equal(report.summary.links, 1)
})

test('a call exactly at the clock is not after it', async () => {
  const report = await apiReport(fixture(operations(), [consumer({ calls: [call({ lastSeen: '2026-06-01T00:00:00Z' })] })]), { now: '2026-06-01T00:00:00Z' })
  assert.deepEqual(raisedRules(report), ['deprecated-operation-in-use'])
})

test('a call at either edge of the coverage window is inside it', async () => {
  const inside = await apiReport(fixture(operations(), [consumer({ calls: [call({ lastSeen: '2026-03-01T00:00:00Z' })] })]))
  assert.deepEqual(inside, await apiReport(fixture(operations(), [consumer({ calls: [call({ lastSeen: '2026-03-01T00:00:00Z' })] })])))
  assert.equal(raisedRules(inside).includes('call-outside-coverage-window'), false)

  const outside = await apiReport(fixture(operations(), [consumer({ calls: [call({ lastSeen: '2026-02-28T23:59:59.999Z' })] })]))
  assert.equal(raisedRules(outside).includes('call-outside-coverage-window'), true)
})
