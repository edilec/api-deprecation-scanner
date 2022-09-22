import assert from 'node:assert/strict'
import test from 'node:test'

import { exitCodeFor, serializeReport } from '../src/index.mjs'
import { NOW, cliHuman, cliReport, cliRun, consumer, current, fixture, operation, operations, withRoot } from './support.mjs'

/**
 * The command-line surface.
 *
 * The two streams are the contract: stdout carries the JSON report and nothing
 * else, so it pipes straight into a parser, and a non-empty stderr is normal
 * rather than a symptom. Exit 2 has two shapes and they are not
 * interchangeable -- a configuration error never had a subject, so stdout stays
 * empty; an input that could not be read had one, so stdout carries the report
 * that says which.
 */

test('--help prints the usage on stdout and exits 0', async () => {
  const result = await cliRun(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^api-deprecation-scanner\n/)
  assert.match(result.stdout, /--now INSTANT\s+ISO-8601 UTC instant the scan is made at \(required\)/)
  assert.match(result.stdout, /What a pass means:/)
  assert.match(result.stdout, /Exit codes:/)
  assert.equal(result.stderr, '')
})

test('--help works without any other argument, including without a root', async () => {
  assert.equal((await cliRun(['-h'])).code, 0)
  assert.equal((await cliRun(['--root', 'nowhere', '--help'])).code, 0)
})

test('--version prints the version alone', async () => {
  const result = await cliRun(['--version'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '0.1.0\n')
  assert.equal((await cliRun(['-v'])).stdout, '0.1.0\n')
})

test('stdout is the JSON report and nothing else', async () => {
  const { stdout, report } = await cliReport(fixture(operations(), [consumer()]))
  assert.equal(stdout.endsWith('\n'), true)
  assert.equal(stdout, `${serializeReport(report)}\n`, 'nothing is written around the report')
  assert.equal(JSON.parse(stdout).tool, 'api-deprecation-scanner')
  assert.equal(JSON.parse(stdout).schemaVersion, '1')
})

test('the human summary goes to stderr, and --json suppresses it', async () => {
  const files = fixture(operations(), [consumer()])
  const human = await cliHuman(files)
  assert.match(human.stderr, /^spec openapi\.json: 2 operation\(s\) read, 1 deprecated, 0 past their removal date at 2026-06-05T00:00:00Z\.\n/)
  assert.match(human.stderr, /\njoin: 1 deprecated-operation\/consumer link\(s\), 0 where an active consumer calls an operation past its removal date\. status pass\.\n/)

  const quiet = await cliReport(files)
  assert.equal(quiet.stderr, '')
  assert.equal(quiet.stdout, human.stdout, 'the report itself does not change')
})

test('an incomplete run says so on stderr as well as in the report', async () => {
  const { code, stderr } = await cliReport(fixture(operations(), [consumer()], { consumersKnown: 9 }))
  assert.equal(code, 2)
  assert.match(stderr, /incomplete: 1 coverage gap\(s\) and 0 unevaluated entr\(ies\); a consumer absent from this inventory is unknown, not safe\. This run is not a pass\.\n$/)
})

test('--root is required, and a configuration error leaves stdout empty', async () => {
  const result = await cliRun(['--now', NOW])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^--root is required\n/)
  assert.match(result.stderr, /Usage:/, 'the usage follows the message')
})

test('--now is required, and the message says why there is no default', async () => {
  await withRoot(fixture(operations(), [consumer()]), async (root) => {
    const result = await cliRun(['--root', root])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^--now is required: this tool never reads a system clock/)
  })
})

test('--now must be a full ISO-8601 UTC instant', async () => {
  await withRoot(fixture(operations(), [consumer()]), async (root) => {
    for (const value of ['2026-06-05', 'yesterday', '2026-06-05T00:00:00+02:00', '2026-02-31T00:00:00Z']) {
      const result = await cliRun(['--root', root, '--now', value])
      assert.equal(result.code, 2, value)
      assert.equal(result.stdout, '', value)
      assert.match(result.stderr, /now must be a full ISO-8601 UTC instant/, value)
    }
  })
})

