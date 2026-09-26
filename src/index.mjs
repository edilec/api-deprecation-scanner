/**
 * api-deprecation-scanner -- join the deprecated operations in a versioned
 * OpenAPI document to the consumers a usage inventory says are calling them,
 * with the announced removal date and the documented replacement.
 *
 * This package opens no socket. It reads two files and reports what they say
 * together that neither says alone: that a named consumer is still calling an
 * operation whose removal date has already passed.
 *
 * Two things it will not do, stated here because the whole design follows from
 * them. It never reads a system clock -- "expired" is decided against the
 * instant passed in as `now`. And it never reads a consumer's absence from the
 * inventory as safety: the inventory covers what it covers, the report says so
 * in numbers, and an incomplete coverage makes the run `incomplete` rather
 * than quietly making it green.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import process from 'node:process'

import { compileInventory } from './inventory.mjs'
import { describeCoverageGaps, joinUsage } from './join.mjs'
import { checkSpecCrossReferences, compileSpec } from './spec.mjs'
import {
  byCodeUnit, decodeUtf8, exceedsDepth, excerpt, hasForbiddenCharacter, isPlainObject,
  parseFailureDetail, parseInstant,
} from './text.mjs'

export const TOOL_ID = 'api-deprecation-scanner'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_SPEC_NAME = 'openapi.json'
export const DEFAULT_INVENTORY_NAME = 'usage.json'

/**
 * Limits, each enforced and each reported by name when it is hit.
 *
 * Exceeding one is never a silent truncation: it produces a finding that names
 * the limit and marks the run `incomplete`, because the part of an input
 * nobody walked is not evidence that the part nobody walked was fine.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxCalls: 50000,
  maxCallsPerConsumer: 2000,
  maxConsumers: 2000,
  maxConsumersNamed: 5,
  maxFileBytes: 5242880,
  maxFindings: 1000,
  maxJsonDepth: 50,
  maxMilliseconds: 10000,
  maxOperations: 2000,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxCalls: 500000,
  maxCallsPerConsumer: 50000,
  maxConsumers: 50000,
  maxConsumersNamed: 100,
  maxFileBytes: 67108864,
  maxFindings: 20000,
  maxJsonDepth: 200,
  maxMilliseconds: 600000,
  maxOperations: 20000,
})

/**
 * Policy windows, all measured against the injected clock and never against a
 * system one. They decide what "expired", "imminent" and "active" mean, so
 * they are configuration rather than limits and they are validated the same
 * strict way: an unknown key throws.
 */
export const DEFAULT_POLICY = Object.freeze({
  activeWithinSeconds: 2592000,
  imminentWindowSeconds: 2592000,
  maxCoverageStalenessSeconds: 604800,
})

export const MAX_POLICY_SECONDS = 315360000

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at a hundred construction sites it drifts
 * silently, and demoting `expired-operation-in-use` turns a consumer still
 * calling a removed endpoint into a green build with every test passing.
 * Every finding takes its severity from here and an unknown rule id throws.
 *
 * `test/severity-table.test.mjs` asserts this table against the documented
 * catalog in both directions. That is worth having and it is not the test: a
 * table, a catalog and a hand-written expected map are three declarations, and
 * one coordinated edit satisfies every assertion that compares them.
 * `test/severity-behaviour.test.mjs` pins the rules whose severity decides the
 * verdict by driving the real binary and asserting the process exit code, and
 * `test/severity-word.test.mjs` pins the rest with literal, inline counts and
 * printed words, sharing no map with anything.
 */
