import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_IDENTIFIER_LENGTH, byCodeUnit, decodeUtf8, describeValue, escapePointerToken, exceedsDepth,
  isPlainObject, parseInstant,
} from '../src/index.mjs'

/** The primitives everything else is built on, checked directly. */

test('byCodeUnit orders by UTF-16 code unit in both directions, and ties', () => {
  assert.equal(byCodeUnit('Z', 'a') < 0, true, 'Z (0x5A) precedes a (0x61)')
  assert.equal(byCodeUnit('a', 'Z') > 0, true)
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true, '- (0x2D) precedes _ (0x5F)')
  assert.equal(byCodeUnit('README', 'assets') < 0, true)
  assert.equal(byCodeUnit('same', 'same'), 0)
  assert.equal(byCodeUnit('', 'a') < 0, true)
})

test('decodeUtf8 lets the decoder decide, and never infers encoding from the decoded text', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0x7b, 0x7d])), { ok: true, text: '{}' })
  assert.equal(decodeUtf8(new Uint8Array([0xff, 0xfe])).ok, false)
  assert.equal(decodeUtf8(new Uint8Array([0xc3, 0x28])).ok, false, 'a truncated sequence is refused')

  // A file that legitimately contains U+FFFD decodes. Hunting for the
  // replacement character in decoded text cannot tell this apart from bytes
  // that did not decode, and that confusion let an unread input report a pass
  // in this catalog. The character is built from its code point so this file
  // stays plain ASCII and the distinction stays visible in a diff.
  const replacement = String.fromCharCode(0xfffd)
  const legitimate = new TextEncoder().encode(`{"note":"${replacement}"}`)
  assert.equal(decodeUtf8(legitimate).ok, true)
  assert.equal(decodeUtf8(legitimate).text.includes(replacement), true)
})

test('parseInstant checks the calendar arithmetically rather than trusting Date.parse', () => {
  assert.equal(parseInstant('2026-06-05T00:00:00Z').ms, Date.UTC(2026, 5, 5))
  assert.equal(parseInstant('2026-06-05T00:00:00Z').canonical, '2026-06-05T00:00:00Z')
  assert.equal(parseInstant('2026-06-05T12:30:45.250Z').canonical, '2026-06-05T12:30:45.250Z')

  // Date.parse accepts both of these and rolls them silently forwards.
  assert.equal(parseInstant('2026-02-31T00:00:00Z').ok, false)
  assert.equal(parseInstant('2026-06-05T24:00:00Z').ok, false)
  assert.equal(parseInstant('2026-13-01T00:00:00Z').ok, false)
  assert.equal(parseInstant('2026-00-01T00:00:00Z').ok, false)
  assert.equal(parseInstant('2026-06-05T00:60:00Z').ok, false)
})

test('parseInstant knows which Februaries have twenty-nine days', () => {
  assert.equal(parseInstant('2024-02-29T00:00:00Z').ok, true, '2024 is a leap year')
  assert.equal(parseInstant('2000-02-29T00:00:00Z').ok, true, '2000 is divisible by 400')
  assert.equal(parseInstant('2026-02-29T00:00:00Z').ok, false)
  assert.equal(parseInstant('2100-02-29T00:00:00Z').ok, false, '2100 is divisible by 100 but not 400')
})

test('parseInstant requires UTC, and requires a time unless a day is explicitly allowed', () => {
  assert.equal(parseInstant('2026-06-05T00:00:00+02:00').ok, false)
  assert.equal(parseInstant('2026-06-05T00:00:00').ok, false)
  assert.equal(parseInstant('2026-06-05').ok, false)
  assert.equal(parseInstant('2026-06-05').reason, 'date-only')

  const day = parseInstant('2026-06-05', { allowDateOnly: true })
  assert.equal(day.ok, true)
  assert.equal(day.canonical, '2026-06-05T00:00:00Z', 'a day means the earliest instant it can mean')
  assert.equal(day.dateOnly, true)
  assert.equal(day.ms, Date.UTC(2026, 5, 5))
})

test('parseInstant refuses a year outside the range it can reason about', () => {
  assert.equal(parseInstant('1969-12-31T23:59:59Z').ok, false)
  assert.equal(parseInstant('2101-01-01T00:00:00Z').ok, false)
  assert.equal(parseInstant('1970-01-01T00:00:00Z').ms, 0)
  assert.equal(parseInstant(42).reason, 'not-a-string')
  assert.equal(parseInstant(undefined).reason, 'not-a-string')
})

test('escapePointerToken escapes the two characters RFC 6901 reserves, tilde first', () => {
  assert.equal(escapePointerToken('/v1/invoices'), '~1v1~1invoices')
  assert.equal(escapePointerToken('a~b'), 'a~0b')
  assert.equal(escapePointerToken('a~/b'), 'a~0~1b', 'the tilde escape is not itself re-escaped')
  assert.equal(escapePointerToken('plain'), 'plain')
})

test('exceedsDepth counts containers, starting the top-level value at one', () => {
  assert.equal(exceedsDepth(1, 1), false, 'a scalar has no container depth')
  assert.equal(exceedsDepth({}, 1), false)
  assert.equal(exceedsDepth({ a: {} }, 1), true)
  assert.equal(exceedsDepth({ a: {} }, 2), false)
  assert.equal(exceedsDepth([[[1]]], 3), false)
  assert.equal(exceedsDepth([[[1]]], 2), true)
  assert.equal(exceedsDepth({ a: [{ b: 1 }] }, 3), false)
  assert.equal(exceedsDepth({ a: [{ b: 1 }] }, 2), true)
})

test('exceedsDepth walks with a stack, so a document that would overflow a recursive walk is still measured', () => {
  let nested = 1
  for (let index = 0; index < 50000; index += 1) nested = [nested]
  assert.equal(exceedsDepth(nested, 50), true)
})

test('describeValue names a shape and never reproduces a value', () => {
  assert.equal(describeValue(undefined), 'nothing')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(true), 'true')
  assert.equal(describeValue(7), 'an integer')
  assert.equal(describeValue(7.5), 'a number')
  assert.equal(describeValue('4111111111111111'), 'a string of 16 character(s)')
  assert.equal(describeValue(['a', 'b']), 'an array of 2 item(s)')
  assert.equal(describeValue({ secret: 'x' }), 'an object')
  assert.equal(describeValue(describeValue), 'a function')
})

test('isPlainObject refuses an array, a null and anything with a foreign prototype', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(new Map()), false)
  assert.equal(isPlainObject('x'), false)
})

test('the identifier bound is the documented one', () => {
  assert.equal(MAX_IDENTIFIER_LENGTH, 200)
})
