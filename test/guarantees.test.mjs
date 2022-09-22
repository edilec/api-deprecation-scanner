import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { apiReport, consumer, fixture, operations, projectDirectory } from './support.mjs'

/**
 * The boundaries this package claims, checked against its own source.
 *
 * A source scan is *not* how ordering is pinned -- substituting `Intl.Collator`
 * for `localeCompare` collates identically and spells differently, so a scan
 * would pass while the output started depending on the host's ICU data.
 * `test/ordering.test.mjs` pins that by the order the tool emits.
 *
 * A scan is the right instrument for a *boundary*, though: "this package never
 * opens a socket" and "this package never reads a system clock" are claims
 * about which APIs appear in it at all, and an API that is absent cannot be
 * reached by any input. Both spellings of the locale comparators are included
 * below anyway, as a cheap second line behind the behavioural pin.
 */

/**
 * Every source file, with its comments removed.
 *
 * The comments are stripped because this file scans for API *names*, and the
 * comments in this package name the very APIs it refuses in order to explain
 * why they are refused. Scanning prose would make the explanation itself the
 * violation.
 */
async function sourceFiles() {
  const files = []
  for (const directory of ['src', 'bin']) {
    for (const name of (await readdir(join(projectDirectory, directory))).sort()) {
      const text = await readFile(join(projectDirectory, directory, name), 'utf8')
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n')
      files.push([`${directory}/${name}`, code, text])
    }
  }
  assert.equal(files.length >= 6, true, 'the source was actually read')
  return files
}

const FORBIDDEN_APIS = [
  ['Date.now', /Date\.now/],
  ['the zero-argument Date constructor', /new Date\b/],
  ['Math.random', /Math\.random/],
  ['crypto randomness', /randomUUID|getRandomValues|randomBytes/],
  ['localeCompare', /localeCompare/],
  ['Intl', /\bIntl\./],
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest or WebSocket', /XMLHttpRequest|WebSocket/],
  ['eval', /\beval\s*\(/],
  ['the Function constructor', /new Function\b/],
  ['the environment', /process\.env/],
  ['a writing filesystem call', /\b(writeFile|appendFile|mkdir|rmdir|unlink|rename|truncate|chmod|chown|utimes|copyFile|createWriteStream)\s*\(/],
  ['rm', /\brm\s*\(/],
]

test('no clock, no random source, no locale comparator, no environment, no write', async () => {
  for (const [name, code] of await sourceFiles()) {
    for (const [label, pattern] of FORBIDDEN_APIS) {
      assert.equal(pattern.test(code), false, `${name} reaches for ${label}`)
    }
  }
})

test('the only time source is a monotonic counter, used for one budget', async () => {
  // `process.hrtime.bigint` is allowed and is the single exception. It is
  // never printed, never compared with a date, and the only thing it can do to
  // a report is turn a completed run into an incomplete one.
  const files = await sourceFiles()
  const uses = files.filter(([, code]) => code.includes('process.hrtime'))
  assert.deepEqual(uses.map(([name]) => name), ['src/index.mjs'])
  assert.equal((uses[0][1].match(/process\.hrtime\.bigint\(\)/g) ?? []).length, 2, 'a start and a comparison, nothing else')
  assert.equal(uses[0][1].includes('Date.UTC'), false, 'the calendar conversion lives in text.mjs')
})

test('nothing outside these modules is imported, so no socket can be opened', async () => {
  const allowed = new Set(['node:fs/promises', 'node:path', 'node:process'])
  for (const [name, code] of await sourceFiles()) {
    for (const match of code.matchAll(/^import[^'"]*from '([^']+)'/gm)) {
      const specifier = match[1]
      if (specifier.startsWith('.')) continue
      assert.equal(allowed.has(specifier), true, `${name} imports ${specifier}`)
    }
    assert.equal(/\bimport\s*\(/.test(code), false, `${name} imports dynamically`)
    assert.equal(/require\s*\(/.test(code), false, `${name} uses require`)
  }
})

test('the package declares no dependency of any kind', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.optionalDependencies, undefined)
  assert.equal(manifest.engines.node, '>=22')
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.author, 'Edilec Private Limited')
})

test('every source file is listed in the lint script, so none of them goes unchecked', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  const lint = manifest.scripts.lint
  for (const directory of ['src', 'bin', 'test']) {
    for (const name of await readdir(join(projectDirectory, directory))) {
      assert.equal(lint.includes(`node --check ${directory}/${name}`), true, `${directory}/${name} is not linted`)
    }
  }
  const checked = (lint.match(/node --check /g) ?? []).length
  const present = (await Promise.all(['src', 'bin', 'test'].map((d) => readdir(join(projectDirectory, d)))))
    .reduce((total, names) => total + names.length, 0)
  assert.equal(checked, present, 'the lint script lists every file and nothing else')
})

test('the changelog ends the way this catalog requires', async () => {
  const changelog = await readFile(join(projectDirectory, 'CHANGELOG.md'), 'utf8')
  assert.equal(changelog.trimEnd().endsWith('No release has been published.'), true)
})

test('the README says what the tool cannot conclude', async () => {
  const readme = await readFile(join(projectDirectory, 'README.md'), 'utf8')
  assert.equal(readme.includes('## Limits and non-goals'), true)
  assert.equal(readme.includes('unknown'), true)
})

test('running twice over one root leaves the same verdict and the same report', async () => {
  const files = fixture(operations(), [consumer()])
  const first = await apiReport(files)
  const second = await apiReport(files)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})
