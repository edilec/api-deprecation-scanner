import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CALL_KEYS, CONSUMER_KEYS, COVERAGE_KEYS, DEFAULT_LIMITS, DEFAULT_POLICY, INVENTORY_KEYS,
  METHODS, REPLACEMENT_KEYS, RULE_SEVERITY, UNRECOGNISED_EXTENSIONS, compareFindings, scanDeprecations,
} from '../src/index.mjs'
import {
  NOW, apiReport, call, cliReport, consumer, current, findingsFor, fixture, inventoryOf,
  operation, operations, specOf, withRoot,
} from './support.mjs'

/**
 * Ordering, pinned by what the tool emits.
 *
 * A source scan for `.localeCompare(` is not a determinism test: `Intl.Collator`
 * collates identically and spells differently, so the scan passes while the
 * output silently starts depending on the ICU data of whichever Node build is
 * running.
 *
 * Pinning the helper is not enough either. `byCodeUnit` having the right sign
 * for `Z` and `a` says nothing about the nine places that *call* it: each one
 * can be swapped to a collator on its own. So this file enumerates every call
 * site in the package that orders something reaching output, and pins each one
 * by pushing an input through the real entry point whose collation order
 * differs from its code-unit order.
 *
 *   1. the unknown-key walk in `validateBounded`      (limits and policy)
 *   2. the known-name list `validateBounded` prints   (closed alphabet)
 *   3. the unknown-option walk in `scanDeprecations`
 *   4. `compareFindings`, comparison 1: location.file
 *   5. `compareFindings`, comparison 2: location.pointer
 *   6. `compareFindings`, comparison 3: ruleId        (closed alphabet)
 *   7. `compareFindings`, comparison 4: message
 *   8. `compareFindings`, comparison 5: evidence
 *   9. the consumer list in the coverage-gap evidence
 *
 * Seven of the nine take values an input file chooses, so a fixture can make
 * the two comparators disagree and the emitted order is asserted exactly. Two
 * of them -- the printed list of known limit names, and the rule-id tie-break
 * -- order values this package declares, over alphabets on which an English
 * collator agrees with code unit for every ordered pair. Those are proved
 * equivalent by enumeration at the bottom of this file rather than claimed to
 * be covered, and the enumeration fails the moment a value is added in an
 * alphabet where the two comparators could differ.
 *
 * The collator is constructed in each case and asserted to disagree, which is
 * what makes these cases cases at all.
 */

const collator = new Intl.Collator('en')
const EXPIRED = operation({ 'x-sunset': '2026-05-01T00:00:00Z' })

/* 1. the unknown-key walk in validateBounded ------------------------------ */

test('an unknown limit is named by walking the given keys in code-unit order', async () => {
  // Object keys keep insertion order, so the sort is what decides which of two
  // unknown limits the throw names.
  assert.equal(collator.compare('Zed', 'abc') > 0, true, 'a collator would name abc')

  await assert.rejects(
    () => scanDeprecations({ root: '.', now: NOW, limits: { abc: 1, Zed: 1 } }),
    /^TypeError: Unknown limits "Zed"; known limits are /,
  )
})

test('an unknown policy window is named by the same walk', async () => {
  await assert.rejects(
    () => scanDeprecations({ root: '.', now: NOW, policy: { abc: 1, Zed: 1 } }),
    /^TypeError: Unknown policy "Zed"; known policy are activeWithinSeconds, imminentWindowSeconds, maxCoverageStalenessSeconds$/,
  )
})

/* 3. the unknown-option walk ---------------------------------------------- */

test('an unknown option is named by walking the given keys in code-unit order', async () => {
  await assert.rejects(
    () => scanDeprecations({ root: '.', now: NOW, abc: 1, Zed: 1 }),
    /^TypeError: Unknown option "Zed"; known options are inventory, limits, now, policy, root, spec$/,
  )
})

/* 4. compareFindings, comparison 1: the file ------------------------------ */

