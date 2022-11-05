import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { cliHuman, consumer, findingsFor, inventoryOf, specOf, operations } from './support.mjs'

/**
 * A JSON parse failure must not carry the document into the report.
 *
 * V8 reports a parse failure two ways, and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. The quoted
 * run is the first ten characters of the document, or the whole document when
 * it is shorter, so a file short enough to be nothing but a credential is
 * reproduced in full by its own error message. Interpolating that message into
 * a finding put the secret on stdout -- on the error path, which is exactly the
 * path an untrusted or malformed file takes.
 *
 * Sanitising does not fix it and neither does truncating: `excerpt` strips
 * control characters and cuts from the end, and the snippet sits at the front.
 *
 * The canary below is `AKIAIOSFODNN7EXAMPLE`, the access key id AWS publishes
 * in its own documentation. It is not a credential; it is the shape of one,
 * and it is the shape a scanner watching this tool's output would flag.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

/** The inventory a spec-side failure is read against: valid, so only the spec fails. */
const INVENTORY = inventoryOf([consumer({ calls: [] })])

/**
 * Assert the canary is absent from both streams, and so is every prefix of it
 * down to eight characters.
 *
 * The prefixes matter because V8 quotes only the first ten characters once the
 * document is long enough. A test that looked for the whole canary alone would
 * pass against a message that still leaked `AKIAIOSFOD`.
 */
function assertNoCanary({ stdout, stderr }, label) {
  for (let length = CANARY.length; length >= 8; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.equal(stdout.includes(prefix), false, `${label}: stdout carries ${prefix}`)
    assert.equal(stderr.includes(prefix), false, `${label}: stderr carries ${prefix}`)
  }
}

test('a document that is nothing but a credential is not echoed by the parse failure', async () => {
  const result = await cliHuman({ 'openapi.json': CANARY, 'usage.json': INVENTORY })

  const refused = findingsFor(result.report, 'input-not-json')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].location.file, 'openapi.json')
  assertNoCanary(result, 'whole document')
})

test('a credential inside a longer document is not echoed either', async () => {
  const result = await cliHuman({
    'openapi.json': `{"openapi": "3.1.0", "info": {"version": ${CANARY}}}`,
    'usage.json': INVENTORY,
  })

  assert.equal(findingsFor(result.report, 'input-not-json').length, 1)
  assertNoCanary(result, 'embedded in a document')
})

test('the inventory side is covered too, not only the spec side', async () => {
  const result = await cliHuman({ 'openapi.json': specOf(operations()), 'usage.json': CANARY })

  const refused = findingsFor(result.report, 'input-not-json')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].location.file, 'usage.json')
  assertNoCanary(result, 'inventory')
})

test('the position, line and column survive -- a parse error that says nothing is a different defect', async () => {
  const result = await cliHuman({
    'openapi.json': '{"openapi": "3.1.0" "info": {"version": "2.4.0"}}',
    'usage.json': INVENTORY,
  })

  const refused = findingsFor(result.report, 'input-not-json')
  assert.equal(refused.length, 1)
  assert.match(refused[0].message, /at position \d+ \(line \d+ column \d+\)/)
})

test('parseFailureDetail keeps the offset and drops the quoted document', () => {
  const detailFor = (text) => {
    try {
      JSON.parse(text)
    } catch (error) {
      return parseFailureDetail(error)
    }
    throw new Error('the fixture parsed, so it pins nothing')
  }

  assert.equal(detailFor(CANARY), "unexpected token 'A' at the start of the document")
  assert.equal(detailFor('ssn 123-45-6789'), "unexpected token 's' at the start of the document")
  assert.equal(detailFor('password=hunter2-correct-horse'), "unexpected token 'p' at the start of the document")
  assert.equal(detailFor(`{"a": 1, "b": ${CANARY}}`), "unexpected token 'A' inside the document")
  assert.equal(detailFor(''), 'Unexpected end of JSON input')
  assert.equal(detailFor('{"a": 1 "b": 2}'), "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)")
  assert.equal(detailFor('{"a": 1} trailing'), 'Unexpected non-whitespace character after JSON at position 9 (line 1 column 10)')
})

