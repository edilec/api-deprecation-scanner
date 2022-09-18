/**
 * The consumer usage inventory.
 *
 * This is the only evidence about who calls what that this tool will ever
 * have. It is produced somewhere else -- a gateway access log, a service mesh,
 * an API-key ledger -- and it covers whatever that source covered, over
 * whatever window it was asked for.
 *
 * So the inventory is required to *state* its coverage, and the coverage block
 * is validated as strictly as the usage itself. A consumer that does not
 * appear here is unknown, not safe, and the only way to say how unknown is to
 * know how many consumers the source believes exist, over what window it
 * looked, and which version of the API it was watching. Every one of those is
 * a required field for exactly that reason.
 *
 * Unknown keys are refused at every level. A `consumersKnwon` that is silently
 * ignored turns "three of twelve consumers are inventoried" into "all known
 * consumers are inventoried", which is a green run built on a typo.
 */

import {
  describeValue, excerpt, isIdentifier, isPlainObject, parseInstant,
} from './text.mjs'

export const INVENTORY_SCHEMA_VERSION = '1'
export const INVENTORY_KEYS = Object.freeze(['consumers', 'coverage', 'schemaVersion'])
export const COVERAGE_KEYS = Object.freeze(['apiVersion', 'consumersKnown', 'source', 'windowEnd', 'windowStart'])
export const CONSUMER_KEYS = Object.freeze(['calls', 'contact', 'id'])
export const CALL_KEYS = Object.freeze(['count', 'lastSeen', 'operationId'])

const MAX_CONSUMERS_KNOWN = 1000000
const MAX_CALL_COUNT = 1000000000000

