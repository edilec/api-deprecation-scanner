import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_LIMITS, DEFAULT_POLICY, HARD_LIMITS, MAX_POLICY_SECONDS, scanDeprecations,
  validateLimits, validatePolicy,
} from '../src/index.mjs'
import {
  NOW, apiReport, call, consumer, current, findingsFor, fixture, inventoryOf, operation,
  operations, raisedRules, specOf,
} from './support.mjs'

/**
 * Every documented limit, enforced and tested from **both** sides of the
 * bound.
 *
 * A limit tested only from above passes whether the bound is `>` or `>=`, and
 * a limit tested only from below passes whether it is enforced at all. Each
 * case here runs the same input twice: once at the bound, where it must be
 * read, and once past it, where it must produce the finding that names the
 * limit and make the run incomplete rather than truncating in silence.
 */

const SPEC = specOf(operations())
const TWO_CALLS = consumer({ calls: [call(), call({ operationId: 'listInvoices' })] })

test('maxFileBytes: a file exactly at the bound is read, one byte over is not', async () => {
  const text = `${JSON.stringify(inventoryOf([consumer()]), null, 2)}\n`
  const size = Buffer.byteLength(text, 'utf8')

  const atBound = await apiReport({ 'openapi.json': SPEC, 'usage.json': text }, { limits: { maxFileBytes: size } })
  assert.deepEqual(raisedRules(atBound), ['deprecated-operation-in-use'])

  const overBound = await apiReport({ 'openapi.json': SPEC, 'usage.json': text }, { limits: { maxFileBytes: size - 1 } })
  assert.deepEqual(raisedRules(overBound), ['input-too-large'])
  assert.equal(overBound.status, 'incomplete')
  assert.match(findingsFor(overBound, 'input-too-large')[0].message, new RegExp(`is ${size} bytes, above the maxFileBytes limit of ${size - 1}`))
})

test('maxJsonDepth: a document exactly at the bound is parsed, one level deeper is not', async () => {
  const nest = (depth) => {
    let value = 1
    for (let index = 0; index < depth; index += 1) value = [value]
    return value
  }

  const atBound = await apiReport({ 'openapi.json': SPEC, 'usage.json': nest(50) })
  assert.deepEqual(raisedRules(atBound), ['inventory-invalid'], 'it was read, and refused on its shape instead')

  const overBound = await apiReport({ 'openapi.json': SPEC, 'usage.json': nest(51) })
  assert.deepEqual(raisedRules(overBound), ['input-too-deep'])
  assert.equal(overBound.status, 'incomplete')
})

test('maxOperations: the last operation inside the bound is read, the one past it is not', async () => {
  const files = fixture([operation({ 'x-replacement': undefined }), current()], [consumer()])

  const atBound = await apiReport(files, { limits: { maxOperations: 2 } })
  assert.equal(atBound.summary.checked, 2)
  assert.equal(atBound.status, 'pass')

  const overBound = await apiReport(files, { limits: { maxOperations: 1 } })
  assert.equal(overBound.summary.checked, 1)
  assert.equal(overBound.status, 'incomplete')
  assert.equal(findingsFor(overBound, 'too-many-operations').length, 1)
})

test('maxConsumers: the last consumer inside the bound is read, the one past it is not', async () => {
  const files = fixture(operations(), [consumer(), consumer({ id: 'partner-sync', calls: [call({ operationId: 'listInvoices' })] })])

  const atBound = await apiReport(files, { limits: { maxConsumers: 2 } })
  assert.equal(atBound.summary.consumers, 2)
  assert.equal(atBound.status, 'pass')

  const overBound = await apiReport(files, { limits: { maxConsumers: 1 } })
  assert.equal(overBound.summary.consumers, 1)
  assert.equal(overBound.summary.unevaluated, 1)
  assert.equal(overBound.status, 'incomplete')
  assert.equal(findingsFor(overBound, 'too-many-consumers').length, 1)
})