test('parseFailureDetail refuses a wording it was not taught rather than guessing', () => {
  assert.equal(
    parseFailureDetail(new Error('Unexpected token \'A\', "AKIAIOSFODNN7EXAMPLE" is not valid JSON at position 0')),
    'the document could not be parsed as JSON',
    'a double quote surviving to the end means the snippet survived with it',
  )
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('')), 'the document could not be parsed as JSON')
})

/**
 * Ordering pin: the quoting shape must be recognised BEFORE the offset.
 *
 * A helper that searches for `at position` first finds that phrase inside the
 * quoted span whenever the document itself supplies it, and slices the
 * document straight back out. The first case below is the one that bites when
 * the two branches are swapped back, and it takes two assertions to bite:
 * whether the document survives, AND whether the diagnostic does. The closing
 * double-quote guard turns a reverted ordering into the generic sentence
 * rather than a leak, so a test that only looked for the leak would sit green
 * over a helper that had stopped saying anything at all about this document.
 *
 * The last two cases pin that same opposite failure for the shapes V8 writes
 * without a quoted span. A helper that answered every message generically
 * would leak nothing and diagnose nothing.
 */

const ORDERING_SECRET = 'sk-live-9f2c1b7a4d'

/** The detail this tool produces for a document V8 refuses. */
function detailOfParseFailure(text) {
  try {
    JSON.parse(text)
  } catch (error) {
    return parseFailureDetail(error)
  }
  throw new Error(`${JSON.stringify(text)} parsed, so it pins nothing`)
}

/** What V8 actually said, so a case cannot quietly stop having a subject. */
function messageOfParseFailure(text) {
  try {
    JSON.parse(text)
  } catch (error) {
    return error.message
  }
  throw new Error(`${JSON.stringify(text)} parsed, so it pins nothing`)
}

test('a document that merely CONTAINS "at position" is not sliced back out', () => {
  const document = 'at position 1'
  assert.match(
    messageOfParseFailure(document),
    /"at position 1"/,
    'V8 still quotes this document back, so this case still has a subject',
  )

  const detail = detailOfParseFailure(document)
  assert.equal(detail.includes('"'), false, `a double quote survived: ${JSON.stringify(detail)}`)
  assert.equal(detail.includes(document), false, `the document survived: ${JSON.stringify(detail)}`)
  assert.match(
    detail,
    /unexpected token 'a'/,
    'the offending token is still named -- searching for the offset first loses it here',
  )
})

test('a document that is nothing but a credential-shaped token is not echoed', () => {
  const detail = detailOfParseFailure(ORDERING_SECRET)
  assert.equal(detail.includes(ORDERING_SECRET), false, `the token survived: ${JSON.stringify(detail)}`)
  assert.equal(detail.includes('"'), false)
})

test('no four-character prefix of a long sensitive document reaches the detail', () => {
  // Long enough that V8 quotes a ten-character window rather than the whole
  // document: asserting only on the whole string would pass while ten
  // characters of the secret still shipped.
  const detail = detailOfParseFailure(`${ORDERING_SECRET}${'x'.repeat(400)}`)
  for (let length = 4; length <= 10; length += 1) {
    assert.equal(
      detail.includes(ORDERING_SECRET.slice(0, length)),
      false,
      `the first ${length} characters of the document survived: ${JSON.stringify(detail)}`,
    )
  }
  assert.equal(detail.includes('"'), false)
})

test('a quoted span containing a newline is still recognised as a quoted span', () => {
  // Without the `s` flag the quoted-span pattern does not match this message
  // at all and the document falls through to a branch that keeps it.
  const detail = detailOfParseFailure('}x\n')
  assert.match(detail, /unexpected token/)
  assert.equal(detail.includes('"'), false, `a double quote survived: ${JSON.stringify(detail)}`)
})

test('the genuinely safe positional form keeps its position, line and column', () => {
  const detail = detailOfParseFailure('{"a": 1 "b": 2}')
  assert.match(detail, /at position 8/)
  assert.match(detail, /line 1 column 9/)
})

test('"Unexpected end of JSON input" passes through unchanged', () => {
  assert.equal(detailOfParseFailure(''), 'Unexpected end of JSON input')
})