test('the file name decides first, by code unit', async () => {
  // Both names are chosen by the caller, so an input decides this comparison
  // rather than the two default names, which collate the way they sort.
  assert.equal(collator.compare('Z.json', 'a.json') > 0, true, 'a collator would put a.json first')

  const report = await apiReport({
    'Z.json': specOf([operation({ 'x-replacement': undefined })]),
    'a.json': { ...inventoryOf([consumer()]), unexpected: 1 },
  }, { spec: 'Z.json', inventory: 'a.json' })

  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.ruleId]),
    [
      ['Z.json', 'deprecated-operation-in-use'],
      ['Z.json', 'replacement-undeclared'],
      ['a.json', 'inventory-key-unknown'],
    ],
  )
})

/* 5. compareFindings, comparison 2: the pointer --------------------------- */

test('the pointer decides second, by code unit', async () => {
  // A JSON key may hold any character, so the pointers two unknown keys
  // produce are where an arbitrary alphabet reaches this comparison.
  assert.equal(collator.compare('/extraZ', '/extra_a') > 0, true, 'a collator would put extra_a first')

  const report = await apiReport({
    'openapi.json': specOf(operations()),
    'usage.json': { ...inventoryOf([consumer()]), extraZ: 1, extra_a: 2 },
  })

  assert.deepEqual(
    findingsFor(report, 'inventory-key-unknown').map((finding) => finding.location.pointer),
    ['/extraZ', '/extra_a'],
  )
})

/* 7. compareFindings, comparison 4: the message --------------------------- */

test('the message decides fourth, where the pointer no longer separates two findings', async () => {
  // Two keys that agree for 199 characters: their pointers are excerpted to
  // the same 200 characters and their rule id is the same, so the message --
  // which is excerpted at 400 and still holds the difference -- is the first
  // field that can tell these two findings apart.
  const shared = 'x'.repeat(199)
  const first = `${shared}Zebra`
  const second = `${shared}_apple`
  assert.equal(collator.compare(first, second) > 0, true, 'a collator would put the _apple key first')

  const report = await apiReport({
    'openapi.json': specOf(operations()),
    'usage.json': { ...inventoryOf([consumer()]), [first]: 1, [second]: 2 },
  })

  const unknown = findingsFor(report, 'inventory-key-unknown')
  assert.equal(unknown.length, 2)
  assert.equal(unknown[0].location.pointer, unknown[1].location.pointer, 'the pointers are excerpted to the same string')
  assert.equal(unknown[0].message.includes(`"${first}"`), true, 'the Zebra key sorts first by code unit')
  assert.equal(unknown[1].message.includes(`"${second}"`), true)
})

/* 8. compareFindings, comparison 5: the evidence -------------------------- */

test('the evidence decides last, by code unit, and two consumers of one operation reach it', async () => {
  // This is why the consumer lives in the evidence and not in the message: two
  // active consumers of one expired operation produce findings that agree on
  // file, pointer, rule id and message, so the documented sort key runs all
  // the way to its last comparison on values an input file chose.
  assert.equal(collator.compare('consumer Zebra', 'consumer apple') > 0, true, 'a collator would put apple first')

  const report = await apiReport(fixture([EXPIRED, current()], [
    consumer({ id: 'apple', contact: undefined }),
    consumer({ id: 'Zebra', contact: undefined }),
  ]))

  const linked = findingsFor(report, 'expired-operation-in-use')
  assert.equal(linked.length, 2)
  assert.equal(linked[0].location.pointer, linked[1].location.pointer)
  assert.equal(linked[0].message, linked[1].message)
  assert.deepEqual(linked.map((finding) => finding.evidence), [
    'consumer Zebra; 12 call(s); last seen 2026-05-30T11:02:00Z',
    'consumer apple; 12 call(s); last seen 2026-05-30T11:02:00Z',
  ])
})

/* 9. the consumer list inside the coverage-gap evidence -------------------- */

