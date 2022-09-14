/**
 * The bounded OpenAPI subset this tool reads.
 *
 * There is no OpenAPI library here and there is not going to be one: the
 * package has no dependencies, and across this catalog a purpose-built reader
 * that declares its own boundary has proven both sufficient and far easier to
 * keep honest than delegating to a parser and then disclaiming the parts of it
 * that were not exercised.
 *
 * The boundary is the whole point. This module reads exactly the fields that
 * decide whether an operation is deprecated, when it is removed and what
 * replaces it. Everything else in an OpenAPI document -- schemas, parameters,
 * responses, security, servers, callbacks -- is not read, and reading none of
 * it is safe precisely because none of it can change those four answers.
 *
 * What is *not* safe is a construct that could change those answers and that
 * this reader cannot follow. A `$ref` path item, a `webhooks` map, a
 * `deprecated` flag at path-item level, a document dialect this reader does
 * not know: each of those may hide a deprecated operation or a sunset date,
 * so each is reported as unsupported and makes the run `incomplete`. An
 * unsupported construct is never silently treated as satisfied.
 */

import {
  describeValue, escapePointerToken, excerpt, isIdentifier, isPlainObject, parseInstant,
} from './text.mjs'

/** The document versions this reader understands. */
export const SUPPORTED_OPENAPI = Object.freeze(['3.0', '3.1'])
const OPENAPI_VERSION = /^3\.[01](?:\.\d{1,3})?$/

