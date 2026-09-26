/**
 * Decoding, sanitising, ordering, identifiers, pointers and instants.
 *
 * Nothing in this module touches the filesystem, the network, the locale or a
 * wall clock. Every value it handles arrived in a file this tool did not
 * write, so every value it returns is treated as data on its way to a report
 * -- never as something that can shape a line of output.
 */

/**
 * Order by UTF-16 code unit.
 *
 * Locale-aware comparison -- the string method and the collator class alike --
 * depends on ICU data that differs between Node builds and between hosts, and
 * both treat punctuation as ignorable: under collation `list-invoices` and
 * `list_invoices` swap places depending on where the tool runs, and `Zebra`
 * sorts before `apple` here but after it there. A report that is deterministic
 * on one machine only is not deterministic, so every order this tool exposes
 * is decided here.
 *
 * Neither spelling appears anywhere in this package outside the tests, and the
 * tests do not scan for one: a scan cannot tell `localeCompare` from
 * `Intl.Collator`, which collate identically. `test/ordering.test.mjs` names
 * every call site that orders something reaching output and pins the emitted
 * order for inputs the two comparators disagree about.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters no untrusted value may carry into output, in five classes.
 *
 * Built from code points rather than written literally: a literal U+2028 or
 * U+2029 inside a module is a line terminator to the JavaScript parser, and
 * every other character here is invisible in an editor. Spelling each one out
 * keeps this file plain ASCII and keeps the list readable.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A newline forges a line in
 *   the human report; ESC opens a terminal escape sequence; NUL truncates a
 *   value in anything that receives it through C.
 * - **C1** (U+0080-U+009F). Easy to forget once C0 is handled, and two of them
 *   do the same damage unaided: U+0085 NEL is a line break to a great many
 *   consumers, and U+009B is the 8-bit CSI, a terminal control introducer that
 *   needs no ESC in front of it.
 * - **Line and paragraph separators** (U+2028, U+2029).
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed
 *   after it, so a consumer id can be displayed as a different team's name
 *   than the one the join actually matched. Ordinary right-to-left text --
 *   Arabic, Hebrew -- needs none of these: the letters carry their own
 *   direction, so refusing the overrides refuses nothing legitimate.
 * - **Default-ignorable code points** (including U+034F and U+200B). They can
 *   make two different identities look identical, or make an all-ignorable
 *   version look present when its rendered evidence is empty.
 */