test('the consumer list in a coverage gap is ordered by code unit', async () => {
  const report = await apiReport(fixture(operations(), [
    consumer({ id: 'apple', calls: [call({ operationId: 'listInvoices' })] }),
    consumer({ id: 'Zebra', calls: [call({ operationId: 'listInvoices' })] }),
    consumer({ id: 'assets', calls: [call({ operationId: 'listInvoices' })] }),
    consumer({ id: 'README', calls: [call({ operationId: 'listInvoices' })] }),
  ], { consumersKnown: 12 }))

  const gap = findingsFor(report, 'coverage-consumers-incomplete')[0]
  assert.equal(gap.evidence, 'inventoried: README, Zebra, apple, assets')
  assert.notEqual(
    ['README', 'Zebra', 'apple', 'assets'].join(','),
    ['README', 'Zebra', 'apple', 'assets'].sort((a, b) => collator.compare(a, b)).join(','),
    'a collator orders these differently, which is what makes this a test',
  )
})

test('that list is cut at maxConsumersNamed, and says how many it did not name', async () => {
  const report = await apiReport(fixture(operations(), [
    consumer({ id: 'apple', calls: [call({ operationId: 'listInvoices' })] }),
    consumer({ id: 'Zebra', calls: [call({ operationId: 'listInvoices' })] }),
    consumer({ id: 'assets', calls: [call({ operationId: 'listInvoices' })] }),
    consumer({ id: 'README', calls: [call({ operationId: 'listInvoices' })] }),
  ], { consumersKnown: 12 }), { limits: { maxConsumersNamed: 2 } })

  assert.equal(findingsFor(report, 'coverage-consumers-incomplete')[0].evidence, 'inventoried: README, Zebra (+2 more)')
})

/* The emitted order of a whole report ------------------------------------- */

test('findings are emitted in the documented order, by code unit throughout', async () => {
  const consumers = []
  for (let index = 1; index <= 10; index += 1) {
    consumers.push(consumer({ id: `consumer-${index}`, calls: [call({ operationId: 'listInvoicesV1' })] }))
  }
  const report = await apiReport(fixture([EXPIRED, current()], consumers))

  assert.deepEqual(
    findingsFor(report, 'expired-operation-in-use').map((finding) => finding.evidence.slice(0, 20)),
    [
      // "consumer-10" sorts ahead of "consumer-1" because the next code unit
      // decides it: "0" (0x30) precedes the ";" (0x3B) that ends the shorter
      // id. Every numeric-aware comparator disagrees, which is the point.
      'consumer consumer-10', 'consumer consumer-1;', 'consumer consumer-2;', 'consumer consumer-3;',
      'consumer consumer-4;', 'consumer consumer-5;', 'consumer consumer-6;', 'consumer consumer-7;',
      'consumer consumer-8;', 'consumer consumer-9;',
    ],
  )
  // A numeric collator -- a plausible substitution, since it reads "better" --
  // would put consumer-1 and consumer-9 before consumer-10, which is exactly
  // the drift being refused: the documented order is by code unit and nothing
  // else.
  const numeric = new Intl.Collator('en', { numeric: true })
  assert.equal(numeric.compare('consumer-1;', 'consumer-10') < 0, true)
  assert.equal(numeric.compare('consumer-9;', 'consumer-10') < 0, true)
})

test('the whole documented sort key is applied in order, every comparison by code unit', () => {
  const finding = (overrides) => ({
    ruleId: 'expired-operation-in-use',
    location: { file: 'openapi.json', pointer: '/paths/~1v1~1invoices/get' },
    message: 'same',
    evidence: 'same',
    ...overrides,
  })
  // `Z` (0x5A) precedes `_` (0x5F) by code unit; an English collator puts the
  // underscored value first, so every pair below is a disagreement.
  assert.equal(collator.compare('Z', '_a') > 0, true, 'the disagreement being pinned')
  const differing = [
    ['file', { location: { file: 'Z', pointer: '/p' } }, { location: { file: '_a', pointer: '/p' } }],
    ['pointer', { location: { file: 'f', pointer: 'Z' } }, { location: { file: 'f', pointer: '_a' } }],
    ['message', { message: 'Z' }, { message: '_a' }],
    ['evidence', { evidence: 'Z' }, { evidence: '_a' }],
  ]

  for (const [field, low, high] of differing) {
    assert.equal(compareFindings(finding(low), finding(high)) < 0, true, `${field} must order by code unit`)
    assert.equal(compareFindings(finding(high), finding(low)) > 0, true, `${field} must order by code unit in both directions`)
  }

  assert.equal(compareFindings(finding({}), finding({})), 0, 'two identical findings tie')
  const bare = finding({})
  delete bare.evidence
  assert.equal(compareFindings(bare, finding({ evidence: 'a' })) < 0, true, 'a finding with no evidence compares as the empty string')
})