/** Operation slots inside a path item, in a fixed order so the walk never depends on key order. */
export const METHODS = Object.freeze(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'])

/** The deprecation extensions this reader understands. */
export const SUNSET_KEY = 'x-sunset'
export const DEPRECATED_SINCE_KEY = 'x-deprecated-since'
export const REPLACEMENT_KEY = 'x-replacement'

/**
 * Extension names that are near-misses for the three above.
 *
 * There is no registry for any of these; every gateway and every team spells
 * the idea differently. Ignoring a spelling this reader does not implement
 * would silently drop a removal date or a migration target and report the
 * operation as having neither -- an unknown dressed up as a fact. Each one
 * found is reported and makes the run `incomplete`, so the answer is "there
 * may be a sunset here that I did not read", which is the truth.
 */
export const UNRECOGNISED_EXTENSIONS = Object.freeze([
  'x-deprecated-at',
  'x-deprecation',
  'x-deprecation-date',
  'x-end-of-life',
  'x-eol',
  'x-removal-date',
  'x-removed-at',
  'x-replaced-by',
  'x-replacedBy',
  'x-successor',
  'x-sunset-date',
  'x-sunsetDate',
])

/** Keys allowed inside an `x-replacement` object. */
export const REPLACEMENT_KEYS = Object.freeze(['docs', 'operationId', 'since'])

const MAX_PATH_LENGTH = 200
const MAX_DOCS_LENGTH = 300

/**
 * Compile the OpenAPI document into the operations this tool joins against.
 *
 * Returns `null` when nothing could be compiled at all. Otherwise returns the
 * operations that did compile, together with `declared` -- the number of
 * operation slots the walk saw. `operations.size !== declared` means some slot
 * was refused, and the caller turns that difference into the run's
 * `incomplete` flag. That is deliberately the only site that does so: making
 * each individual refusal set the flag as well would leave every one of them
 * backstopped by the others, so removing any single flag would change nothing
 * observable and no test could fail when it went.
 *
 * `truncated` is separate because the operation limit stops the walk *before*
 * a slot is reached, so nothing is refused and `declared` stays equal to the
 * number compiled. Without its own flag a limit that cut the document short
 * would report a complete-looking `fail`.
 */
export function compileSpec(sink, file, document, limits) {
  const add = (row) => sink.add({ file, ...row })

  if (!isPlainObject(document)) {
    add({ ruleId: 'spec-invalid', message: `The OpenAPI document must be a JSON object; this file holds ${describeValue(document)}.` })
    return null
  }
  if (Object.hasOwn(document, 'swagger')) {
    add({
      ruleId: 'spec-version-unsupported',
      pointer: '/swagger',
      message: `This is a Swagger 2.0 document. This tool reads OpenAPI ${SUPPORTED_OPENAPI.join(' and ')} only, so nothing in it was read.`,
      suggestion: 'Convert the document to OpenAPI 3.0 or 3.1 before scanning it.',
    })
    return null
  }
  const declaredVersion = document.openapi
  if (typeof declaredVersion !== 'string') {
    add({
      ruleId: 'spec-invalid',
      pointer: '/openapi',
      message: `The document needs an "openapi" version string; it holds ${describeValue(declaredVersion)}.`,
    })
    return null
  }
  if (!OPENAPI_VERSION.test(declaredVersion)) {
    add({
      ruleId: 'spec-version-unsupported',
      pointer: '/openapi',
      message: `The document declares OpenAPI "${excerpt(declaredVersion, 40)}". This tool reads ${SUPPORTED_OPENAPI.join(' and ')} only, so nothing in it was read.`,
      suggestion: `Scan a ${SUPPORTED_OPENAPI.join(' or ')} document, or treat this result as no evidence at all.`,
    })
    return null
  }

  if (!isPlainObject(document.info)) {
    add({ ruleId: 'spec-invalid', pointer: '/info', message: `The document needs an "info" object; it holds ${describeValue(document.info)}.` })
    return null
  }
  const version = document.info.version
  if (!isIdentifier(version)) {
    add({
      ruleId: 'spec-invalid',
      pointer: '/info/version',
      message: `The API version must be a printable identifier of 1-200 characters; this document holds ${describeValue(version)}.`,
      suggestion: 'Declare info.version, and match it in the inventory coverage block.',
    })
    return null
  }
  const title = typeof document.info.title === 'string' ? excerpt(document.info.title, 80) : ''

  // Constructs that can hide a deprecated operation. Each is reported and each
  // makes the run incomplete; the walk still covers what it can reach, because
  // a partial answer plus an explicit gap is worth more than no answer.
  let unsupported = 0
  if (Object.hasOwn(document, 'webhooks')) {
    unsupported += 1
    add({
      ruleId: 'spec-construct-unsupported',
      pointer: '/webhooks',
      message: 'This document declares webhooks. This reader scans "paths" only, so a deprecated webhook operation and its sunset date were not read.',
      suggestion: 'Record webhook consumers in the inventory by hand, or treat webhooks as unscanned.',
    })
  }
  if (isPlainObject(document.components) && Object.hasOwn(document.components, 'pathItems')) {
    unsupported += 1
    add({
      ruleId: 'spec-construct-unsupported',
      pointer: '/components/pathItems',
      message: 'This document declares reusable path items under components. This reader does not resolve them, so any deprecated operation they hold was not read.',
      suggestion: 'Inline the path items, or treat them as unscanned.',
    })
  }

  if (!isPlainObject(document.paths)) {
    add({ ruleId: 'spec-invalid', pointer: '/paths', message: `The document needs a "paths" object; it holds ${describeValue(document.paths)}.` })
    return null
  }

  const operations = new Map()
  let declared = 0
  let stopped = false
  let truncated = false

  for (const path of Object.keys(document.paths)) {
    if (stopped) break
    const pathPointer = `/paths/${escapePointerToken(path)}`
    if (!isIdentifier(path) || path.length > MAX_PATH_LENGTH) {
      declared += 1
      add({
        ruleId: 'identifier-invalid',
        pointer: pathPointer,
        message: `A path template must be a printable identifier of 1-${MAX_PATH_LENGTH} characters with no control, separator or bidi character; this one is not, so its operations were not read.`,
        suggestion: 'Remove the control or bidi character from the path template.',
      })
      continue
    }
    if (!path.startsWith('/')) {
      declared += 1
      add({ ruleId: 'spec-invalid', pointer: pathPointer, message: 'A path template must begin with "/", so this entry and its operations were not read.' })
      continue
    }
    const item = document.paths[path]
    if (!isPlainObject(item)) {
      declared += 1
      add({ ruleId: 'spec-invalid', pointer: pathPointer, message: `A path item must be an object; this one is ${describeValue(item)}.` })
      continue
    }
    if (Object.hasOwn(item, '$ref')) {
      declared += 1
      unsupported += 1
      add({
        ruleId: 'spec-construct-unsupported',
        pointer: `${pathPointer}/$ref`,
        message: 'This path item is a reference. This reader does not resolve references, so the operations behind it and any sunset date they carry were not read.',
        suggestion: 'Inline the referenced path item, or treat this path as unscanned.',
      })
      continue
    }
    if (Object.hasOwn(item, 'deprecated')) {
      unsupported += 1
      add({
        ruleId: 'spec-construct-unsupported',
        pointer: `${pathPointer}/deprecated`,
        message: 'This path item carries a "deprecated" flag. That is not an OpenAPI field and this reader does not interpret it, so whether it deprecates every operation underneath was not decided.',
        suggestion: 'Move the flag onto each operation, where OpenAPI defines it.',
      })
    }

    for (const method of METHODS) {
      if (!Object.hasOwn(item, method)) continue
      if (operations.size >= limits.maxOperations) {
        add({
          ruleId: 'too-many-operations',
          pointer: `${pathPointer}/${method}`,
          message: `The document holds more operations than the maxOperations limit of ${limits.maxOperations}; the walk stopped here and the operations past this point were not read.`,
          suggestion: 'Raise --max-operations, or split the document.',
        })
        stopped = true
        truncated = true
        break
      }
      declared += 1
      const compiled = compileOperation(add, `${pathPointer}/${method}`, path, method, item[method])
      if (compiled === null) continue
      if (operations.has(compiled.operationId)) {
        add({
          ruleId: 'operation-duplicate',
          pointer: `${pathPointer}/${method}/operationId`,
          message: `Operation id "${excerpt(compiled.operationId, 80)}" is declared more than once, so this occurrence was not read and the usage inventory cannot be joined to it unambiguously.`,
          suggestion: 'Give every operation a unique operationId.',
        })
        continue
      }
      operations.set(compiled.operationId, compiled)
    }
  }

  return { operations, declared, version, title, unsupported, truncated }
}

function compileOperation(add, pointer, path, method, value) {
  if (!isPlainObject(value)) {
    add({ ruleId: 'spec-invalid', pointer, message: `An operation must be an object; this one is ${describeValue(value)}.` })
    return null
  }
  if (Object.hasOwn(value, '$ref')) {
    add({
      ruleId: 'spec-construct-unsupported',
      pointer: `${pointer}/$ref`,
      message: 'This operation is a reference. This reader does not resolve references, so whether it is deprecated and when it is removed were not read.',
      suggestion: 'Inline the referenced operation, or treat it as unscanned.',
    })
    return null
  }
  const operationId = value.operationId
  if (!isIdentifier(operationId)) {
    add({
      ruleId: 'operation-invalid',
      pointer: `${pointer}/operationId`,
      message: 'This operation declares no usable operationId, so no consumer usage can be joined to it.',
      evidence: `${method.toUpperCase()} ${excerpt(path, 100)}`,
      suggestion: 'Give the operation a printable operationId of 1-200 characters, and use the same id in the inventory.',
    })
    return null
  }

  const operation = {
    operationId,
    path,
    method,
    pointer,
    deprecated: false,
    deprecatedUnknown: false,
    sunset: null,
    sunsetUnknown: false,
    deprecatedSince: null,
    replacement: null,
    replacementBroken: false,
    unknownEvidence: false,
  }

  if (Object.hasOwn(value, 'deprecated')) {
    if (typeof value.deprecated !== 'boolean') {
      add({
        ruleId: 'deprecated-flag-invalid',
        pointer: `${pointer}/deprecated`,
        message: `"deprecated" must be true or false; operation "${excerpt(operationId, 80)}" holds ${describeValue(value.deprecated)}, so whether it is deprecated was not decided.`,
        suggestion: 'Write the flag as a JSON boolean.',
      })
      operation.unknownEvidence = true
      operation.deprecatedUnknown = true
    } else {
      operation.deprecated = value.deprecated
    }
  }

  for (const key of UNRECOGNISED_EXTENSIONS) {
    if (!Object.hasOwn(value, key)) continue
    operation.unknownEvidence = true
    add({
      ruleId: 'sunset-extension-unrecognised',
      pointer: `${pointer}/${escapePointerToken(key)}`,
      message: `Operation "${excerpt(operationId, 80)}" carries "${key}", which this reader does not interpret. It may hold the removal date or the replacement, so neither was decided from it.`,
      suggestion: `Restate it as "${SUNSET_KEY}", "${DEPRECATED_SINCE_KEY}" or "${REPLACEMENT_KEY}".`,
    })
  }

  for (const [key, field] of [[SUNSET_KEY, 'sunset'], [DEPRECATED_SINCE_KEY, 'deprecatedSince']]) {
    if (!Object.hasOwn(value, key)) continue
    const parsed = parseInstant(value[key], { allowDateOnly: true })
    if (!parsed.ok) {
      add({
        ruleId: 'sunset-invalid',
        pointer: `${pointer}/${escapePointerToken(key)}`,
        message: `"${key}" on operation "${excerpt(operationId, 80)}" must be an ISO-8601 UTC instant or calendar day; it holds ${describeValue(value[key])} (${parsed.reason}), so the date it announces was not read.`,
        suggestion: 'Write it as 2026-06-30 or 2026-06-30T00:00:00Z.',
      })
      operation.unknownEvidence = true
      continue
    }
    operation[field] = parsed
  }

  const replacement = compileReplacement(add, pointer, operationId, value[REPLACEMENT_KEY])
  if (replacement === 'broken') operation.replacementBroken = true
  else operation.replacement = replacement

  // Not reported when the `deprecated` flag itself could not be read: "is not
  // marked deprecated" would be a claim about a value this reader refused.
  if (!operation.deprecated && !operation.deprecatedUnknown && operation.sunset !== null) {
    add({
      ruleId: 'sunset-without-deprecation',
      pointer: `${pointer}/${escapePointerToken(SUNSET_KEY)}`,
      message: `Operation "${excerpt(operationId, 80)}" announces a removal date of ${operation.sunset.canonical} but is not marked deprecated, so consumers reading the document see no warning.`,
      suggestion: 'Set "deprecated": true alongside the removal date.',
    })
  }

  return operation
}

function compileReplacement(add, pointer, operationId, value) {
  if (value === undefined) return null
  const at = `${pointer}/${escapePointerToken(REPLACEMENT_KEY)}`
  const refuse = (message) => {
    add({
      ruleId: 'replacement-invalid',
      pointer: at,
      message,
      suggestion: `Write "${REPLACEMENT_KEY}" as an operationId string, or as an object with ${REPLACEMENT_KEYS.join(', ')}.`,
    })
    return 'broken'
  }

  if (typeof value === 'string') {
    if (!isIdentifier(value)) return refuse(`The replacement named on operation "${excerpt(operationId, 80)}" is not a usable operationId, so the migration target was not read.`)
    return { operationId: value, since: '', docs: '' }
  }
  if (!isPlainObject(value)) {
    return refuse(`"${REPLACEMENT_KEY}" on operation "${excerpt(operationId, 80)}" must be a string or an object; it holds ${describeValue(value)}.`)
  }
  for (const key of Object.keys(value)) {
    if (!REPLACEMENT_KEYS.includes(key)) {
      return refuse(`"${REPLACEMENT_KEY}" on operation "${excerpt(operationId, 80)}" holds the unknown key "${excerpt(key, 60)}", so the migration target was not read rather than half-read.`)
    }
  }
  if (!isIdentifier(value.operationId)) {
    return refuse(`"${REPLACEMENT_KEY}.operationId" on operation "${excerpt(operationId, 80)}" must be a printable operationId; it holds ${describeValue(value.operationId)}.`)
  }
  for (const key of ['since', 'docs']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      return refuse(`"${REPLACEMENT_KEY}.${key}" on operation "${excerpt(operationId, 80)}" must be a string; it holds ${describeValue(value[key])}.`)
    }
  }
  return {
    operationId: value.operationId,
    since: value.since === undefined ? '' : excerpt(value.since, 60),
    docs: value.docs === undefined ? '' : excerpt(value.docs, MAX_DOCS_LENGTH),
  }
}