test('maxCalls: the last call inside the bound is read, the one past it is not', async () => {
  const files = fixture(operations(), [TWO_CALLS])

  const atBound = await apiReport(files, { limits: { maxCalls: 2 } })
  assert.equal(atBound.summary.calls, 2)
  assert.equal(atBound.status, 'pass')

  const overBound = await apiReport(files, { limits: { maxCalls: 1 } })
  assert.equal(overBound.summary.calls, 1)
  assert.equal(overBound.status, 'incomplete')
  assert.equal(findingsFor(overBound, 'too-many-calls').length, 1)
})

test('maxCallsPerConsumer: the last call inside the bound is read, the one past it is not', async () => {
  const files = fixture(operations(), [TWO_CALLS])

  const atBound = await apiReport(files, { limits: { maxCallsPerConsumer: 2 } })
  assert.equal(atBound.summary.calls, 2)
  assert.equal(atBound.status, 'pass')

  const overBound = await apiReport(files, { limits: { maxCallsPerConsumer: 1 } })
  assert.equal(overBound.summary.calls, 1)
  assert.equal(overBound.status, 'incomplete')
  assert.equal(findingsFor(overBound, 'too-many-calls-for-consumer').length, 1)
})

test('maxConsumersNamed: the list names exactly that many, and counts the rest', async () => {
  const many = []
  for (let index = 1; index <= 4; index += 1) {
    many.push(consumer({ id: `consumer-${index}`, calls: [call({ operationId: 'listInvoices' })] }))
  }
  const files = fixture(operations(), many, { consumersKnown: 40 })

  const atBound = await apiReport(files, { limits: { maxConsumersNamed: 4 } })
  assert.equal(
    findingsFor(atBound, 'coverage-consumers-incomplete')[0].evidence,
    'inventoried: consumer-1, consumer-2, consumer-3, consumer-4',
  )

  const overBound = await apiReport(files, { limits: { maxConsumersNamed: 3 } })
  assert.equal(
    findingsFor(overBound, 'coverage-consumers-incomplete')[0].evidence,
    'inventoried: consumer-1, consumer-2, consumer-3 (+1 more)',
  )
})

test('maxFindings: a report exactly at the bound is whole, one finding over is truncated and incomplete', async () => {
  const files = fixture([operation({ 'x-replacement': undefined })], [consumer()])

  const atBound = await apiReport(files, { limits: { maxFindings: 2 } })
  assert.equal(atBound.findings.length, 2)
  assert.equal(atBound.status, 'pass')

  const overBound = await apiReport(files, { limits: { maxFindings: 1 } })
  assert.equal(overBound.findings.length, 1)
  assert.deepEqual(raisedRules(overBound), ['too-many-findings'])
  assert.equal(overBound.status, 'incomplete')
  assert.match(findingsFor(overBound, 'too-many-findings')[0].message, /2 were not reported and this report is partial/)
})

test('maxMilliseconds: a generous budget completes, a one-millisecond budget does not', async () => {
  const many = []
  for (let index = 0; index < 300; index += 1) {
    many.push(consumer({ id: `consumer-${index}`, calls: [call(), call({ operationId: 'listInvoices' })] }))
  }
  const files = fixture(operations(), many)

  const atBound = await apiReport(files)
  assert.equal(atBound.status, 'pass')
  assert.equal(atBound.summary.links, 300)

  const overBound = await apiReport(files, { limits: { maxMilliseconds: 1 } })
  assert.equal(overBound.status, 'incomplete')
  assert.equal(findingsFor(overBound, 'time-limit-exceeded').length, 1)
})

