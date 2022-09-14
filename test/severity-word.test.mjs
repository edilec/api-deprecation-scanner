import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Severity, for the rules whose exit code cannot show it.
 *
 * Thirty-seven of the error rules also mark the run incomplete, so they exit 2
 * whether their severity says `error` or `warning`. For those the exit code is
 * not the assertion -- the count of errors in the summary and the severity word
 * printed in the human report are.
 *
 * This file deliberately shares nothing with the rest of the suite. It imports
 * no table, reads no catalog, imports no support module, and takes no
 * expectation from a map or a loop variable: every rule id, every pointer,
 * every count and every printed line is written out inline, at the place it is
 * asserted. That is the whole point. A table, a documented catalog and a
 * test's expected map are three declarations, and one edit that changes all
 * three leaves every assertion that compares them satisfied -- including an
 * assertion made inside a loop over that same map. Nothing below can be
 * satisfied by editing a declaration.
 *
 * The builders are inputs, not expectations: they construct the two documents
 * a case feeds in, and carry no severity, no rule id and no count.
 */

const execFileAsync = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), '../bin/api-deprecation-scanner.mjs')
const CLOCK = '2026-06-05T00:00:00Z'

/** Build a root, run the real binary over it with the human report on, tear the root down. */
async function audit(files, extraArgs = [], prepare = null) {
  const root = await mkdtemp(join(tmpdir(), 'api-deprecation-scanner-word-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' || content instanceof Uint8Array
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
      await writeFile(join(root, name), bytes)
    }
    if (prepare !== null) await prepare(root)
    return await spawn(['--root', root, '--now', CLOCK, ...extraArgs])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function spawn(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args])
    return { code: 0, report: JSON.parse(stdout), stderr }
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr ?? '' }
  }
}

// Inputs only. Nothing here decides what a case expects.
const deprecated = (overrides = {}) => ({
  operationId: 'listInvoicesV1',
  deprecated: true,
  'x-deprecated-since': '2026-01-15',
  'x-sunset': '2026-12-01T00:00:00Z',
  'x-replacement': 'listInvoices',
  ...overrides,
})
const supported = (overrides = {}) => ({ operationId: 'listInvoices', ...overrides })
const doc = (paths, extra = {}) => ({
  openapi: '3.1.0',
  info: { title: 'Billing API', version: '2.4.0' },
  paths,
  ...extra,
})
const SPEC = doc({
  '/v1/invoices': { get: deprecated() },
  '/v2/invoices': { get: supported() },
})
const callTo = (overrides = {}) => ({
  operationId: 'listInvoicesV1',
  count: 12,
  lastSeen: '2026-05-30T11:02:00Z',
  ...overrides,
})
const caller = (overrides = {}) => ({
  id: 'billing-portal',
  contact: 'revenue-platform',
  calls: [callTo()],
  ...overrides,
})
const inventory = (consumers, coverage = {}) => ({
  schemaVersion: '1',
  coverage: {
    apiVersion: '2.4.0',
    windowStart: '2026-03-01T00:00:00Z',
    windowEnd: '2026-06-01T00:00:00Z',
    consumersKnown: consumers.length,
    source: 'gateway-access-log',
    ...coverage,
  },
  consumers,
})
const USAGE = inventory([caller()])

/* The inventory ------------------------------------------------------------ */

test('call-duplicate prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory([caller({ calls: [callTo(), callTo({ count: 3 })] })]),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   usage.json/consumers/0/calls/1/operationId call-duplicate'), true)
})

test('call-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory([caller({ calls: [callTo(), callTo({ operationId: 'listInvoices', count: 0 })] })]),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   usage.json/consumers/0/calls/1/count call-invalid'), true)
})

test('consumer-duplicate prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory([caller(), caller({ calls: [callTo({ count: 9 })] })], { consumersKnown: 1 }),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   usage.json/consumers/1/id consumer-duplicate'), true)
})

