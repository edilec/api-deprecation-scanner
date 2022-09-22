import assert from 'node:assert/strict'
import test from 'node:test'

import { METHODS, SUPPORTED_OPENAPI, UNRECOGNISED_EXTENSIONS } from '../src/index.mjs'
import {
  apiReport, consumer, current, findingsFor, fixture, inventoryOf, operation, operations,
  raisedRules, specOf,
} from './support.mjs'

/**
 * The bounded OpenAPI subset: what is read, what is refused, and what is
 * declared unsupported rather than silently skipped.
 *
 * The last of those is the point. Not reading a schema is safe because a
 * schema cannot change whether an operation is deprecated. Not following a
 * `$ref` is *not* safe, because the operation behind it might be, so it is
 * reported and the run is incomplete.
 */

const quiet = [consumer({ calls: [] })]

test('every method slot a path item can hold is read', async () => {
  for (const method of METHODS) {
    const report = await apiReport({
      'openapi.json': specOf([{ path: '/v1/invoices', method, operationId: 'listInvoicesV1', deprecated: true, 'x-sunset': '2026-12-01T00:00:00Z', 'x-replacement': 'listInvoices' }, current()]),
      'usage.json': inventoryOf(quiet),
    })

    assert.equal(report.summary.checked, 2, method)
    assert.equal(report.summary.deprecated, 1, method)
    assert.equal(findingsFor(report, 'deprecated-operation-unused')[0].location.pointer, `/paths/~1v1~1invoices/${method}`)
  }
})

test('a key inside a path item that is not a method is ignored, because it cannot be an operation', async () => {
  const report = await apiReport({
    'openapi.json': { openapi: '3.1.0', info: { version: '2.4.0' }, paths: { '/v1/invoices': { get: { operationId: 'listInvoices' }, parameters: [], summary: 'Invoices', servers: [] } } },
    'usage.json': inventoryOf(quiet),
  })

  assert.deepEqual(raisedRules(report), ['no-deprecated-operations'])
  assert.equal(report.summary.checked, 1)
})

test('both supported document versions are read, and a fourth-generation one is not', async () => {
  for (const version of ['3.0.0', '3.0.3', '3.1.0', '3.1.1', '3.0', '3.1']) {
    const report = await apiReport({
      'openapi.json': { ...specOf(operations()), openapi: version },
      'usage.json': inventoryOf(quiet),
    })
    assert.equal(report.summary.checked, 2, version)
  }
  for (const version of ['2.0', '3.2.0', '4.0.0', '3', 'v3.1.0', '']) {
    const report = await apiReport({
      'openapi.json': { ...specOf(operations()), openapi: version },
      'usage.json': inventoryOf(quiet),
    })
    assert.deepEqual(raisedRules(report), ['spec-version-unsupported'], version)
    assert.equal(report.summary.checked, 0, version)
  }
  assert.deepEqual(SUPPORTED_OPENAPI, ['3.0', '3.1'])
})

test('every near-miss deprecation extension is reported rather than ignored', async () => {
  for (const key of UNRECOGNISED_EXTENSIONS) {
    const report = await apiReport(fixture([operation({ [key]: '2026-05-01' }), current()], [consumer()]))

    const found = findingsFor(report, 'sunset-extension-unrecognised')
    assert.equal(found.length, 1, key)
    assert.equal(found[0].location.pointer, `/paths/~1v1~1invoices/get/${key}`)
    assert.equal(report.status, 'incomplete', key)
  }
})

test('an operation carrying an unread extension is never reported as having no removal date', async () => {
  // The dishonest answer this prevents: "this operation announces no removal
  // date" when the date may be sitting in the very key the reader skipped.
  const report = await apiReport(fixture([operation({ 'x-sunset': undefined, 'x-removal-date': '2026-05-01' }), current()], [consumer()]))

  assert.equal(raisedRules(report).includes('sunset-undeclared'), false)
  assert.equal(raisedRules(report).includes('sunset-extension-unrecognised'), true)
})

test('the three supported extensions are read in both of their accepted forms', async () => {
  const report = await apiReport(fixture([
    operation({ 'x-sunset': '2026-12-01', 'x-deprecated-since': '2026-01-15T09:00:00Z', 'x-replacement': { operationId: 'listInvoices', since: '2.2.0', docs: 'https://docs.example.test/a' } }),
    current(),
  ], [consumer()]))

  const link = findingsFor(report, 'deprecated-operation-in-use')[0]
  assert.match(link.message, /is removed at 2026-12-01T00:00:00Z/)
  assert.equal(link.suggestion, 'Move this consumer to "listInvoices" (available since 2.2.0). See https://docs.example.test/a')
  assert.equal(report.status, 'pass')
})

test('a malformed replacement is refused whole rather than half-read', async () => {
  for (const value of [42, [], { operationId: 'listInvoices', extra: 1 }, { since: '2.2.0' }, { operationId: 'listInvoices', docs: 7 }, '']) {
    const report = await apiReport(fixture([operation({ 'x-replacement': value }), current()], [consumer()]))
    assert.equal(findingsFor(report, 'replacement-invalid').length, 1, JSON.stringify(value))
    assert.equal(raisedRules(report).includes('replacement-undeclared'), false, 'it is not also reported as absent')
  }
})