const DEL_AND_C1 = `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
const SEPARATORS = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
const BIDI =
  `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}` +
  `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}` +
  `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`

/**
 * Stripped from every untrusted string on its way into output -- operation
 * ids, consumer ids, path templates, JSON pointers, titles, coverage sources,
 * messages, suggestions and evidence alike, not only an excerpt field. Tab,
 * newline and carriage return are left out of this class deliberately:
 * `excerpt` collapses them into a single space in the very next step, which is
 * the same result by a shorter route.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
  'g',
)

/**
 * What an identifier may not contain: the same five classes, plus the three
 * ASCII whitespace controls `CONTROL` leaves to the collapse. An identifier
 * gets no second pass, because an operation id or a consumer id that prints
 * differently from the value the join actually matched is a value nobody can
 * audit.
 */
const FORBIDDEN_IN_IDENTIFIER = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
)
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u
const DEFAULT_IGNORABLES = /\p{Default_Ignorable_Code_Point}/gu

/**
 * Detects any of the five classes anywhere in a string. Exported so tests can
 * walk a whole report and assert that nothing survived anywhere, rather than
 * checking the one field a developer remembered to sanitise.
 */
export function hasForbiddenCharacter(value) {
  const text = String(value)
  return FORBIDDEN_IN_IDENTIFIER.test(text) || DEFAULT_IGNORABLE.test(text)
}

export const EXCERPT_LIMIT = 160
export const MAX_IDENTIFIER_LENGTH = 200

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every identifier, path, pointer, message and piece of evidence that reaches
 * a finding goes through here. A tool in this catalog sanitised its evidence
 * carefully and left its identifiers raw, so a record id holding a newline
 * printed two lines into the human report and invented a finding that was
 * never emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(DEFAULT_IGNORABLES, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * Identifiers are this tool's vocabulary: operation ids, consumer ids, path
 * templates and API version strings. They are compared, used as map keys, used
 * to join a deprecated operation to the consumers calling it, and then
 * printed. A control character in one of them is refused at the door rather
 * than cleaned up on the way out, because a value that prints differently from
 * the value that was joined cannot be checked by the person reading the
 * report. Compare at the full identifier bound: report excerpts may be shorter
 * without making a legal 161-200-character identifier unusable.
 */
export function isIdentifier(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false
  if (value.trim() !== value) return false
  return !hasForbiddenCharacter(value) && excerpt(value, MAX_IDENTIFIER_LENGTH) === value
}

/**
 * Say what a refused value was, without reproducing any of it.
 *
 * A rejected field is arbitrary content from a file this tool did not write,
 * and the report goes to stdout -- a stream that is piped, logged and pasted
 * somewhere more public than the inventory ever was. Echoing the value back
 * hands that content a wider audience than it had, on exactly the fields whose
 * validation exists to keep a credential, a bearer token or a personal detail
 * out of the report. The pointer on the finding already names the exact
 * position in the file, so the shape is all a reader needs from the report;
 * the value stays in the file it started in.
 */
export function describeValue(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number'
  if (typeof value === 'string') return `a string of ${value.length} character(s)`
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * Say what a JSON parse failure was, without reproducing the document.
 *
 * V8 reports a parse failure two ways, and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. The quoted
 * run is the first ten characters of the document, or the whole document when
 * it is shorter than that -- so a file short enough to be nothing but a
 * credential is reproduced in full by its own error message, and interpolating
 * that message into a finding walks the secret straight onto stdout. Neither
 * `excerpt` nor `sanitise` helps: the snippet is at the front of the message
 * and both cut from the end.
 *
 * Position, line and column are the useful half and carry no content, so they
 * are kept whole. The quoted half never leaves this function. The closing
 * guard is deliberate belt and braces: every parse message V8 emits without a
 * snippet quotes JSON punctuation with apostrophes and contains no double
 * quote at all, so a double quote surviving to the end means a wording this
 * function has not been taught, and the generic sentence is returned instead.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input. A leading `...` means the quoted run was
 * taken from the middle of the document rather than its start, which is the
 * only thing about the position this shape reveals.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains
 * a replacement character, and that confusion has let an unread input report a
 * pass in this catalog. The decoder decides; the decoded text never gets a
 * vote. Every file this tool opens goes through here -- the OpenAPI document
 * and the usage inventory alike, and the inventory is the one carrying the
 * tool's own configuration block, which is exactly where a sibling tool
 * hardened its data path and left its configuration path lossy.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z)?$/
const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])

function daysInMonth(year, month) {
  if (month !== 2) return DAYS_IN_MONTH[month - 1]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return leap ? 29 : 28
}

/**
 * Parse an ISO-8601 UTC instant, exactly.
 *
 * `Date.parse` alone is not a validator: it accepts `2026-02-31T00:00:00Z` and
 * hands back the third of March, and it accepts `24:00:00` and hands back the
 * following midnight. Either would move a sunset date across the injected
 * clock, which is the difference between "this operation is still supported"
 * and "this operation was removed and an active consumer is still calling it".
 * The calendar is checked arithmetically instead, and only `Z` is accepted: an
 * inventory that mixes local offsets is an inventory whose expiry answer
 * depends on who wrote the line.
 *
 * `allowDateOnly` exists for the two announcement fields, `x-sunset` and
 * `x-deprecated-since`, which are routinely written as a calendar day. A
 * date-only value means midnight UTC at the start of that day, which is the
 * earliest instant the day can mean -- so an operation is never reported as
 * still supported because the tool rounded its removal date forwards. The
 * clock, the coverage window and every observation instant require the full
 * form, because a whole day of slack there is a whole day of wrong answer.
 *
 * `Date.UTC` is a pure conversion from validated components to an epoch
 * offset. It reads no clock; the zero-argument `Date` constructor and
 * `Date.now` do, and neither appears anywhere in this package.
 */
export function parseInstant(value, { allowDateOnly = false } = {}) {
  if (typeof value !== 'string') return { ok: false, reason: 'not-a-string' }
  const parts = INSTANT.exec(value)
  if (parts === null) return { ok: false, reason: 'not-iso-utc' }
  const dateOnly = parts[4] === undefined
  if (dateOnly && !allowDateOnly) return { ok: false, reason: 'date-only' }
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const hour = dateOnly ? 0 : Number(parts[4])
  const minute = dateOnly ? 0 : Number(parts[5])
  const second = dateOnly ? 0 : Number(parts[6])
  const millisecond = parts[7] === undefined ? 0 : Number(parts[7])
  if (year < 1970 || year > 2100) return { ok: false, reason: 'out-of-range' }
  if (month < 1 || month > 12) return { ok: false, reason: 'not-a-real-instant' }
  if (day < 1 || day > daysInMonth(year, month)) return { ok: false, reason: 'not-a-real-instant' }
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: 'not-a-real-instant' }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  if (!Number.isFinite(ms)) return { ok: false, reason: 'not-a-real-instant' }
  const canonical = dateOnly
    ? `${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`
    : `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}` +
      `${parts[7] === undefined ? '' : `.${parts[7]}`}Z`
  return { ok: true, ms, canonical, dateOnly }
}

/** True for a plain object -- not an array, not null, not a class instance dressed up as one. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Escape one JSON Pointer reference token (RFC 6901).
 *
 * Path templates are object keys in an OpenAPI document and they are full of
 * slashes, so an unescaped pointer to `/v1/invoices` would name a position
 * that does not exist. The escape happens before sanitisation, never after:
 * sanitising first would let a stripped character change which token an
 * escape belonged to.
 */
export function escapePointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1')
}

/**
 * True when a parsed JSON value nests deeper than `limit` containers.
 *
 * Walked with an explicit stack rather than recursion, because the point of
 * the limit is to survive input that would overflow a recursive walk. The
 * top-level value is depth 1, so `{"a": {"b": 1}}` has depth 2.
 */
export function exceedsDepth(value, limit) {
  const stack = [[value, 1]]
  while (stack.length > 0) {
    const [node, depth] = stack.pop()
    if (node === null || typeof node !== 'object') continue
    if (depth > limit) return true
    const children = Array.isArray(node) ? node : Object.values(node)
    for (const child of children) stack.push([child, depth + 1])
  }
  return false
}