test('consumer-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory([caller(), { id: 'partner-sync', calls: 'all of them' }], { consumersKnown: 1 }),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   usage.json/consumers/1/calls consumer-invalid'), true)
})

test('consumer-invalid refuses a contact that looks like an address, without echoing it', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory([caller(), { id: 'partner-sync', contact: 'someone@example.test', calls: [] }], { consumersKnown: 1 }),
  })

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(stderr.includes('ERROR   usage.json/consumers/1/contact consumer-invalid'), true)
  assert.equal(stderr.includes('example.test'), false)
  assert.equal(JSON.stringify(report).includes('example.test'), false)
})

test('inventory-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': [],
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   usage.json inventory-invalid'), true)
})

test('inventory-key-unknown prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': { ...USAGE, consumersKnwon: 12 },
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   usage.json/consumersKnwon inventory-key-unknown'), true)
})

test('identifier-invalid prints ERROR and counts as one error', async () => {
  // The control character arrives through an identifier -- a consumer id --
  // and not through an excerpt field. It is refused at the door, and the
  // refusal does not reproduce it.
  const nel = String.fromCharCode(0x85)
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory([caller(), { id: `partner${nel}sync`, calls: [] }], { consumersKnown: 1 }),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   usage.json/consumers/1/id identifier-invalid'), true)
  assert.equal(stderr.includes(nel), false)
})

test('no-consumers-inventoried prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory([]),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   usage.json/consumers no-consumers-inventoried'), true)
})

test('usage-operation-unknown prints ERROR, and the operation it hides is reported as unknown too', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory([caller({ calls: [callTo({ operationId: 'listInvoicesV9' })] })]),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   usage.json/consumers/0/calls/0/operationId usage-operation-unknown'), true)
  assert.equal(stderr.includes('ERROR   openapi.json/paths/~1v1~1invoices/get deprecated-operation-usage-unknown'), true)
})

/* The coverage block ------------------------------------------------------- */

test('coverage-consumers-incomplete prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory([caller()], { consumersKnown: 9 }),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   usage.json/coverage/consumersKnown coverage-consumers-incomplete'), true)
})

test('coverage-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': { schemaVersion: '1', consumers: [caller()] },
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   usage.json/coverage coverage-invalid'), true)
})

test('coverage-version-mismatch prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory([caller()], { apiVersion: '1.9.0' }),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   usage.json/coverage/apiVersion coverage-version-mismatch'), true)
})

test('coverage-window-stale prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory(
      [caller({ calls: [callTo({ lastSeen: '2025-12-01T00:00:00Z' })] })],
      { windowStart: '2025-10-01T00:00:00Z', windowEnd: '2026-01-01T00:00:00Z' },
    ),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   usage.json/coverage/windowEnd coverage-window-stale'), true)
})

test('deprecated-operation-usage-unknown prints ERROR alongside the gap that caused it', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': inventory([caller({ calls: [callTo({ operationId: 'listInvoices' })] })], { consumersKnown: 40 }),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   openapi.json/paths/~1v1~1invoices/get deprecated-operation-usage-unknown'), true)
})

test('expired-operation-usage-unknown prints ERROR alongside the gap that caused it', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': doc({
      '/v1/invoices': { get: deprecated({ 'x-sunset': '2026-05-01T00:00:00Z' }) },
      '/v2/invoices': { get: supported() },
    }),
    'usage.json': inventory([caller({ calls: [callTo({ operationId: 'listInvoices' })] })], { consumersKnown: 40 }),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   openapi.json/paths/~1v1~1invoices/get expired-operation-usage-unknown'), true)
})

/* The document ------------------------------------------------------------- */

test('deprecated-flag-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': doc({ '/v1/invoices': { get: deprecated({ deprecated: 'yes' }) }, '/v2/invoices': { get: supported() } }),
    'usage.json': USAGE,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   openapi.json/paths/~1v1~1invoices/get/deprecated deprecated-flag-invalid'), true)
})