/* 2 and 6: the closed alphabets, proved equivalent by enumeration ---------- */

test('the comparisons over a closed alphabet cannot be told from a collator, enumerated', () => {
  // Two call sites order values this package declares rather than values a
  // file supplies: the rule-id tie-break in `compareFindings` (an id outside
  // `RULE_SEVERITY` throws in `createFinding`, so no other value can reach
  // it), and the list of known names `validateBounded` prints. Over those
  // alphabets an English collator agrees with code unit on every ordered pair,
  // so no fixture can tell the two comparators apart there and substituting a
  // collator at either site is an equivalent mutant, not a gap.
  //
  // The enumeration is the test. A value added in some other alphabet -- a
  // digit-letter mix, an underscore, a capital where the rest are lower case
  // -- makes this fail and says the comparison has become observable and needs
  // a fixture of its own. The frozen lists that are iterated rather than
  // sorted are enumerated too, for the same reason.
  const alphabets = [
    ['rule ids', Object.keys(RULE_SEVERITY), 50],
    ['limit names', Object.keys(DEFAULT_LIMITS), 8],
    ['policy names', Object.keys(DEFAULT_POLICY), 2],
    ['methods', METHODS, 7],
    ['unrecognised extensions', UNRECOGNISED_EXTENSIONS, 11],
    ['replacement keys', REPLACEMENT_KEYS, 2],
    ['inventory keys', INVENTORY_KEYS, 2],
    ['coverage keys', COVERAGE_KEYS, 4],
    ['consumer keys', CONSUMER_KEYS, 2],
    ['call keys', CALL_KEYS, 2],
  ]

  for (const [label, values, atLeast] of alphabets) {
    assert.equal(values.length > atLeast, true, `${label} were actually read`)
    let compared = 0
    for (const left of values) {
      for (const right of values) {
        if (left === right) continue
        compared += 1
        assert.equal(
          Math.sign(collator.compare(left, right)),
          Math.sign(left < right ? -1 : 1),
          `${label}: ${left} and ${right} order differently under collation, so this comparison is now observable and needs a fixture`,
        )
      }
    }
    assert.equal(compared, values.length * (values.length - 1), `${label}: every ordered pair`)
  }
})

/* Determinism end to end --------------------------------------------------- */

test('two runs over the same bytes produce byte-identical stdout', async () => {
  const files = fixture([EXPIRED, current(), operation({ path: '/v1/reports', operationId: 'listReportsV1', 'x-replacement': undefined })], [
    consumer({ id: 'apple' }),
    consumer({ id: 'Zebra', calls: [call({ operationId: 'listReportsV1' })] }),
  ])

  const first = await cliReport(files)
  const second = await cliReport(files)

  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.equal(first.report.findings.length, 3, 'the comparison is over a report with something in it')
})

test('a run over a root with nothing in it is still a report, not an ordering', async () => {
  // A positive control for the rejection cases above: the same call with no
  // unknown key reaches the inputs instead, so those tests are failing on the
  // key they name and not on the root they borrow.
  await withRoot({}, async (root) => {
    const report = await scanDeprecations({ root, now: NOW, limits: { maxOperations: 5 } })
    assert.equal(report.status, 'incomplete')
  })
})
