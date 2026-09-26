import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXCERPT_LIMIT, excerpt, formatReport, hasForbiddenCharacter, isIdentifier,
} from '../src/index.mjs'
import {
  FORBIDDEN, apiReport, call, consumer, current, findingsFor, fixture, inventoryOf, operation,
  operations, specOf,
} from './support.mjs'

/**
 * Sanitising every untrusted string that reaches output.
 *
 * Stripping C0 and U+2028/U+2029 is not sanitising. Four tools in this catalog
 * did exactly that and let the C1 range through: U+0085 NEL is a line break to
 * a great many consumers and U+009B is the 8-bit CSI, a terminal control
 * introducer that needs no ESC in front of it. U+202E reverses everything
 * printed after it, so a consumer id can be displayed as a different team's
 * name than the one the join actually matched.
 *
 * Two routes are covered, because a tool that hardens one and forgets the
 * other has not hardened anything:
 *
 *   - through an **identifier** -- a path template, an operationId, a consumer
 *     id, an API version. These are compared, used as map keys and used to
 *     join two documents, so a value that prints differently from the value
 *     that was matched is refused at the door rather than cleaned on the way
 *     out, and the refusal does not reproduce it.
 *   - through **free text and keys** -- a coverage source, a contact, a
 *     replacement link, an unknown JSON key. These are excerpted, and the
 *     excerpt is what reaches the report.
 */

const walk = (value, visit) => {
  if (typeof value === 'string') visit(value)
  else if (Array.isArray(value)) for (const item of value) walk(item, visit)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      visit(key)
      walk(item, visit)
    }
  }
}

/** Assert that nothing anywhere in the report -- key or value -- carries a forbidden character. */
function assertClean(report, label) {
  walk(report, (text) => {
    assert.equal(hasForbiddenCharacter(text), false, `${label}: ${JSON.stringify(text)} reached the report`)
  })
}