export const RULE_SEVERITY = Object.freeze({
  'call-duplicate': 'error',
  'call-invalid': 'error',
  'call-observed-after-clock': 'error',
  'call-outside-coverage-window': 'error',
  'consumer-duplicate': 'error',
  'consumer-invalid': 'error',
  'coverage-consumers-incomplete': 'error',
  'coverage-invalid': 'error',
  'coverage-version-mismatch': 'error',
  'coverage-window-stale': 'error',
  'deprecated-flag-invalid': 'error',
  'deprecated-operation-dormant-use': 'info',
  'deprecated-operation-in-use': 'warning',
  'deprecated-operation-unused': 'info',
  'deprecated-operation-usage-unknown': 'error',
  'expired-operation-dormant-use': 'warning',
  'expired-operation-in-use': 'error',
  'expired-operation-unused': 'warning',
  'expired-operation-usage-unknown': 'error',
  'identifier-invalid': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-deep': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'inputs-same-file': 'error',
  'inventory-invalid': 'error',
  'inventory-key-unknown': 'error',
  'no-consumers-inventoried': 'error',
  'no-deprecated-operations': 'info',
  'no-operations': 'error',
  'operation-duplicate': 'error',
  'operation-invalid': 'error',
  'path-escapes-root': 'error',
  'replacement-also-deprecated': 'error',
  'replacement-invalid': 'error',
  'replacement-undeclared': 'warning',
  'replacement-unknown-operation': 'error',
  'spec-construct-unsupported': 'error',
  'spec-invalid': 'error',
  'spec-version-unsupported': 'error',
  'sunset-before-deprecation': 'error',
  'sunset-extension-unrecognised': 'error',
  'sunset-imminent-operation-in-use': 'warning',
  'sunset-invalid': 'error',
  'sunset-undeclared': 'warning',
  'sunset-without-deprecation': 'warning',
  'time-limit-exceeded': 'error',
  'too-many-calls': 'error',
  'too-many-calls-for-consumer': 'error',
  'too-many-consumers': 'error',
  'too-many-findings': 'error',
  'too-many-operations': 'error',
  'usage-operation-unknown': 'error',
})

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200
const MAX_NAME_LENGTH = 200

const ALLOWED_OPTIONS = Object.freeze(['inventory', 'limits', 'now', 'policy', 'root', 'spec'])

function validateBounded(overrides, defaults, caps, what) {
  if (!isPlainObject(overrides)) throw new TypeError(`${what} must be an object`)
  const result = { ...defaults }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(defaults, key)) {
      throw new TypeError(`Unknown ${what} "${excerpt(key, 60)}"; known ${what} are ${Object.keys(defaults).sort(byCodeUnit).join(', ')}`)
    }
    const value = overrides[key]
    const cap = typeof caps === 'number' ? caps : caps[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`${what}.${key} must be an integer between 1 and ${cap}`)
    }
    result[key] = value
  }
  return Object.freeze(result)
}

/**
 * Validate limit overrides. An unknown key throws rather than being ignored: a
 * documented limit that a typo silently disables is a limit that is not
 * enforced, and the CLI turns this throw into a configuration error with an
 * empty stdout.
 */
export function validateLimits(overrides = {}) {
  return validateBounded(overrides, DEFAULT_LIMITS, HARD_LIMITS, 'limits')
}

/** Validate policy overrides, on the same terms. */
export function validatePolicy(overrides = {}) {
  return validateBounded(overrides, DEFAULT_POLICY, MAX_POLICY_SECONDS, 'policy')
}

/**
 * True when `candidate` is the real root itself or lies beneath it.
 *
 * Both sides must already be real paths. Comparing a real root against a path
 * that has not been resolved refuses legitimate files whenever the root is
 * reached through a symbolic link -- a `/var` that is really `/private/var` is
 * enough -- and a false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * A file name given on the command line, checked as configuration.
 *
 * Absolute paths and `..` segments are refused here, before any evidence is
 * gathered, because naming a file outside the declared root is a usage error
 * rather than a fact about the subject. This is emphatically *not* the
 * confinement: a symbolic link planted inside the root passes every check in
 * this function, and `resolveInput` is what catches it by resolving the real
 * path of both sides.
 */
