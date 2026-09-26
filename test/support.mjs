/**
 * Fixtures and runners shared by the test suite.
 *
 * Two entry points are exercised throughout: `apiReport` calls the exported
 * function, and `cliRun` spawns the real binary and reads the real exit code.
 * Several guarantees in this package can only be pinned by the second -- an
 * exit code cannot be satisfied by editing a table.
 *
 * Everything here builds *inputs*. Nothing here carries a severity, a rule id
 * or an expected count, so no test can be satisfied by editing this file.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { scanDeprecations } from '../src/index.mjs'

const execFileAsync = promisify(execFile)

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(projectDirectory, 'bin/api-deprecation-scanner.mjs')

/** The injected clock every fixture is read against unless a test says otherwise. */
export const NOW = '2026-06-05T00:00:00Z'

/** A deprecated operation with a removal date well in the future and a replacement that exists. */
export const operation = (overrides = {}) => ({
  path: '/v1/invoices',
  method: 'get',
  operationId: 'listInvoicesV1',
  deprecated: true,
  'x-deprecated-since': '2026-01-15',
  'x-sunset': '2026-12-01T00:00:00Z',
  'x-replacement': 'listInvoices',
  ...overrides,
})

/** The operation a replacement points at. Not deprecated, so it never raises a rule of its own. */
export const current = (overrides = {}) => ({
  path: '/v2/invoices',
  method: 'get',
  operationId: 'listInvoices',
  ...overrides,
})

/** The default pair: one deprecated operation and the operation that replaces it. */
export const operations = (overrides = {}) => [operation(overrides), current()]

/** Turn a flat list of operation descriptors into an OpenAPI paths object. */
export function pathsFrom(list) {
  const paths = {}
  for (const entry of list) {
    const { path, method, ...rest } = entry
    const compiled = {}
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) compiled[key] = value
    }
    if (paths[path] === undefined) paths[path] = {}
    paths[path][method] = compiled
  }
  return paths
}

export const specOf = (list, extra = {}) => ({
  openapi: '3.1.0',
  info: { title: 'Billing API', version: '2.4.0' },
  paths: pathsFrom(list),
  ...extra,
})

/** One observed call, inside the default coverage window and recent enough to be active. */
export const call = (overrides = {}) => ({
  operationId: 'listInvoicesV1',
  count: 12,
  lastSeen: '2026-05-30T11:02:00Z',
  ...overrides,
})

export const consumer = (overrides = {}) => ({
  id: 'billing-portal',
  contact: 'revenue-platform',
  calls: [call()],
  ...overrides,
})

export const coverageOf = (overrides = {}) => ({
  apiVersion: '2.4.0',
  windowStart: '2026-03-01T00:00:00Z',
  windowEnd: '2026-06-01T00:00:00Z',
  source: 'gateway-access-log',
  ...overrides,
})

/**
 * An inventory whose declared coverage is complete by default: it knows about
 * exactly the consumers it lists. A test that wants a gap says so.
 */
export const inventoryOf = (list, coverageOverrides = {}) => ({
  schemaVersion: '1',
  coverage: coverageOf({ consumersKnown: list.length, ...coverageOverrides }),
  consumers: list,
})

/** The two files a run reads, under their default names. */
export const fixture = (list = operations(), consumers = [consumer()], coverageOverrides = {}) => ({
  'openapi.json': specOf(list),
  'usage.json': inventoryOf(consumers, coverageOverrides),
})

/**
 * Create a temporary root, write the named files into it, run `body(root)`,
 * and remove the tree afterwards whatever happened.
 *
 * A string is written verbatim and a `Uint8Array` byte for byte, so a test can
 * plant text that is not JSON, or bytes that are not UTF-8 at all.
 */
export async function withRoot(files, body) {
  const root = await mkdtemp(join(tmpdir(), 'api-deprecation-scanner-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Run the exported API over a temporary root. */
export async function apiReport(files, options = {}) {
  return withRoot(files, (root) => scanDeprecations({ root, now: NOW, ...options }))
}

/** Spawn the real binary. Returns the exit code and both streams, never throws on a non-zero exit. */
export async function cliRun(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** Spawn the real binary over a temporary root, and parse whatever stdout carried. */
export async function cliReport(files, extraArgs = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--now', NOW, '--json', ...extraArgs])
    return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

/** Spawn the real binary with the human summary left on, and return both streams. */
export async function cliHuman(files, extraArgs = []) {
  return withRoot(files, async (root) => {
    const result = await cliRun(['--root', root, '--now', NOW, ...extraArgs])
    return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

/** Every rule id a report raised, deduplicated and ordered by code unit. */
export const raisedRules = (report) =>
  [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

/** The findings for one rule id, in emitted order. */
export const findingsFor = (report, ruleId) => report.findings.filter((finding) => finding.ruleId === ruleId)

/**
 * One character from each class the report contract names, built from code
 * points so every test file that uses them stays plain ASCII and readable.
 */
export const FORBIDDEN = Object.freeze({
  'C0 NUL': String.fromCharCode(0x00),
  'C0 LF': String.fromCharCode(0x0a),
  'C0 ESC': String.fromCharCode(0x1b),
  DEL: String.fromCharCode(0x7f),
  'C1 NEL': String.fromCharCode(0x85),
  'C1 CSI': String.fromCharCode(0x9b),
  'line separator': String.fromCharCode(0x2028),
  'paragraph separator': String.fromCharCode(0x2029),
  'bidi LRM': String.fromCharCode(0x200e),
  'bidi RLO': String.fromCharCode(0x202e),
  'bidi isolate': String.fromCharCode(0x2066),
})
