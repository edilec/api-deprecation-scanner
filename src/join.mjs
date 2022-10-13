/**
 * The join: deprecated operations to the consumers actually calling them.
 *
 * Two honesty rules shape everything here.
 *
 * **Expiry is decided against an injected clock.** `now` arrives as a
 * parameter, from `--now` on the command line. Nothing in this package reads a
 * system clock, so the same two files and the same `--now` produce the same
 * report on any machine, on any day, forever -- and a test can stand an
 * operation one second either side of its own sunset instant without waiting
 * for a calendar.
 *
 * **Absence from the inventory is unknown, not safe.** The inventory covers
 * the consumers it covers, over the window it covers, for the API version it
 * was watching. When any of those is short of complete, a deprecated operation
 * with no recorded usage is reported as `...-usage-unknown` -- an error -- and
 * not as unused. Silence is only evidence when the coverage says it is.
 */

import { byCodeUnit, excerpt } from './text.mjs'

/** Why the coverage of this inventory is short of complete. Empty means complete. */
export function describeCoverageGaps(sink, file, inventory, spec, now, policy, limits) {
  const coverage = inventory.coverage
  const gaps = []
  const listed = inventory.consumers.length

  if (coverage.apiVersion !== spec.version) {
    gaps.push('version')
    sink.add({
      file,
      ruleId: 'coverage-version-mismatch',
      pointer: '/coverage/apiVersion',
      message: `The usage was observed against API version "${excerpt(coverage.apiVersion, 60)}" but the document declares "${excerpt(spec.version, 60)}", so this inventory is not evidence about the operations that were scanned.`,
      suggestion: 'Scan the document the usage was recorded against, or re-record the usage against this one.',
    })
  }
  if (listed < coverage.consumersKnown) {
    gaps.push('consumers')
    const named = inventory.consumers.map((consumer) => consumer.id).sort(byCodeUnit)
    const shown = named.slice(0, limits.maxConsumersNamed)
    const more = named.length - shown.length
    sink.add({
      file,
      ruleId: 'coverage-consumers-incomplete',
      pointer: '/coverage/consumersKnown',
      message: `${listed} of ${coverage.consumersKnown} known consumer(s) are inventoried, so ${coverage.consumersKnown - listed} consumer(s) were never examined. Their absence from a finding is not evidence that they call nothing.`,
      evidence: `inventoried: ${shown.map((id) => excerpt(id, 40)).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`,
      suggestion: 'Inventory every known consumer, or read every result below as covering only the consumers named here.',
    })
  }
  const staleBy = now.ms - coverage.windowEnd.ms
  if (staleBy > policy.maxCoverageStalenessSeconds * 1000) {
    gaps.push('window')
    sink.add({
      file,
      ruleId: 'coverage-window-stale',
      pointer: '/coverage/windowEnd',
      message: `The coverage window ended at ${coverage.windowEnd.canonical}, ${Math.floor(staleBy / 1000)} second(s) before the scan clock of ${now.canonical} and past the maxCoverageStalenessSeconds allowance of ${policy.maxCoverageStalenessSeconds}. Nothing is known about usage since then.`,
      suggestion: 'Re-export the inventory, or raise --max-coverage-staleness-seconds if a gap this size is acceptable to you.',
    })
  }
  if (inventory.declaredConsumers !== inventory.consumers.length || inventory.declaredCalls !== inventory.compiledCalls) {
    gaps.push('unevaluated')
  }
  if (listed === 0) {
    // An inventory with nobody in it is the emptiest possible coverage, and
    // reading its silence as "no consumer calls this" would be the vacuous
    // pass wearing a different hat. It raises no finding of its own here --
    // `no-consumers-inventoried` already says it, and owns the flag.
    gaps.push('empty')
  }
  return gaps
}

/**
 * Join the deprecated operations to the inventory.
 *
 * One finding per (deprecated operation, consumer) pair, located at the
 * operation in the OpenAPI document, with the consumer, its last observed call
 * and its call count in the evidence. Nothing is aggregated away: every link
 * the inventory supports is in the report, and the finding limit -- not a
 * truncation inside this function -- is what bounds the total.
 */
