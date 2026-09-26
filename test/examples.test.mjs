import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { cliRun, projectDirectory, raisedRules } from './support.mjs'

/**
 * The three runnable example roots, exercised through the real binary at the
 * clock the README and the package script use.
 *
 * They exist so that the three exit codes can be seen without constructing
 * anything: clean exits 0, broken exits 1, incomplete exits 2. A change that
 * quietly turns one of them into another is caught here.
 */

const CLOCK = '2026-06-05T00:00:00Z'

async function example(name, extraArgs = []) {
  const result = await cliRun(['--root', `examples/${name}`, '--now', CLOCK, ...extraArgs])
  return { ...result, report: JSON.parse(result.stdout) }
}

test('examples/clean exits 0 and explains why it is green', async () => {
  const { code, report } = await example('clean')

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.checked, 6)
  assert.equal(report.summary.deprecated, 3)
  assert.equal(report.summary.expired, 0)
  assert.equal(report.summary.consumers, 4)
  assert.equal(report.summary.links, 3)
  assert.equal(report.summary.coverageGaps, 0)
  assert.deepEqual(raisedRules(report), [
    'deprecated-operation-dormant-use',
    'deprecated-operation-in-use',
    'deprecated-operation-unused',
    'sunset-imminent-operation-in-use',
  ])
})

test('examples/broken exits 1 because an active consumer calls an operation past its removal date', async () => {
  const { code, report } = await example('broken')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.expiredLinks, 2)
  const expired = report.findings.filter((finding) => finding.ruleId === 'expired-operation-in-use')
  assert.equal(expired.length, 2)
  assert.deepEqual(expired.map((finding) => finding.evidence), [
    'consumer billing-portal; 41203 call(s); last seen 2026-05-30T11:02:00Z; owner revenue-platform',
    'consumer mobile-app; 640 call(s); last seen 2026-05-29T18:20:00Z; owner apps-guild',
  ])
  assert.equal(raisedRules(report).includes('replacement-unknown-operation'), true)
  assert.equal(raisedRules(report).includes('replacement-also-deprecated'), true)
  assert.equal(raisedRules(report).includes('sunset-before-deprecation'), true)
})

test('examples/incomplete exits 2 and says what it could not see', async () => {
  const { code, report } = await example('incomplete')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.coverageGaps, 1)
  assert.deepEqual(raisedRules(report), [
    'coverage-consumers-incomplete',
    'deprecated-operation-in-use',
    'deprecated-operation-usage-unknown',
    'spec-construct-unsupported',
    'sunset-extension-unrecognised',
  ])
  const gap = report.findings.find((finding) => finding.ruleId === 'coverage-consumers-incomplete')
  assert.equal(gap.message.startsWith('2 of 9 known consumer(s) are inventoried'), true)
})

test('the three roots produce three different exit codes, which is what they are for', async () => {
  assert.deepEqual(
    [(await example('clean')).code, (await example('broken')).code, (await example('incomplete')).code],
    [0, 1, 2],
  )
})

test('the package example script runs the clean root at the documented clock', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts.example, `node bin/api-deprecation-scanner.mjs --root examples/clean --now ${CLOCK}`)
})

test('no example carries an address, a token or anything that looks like a secret', async () => {
  for (const name of ['clean', 'broken', 'incomplete']) {
    for (const file of ['openapi.json', 'usage.json']) {
      const text = await readFile(join(projectDirectory, 'examples', name, file), 'utf8')
      assert.equal(text.includes('@'), false, `${name}/${file}`)
      assert.match(text, /^[\x20-\x7e\n]*$/, `${name}/${file} is plain printable ASCII`)
      assert.equal(/(?:secret|token|password|api[_-]?key|bearer)/i.test(text), false, `${name}/${file}`)
      for (const host of text.matchAll(/https?:\/\/([^/"]+)/g)) {
        assert.equal(host[1].endsWith('.test'), true, `${name}/${file} points at ${host[1]}`)
      }
    }
  }
})

test('running an example twice produces byte-identical stdout', async () => {
  const first = await cliRun(['--root', 'examples/broken', '--now', CLOCK, '--json'])
  const second = await cliRun(['--root', 'examples/broken', '--now', CLOCK, '--json'])
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
})

test('the clean example is only clean at a clock before its removal dates', async () => {
  // The examples are read against an injected clock like everything else, so
  // the clean root is not clean forever -- it is clean at the stated instant,
  // and this proves the instant is doing the work.
  const later = await cliRun(['--root', 'examples/clean', '--now', '2027-01-01T00:00:00Z', '--json'])
  const report = JSON.parse(later.stdout)

  assert.equal(later.code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.expired, 3, 'all three removal dates are behind this clock')
  // And the same clock says the inventory is now far too old to speak for the
  // period since, which is exactly why the run is incomplete rather than a
  // verdict: every consumer in it was last seen seven months ago.
  assert.equal(raisedRules(report).includes('coverage-window-stale'), true)
  assert.equal(raisedRules(report).includes('expired-operation-dormant-use'), true)
})