function refuseUnknownKeys(add, pointer, value, allowed, what) {
  let refused = 0
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    refused += 1
    add({
      ruleId: 'inventory-key-unknown',
      pointer: `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
      message: `Unknown ${what} key "${key}". Known keys are ${allowed.join(', ')}. An unrecognised key is refused rather than ignored, because a typo that is ignored turns a coverage gap into a silent pass.`,
      suggestion: 'Remove the key, or correct its spelling.',
    })
  }
  return refused
}

/**
 * Compile the inventory.
 *
 * Returns `null` when nothing usable could be read. Otherwise returns the
 * consumers that compiled, the coverage block, and the counts of what was
 * declared -- the caller turns `declared !== compiled` into the run's
 * `incomplete` flag at one site, so that no refusal is backstopped by another.
 */
export function compileInventory(sink, file, document, limits) {
  const add = (row) => sink.add({ file, ...row })

  if (!isPlainObject(document)) {
    add({ ruleId: 'inventory-invalid', message: `The usage inventory must be a JSON object; this file holds ${describeValue(document)}.` })
    return null
  }
  let unknownKeys = refuseUnknownKeys(add, '', document, INVENTORY_KEYS, 'inventory')
  if (document.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    add({
      ruleId: 'inventory-invalid',
      pointer: '/schemaVersion',
      message: `The inventory must declare "schemaVersion": "${INVENTORY_SCHEMA_VERSION}"; it holds ${describeValue(document.schemaVersion)}.`,
    })
    return null
  }

  const coverage = compileCoverage(add, document.coverage)
  if (coverage === null) return null
  unknownKeys += coverage.unknownKeys

  if (!Array.isArray(document.consumers)) {
    add({ ruleId: 'inventory-invalid', pointer: '/consumers', message: `"consumers" must be an array; it holds ${describeValue(document.consumers)}.` })
    return null
  }

  const consumers = []
  const seen = new Set()
  let declaredConsumers = 0
  let declaredCalls = 0
  let compiledCalls = 0

  for (let index = 0; index < document.consumers.length; index += 1) {
    const pointer = `/consumers/${index}`
    if (consumers.length >= limits.maxConsumers) {
      add({
        ruleId: 'too-many-consumers',
        pointer,
        message: `The inventory holds more consumers than the maxConsumers limit of ${limits.maxConsumers}; the walk stopped here and the consumers past this point were not read.`,
        suggestion: 'Raise --max-consumers, or split the inventory.',
      })
      declaredConsumers += document.consumers.length - index
      break
    }
    declaredConsumers += 1
    const entry = document.consumers[index]
    if (!isPlainObject(entry)) {
      add({ ruleId: 'consumer-invalid', pointer, message: `A consumer must be an object; this one is ${describeValue(entry)}.` })
      continue
    }
    unknownKeys += refuseUnknownKeys(add, pointer, entry, CONSUMER_KEYS, 'consumer')
    if (!isIdentifier(entry.id)) {
      add({
        ruleId: 'identifier-invalid',
        pointer: `${pointer}/id`,
        message: `A consumer id must be a printable identifier of 1-200 characters with no control, separator or bidi character; this one is ${describeValue(entry.id)}, so this consumer's usage was not read.`,
        suggestion: 'Give the consumer a plain identifier.',
      })
      continue
    }
    if (seen.has(entry.id)) {
      add({
        ruleId: 'consumer-duplicate',
        pointer: `${pointer}/id`,
        message: `Consumer "${excerpt(entry.id, 80)}" appears more than once. This occurrence was not read, because merging two entries would invent usage that neither of them claims.`,
        suggestion: 'Give every consumer one entry, with all of its calls in it.',
      })
      continue
    }
    let contact = ''
    if (entry.contact !== undefined) {
      if (typeof entry.contact !== 'string' || entry.contact.length > 200) {
        add({ ruleId: 'consumer-invalid', pointer: `${pointer}/contact`, message: `A consumer contact must be a string of at most 200 characters; this one is ${describeValue(entry.contact)}.` })
        continue
      }
      if (entry.contact.includes('@')) {
        add({
          ruleId: 'consumer-invalid',
          pointer: `${pointer}/contact`,
          message: 'A consumer contact must name a team or a channel, never an address. This one contains "@", so it was refused unread rather than copied into a report that gets piped, logged and pasted.',
          suggestion: 'Name the owning team; look the people up in your own directory.',
        })
        continue
      }
      contact = excerpt(entry.contact, 80)
    }

    if (!Array.isArray(entry.calls)) {
      add({ ruleId: 'consumer-invalid', pointer: `${pointer}/calls`, message: `A consumer's "calls" must be an array; consumer "${excerpt(entry.id, 80)}" holds ${describeValue(entry.calls)}.` })
      continue
    }

    const calls = []
    const calledOperations = new Set()
    for (let callIndex = 0; callIndex < entry.calls.length; callIndex += 1) {
      const callPointer = `${pointer}/calls/${callIndex}`
      if (calls.length >= limits.maxCallsPerConsumer) {
        add({
          ruleId: 'too-many-calls-for-consumer',
          pointer: callPointer,
          message: `Consumer "${excerpt(entry.id, 80)}" declares more calls than the maxCallsPerConsumer limit of ${limits.maxCallsPerConsumer}; the walk stopped here and its remaining calls were not read.`,
          suggestion: 'Raise --max-calls-per-consumer, or aggregate the inventory before scanning it.',
        })
        declaredCalls += entry.calls.length - callIndex
        break
      }
      if (compiledCalls >= limits.maxCalls) {
        add({
          ruleId: 'too-many-calls',
          pointer: callPointer,
          message: `The inventory declares more calls than the maxCalls limit of ${limits.maxCalls}; the walk stopped here and the calls past this point were not read.`,
          suggestion: 'Raise --max-calls, or aggregate the inventory before scanning it.',
        })
        declaredCalls += entry.calls.length - callIndex
        break
      }
      declaredCalls += 1
      const counters = { unknownKeys: 0 }
      const call = compileCall(add, callPointer, entry.id, entry.calls[callIndex], counters)
      unknownKeys += counters.unknownKeys
      if (call === null) continue
      if (calledOperations.has(call.operationId)) {
        add({
          ruleId: 'call-duplicate',
          pointer: `${callPointer}/operationId`,
          message: `Consumer "${excerpt(entry.id, 80)}" declares operation "${excerpt(call.operationId, 80)}" more than once. This entry was not read, because two counts for one pair cannot be reconciled without inventing a total.`,
          suggestion: 'Aggregate the calls one consumer makes to one operation into a single entry.',
        })
        continue
      }
      calledOperations.add(call.operationId)
      calls.push(call)
      compiledCalls += 1
    }

    seen.add(entry.id)
    consumers.push({ id: entry.id, contact, pointer, calls })
  }

  return { coverage, consumers, declaredConsumers, declaredCalls, compiledCalls, unknownKeys }
}