export function joinUsage(sink, files, spec, inventory, context) {
  const { now, policy, coverageGaps, deadline } = context
  const usage = new Map()
  let unknownOperations = 0
  let timedOut = false

  for (const consumer of inventory.consumers) {
    if (deadline.exceeded()) {
      timedOut = true
      break
    }
    for (const call of consumer.calls) {
      const operation = spec.operations.get(call.operationId)
      if (operation === undefined) {
        unknownOperations += 1
        sink.add({
          file: files.inventory,
          ruleId: 'usage-operation-unknown',
          pointer: `${call.pointer}/operationId`,
          message: `Consumer "${excerpt(consumer.id, 80)}" calls operation "${excerpt(call.operationId, 80)}", which this document does not declare. Whether that call reaches a deprecated operation under another id was not decided.`,
          suggestion: 'Align the inventory with the document, or scan the document version this usage was recorded against.',
        })
        continue
      }
      if (call.lastSeen.ms > now.ms) {
        sink.add({
          file: files.inventory,
          ruleId: 'call-observed-after-clock',
          pointer: `${call.pointer}/lastSeen`,
          message: `Consumer "${excerpt(consumer.id, 80)}" was last seen calling "${excerpt(call.operationId, 80)}" at ${call.lastSeen.canonical}, after the scan clock of ${now.canonical}. One of the two is wrong.`,
          suggestion: 'Correct the observation, or pass the --now the inventory was exported at.',
        })
      } else if (call.lastSeen.ms < inventory.coverage.windowStart.ms || call.lastSeen.ms > inventory.coverage.windowEnd.ms) {
        sink.add({
          file: files.inventory,
          ruleId: 'call-outside-coverage-window',
          pointer: `${call.pointer}/lastSeen`,
          message: `Consumer "${excerpt(consumer.id, 80)}" was last seen calling "${excerpt(call.operationId, 80)}" at ${call.lastSeen.canonical}, outside the declared coverage window ${inventory.coverage.windowStart.canonical} to ${inventory.coverage.windowEnd.canonical}.`,
          suggestion: 'Widen the declared window to the one the source actually covered, or correct the observation.',
        })
      }
      if (!operation.deprecated) continue
      const rows = usage.get(operation.operationId)
      if (rows === undefined) usage.set(operation.operationId, [{ consumer, call }])
      else rows.push({ consumer, call })
    }
  }

  /**
   * Completeness is decided here, after the first pass, and not before it.
   *
   * A call naming an operation this document does not declare is a hole in the
   * coverage exactly as a missing consumer is: that consumer was calling
   * *something*, and it may have been the very operation about to be reported
   * as unused. Deciding completeness before the first pass would let such a
   * run claim an operation is unused on evidence that was never resolved.
   */
  const coverageComplete = coverageGaps === 0 && unknownOperations === 0

  let links = 0
  let expiredLinks = 0
  let expired = 0
  let deprecated = 0
  let examined = 0

  // A join that ran out of budget in the first pass has an incomplete picture
  // of who calls what, so the second pass is skipped entirely rather than run
  // over half an inventory and reporting operations as unused that simply were
  // not reached.
  for (const operation of timedOut ? [] : spec.operations.values()) {
    if (deadline.exceeded()) {
      timedOut = true
      break
    }
    // Counted before anything else this loop does, and returned: `deprecated`
    // alone cannot tell "none of them is deprecated" from "the walk stopped
    // before it got to one", and the caller makes a claim that depends on the
    // difference.
    examined += 1
    if (!operation.deprecated) continue
    deprecated += 1

    const isExpired = operation.sunset !== null && operation.sunset.ms <= now.ms
    const isImminent = operation.sunset !== null && !isExpired && operation.sunset.ms <= now.ms + policy.imminentWindowSeconds * 1000
    if (isExpired) expired += 1

    reportOperationMetadata(sink, files.spec, operation)

    const rows = usage.get(operation.operationId) ?? []
    if (rows.length === 0) {
      reportNoUsage(sink, files, operation, inventory, isExpired, coverageComplete)
      continue
    }

    for (const { consumer, call } of rows) {
      links += 1
      const active = call.lastSeen.ms >= now.ms - policy.activeWithinSeconds * 1000
      if (isExpired && active) expiredLinks += 1
      sink.add({
        file: files.spec,
        ruleId: linkRule(isExpired, isImminent, active),
        pointer: operation.pointer,
        message: linkMessage(operation, isExpired, isImminent, active, now, policy),
        evidence:
          `consumer ${excerpt(consumer.id, 60)}; ${call.count} call(s); last seen ${call.lastSeen.canonical}` +
          `${consumer.contact === '' ? '' : `; owner ${consumer.contact}`}`,
        suggestion: migrationAdvice(operation),
      })
    }
  }

  return { links, expiredLinks, expired, deprecated, examined, unknownOperations, timedOut }
}

/** Which of the five link rules this pair falls under. */
function linkRule(isExpired, isImminent, active) {
  if (isExpired) return active ? 'expired-operation-in-use' : 'expired-operation-dormant-use'
  if (!active) return 'deprecated-operation-dormant-use'
  return isImminent ? 'sunset-imminent-operation-in-use' : 'deprecated-operation-in-use'
}

/**
 * The message names the operation and the verdict; the consumer lives in the
 * evidence. That split is deliberate and it is load-bearing: two consumers of
 * one expired operation produce two findings that agree on file, pointer, rule
 * id and message, so the documented sort key reaches its last comparison --
 * evidence -- for real, on values an input file chose. See
 * `test/ordering.test.mjs`.
 */
