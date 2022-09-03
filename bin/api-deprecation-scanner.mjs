#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_INVENTORY_NAME,
  DEFAULT_SPEC_NAME,
  excerpt,
  exitCodeFor,
  formatReport,
  scanDeprecations,
  serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `api-deprecation-scanner

Join the deprecated operations in a versioned OpenAPI document to the consumers
a usage inventory says are calling them, with the announced removal date and
the documented replacement. Nothing is requested over a network: the inventory
is the only evidence about consumers there is, and the report says how much of
it there is.

Usage:
  api-deprecation-scanner --root DIR --now INSTANT [--spec FILE]
                          [--inventory FILE] [--json]
                          [--active-within-seconds N] [--imminent-window-seconds N]
                          [--max-coverage-staleness-seconds N]
                          [--max-file-bytes N] [--max-json-depth N]
                          [--max-operations N] [--max-consumers N]
                          [--max-calls N] [--max-calls-per-consumer N]
                          [--max-consumers-named N] [--max-milliseconds N]
                          [--max-findings N]

Options:
  --root DIR                Directory holding both inputs (required)
  --now INSTANT             ISO-8601 UTC instant the scan is made at (required)
  --spec FILE               OpenAPI document, relative to --root
                            (default ${DEFAULT_SPEC_NAME})
  --inventory FILE          Consumer usage inventory, relative to --root
                            (default ${DEFAULT_INVENTORY_NAME})
  --json                    Suppress the human summary on stderr
  -h, --help                Show this help
  -v, --version             Show the version

Policy windows, all measured against --now:
  --active-within-seconds N            A consumer last seen within this many
                                       seconds of the clock is active
                                       (default 2592000, 30 days)
  --imminent-window-seconds N          A removal date this close counts as
                                       imminent (default 2592000, 30 days)
  --max-coverage-staleness-seconds N   How far behind the clock the coverage
                                       window may end (default 604800, 7 days)

Limits, each reported by name when it is hit:
  --max-file-bytes N          Bytes per input file (default 5242880)
  --max-json-depth N          JSON nesting depth (default 50)
  --max-operations N          Operations read from the document (default 2000)
  --max-consumers N           Consumers read from the inventory (default 2000)
  --max-calls N               Call entries in total (default 50000)
  --max-calls-per-consumer N  Call entries per consumer (default 2000)
  --max-consumers-named N     Consumer ids named in one evidence line (default 5)
  --max-milliseconds N        Wall budget for the join (default 10000)
  --max-findings N            Findings in one report (default 1000)

--now has no default, and this is not an oversight. Whether an operation has
passed its removal date is the question this tool answers, so the instant it is
answered at is configuration: it is stated, it is recorded, and two people
running the same scan on different days get the same report unless they say
otherwise.

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

What a pass means:
  Nothing in the inventory showed a consumer calling an operation past its
  removal date. The inventory covers the consumers and the window it declares
  and no more, so a consumer that is not in it is unknown and not safe. Where
  the coverage is short in any way -- consumers missing, window stale, version
  mismatched, entries unread -- the run is "incomplete" and exits 2 instead.

Exit codes:
  0  scanned, and no covered consumer calls an operation past its removal date
  1  scanned, and at least one error-severity rule fired
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-calls', 'maxCalls'],
  ['--max-calls-per-consumer', 'maxCallsPerConsumer'],
  ['--max-consumers', 'maxConsumers'],
  ['--max-consumers-named', 'maxConsumersNamed'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-findings', 'maxFindings'],
  ['--max-json-depth', 'maxJsonDepth'],
  ['--max-milliseconds', 'maxMilliseconds'],
  ['--max-operations', 'maxOperations'],
])

const POLICY_FLAGS = new Map([
  ['--active-within-seconds', 'activeWithinSeconds'],
  ['--imminent-window-seconds', 'imminentWindowSeconds'],
  ['--max-coverage-staleness-seconds', 'maxCoverageStalenessSeconds'],
])

const VALUE_FLAGS = new Map([
  ['--inventory', 'inventory'],
  ['--now', 'now'],
  ['--root', 'root'],
  ['--spec', 'spec'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, now: null, spec: null, inventory: null, json: false, limits: {}, policy: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--now 2026-01-01T00:00:00Z --now 2020-01-01T00:00:00Z` answers the
   * expiry question at an instant nobody asked about. That is the same defect
   * as an ignored typo, which this tool also refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument) || POLICY_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      const bucket = LIMIT_FLAGS.has(argument) ? options.limits : options.policy
      bucket[(LIMIT_FLAGS.get(argument) ?? POLICY_FLAGS.get(argument))] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  if (options.now === null) {
    throw new Error('--now is required: this tool never reads a system clock, so the instant the scan is made at must be stated')
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await scanDeprecations({
      root: options.root,
      now: options.now,
      limits: options.limits,
      policy: options.policy,
      ...(options.spec === null ? {} : { spec: options.spec }),
      ...(options.inventory === null ? {} : { inventory: options.inventory }),
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty and the
    // consumer that pipes stdout gets nothing rather than a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) {
    process.stderr.write(formatReport(report, {
      spec: options.spec ?? DEFAULT_SPEC_NAME,
      inventory: options.inventory ?? DEFAULT_INVENTORY_NAME,
      now: options.now,
    }))
  }
  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.coverageGaps} coverage gap(s) and ${report.summary.unevaluated} unevaluated entr(ies); ` +
      `a consumer absent from this inventory is unknown, not safe. This run is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
