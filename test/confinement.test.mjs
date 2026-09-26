import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isInside, scanDeprecations } from '../src/index.mjs'
import {
  FORBIDDEN, NOW, cliRun, consumer, findingsFor, fixture, inventoryOf, operations, raisedRules,
  specOf, withRoot,
} from './support.mjs'

/**
 * Path confinement and path identity.
 *
 * Rejecting `..` and absolute paths is not confinement: a symbolic link
 * planted inside the root points anywhere and contains no `..` at all. And
 * comparing real paths is not identity: a hard link has no target, so two
 * names for one inode are two different real paths and a real-path comparison
 * says they are different files.
 *
 * Both directions matter. A tool that refuses a legitimate file because its
 * root was reached through a symbolic link -- a `/var` that is really
 * `/private/var` is enough -- has a defect too, so that case is pinned here as
 * well.
 */

const SPEC = specOf(operations())
const USAGE = inventoryOf([consumer()])

async function outsideRoot(body) {
  const outside = await mkdtemp(join(tmpdir(), 'api-deprecation-scanner-outside-'))
  try {
    return await body(outside)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
}

test('a symbolic link out of the root is refused unread', async () => {
  await outsideRoot(async (outside) => {
    await writeFile(join(outside, 'elsewhere.json'), `${JSON.stringify(USAGE)}\n`)
    const report = await withRoot({ 'openapi.json': SPEC }, async (root) => {
      await symlink(join(outside, 'elsewhere.json'), join(root, 'usage.json'))
      return scanDeprecations({ root, now: NOW })
    })

    assert.deepEqual(raisedRules(report), ['path-escapes-root'])
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.consumers, 0, 'nothing out of the tree was read')
  })
})

test('a symbolic link out of the root is refused for the document too', async () => {
  await outsideRoot(async (outside) => {
    await writeFile(join(outside, 'elsewhere.json'), `${JSON.stringify(SPEC)}\n`)
    const report = await withRoot({ 'usage.json': USAGE }, async (root) => {
      await symlink(join(outside, 'elsewhere.json'), join(root, 'openapi.json'))
      return scanDeprecations({ root, now: NOW })
    })

    assert.equal(findingsFor(report, 'path-escapes-root')[0].location.file, 'openapi.json')
    assert.equal(report.summary.checked, 0)
  })
})

test('a symbolic link to a parent directory outside the root is refused, even for a file that is not there', async () => {
  await outsideRoot(async (outside) => {
    const report = await withRoot({ 'openapi.json': SPEC }, async (root) => {
      await mkdir(join(root, 'nested'))
      await symlink(outside, join(root, 'nested', 'escape'))
      return scanDeprecations({ root, now: NOW, inventory: 'nested/escape/usage.json' })
    })

    assert.deepEqual(raisedRules(report), ['path-escapes-root'])
  })
})

test('a symbolic-link loop behind an escape is refused as an escape, not as a read error', async () => {
  // `resolveInput` carves ELOOP out beside ENOENT, and the carve-out is the
  // whole reason the parent is looked at: both codes mean the target itself
  // could not be resolved, and neither says anything about *where* the target
  // is. Without the carve-out a loop planted behind a link out of the tree
  // would be reported as a file that happened not to read, hiding the escape.
  await outsideRoot(async (outside) => {
    await symlink('loop', join(outside, 'loop'))
    const report = await withRoot({ 'openapi.json': SPEC }, async (root) => {
      await symlink(outside, join(root, 'escape'))
      return scanDeprecations({ root, now: NOW, inventory: 'escape/loop' })
    })

    assert.deepEqual(raisedRules(report), ['path-escapes-root'])
    assert.equal(report.status, 'incomplete')
  })
})

test('a symbolic-link loop that stays inside the root is an unreadable input, and names the error', async () => {
  const report = await withRoot({ 'openapi.json': SPEC }, async (root) => {
    await mkdir(join(root, 'nested'))
    await symlink('loop', join(root, 'nested', 'loop'))
    return scanDeprecations({ root, now: NOW, inventory: 'nested/loop' })
  })

  assert.deepEqual(raisedRules(report), ['input-unreadable'])
  assert.match(findingsFor(report, 'input-unreadable')[0].message, /could not be resolved inside --root: ELOOP\./)
})

test('a symbolic link inside the root is followed, because it does not leave the tree', async () => {
  const report = await withRoot({ 'openapi.json': SPEC, 'real-usage.json': USAGE }, async (root) => {
    await symlink(join(root, 'real-usage.json'), join(root, 'usage.json'))
    return scanDeprecations({ root, now: NOW })
  })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.consumers, 1)
})