function linkMessage(operation, isExpired, isImminent, active, now, policy) {
  const id = excerpt(operation.operationId, 80)
  const where = `${operation.method.toUpperCase()} ${excerpt(operation.path, 80)}`
  const seen = active
    ? `is still being called`
    : `was last called more than ${policy.activeWithinSeconds} second(s) before the scan clock of ${now.canonical}`
  if (isExpired) {
    return `Operation "${id}" (${where}) passed its announced removal date of ${operation.sunset.canonical}; it ${seen}.`
  }
  if (isImminent) {
    return `Operation "${id}" (${where}) is removed at ${operation.sunset.canonical}, within the ${policy.imminentWindowSeconds}-second imminent window; it ${seen}.`
  }
  const when = operation.sunset === null
    ? 'is deprecated with no announced removal date'
    : `is deprecated and is removed at ${operation.sunset.canonical}`
  return `Operation "${id}" (${where}) ${when}; it ${seen}.`
}

function migrationAdvice(operation) {
  if (operation.replacement === null) {
    return `Confirm with this consumer what it needs; operation "${excerpt(operation.operationId, 60)}" names no replacement.`
  }
  const since = operation.replacement.since === '' ? '' : ` (available since ${operation.replacement.since})`
  const docs = operation.replacement.docs === '' ? '' : ` See ${operation.replacement.docs}`
  return `Move this consumer to "${excerpt(operation.replacement.operationId, 60)}"${since}.${docs}`
}

/** The metadata rules: what a deprecation announcement does not say. */
function reportOperationMetadata(sink, file, operation) {
  if (operation.sunset === null && !operation.unknownEvidence) {
    sink.add({
      file,
      ruleId: 'sunset-undeclared',
      pointer: operation.pointer,
      message: `Operation "${excerpt(operation.operationId, 80)}" is deprecated but announces no removal date, so no consumer can plan a migration and this scan has no deadline to measure against.`,
      suggestion: 'Add "x-sunset" with the date the operation stops answering.',
    })
  }
  if (operation.replacement === null && !operation.replacementBroken) {
    sink.add({
      file,
      ruleId: 'replacement-undeclared',
      pointer: operation.pointer,
      message: `Operation "${excerpt(operation.operationId, 80)}" is deprecated but names no replacement, so every consumer below has to work out where to go on its own.`,
      suggestion: 'Add "x-replacement" naming the operationId that supersedes it.',
    })
  }
}

/**
 * A deprecated operation nobody in the inventory calls.
 *
 * This is where silence is interpreted, so it is where the coverage decides
 * the answer. With complete coverage the absence is evidence about the
 * consumers and window the inventory declares -- stated in the evidence field,
 * because it is a bounded claim and reading it as a general one is exactly the
 * mistake this tool exists to prevent. Without complete coverage it is an
 * error and no claim at all.
 *
 * Neither branch marks the run incomplete. The unknown branch is only reached
 * when the coverage is already short, and every way it can be short -- a
 * missing consumer, a stale window, a mismatched version, an entry that did
 * not compile, a call naming an operation the document does not declare -- has
 * already raised its own error and set that flag; a second flag here would
 * backstop the first, so removing either would change nothing observable and
 * no test could fail when it went.
 */
function reportNoUsage(sink, files, operation, inventory, isExpired, coverageComplete) {
  const coverage = inventory.coverage
  const window = `${coverage.windowStart.canonical} to ${coverage.windowEnd.canonical}`
  const from = coverage.source === '' ? '' : ` from ${coverage.source}`
  if (!coverageComplete) {
    sink.add({
      file: files.spec,
      ruleId: isExpired ? 'expired-operation-usage-unknown' : 'deprecated-operation-usage-unknown',
      pointer: operation.pointer,
      message: `No inventoried consumer calls "${excerpt(operation.operationId, 80)}", but the coverage of this inventory is incomplete, so that is not evidence that nothing calls it.`,
      evidence: `coverage ${window}${from}, ${inventory.consumers.length} of ${coverage.consumersKnown} consumer(s)`,
      suggestion: 'Close the coverage gaps reported against the inventory before reading this operation as unused.',
    })
    return
  }
  sink.add({
    file: files.spec,
    ruleId: isExpired ? 'expired-operation-unused' : 'deprecated-operation-unused',
    pointer: operation.pointer,
    message: isExpired
      ? `Operation "${excerpt(operation.operationId, 80)}" passed its removal date of ${operation.sunset.canonical} and no covered consumer called it in the declared window, so it can be removed from the document.`
      : `Operation "${excerpt(operation.operationId, 80)}" is deprecated and no covered consumer called it in the declared window.`,
    // Both numbers, because the comparison that licenses this claim is
    // one-sided on purpose: an inventory may list more consumers than its
    // source claims to know about, and that is accepted as complete coverage.
    // Stating only `consumersKnown` then read as "all 0 known consumer(s)" for
    // an inventory whose one consumer really had been read and examined --
    // evidence that was obtained, described as if it were not.
    evidence: `coverage ${window}${from}, all ${inventory.consumers.length} inventoried consumer(s), ${coverage.consumersKnown} known to the source`,
    suggestion: 'This covers the declared consumers and window only; usage outside either remains unknown.',
  })
}