test('a join that runs out of budget leaves no verdict behind', async () => {
  // The budget is checked inside the join's loops, so it stops the walk in the
  // middle. Everything that walk was responsible for concluding is unfinished
  // at that point, and `no-deprecated-operations` is the conclusion it owns:
  // it is a claim about every operation in the document, and this run examined
  // none of them. The document below does hold a deprecated operation, so the
  // claim is not merely unearned, it is false -- and it would be written into
  // the JSON report a consumer parses rather than only printed.
  const many = []
  for (let index = 0; index < 300; index += 1) {
    many.push(consumer({ id: `consumer-${index}`, calls: [call(), call({ operationId: 'listInvoices' })] }))
  }
  const report = await apiReport(fixture(operations(), many), { limits: { maxMilliseconds: 1 } })

  assert.equal(report.status, 'incomplete')
  assert.equal(findingsFor(report, 'time-limit-exceeded').length, 1)
  assert.equal(report.summary.deprecated, 0, 'the walk that counts them never ran')
  assert.equal(
    findingsFor(report, 'no-deprecated-operations').length,
    0,
    'one of these operations is deprecated; the run simply never looked at it',
  )
})

/* The limit configuration itself ------------------------------------------- */

test('an unknown limit name throws rather than being ignored', () => {
  // A documented limit that a typo silently disables is a limit that is not
  // enforced, and a run that quietly used the default would look green for the
  // wrong reason.
  assert.throws(() => validateLimits({ maxOperation: 5 }), /Unknown limits "maxOperation"/)
  assert.throws(() => validateLimits({ maxfilebytes: 5 }), /Unknown limits "maxfilebytes"/)
  assert.throws(() => validateLimits([]), /limits must be an object/)
})

test('every limit accepts 1 and its cap, and refuses 0 and one past the cap', () => {
  for (const [key, cap] of Object.entries(HARD_LIMITS)) {
    assert.equal(validateLimits({ [key]: 1 })[key], 1, key)
    assert.equal(validateLimits({ [key]: cap })[key], cap, key)
    assert.throws(() => validateLimits({ [key]: 0 }), new RegExp(`limits.${key} must be an integer between 1 and ${cap}`))
    assert.throws(() => validateLimits({ [key]: cap + 1 }), new RegExp(`limits.${key} must be an integer between 1 and ${cap}`))
    assert.throws(() => validateLimits({ [key]: 1.5 }), new RegExp(`limits.${key} must be an integer`))
  }
  assert.deepEqual(Object.keys(HARD_LIMITS).sort(), Object.keys(DEFAULT_LIMITS).sort(), 'every default has a cap')
  for (const [key, value] of Object.entries(DEFAULT_LIMITS)) {
    assert.equal(value <= HARD_LIMITS[key], true, `${key} defaults inside its own cap`)
  }
})

test('every policy window accepts 1 and its cap, and refuses 0 and one past the cap', () => {
  for (const key of Object.keys(DEFAULT_POLICY)) {
    assert.equal(validatePolicy({ [key]: 1 })[key], 1, key)
    assert.equal(validatePolicy({ [key]: MAX_POLICY_SECONDS })[key], MAX_POLICY_SECONDS, key)
    assert.throws(() => validatePolicy({ [key]: 0 }), new RegExp(`policy.${key} must be an integer between 1 and ${MAX_POLICY_SECONDS}`))
    assert.throws(() => validatePolicy({ [key]: MAX_POLICY_SECONDS + 1 }), new RegExp(`policy.${key} must be an integer`))
  }
  assert.throws(() => validatePolicy({ activeWithin: 5 }), /Unknown policy "activeWithin"/)
})

test('the defaults are frozen, and an override leaves them alone', () => {
  assert.equal(Object.isFrozen(DEFAULT_LIMITS), true)
  assert.equal(Object.isFrozen(DEFAULT_POLICY), true)
  assert.equal(Object.isFrozen(validateLimits({ maxFindings: 3 })), true)
  assert.equal(DEFAULT_LIMITS.maxFindings, 1000)
})

test('an unknown option throws rather than being ignored', async () => {
  await assert.rejects(() => scanDeprecations({ root: '.', now: NOW, inventry: 'usage.json' }), /Unknown option "inventry"/)
  await assert.rejects(() => scanDeprecations([]), /options must be an object/)
  await assert.rejects(() => scanDeprecations({ now: NOW }), /root must be a non-empty string/)
})