test('a root reached through a symbolic link is not falsely refused', async () => {
  // The failure this guards against: comparing a real root against an
  // unresolved target refuses every legitimate file whenever the root itself
  // is a link. A false refusal is a defect exactly as a missed escape is.
  await outsideRoot(async (outside) => {
    const report = await withRoot({ 'openapi.json': SPEC, 'usage.json': USAGE }, async (root) => {
      const linkedRoot = join(outside, 'linked-root')
      await symlink(root, linkedRoot)
      return scanDeprecations({ root: linkedRoot, now: NOW })
    })

    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 2)
  })
})

test('a dangling symbolic link is unreadable, not an escape', async () => {
  const report = await withRoot({ 'openapi.json': SPEC }, async (root) => {
    await symlink(join(root, 'nowhere.json'), join(root, 'usage.json'))
    return scanDeprecations({ root, now: NOW })
  })

  assert.deepEqual(raisedRules(report), ['input-unreadable'])
})

test('two names for one inode are refused, which a real-path comparison would not catch', async () => {
  const report = await withRoot({ 'openapi.json': SPEC }, async (root) => {
    await link(join(root, 'openapi.json'), join(root, 'usage.json'))
    return scanDeprecations({ root, now: NOW })
  })

  assert.deepEqual(raisedRules(report), ['inputs-same-file'])
  const finding = findingsFor(report, 'inputs-same-file')[0]
  assert.match(finding.message, /two names for one file \(device \d+, inode \d+\)/)
  assert.equal(report.status, 'incomplete')
})

test('naming one file twice is refused on the same ground', async () => {
  const report = await withRoot({ 'openapi.json': SPEC }, (root) =>
    scanDeprecations({ root, now: NOW, inventory: 'openapi.json' }))

  assert.deepEqual(raisedRules(report), ['inputs-same-file'])
})

test('two genuinely different files are not refused', async () => {
  // The control: the inode check must refuse two names for one file and
  // nothing else.
  const report = await withRoot({ 'openapi.json': SPEC, 'usage.json': USAGE }, (root) =>
    scanDeprecations({ root, now: NOW }))

  assert.equal(report.status, 'pass')
})

test('a name that steps out of the root with .. is a configuration error with an empty stdout', async () => {
  await withRoot({ 'openapi.json': SPEC, 'usage.json': USAGE }, async (root) => {
    const result = await cliRun(['--root', root, '--now', NOW, '--inventory', '../usage.json'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /must not step outside --root/)
  })
})

test('an absolute input path is a configuration error with an empty stdout', async () => {
  await withRoot({ 'openapi.json': SPEC, 'usage.json': USAGE }, async (root) => {
    const result = await cliRun(['--root', root, '--now', NOW, '--spec', join(root, 'openapi.json')])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /must be relative to --root/)
  })
})

test('a control character in an input name is a configuration error', async () => {
  for (const [label, character] of Object.entries(FORBIDDEN)) {
    await assert.rejects(
      () => scanDeprecations({ root: '.', now: NOW, spec: `open${character}api.json` }),
      /must not contain a control, separator or bidi character/,
      label,
    )
  }
})

test('a root that is not a directory, or is not there at all, is a configuration error', async () => {
  await withRoot({ 'openapi.json': SPEC }, async (root) => {
    await assert.rejects(() => scanDeprecations({ root: join(root, 'openapi.json'), now: NOW }), /--root must be a directory/)
    await assert.rejects(() => scanDeprecations({ root: join(root, 'nowhere'), now: NOW }), /--root could not be resolved/)
  })
})

test('isInside compares real paths, and a sibling directory with a shared prefix is outside', () => {
  assert.equal(isInside('/a/root', '/a/root'), true)
  assert.equal(isInside('/a/root', '/a/root/child.json'), true)
  assert.equal(isInside('/a/root', '/a/rootless/child.json'), false)
  assert.equal(isInside('/a/root/', '/a/root/child.json'), true)
  assert.equal(isInside('/a/root', '/a'), false)
})

test('nothing under the root is written, renamed or removed by a run', async () => {
  const files = fixture(operations(), [consumer()])
  await withRoot(files, async (root) => {
    const { readdir, readFile } = await import('node:fs/promises')
    const before = new Map()
    for (const name of (await readdir(root)).sort()) before.set(name, await readFile(join(root, name)))

    await scanDeprecations({ root, now: NOW })

    const after = new Map()
    for (const name of (await readdir(root)).sort()) after.set(name, await readFile(join(root, name)))
    assert.deepEqual([...after.keys()], [...before.keys()], 'no file was added or removed')
    for (const [name, bytes] of before) assert.equal(Buffer.compare(bytes, after.get(name)), 0, `${name} is byte-identical`)
  })
})