function compileCoverage(add, value) {
  if (!isPlainObject(value)) {
    add({
      ruleId: 'coverage-invalid',
      pointer: '/coverage',
      message: `The inventory must declare a "coverage" object; it holds ${describeValue(value)}. Without it a consumer's absence from the inventory says nothing at all, so there is no scan to run.`,
      suggestion: `Declare coverage with ${COVERAGE_KEYS.join(', ')}.`,
    })
    return null
  }
  const unknownKeys = refuseUnknownKeys(add, '/coverage', value, COVERAGE_KEYS, 'coverage')

  if (!isIdentifier(value.apiVersion)) {
    add({
      ruleId: 'coverage-invalid',
      pointer: '/coverage/apiVersion',
      message: `"coverage.apiVersion" must be a printable identifier naming the API version the usage was observed against; it holds ${describeValue(value.apiVersion)}.`,
    })
    return null
  }
  const window = {}
  for (const key of ['windowStart', 'windowEnd']) {
    const parsed = parseInstant(value[key])
    if (!parsed.ok) {
      add({
        ruleId: 'coverage-invalid',
        pointer: `/coverage/${key}`,
        message: `"coverage.${key}" must be a full ISO-8601 UTC instant; it holds ${describeValue(value[key])} (${parsed.reason}). A calendar day is not precise enough to decide whether an observation falls inside the window.`,
        suggestion: 'Write it as 2026-06-01T00:00:00Z.',
      })
      return null
    }
    window[key] = parsed
  }
  if (window.windowStart.ms >= window.windowEnd.ms) {
    add({
      ruleId: 'coverage-invalid',
      pointer: '/coverage/windowEnd',
      message: `The coverage window ends at ${window.windowEnd.canonical}, at or before its start of ${window.windowStart.canonical}, so it covers nothing.`,
    })
    return null
  }
  if (!Number.isInteger(value.consumersKnown) || value.consumersKnown < 0 || value.consumersKnown > MAX_CONSUMERS_KNOWN) {
    add({
      ruleId: 'coverage-invalid',
      pointer: '/coverage/consumersKnown',
      message: `"coverage.consumersKnown" must be an integer between 0 and ${MAX_CONSUMERS_KNOWN} -- how many consumers the source believes exist, whether or not it inventoried them; it holds ${describeValue(value.consumersKnown)}.`,
      suggestion: 'State the number your source knows about, even when it is larger than the number you listed. That difference is the point of the field.',
    })
    return null
  }
  let source = ''
  if (value.source !== undefined) {
    if (typeof value.source !== 'string' || value.source.length === 0 || value.source.length > 200) {
      add({ ruleId: 'coverage-invalid', pointer: '/coverage/source', message: `"coverage.source" must be a string of 1-200 characters naming where the usage came from; it holds ${describeValue(value.source)}.` })
      return null
    }
    source = excerpt(value.source, 80)
  }

  return {
    apiVersion: value.apiVersion,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    consumersKnown: value.consumersKnown,
    source,
    unknownKeys,
  }
}

function compileCall(add, pointer, consumerId, value, counters) {
  if (!isPlainObject(value)) {
    add({ ruleId: 'call-invalid', pointer, message: `A call entry must be an object; consumer "${excerpt(consumerId, 80)}" holds ${describeValue(value)} at this position.` })
    return null
  }
  // Counted, not merely reported: an unknown key here is the same typo risk as
  // one at the top level, and a typo that only produces a finding without
  // marking the run incomplete is a typo that can still turn a gap green.
  counters.unknownKeys += refuseUnknownKeys(add, pointer, value, CALL_KEYS, 'call')
  if (!isIdentifier(value.operationId)) {
    add({
      ruleId: 'identifier-invalid',
      pointer: `${pointer}/operationId`,
      message: `A call must name a printable operationId of 1-200 characters with no control, separator or bidi character; consumer "${excerpt(consumerId, 80)}" holds ${describeValue(value.operationId)} here, so this call was not read.`,
      suggestion: 'Use the operationId exactly as the OpenAPI document spells it.',
    })
    return null
  }
  if (!Number.isInteger(value.count) || value.count < 1 || value.count > MAX_CALL_COUNT) {
    add({
      ruleId: 'call-invalid',
      pointer: `${pointer}/count`,
      message: `"count" must be an integer between 1 and ${MAX_CALL_COUNT}; consumer "${excerpt(consumerId, 80)}" holds ${describeValue(value.count)} for operation "${excerpt(value.operationId, 80)}".`,
      suggestion: 'Omit the entry entirely if the consumer made no call; zero is not a call.',
    })
    return null
  }
  const lastSeen = parseInstant(value.lastSeen)
  if (!lastSeen.ok) {
    add({
      ruleId: 'call-invalid',
      pointer: `${pointer}/lastSeen`,
      message: `"lastSeen" must be a full ISO-8601 UTC instant; consumer "${excerpt(consumerId, 80)}" holds ${describeValue(value.lastSeen)} (${lastSeen.reason}) for operation "${excerpt(value.operationId, 80)}", so whether this consumer is still active was not decided.`,
      suggestion: 'Write it as 2026-05-30T11:02:00Z.',
    })
    return null
  }
  return { operationId: value.operationId, count: value.count, lastSeen, pointer }
}