function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  if (normalize(name).split(/[\\/]/).includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

class FindingSink {
  constructor() {
    this.rows = []
  }

  add(row) {
    this.rows.push({ pointer: '', ...row })
  }
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message,
 * suggestion and evidence alike, not only the evidence field. A sibling tool
 * sanitised evidence carefully and left identifiers raw, so a record id
 * holding a newline forged an extra line in the human report.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/deprecation-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, LOCATION_LIMIT), pointer: excerpt(row.pointer, LOCATION_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/** Documented sort key: location.file, location.pointer, ruleId, message, evidence. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file, b.location.file) ||
    byCodeUnit(a.location.pointer, b.location.pointer) ||
    byCodeUnit(a.ruleId, b.ruleId) ||
    byCodeUnit(a.message, b.message) ||
    byCodeUnit(a.evidence ?? '', b.evidence ?? '')
  )
}

/**
 * A monotonic budget for one run.
 *
 * `process.hrtime.bigint` is a monotonic counter, not a wall clock: it is never
 * printed, never compared with a date, and cannot move an operation across its
 * sunset instant. The only thing it can change is turning a run that would
 * have completed into one that reports `time-limit-exceeded` and `incomplete`
 * -- never a fail into a pass. A run that finishes inside its budget is
 * byte-identical every time, which is the determinism the contract asks for.
 */
function createDeadline(maxMilliseconds) {
  const started = process.hrtime.bigint()
  const budget = BigInt(maxMilliseconds) * 1000000n
  let tripped = false
  return {
    exceeded() {
      if (!tripped && process.hrtime.bigint() - started > budget) tripped = true
      return tripped
    },
  }
}

function buildReport(sink, state, limits) {
  let findings = sink.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: state.files.spec,
      ruleId: 'too-many-findings',
      pointer: '',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or narrow the inputs.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const status = state.incomplete || truncated ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.checked,
      errors,
      warnings,
      deprecated: state.deprecated,
      expired: state.expired,
      consumers: state.consumers,
      calls: state.calls,
      links: state.links,
      expiredLinks: state.expiredLinks,
      unevaluated: state.unevaluated,
      coverageGaps: state.coverageGaps,
    },
    findings,
  }
}

/**
 * Resolve one declared input inside the declared root.
 *
 * Both sides are resolved to their real paths before they are compared.
 * Rejecting `..` lexically -- which `validateName` also does -- is not
 * confinement: a symbolic link planted inside the root points anywhere and
 * contains no `..` at all. Equally, comparing a real root against an
 * unresolved target refuses legitimate files, so the root is resolved too.
 */
async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') return { ok: false, reason: 'unreadable', code: error.code }
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
}

/** Read one confined input and turn it into parsed JSON, or into the finding that says why not. */
async function loadJson(sink, file, real, limits) {
  let info
  try {
    info = await stat(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be inspected: ${error.code ?? 'unknown error'}.` })
    return null
  }
  if (!info.isFile()) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} is not a regular file, so nothing was read from it.` })
    return null
  }
  if (info.size > limits.maxFileBytes) {
    sink.add({
      file,
      ruleId: 'input-too-large',
      message: `${file} is ${info.size} bytes, above the maxFileBytes limit of ${limits.maxFileBytes}; it was not read.`,
      suggestion: 'Raise --max-file-bytes, or split the input.',
    })
    return null
  }
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    sink.add({ file, ruleId: 'input-unreadable', message: `${file} could not be read: ${error.code ?? 'unknown error'}.` })
    return null
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    sink.add({
      file,
      ruleId: 'input-not-utf8',
      message: `${file} is not valid UTF-8, so it was not parsed. Whether a file decodes is the decoder's decision, never an inference drawn from the decoded text.`,
      suggestion: 'Re-encode the file as UTF-8.',
    })
    return null
  }
  let value
  try {
    value = JSON.parse(decoded.text)
  } catch (error) {
    sink.add({
      file,
      ruleId: 'input-not-json',
      message: `${file} is not valid JSON: ${parseFailureDetail(error)}.`,
      suggestion: 'Validate the file with a JSON parser before re-running.',
    })
    return null
  }
  if (exceedsDepth(value, limits.maxJsonDepth)) {
    sink.add({
      file,
      ruleId: 'input-too-deep',
      message: `${file} nests deeper than the maxJsonDepth limit of ${limits.maxJsonDepth}, so it was not read.`,
      suggestion: 'Raise --max-json-depth, or flatten the document.',
    })
    return null
  }
  return { value }
}