test('operation-duplicate prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': doc({
      '/v1/invoices': { get: deprecated() },
      '/v1/legacy-invoices': { get: deprecated() },
      '/v2/invoices': { get: supported() },
    }),
    'usage.json': USAGE,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   openapi.json/paths/~1v1~1legacy-invoices/get/operationId operation-duplicate'), true)
})

test('operation-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': doc({
      '/v1/invoices': { get: deprecated() },
      '/v1/reports': { get: { summary: 'no operationId here' } },
      '/v2/invoices': { get: supported() },
    }),
    'usage.json': USAGE,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   openapi.json/paths/~1v1~1reports/get/operationId operation-invalid'), true)
})

test('no-operations prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': doc({}),
    'usage.json': inventory([caller({ calls: [] })]),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   openapi.json/paths no-operations'), true)
})

test('spec-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': { openapi: '3.1.0', info: { title: 'Billing API', version: '2.4.0' } },
    'usage.json': USAGE,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   openapi.json/paths spec-invalid'), true)
})

test('spec-version-unsupported prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': { ...SPEC, openapi: '4.0.0' },
    'usage.json': USAGE,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   openapi.json/openapi spec-version-unsupported'), true)
})

test('spec-version-unsupported also refuses a Swagger 2.0 document', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': { swagger: '2.0', info: { title: 'Billing API', version: '2.4.0' }, paths: {} },
    'usage.json': USAGE,
  })

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(stderr.includes('ERROR   openapi.json/swagger spec-version-unsupported'), true)
})

test('spec-construct-unsupported prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': doc(
      { '/v1/invoices': { get: deprecated() }, '/v2/invoices': { get: supported() } },
      { webhooks: { invoicePaid: { post: { operationId: 'invoicePaidWebhook', deprecated: true } } } },
    ),
    'usage.json': USAGE,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   openapi.json/webhooks spec-construct-unsupported'), true)
})

test('spec-construct-unsupported refuses a referenced path item', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': doc({
      '/v1/invoices': { get: deprecated() },
      '/v1/reports': { $ref: '#/components/pathItems/reports' },
      '/v2/invoices': { get: supported() },
    }),
    'usage.json': USAGE,
  })

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(stderr.includes('ERROR   openapi.json/paths/~1v1~1reports/$ref spec-construct-unsupported'), true)
})

test('spec-construct-unsupported refuses a deprecated flag on a path item', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': doc({
      '/v1/invoices': { deprecated: true, get: deprecated() },
      '/v2/invoices': { get: supported() },
    }),
    'usage.json': USAGE,
  })

  assert.equal(code, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(stderr.includes('ERROR   openapi.json/paths/~1v1~1invoices/deprecated spec-construct-unsupported'), true)
})

test('sunset-extension-unrecognised prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': doc({
      '/v1/invoices': { get: deprecated({ 'x-sunset-date': '2026-05-01' }) },
      '/v2/invoices': { get: supported() },
    }),
    'usage.json': USAGE,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   openapi.json/paths/~1v1~1invoices/get/x-sunset-date sunset-extension-unrecognised'), true)
})

test('sunset-invalid prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': doc({
      '/v1/invoices': { get: deprecated({ 'x-sunset': '2026-02-31' }) },
      '/v2/invoices': { get: supported() },
    }),
    'usage.json': USAGE,
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   openapi.json/paths/~1v1~1invoices/get/x-sunset sunset-invalid'), true)
})

/* The inputs --------------------------------------------------------------- */

test('input-not-json prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': '{ "schemaVersion": "1", ',
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   usage.json input-not-json'), true)
})

test('input-not-utf8 prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({
    'openapi.json': SPEC,
    'usage.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
  })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   usage.json input-not-utf8'), true)
})

test('input-too-deep prints ERROR and counts as one error', async () => {
  let nested = 1
  for (let depth = 0; depth < 60; depth += 1) nested = [nested]
  const { code, report, stderr } = await audit({ 'openapi.json': SPEC, 'usage.json': nested })

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   usage.json input-too-deep'), true)
})