/**
 * Checks that need the whole map, run once it is built.
 *
 * None of these marks the run incomplete. Each is a complete statement about
 * the bytes -- the migration target named does not exist, the migration target
 * is itself being removed, the removal date precedes the announcement -- so
 * each is an ordinary `error` whose only backstop is its own severity, and the
 * process exit code is what pins it.
 */
export function checkSpecCrossReferences(sink, file, spec) {
  for (const operation of spec.operations.values()) {
    if (!operation.deprecated) continue
    if (operation.sunset !== null && operation.deprecatedSince !== null && operation.sunset.ms < operation.deprecatedSince.ms) {
      sink.add({
        file,
        ruleId: 'sunset-before-deprecation',
        pointer: `${operation.pointer}/${escapePointerToken(SUNSET_KEY)}`,
        message: `Operation "${excerpt(operation.operationId, 80)}" is removed at ${operation.sunset.canonical} but announced as deprecated only from ${operation.deprecatedSince.canonical}, so consumers were given no notice at all.`,
        suggestion: 'Correct one of the two dates; a removal date must not precede its announcement.',
      })
    }
    if (operation.replacement === null) continue
    const target = spec.operations.get(operation.replacement.operationId)
    if (target === undefined) {
      sink.add({
        file,
        ruleId: 'replacement-unknown-operation',
        pointer: `${operation.pointer}/${escapePointerToken(REPLACEMENT_KEY)}`,
        message: `Operation "${excerpt(operation.operationId, 80)}" names "${excerpt(operation.replacement.operationId, 80)}" as its replacement, but this document declares no such operation, so the migration guidance points nowhere.`,
        suggestion: 'Name an operationId this document declares, or remove the replacement.',
      })
      continue
    }
    if (target.deprecated) {
      sink.add({
        file,
        ruleId: 'replacement-also-deprecated',
        pointer: `${operation.pointer}/${escapePointerToken(REPLACEMENT_KEY)}`,
        message: `Operation "${excerpt(operation.operationId, 80)}" names "${excerpt(target.operationId, 80)}" as its replacement, and that operation is deprecated too, so the migration guidance sends consumers to another removal.`,
        suggestion: 'Point the replacement at an operation that is not itself deprecated.',
      })
    }
  }
}