/**
 * Scan a versioned OpenAPI document against a consumer usage inventory.
 *
 * @param {object} options
 * @param {string} options.root Directory holding both inputs.
 * @param {string} options.now ISO-8601 UTC instant the scan is made at. Required: nothing here reads a system clock.
 * @param {string} [options.spec] OpenAPI document, relative to the root.
 * @param {string} [options.inventory] Usage inventory, relative to the root.
 * @param {object} [options.limits] Limit overrides; an unknown key throws.
 * @param {object} [options.policy] Policy window overrides; an unknown key throws.
 * @returns {Promise<object>} the report.
 */
export async function scanDeprecations(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  const policy = validatePolicy(options.policy ?? {})
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root must be a non-empty string')
  const now = parseInstant(options.now)
  if (!now.ok) {
    throw new TypeError(
      'now must be a full ISO-8601 UTC instant such as 2026-06-05T00:00:00Z. ' +
      'This tool never reads a system clock, so the instant a scan is made at is configuration and has no default.',
    )
  }
  const specName = validateName(options.spec ?? DEFAULT_SPEC_NAME, '--spec')
  const inventoryName = validateName(options.inventory ?? DEFAULT_INVENTORY_NAME, '--inventory')

  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new Error(`--root could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  let rootInfo
  try {
    rootInfo = await stat(realRoot)
  } catch (error) {
    throw new Error(`--root could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  if (!rootInfo.isDirectory()) throw new Error('--root must be a directory')

  const sink = new FindingSink()
  const files = { spec: specName, inventory: inventoryName }
  const state = {
    files,
    checked: 0,
    deprecated: 0,
    expired: 0,
    consumers: 0,
    calls: 0,
    links: 0,
    expiredLinks: 0,
    unevaluated: 0,
    coverageGaps: 0,
    incomplete: false,
  }
  const deadline = createDeadline(limits.maxMilliseconds)

  const located = {}
  for (const [kind, name] of [['spec', specName], ['inventory', inventoryName]]) {
    const result = await resolveInput(realRoot, name)
    if (!result.ok) {
      state.incomplete = true
      if (result.reason === 'escapes') {
        sink.add({
          file: name,
          ruleId: 'path-escapes-root',
          message: `${name} resolves outside --root, so it was refused unread.`,
          suggestion: 'Keep both inputs inside the declared root; a symbolic link out of the tree is refused.',
        })
      } else {
        sink.add({
          file: name,
          ruleId: 'input-unreadable',
          message: `${name} could not be resolved inside --root: ${result.code ?? 'unknown error'}.`,
          suggestion: 'Check the file name and its permissions.',
        })
      }
    }
    located[kind] = result
  }

  /**
   * The two inputs must be two files.
   *
   * Comparing real paths is not enough to decide that. A symbolic link has a
   * target and resolves to it, but a **hard link** has no target at all: two
   * names for one inode are two different real paths, and a real-path
   * comparison says they are different files. The identity of a file is its
   * device and inode, so that is what is compared -- a sibling tool in this
   * catalog destroyed its own input by trusting the weaker check.
   */
  if (located.spec.ok && located.inventory.ok) {
    const [specInfo, inventoryInfo] = await Promise.all([
      stat(located.spec.real).catch(() => null),
      stat(located.inventory.real).catch(() => null),
    ])
    if (specInfo !== null && inventoryInfo !== null && specInfo.dev === inventoryInfo.dev && specInfo.ino === inventoryInfo.ino) {
      state.incomplete = true
      sink.add({
        file: inventoryName,
        ruleId: 'inputs-same-file',
        message: `${specName} and ${inventoryName} are two names for one file (device ${specInfo.dev}, inode ${specInfo.ino}), so there is no inventory to join the document to and neither was read. Two names for one inode are two different real paths, which is why the check is on the inode and not on the path.`,
        suggestion: 'Point --spec and --inventory at two separate documents.',
      })
      return buildReport(sink, state, limits)
    }
  }

  const documents = {}
  for (const [kind, name] of [['spec', specName], ['inventory', inventoryName]]) {
    if (!located[kind].ok) {
      documents[kind] = null
      continue
    }
    const loaded = await loadJson(sink, name, located[kind].real, limits)
    if (loaded === null) state.incomplete = true
    documents[kind] = loaded
  }

  let spec = null
  if (documents.spec !== null) {
    spec = compileSpec(sink, specName, documents.spec.value, limits)
    if (spec === null) state.incomplete = true
    else {
      state.checked = spec.operations.size
      state.unevaluated += spec.declared - spec.operations.size
      // One site owns this flag. Setting it at each individual refusal instead
      // would leave every refusal backstopped by the others, so removing any
      // one of them would change nothing observable and no test could fail.
      if (spec.declared !== spec.operations.size) state.incomplete = true
      if (spec.unsupported > 0) state.incomplete = true
      if (spec.truncated) state.incomplete = true
      for (const operation of spec.operations.values()) {
        if (operation.unknownEvidence) state.incomplete = true
      }
      checkSpecCrossReferences(sink, specName, spec)
    }
  }

  let inventory = null
  if (documents.inventory !== null) {
    inventory = compileInventory(sink, inventoryName, documents.inventory.value, limits)
    if (inventory === null) state.incomplete = true
    else {
      state.consumers = inventory.consumers.length
      state.calls = inventory.compiledCalls
      state.unevaluated += (inventory.declaredConsumers - inventory.consumers.length) + (inventory.declaredCalls - inventory.compiledCalls)
      if (inventory.declaredConsumers !== inventory.consumers.length || inventory.declaredCalls !== inventory.compiledCalls) {
        state.incomplete = true
      }
      if (inventory.unknownKeys > 0) state.incomplete = true
    }
  }

  if (spec !== null && inventory !== null) {
    const gaps = describeCoverageGaps(sink, inventoryName, inventory, spec, now, policy, limits)
    state.coverageGaps = gaps.length
    // The `unevaluated` and `empty` gaps are already flagged elsewhere -- by
    // the declared-versus-compiled check and by `no-consumers-inventoried` --
    // so only the three coverage rules set the flag here. A gap that is
    // backstopped by another flag is a flag whose removal nothing can catch.
    if (gaps.some((gap) => gap !== 'unevaluated' && gap !== 'empty')) state.incomplete = true

    const joined = joinUsage(sink, files, spec, inventory, {
      now,
      policy,
      coverageGaps: gaps.length,
      deadline,
    })
    state.links = joined.links
    state.expiredLinks = joined.expiredLinks
    state.expired = joined.expired
    state.deprecated = joined.deprecated
    if (joined.unknownOperations > 0) state.incomplete = true
    if (joined.timedOut) {
      state.incomplete = true
      // The consumers and operations the budget stopped the join from reaching
      // are entries nobody evaluated, and the summary says so. Leaving them out
      // let the report print "0 entr(ies) not evaluated" on the same run that
      // reports `time-limit-exceeded`.
      state.unevaluated += joined.unreached
      sink.add({
        file: inventoryName,
        ruleId: 'time-limit-exceeded',
        message: `The join ran past the maxMilliseconds limit of ${limits.maxMilliseconds} and stopped, so part of the inventory was never joined to the document.`,
        suggestion: 'Raise --max-milliseconds, or narrow the inputs.',
      })
    }

    /**
     * A document in which nothing is deprecated is a real answer, not an empty
     * one -- the operations were read and none of them announced a removal.
     * It is recorded as `info` so that a green report says why it is green,
     * rather than leaving the reader to guess whether anything was examined.
     *
     * It is a claim about *every* operation, so it is only made when the walk
     * that would have found a deprecated one actually finished. The join's
     * loops break on an exhausted budget, and a run that stopped halfway knows
     * nothing about the operations it never reached: saying "none of them is
     * deprecated" there would be a positive verdict for work that never
     * happened, written into the JSON a consumer parses. `examined` is what
     * the walk really looked at, so it is both the guard and the number the
     * message states -- and when nothing was examined, because every operation
     * in the document was refused, there is no claim to make either.
     */
    if (!joined.timedOut && joined.deprecated === 0 && joined.examined > 0) {
      sink.add({
        file: specName,
        ruleId: 'no-deprecated-operations',
        message: `None of the ${joined.examined} operation(s) read from this document is marked deprecated, so there was nothing to join the inventory to.`,
      })
    }
  }

  /**
   * The two vacuous passes, refused explicitly.
   *
   * A document with no operations at all, or an inventory with no consumers at
   * all, reaches the end of a run with `checked: 0` and nothing to say, and
   * would report `pass` -- green on no evidence whatsoever. Each is an error
   * and each marks the run incomplete, and each is the only guard holding its
   * own case: `no-operations` is confined to a document that declared none, so
   * a document whose operations were refused is held by the declared-versus-
   * compiled check above instead, and removing either changes an observable
   * exit code.
   */
  if (spec !== null && spec.declared === 0) {
    state.incomplete = true
    sink.add({
      file: specName,
      ruleId: 'no-operations',
      pointer: '/paths',
      message: 'This document declares no operations at all, so the scan has nothing to be green about.',
      suggestion: 'Scan a document with paths in it.',
    })
  }
  if (inventory !== null && inventory.declaredConsumers === 0) {
    state.incomplete = true
    sink.add({
      file: inventoryName,
      ruleId: 'no-consumers-inventoried',
      pointer: '/consumers',
      message: 'This inventory lists no consumers at all, so it is not evidence that no consumer calls a deprecated operation -- it is the absence of evidence either way.',
      suggestion: 'Inventory the consumers your source knows about, even if you believe none of them calls a deprecated operation.',
    })
  }

  return buildReport(sink, state, limits)
}

/** stdout carries this and nothing else, so it can be piped straight into a parser. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 completed and passed, 1 completed and failed, 2 the run could not be completed. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_WIDTH = 7

/** The human summary. It goes to stderr; stdout is the JSON report alone. */
export function formatReport(report, extra = {}) {
  const { summary } = report
  const lines = [
    `spec ${excerpt(extra.spec ?? DEFAULT_SPEC_NAME, 80)}: ${summary.checked} operation(s) read, ${summary.deprecated} deprecated, ${summary.expired} past their removal date at ${excerpt(extra.now ?? 'an unstated instant', 40)}.`,
    `inventory ${excerpt(extra.inventory ?? DEFAULT_INVENTORY_NAME, 80)}: ${summary.consumers} consumer(s), ${summary.calls} call(s) read, ${summary.unevaluated} entr(ies) not evaluated, ${summary.coverageGaps} coverage gap(s).`,
    `join: ${summary.links} deprecated-operation/consumer link(s), ${summary.expiredLinks} where an active consumer calls an operation past its removal date. status ${report.status}.`,
  ]
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ` +
      `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}` +
      `${finding.evidence === undefined ? '' : ` [${finding.evidence}]`}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { compileInventory, CALL_KEYS, CONSUMER_KEYS, COVERAGE_KEYS, INVENTORY_KEYS, INVENTORY_SCHEMA_VERSION } from './inventory.mjs'
export { describeCoverageGaps, joinUsage } from './join.mjs'
export {
  DEPRECATED_SINCE_KEY, METHODS, REPLACEMENT_KEY, REPLACEMENT_KEYS, SUNSET_KEY,
  SUPPORTED_OPENAPI, UNRECOGNISED_EXTENSIONS, checkSpecCrossReferences, compileSpec,
} from './spec.mjs'
export {
  EXCERPT_LIMIT, MAX_IDENTIFIER_LENGTH, byCodeUnit, decodeUtf8, describeValue,
  escapePointerToken, exceedsDepth, excerpt, hasForbiddenCharacter, isIdentifier,
  isPlainObject, parseFailureDetail, parseInstant,
} from './text.mjs'