test('input-too-large prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit(
    { 'openapi.json': SPEC, 'usage.json': inventory([caller()], { source: 'x'.repeat(20000) }) },
    ['--max-file-bytes', '5000'],
  )

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   usage.json input-too-large'), true)
})

test('input-unreadable prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit({ 'openapi.json': SPEC }, ['--inventory', 'missing.json'])

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   missing.json input-unreadable'), true)
})

test('inputs-same-file prints ERROR and counts as one error', async () => {
  // A hard link, not a symbolic one: it has no target, so the two names
  // resolve to two different real paths and only the inode says they are one
  // file.
  const { code, report, stderr } = await audit(
    { 'openapi.json': SPEC },
    [],
    (root) => link(join(root, 'openapi.json'), join(root, 'usage.json')),
  )

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   usage.json inputs-same-file'), true)
})

test('path-escapes-root prints ERROR and counts as one error', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'api-deprecation-scanner-outside-'))
  try {
    await writeFile(join(outside, 'elsewhere.json'), `${JSON.stringify(USAGE)}\n`)
    const { code, report, stderr } = await audit(
      { 'openapi.json': SPEC },
      [],
      (root) => symlink(join(outside, 'elsewhere.json'), join(root, 'usage.json')),
    )

    assert.equal(code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 1)
    assert.equal(report.summary.warnings, 0)
    assert.equal(stderr.includes('ERROR   usage.json path-escapes-root'), true)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

/* The limits --------------------------------------------------------------- */

test('time-limit-exceeded prints ERROR and counts as one error', async () => {
  const many = []
  for (let index = 0; index < 300; index += 1) {
    many.push({ id: `consumer-${index}`, calls: [callTo(), callTo({ operationId: 'listInvoices' })] })
  }
  const { code, report, stderr } = await audit(
    { 'openapi.json': SPEC, 'usage.json': inventory(many) },
    ['--max-milliseconds', '1'],
  )

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(stderr.includes('ERROR   usage.json time-limit-exceeded'), true)
})

test('too-many-calls prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit(
    {
      'openapi.json': SPEC,
      'usage.json': inventory([caller({ calls: [callTo(), callTo({ operationId: 'listInvoices' })] })]),
    },
    ['--max-calls', '1'],
  )

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   usage.json/consumers/0/calls/1 too-many-calls'), true)
})

test('too-many-calls-for-consumer prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit(
    {
      'openapi.json': SPEC,
      'usage.json': inventory([caller({ calls: [callTo(), callTo({ operationId: 'listInvoices' })] })]),
    },
    ['--max-calls-per-consumer', '1'],
  )

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   usage.json/consumers/0/calls/1 too-many-calls-for-consumer'), true)
})

test('too-many-consumers prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit(
    {
      'openapi.json': SPEC,
      'usage.json': inventory([caller(), { id: 'partner-sync', calls: [callTo({ operationId: 'listInvoices' })] }], { consumersKnown: 1 }),
    },
    ['--max-consumers', '1'],
  )

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(stderr.includes('ERROR   usage.json/consumers/1 too-many-consumers'), true)
})

test('too-many-findings prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit(
    { 'openapi.json': doc({ '/v1/invoices': { get: deprecated({ 'x-replacement': undefined }) } }), 'usage.json': USAGE },
    ['--max-findings', '1'],
  )

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.findings.length, 1)
  assert.equal(stderr.includes('ERROR   openapi.json too-many-findings'), true)
})

test('too-many-operations prints ERROR and counts as one error', async () => {
  const { code, report, stderr } = await audit(
    {
      'openapi.json': doc({
        '/v1/invoices': { get: deprecated({ 'x-replacement': undefined }) },
        '/v2/invoices': { get: supported() },
      }),
      'usage.json': USAGE,
    },
    ['--max-operations', '1'],
  )

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 2)
  assert.equal(stderr.includes('ERROR   openapi.json/paths/~1v2~1invoices/get too-many-operations'), true)
})