test('a reference is refused at both levels it can appear', async () => {
  const pathItem = await apiReport({
    'openapi.json': { openapi: '3.1.0', info: { version: '2.4.0' }, paths: { '/v1/invoices': { $ref: '#/components/pathItems/x' }, '/v2/invoices': { get: { operationId: 'listInvoices' } } } },
    'usage.json': inventoryOf(quiet),
  })
  assert.equal(findingsFor(pathItem, 'spec-construct-unsupported')[0].location.pointer, '/paths/~1v1~1invoices/$ref')
  assert.equal(pathItem.summary.checked, 1, 'the rest of the document is still read')

  const operationRef = await apiReport({
    'openapi.json': { openapi: '3.1.0', info: { version: '2.4.0' }, paths: { '/v1/invoices': { get: { $ref: '#/components/x' } }, '/v2/invoices': { get: { operationId: 'listInvoices' } } } },
    'usage.json': inventoryOf(quiet),
  })
  assert.equal(findingsFor(operationRef, 'spec-construct-unsupported')[0].location.pointer, '/paths/~1v1~1invoices/get/$ref')
})

test('reusable path items are reported even when paths itself is fine', async () => {
  const report = await apiReport({
    'openapi.json': specOf(operations(), { components: { pathItems: { reports: { get: { operationId: 'x', deprecated: true } } } } }),
    'usage.json': inventoryOf(quiet),
  })

  assert.equal(findingsFor(report, 'spec-construct-unsupported')[0].location.pointer, '/components/pathItems')
  assert.equal(report.status, 'incomplete')
})

test('components without pathItems is not reported, because nothing in it can hide an operation', async () => {
  const report = await apiReport({
    'openapi.json': specOf(operations(), { components: { schemas: { Invoice: { type: 'object' } } } }),
    'usage.json': inventoryOf(quiet),
  })

  assert.equal(raisedRules(report).includes('spec-construct-unsupported'), false)
  assert.equal(report.status, 'pass')
})

test('a path template that is not a path is refused, and the rest of the document is still read', async () => {
  const report = await apiReport({
    'openapi.json': { openapi: '3.1.0', info: { version: '2.4.0' }, paths: { 'v1/invoices': { get: { operationId: 'a' } }, '/v2/invoices': { get: { operationId: 'listInvoices' } } } },
    'usage.json': inventoryOf(quiet),
  })

  assert.equal(findingsFor(report, 'spec-invalid')[0].location.pointer, '/paths/v1~1invoices')
  assert.equal(report.summary.checked, 1)
})

test('a duplicate operationId refuses the second occurrence rather than overwriting the first', async () => {
  const report = await apiReport({
    'openapi.json': specOf([
      operation(),
      operation({ path: '/v1/legacy-invoices', 'x-sunset': '2020-01-01T00:00:00Z' }),
      current(),
    ]),
    'usage.json': inventoryOf([consumer()]),
  })

  assert.equal(findingsFor(report, 'operation-duplicate')[0].location.pointer, '/paths/~1v1~1legacy-invoices/get/operationId')
  assert.equal(report.summary.expired, 0, 'the first occurrence is the one that was kept')
  assert.equal(report.summary.checked, 2)
})

test('a deprecated operation with no announcement at all raises both absences', async () => {
  const report = await apiReport(fixture([operation({ 'x-sunset': undefined, 'x-deprecated-since': undefined, 'x-replacement': undefined })], [consumer()]))

  assert.deepEqual(raisedRules(report), ['deprecated-operation-in-use', 'replacement-undeclared', 'sunset-undeclared'])
  assert.equal(report.status, 'pass', 'neither absence is an error; both are stated')
})

test('a removal date announced without the deprecated flag is reported', async () => {
  const report = await apiReport(fixture([operation({ deprecated: false }), current()], [consumer()]))

  assert.equal(findingsFor(report, 'sunset-without-deprecation').length, 1)
  assert.equal(report.summary.deprecated, 0)
})

test('a document whose info or paths is the wrong shape is refused before anything is read', async () => {
  for (const [document, pointer] of [
    [{ openapi: '3.1.0', paths: {} }, '/info'],
    [{ openapi: '3.1.0', info: [], paths: {} }, '/info'],
    [{ openapi: '3.1.0', info: {}, paths: {} }, '/info/version'],
    [{ openapi: '3.1.0', info: { version: 2.4 }, paths: {} }, '/info/version'],
    [{ openapi: '3.1.0', info: { version: '2.4.0' } }, '/paths'],
    [{ openapi: '3.1.0', info: { version: '2.4.0' }, paths: [] }, '/paths'],
  ]) {
    const report = await apiReport({ 'openapi.json': document, 'usage.json': inventoryOf(quiet) })
    assert.equal(findingsFor(report, 'spec-invalid')[0].location.pointer, pointer, JSON.stringify(document))
  }

  // Written as JSON text holding a string, so the file parses and it is the
  // document's shape that is refused rather than its syntax.
  const notAnObject = await apiReport({ 'openapi.json': '"a document"', 'usage.json': inventoryOf(quiet) })
  assert.equal(findingsFor(notAnObject, 'spec-invalid')[0].message, 'The OpenAPI document must be a JSON object; this file holds a string of 10 character(s).')
})