test('a forbidden character in a path template is refused, and the pointer it produces is clean', async () => {
  for (const [label, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport({
      'openapi.json': { openapi: '3.1.0', info: { version: '2.4.0' }, paths: { [`/v1/inv${character}oices`]: { get: { operationId: 'listInvoicesV1' } } } },
      'usage.json': inventoryOf([consumer({ calls: [] })]),
    })

    assert.equal(findingsFor(report, 'identifier-invalid').length, 1, label)
    assertClean(report, label)
  }
})

test('a forbidden character in a consumer id is refused without reproducing the value', async () => {
  for (const [label, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport(fixture(
      operations(),
      [consumer(), { id: `partner${character}sync`, calls: [] }],
      { consumersKnown: 1 },
    ))

    const refused = findingsFor(report, 'identifier-invalid')
    assert.equal(refused.length, 1, label)
    assert.equal(refused[0].location.pointer, '/consumers/1/id')
    assert.match(refused[0].message, /is a string of \d+ character\(s\)/, 'the shape, not the value')
    assertClean(report, label)
  }
})

test('a forbidden character in an operationId is refused', async () => {
  for (const [label, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport({
      'openapi.json': specOf([operation({ operationId: `listInvoices${character}V1` }), current()]),
      'usage.json': inventoryOf([consumer({ calls: [] })]),
    })

    assert.equal(findingsFor(report, 'operation-invalid').length, 1, label)
    assertClean(report, label)
  }
})

test('a forbidden character in the API version is refused on both sides of the join', async () => {
  for (const [label, character] of Object.entries(FORBIDDEN)) {
    const inSpec = await apiReport({
      'openapi.json': { openapi: '3.1.0', info: { version: `2.4${character}0` }, paths: {} },
      'usage.json': inventoryOf([consumer({ calls: [] })]),
    })
    assert.equal(findingsFor(inSpec, 'spec-invalid').length, 1, label)
    assertClean(inSpec, label)

    const inInventory = await apiReport(fixture(operations(), [consumer()], { apiVersion: `2.4${character}0` }))
    assert.equal(findingsFor(inInventory, 'coverage-invalid').length, 1, label)
    assertClean(inInventory, label)
  }
})

test('a forbidden character in free text is excerpted rather than refused, and the excerpt is clean', async () => {
  for (const [label, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport(fixture(
      [operation({ 'x-replacement': { operationId: 'listInvoices', since: `2.2${character}0`, docs: `https://docs.example.test/a${character}b` } }), current()],
      [consumer({ contact: `revenue${character}platform` })],
    ))

    assert.equal(report.status, 'pass', label)
    const link = findingsFor(report, 'deprecated-operation-in-use')[0]
    assert.equal(link.evidence.includes('revenue platform') || link.evidence.includes('revenueplatform'), true, label)
    assertClean(report, label)
  }
})

test('a forbidden character in an unknown JSON key is excerpted into the pointer and the message', async () => {
  for (const [label, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport({
      'openapi.json': specOf(operations()),
      'usage.json': { ...inventoryOf([consumer()]), [`extra${character}key`]: 1 },
    })

    assert.equal(findingsFor(report, 'inventory-key-unknown').length, 1, label)
    assertClean(report, label)
  }
})

test('a forbidden character in a coverage source is excerpted into the evidence', async () => {
  for (const [label, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport(fixture(
      operations(),
      [consumer({ calls: [call({ operationId: 'listInvoices' })] })],
      { source: `gateway${character}access-log` },
    ))

    assert.equal(findingsFor(report, 'deprecated-operation-unused').length, 1, label)
    assertClean(report, label)
  }
})

test('the human report cannot be given extra lines by any of the four classes', async () => {
  // The concrete damage a missed class does: a value that prints as a line of
  // its own invents a finding that was never emitted.
  for (const [label, character] of Object.entries(FORBIDDEN)) {
    const report = await apiReport(fixture(
      [operation({ 'x-replacement': { operationId: 'listInvoices', docs: `https://docs${character}example.test` } }), current()],
      [consumer({ contact: `revenue${character}platform` })],
      { source: `gateway${character}log` },
    ))

    const printed = formatReport(report, { spec: 'openapi.json', inventory: 'usage.json', now: '2026-06-05T00:00:00Z' })
    const lines = printed.trimEnd().split('\n')
    assert.equal(lines.length, 3 + report.findings.length, `${label}: one line per finding, plus the three summary lines`)
    // Checked line by line, because the report is deliberately multi-line: the
    // question is whether an input added a line, not whether the format has any.
    for (const line of lines) assert.equal(hasForbiddenCharacter(line), false, `${label}: ${JSON.stringify(line)}`)
  }
})

test('the identifier rule refuses the three ASCII whitespace controls too', () => {
  // `excerpt` collapses tab, newline and carriage return into a single space,
  // which is the same result by a shorter route -- but an identifier gets no
  // second pass, so it has to refuse them itself.
  for (const character of ['\t', '\n', '\r']) {
    assert.equal(isIdentifier(`listInvoices${character}V1`), false)
  }
  assert.equal(isIdentifier('listInvoicesV1'), true)
  assert.equal(isIdentifier(' listInvoicesV1'), false, 'a leading space is not part of an identifier')
  assert.equal(isIdentifier('listInvoicesV1 '), false)
  assert.equal(isIdentifier(''), false)
  assert.equal(isIdentifier('x'.repeat(200)), true)
  assert.equal(isIdentifier('x'.repeat(201)), false)
  assert.equal(isIdentifier(42), false)
})

test('default-ignorable code points are not identities or invisible prose', () => {
  for (const code of [0x034f, 0x200b]) {
    const invisible = String.fromCharCode(code)
    assert.equal(isIdentifier(invisible), false)
    assert.equal(isIdentifier(`2.4.${invisible}0`), false)
    assert.equal(hasForbiddenCharacter(invisible), true)
    assert.equal(excerpt(`a${invisible}b`), 'a b')
  }
  assert.equal(isIdentifier('2.4.0'), true)
  assert.equal(excerpt('a b'), 'a b')
})

test('every excerpt is bounded, and says it was cut', () => {
  assert.equal(excerpt('x'.repeat(EXCERPT_LIMIT)), 'x'.repeat(EXCERPT_LIMIT))
  assert.equal(excerpt('x'.repeat(EXCERPT_LIMIT + 1)), `${'x'.repeat(EXCERPT_LIMIT)}...`)
  assert.equal(excerpt('a  b\tc', 40), 'a b c', 'whitespace collapses to one space')
  assert.equal(excerpt('  padded  ', 40), 'padded')
})

test('an over-long free-text field is cut rather than carried whole into the report', async () => {
  const report = await apiReport(fixture(
    [operation({ 'x-replacement': { operationId: 'listInvoices', docs: `https://docs.example.test/${'x'.repeat(500)}` } }), current()],
    [consumer()],
  ))

  const suggestion = findingsFor(report, 'deprecated-operation-in-use')[0].suggestion
  assert.equal(suggestion.length <= 303, true, 'the suggestion is bounded')
  assert.equal(suggestion.endsWith('...'), true)
})