test('an unknown option is refused, and the refusal does not echo a control character', async () => {
  const result = await cliRun(['--root', '.', '--now', NOW, `--max-operation${String.fromCharCode(0x0a)}s`, '5'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^Unknown option "--max-operation s"/)
})

test('a value-carrying flag given twice is refused rather than silently last-wins', async () => {
  await withRoot(fixture(operations(), [consumer()]), async (root) => {
    for (const [flag, first, second] of [
      ['--now', NOW, '2020-01-01T00:00:00Z'],
      ['--spec', 'openapi.json', 'other.json'],
      ['--max-operations', '5', '50'],
      ['--active-within-seconds', '60', '600'],
    ]) {
      const args = flag === '--now'
        ? ['--root', root, '--now', first, '--now', second]
        : ['--root', root, '--now', NOW, flag, first, flag, second]
      const result = await cliRun(args)
      assert.equal(result.code, 2, flag)
      assert.equal(result.stdout, '', flag)
      assert.match(result.stderr, new RegExp(`^\\${flag} was given more than once`), flag)
    }
  })
})

test('a flag with no value, or a non-integer limit, is refused', async () => {
  assert.match((await cliRun(['--root', '.', '--now', NOW, '--max-operations'])).stderr, /--max-operations requires a value/)
  assert.match((await cliRun(['--root', '.', '--now', NOW, '--max-operations', 'lots'])).stderr, /--max-operations requires a positive integer/)
  assert.match((await cliRun(['--root', '.', '--now', NOW, '--max-operations', '0'])).stderr, /--max-operations requires a positive integer/)
  assert.match((await cliRun(['--root'])).stderr, /--root requires a value/)
})

test('a limit past its cap is refused as configuration, with an empty stdout', async () => {
  await withRoot(fixture(operations(), [consumer()]), async (root) => {
    const result = await cliRun(['--root', root, '--now', NOW, '--max-operations', '999999'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /limits.maxOperations must be an integer between 1 and 20000/)
  })
})

test('the policy flags reach the join', async () => {
  // `--active-within-seconds 1` makes yesterday dormant, which changes the
  // rule the same input raises. A documented flag the CLI never wires through
  // is a limit that is not enforced.
  const files = fixture([operation({ 'x-sunset': '2026-05-01T00:00:00Z' }), current()], [consumer()])

  const wide = await cliReport(files)
  assert.equal(wide.code, 1)
  assert.deepEqual(wide.report.findings.map((finding) => finding.ruleId), ['expired-operation-in-use'])

  const narrow = await cliReport(files, ['--active-within-seconds', '1'])
  assert.equal(narrow.code, 0)
  assert.deepEqual(narrow.report.findings.map((finding) => finding.ruleId), ['expired-operation-dormant-use'])
})

test('--imminent-window-seconds and --max-coverage-staleness-seconds reach the join too', async () => {
  const soon = fixture([operation({ 'x-sunset': '2026-06-20T00:00:00Z' }), current()], [consumer()])
  const wide = await cliReport(soon)
  assert.deepEqual(wide.report.findings.map((finding) => finding.ruleId), ['sunset-imminent-operation-in-use'])
  const narrow = await cliReport(soon, ['--imminent-window-seconds', '60'])
  assert.deepEqual(narrow.report.findings.map((finding) => finding.ruleId), ['deprecated-operation-in-use'])

  const files = fixture(operations(), [consumer()])
  assert.equal((await cliReport(files)).code, 0)
  const strict = await cliReport(files, ['--max-coverage-staleness-seconds', '60'])
  assert.equal(strict.code, 2)
  assert.deepEqual(strict.report.findings.map((finding) => finding.ruleId).includes('coverage-window-stale'), true)
})

test('exitCodeFor maps the three statuses, and nothing else', () => {
  assert.equal(exitCodeFor({ status: 'pass' }), 0)
  assert.equal(exitCodeFor({ status: 'fail' }), 1)
  assert.equal(exitCodeFor({ status: 'incomplete' }), 2)
})
