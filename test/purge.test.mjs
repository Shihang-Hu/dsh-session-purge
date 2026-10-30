/**
 * Unit tests for the dsh-session-purge host half.
 *
 * Everything runs against a throwaway DSH home under `<workspace>/.tmp` and a
 * fake Cordis context, so no real session, cache or registry is ever touched.
 *
 * Run: node --test test/purge.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { __internals as core } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..', '..')
const HOME = join(workspace, '.tmp', 'purge-test-home')

const PARENT = 'session-11111111-1111-1111-1111-111111111111'
const CHILD_A = 'session-22222222-2222-2222-2222-222222222222'
const CHILD_B = 'session-33333333-3333-3333-3333-333333333333'
const GRANDCHILD = 'session-44444444-4444-4444-4444-444444444444'
const LONE = 'session-55555555-5555-5555-5555-555555555555'

const PROJECT = '--C-fake-project--'

/** Build a throwaway DSH home. */
async function buildHome({ sessions, workspaceState, projcache = true }) {
  await rm(HOME, { recursive: true, force: true })
  for (const session of sessions) {
    if (session.dirs !== false) {
      const dir = join(HOME, 'sessions', PROJECT, session.id)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.from('x'.repeat(session.bytes ?? 2048)))
    }
    if (projcache && session.projcache !== false) {
      const dir = join(HOME, 'storages', 'session_projcache', 'sessions')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${session.id}.json`), JSON.stringify({ version: 7, record: {} }))
    }
  }
  await mkdir(join(HOME, 'storages'), { recursive: true })
  await writeFile(join(HOME, 'storages', 'workspace.json'), `${JSON.stringify(workspaceState, null, 2)}\n`)
}

/** A fake Cordis context over a plain service map. */
function makeCtx(services = {}) {
  const emitted = []
  return {
    emitted,
    get: (name) => services[name],
    emit: (name, payload) => { emitted.push([name, payload]) },
    inject: () => {},
    effect: () => {},
  }
}

/** Fake sessions + persistence services exposing a header graph. */
function makeGraph(headers) {
  const sessions = {
    list: () => headers.filter((h) => h.live === true).map((h) => ({ header: h })),
  }
  const sessionPersistence = { list: async () => headers.map((h) => ({ header: h })) }
  return { sessions, sessionPersistence }
}

/** Fake storageDomain service with observable tables. */
function makeStorageDomain({ projRows = [], workspaces = {}, archived = [], pinned = [], workspaceIds = [] }) {
  const projTable = new Map(projRows.map((id) => [id, { rows: { title: { val: `T:${id}` } } }]))
  const wsTable = new Map(Object.entries(workspaces).map(([id, record]) => [id, { ...record }]))
  const putCalls = []
  const wsDeleteCalls = []
  const globalSets = []
  let globalState = { archivedSessionIds: [...archived], pinnedSessionIds: [...pinned], workspaceIds: [...workspaceIds] }
  return {
    putCalls,
    wsDeleteCalls,
    globalSets,
    projTable,
    wsTable,
    globalState: () => globalState,
    setGlobal: (value) => { globalState = value },
    get(name) {
      if (name === 'session_projcache') {
        return {
          table: () => ({
            get: (key) => projTable.get(key),
            delete: async (key) => { projTable.delete(key) },
            entries: () => projTable.entries(),
          }),
        }
      }
      if (name === 'workspace') {
        return {
          table: () => ({
            get: (key) => wsTable.get(key),
            delete: async (key) => { wsDeleteCalls.push(key); wsTable.delete(key) },
            entries: () => wsTable.entries(),
            put: async (key, value) => { putCalls.push([key, value]); wsTable.set(key, value) },
          }),
          global: {
            get: () => globalState,
            set: async (value) => { globalSets.push(value); globalState = value },
          },
        }
      }
      return undefined
    },
  }
}

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const sessionDir = (id) => join(HOME, 'sessions', PROJECT, id)
const projFile = (id) => join(HOME, 'storages', 'session_projcache', 'sessions', `${id}.json`)

after(async () => {
  await rm(HOME, { recursive: true, force: true })
})

test('idVariants covers both spellings', () => {
  assert.deepEqual(core.idVariants(PARENT), [PARENT, PARENT.slice('session-'.length)])
  assert.deepEqual(core.idVariants('11111111-1111-1111-1111-111111111111'), ['11111111-1111-1111-1111-111111111111', PARENT])
  assert.equal(core.SESSION_ID_RE.test(PARENT), true)
  assert.equal(core.SESSION_ID_RE.test('not-a-session'), false)
  assert.equal(core.SESSION_ID_RE.test('session-../../etc'), false)
})

test('cascadeOrder walks the subagent tree breadth-first', async () => {
  const graph = makeGraph([
    { id: PARENT, origin: 'human', cwd: 'C:\\w' },
    { id: CHILD_A, origin: 'subagent', parentSession: PARENT },
    { id: CHILD_B, origin: 'subagent', parentSession: PARENT },
    { id: GRANDCHILD, origin: 'subagent', parentSession: CHILD_A },
    { id: LONE, origin: 'human' },
  ])
  const { order, truncated } = await core.cascadeOrder(makeCtx(graph), PARENT)
  assert.deepEqual(order, [PARENT, CHILD_A, CHILD_B, GRANDCHILD])
  assert.equal(truncated, false)
})

test('cascadeOrder reports an exact truncation beyond the depth ceiling', async () => {
  // MAX_CASCADE_DEPTH = 8: a 12-chain visits the root plus 8 levels, and the
  // chain below the frontier (s9..s11) stays unvisited.
  const deep = []
  for (let i = 0; i < 12; i++) deep.push({ id: `s${i}`, ...(i > 0 ? { parentSession: `s${i - 1}` } : {}) })
  const truncatedWalk = await core.cascadeOrder(makeCtx(makeGraph(deep)), 's0')
  assert.equal(truncatedWalk.order.length, 9)
  assert.equal(truncatedWalk.order[truncatedWalk.order.length - 1], 's8')
  assert.equal(truncatedWalk.order.includes('s9'), false)
  assert.equal(truncatedWalk.truncated, true)

  // A non-empty frontier alone proves nothing: a chain of exactly the ceiling
  // depth has a frontier (s8) whose children simply do not exist.
  const shallow = []
  for (let i = 0; i < 9; i++) shallow.push({ id: `t${i}`, ...(i > 0 ? { parentSession: `t${i - 1}` } : {}) })
  const fullWalk = await core.cascadeOrder(makeCtx(makeGraph(shallow)), 't0')
  assert.equal(fullWalk.order.length, 9)
  assert.equal(fullWalk.truncated, false)
})

test('purgeTree surfaces a truncated cascade in the report', async () => {
  await buildHome({ sessions: [], workspaceState: { global: {}, tables: { workspaces: {} } } })
  const chain = [{ id: PARENT, origin: 'human' }]
  for (let i = 1; i < 11; i++) chain.push({ id: `c${i}`, origin: 'subagent', parentSession: i === 1 ? PARENT : `c${i - 1}` })
  const ctx = makeCtx(makeGraph(chain))
  const report = await core.purgeTree(ctx, HOME, PARENT)
  assert.equal(report.cascadeTruncated, true)
  assert.equal(report.deleted.length, 9)
  assert.equal(report.deleted.includes('c9'), false)
})

test('purgeTree removes logs, projection files, registry refs and notifies (file fallback)', async () => {
  await buildHome({
    sessions: [{ id: PARENT }, { id: CHILD_A }, { id: CHILD_B, dirs: false }],
    workspaceState: {
      global: { archivedSessionIds: [CHILD_B, LONE] },
      tables: { workspaces: { ws1: { sessionIds: [PARENT, CHILD_A, CHILD_B, LONE] } } },
    },
  })
  const ctx = makeCtx({
    ...makeGraph([
      { id: PARENT, origin: 'human' },
      { id: CHILD_A, origin: 'subagent', parentSession: PARENT },
      { id: CHILD_B, origin: 'subagent', parentSession: PARENT },
    ]),
    // no storageDomain → the file-level fallback is exercised
  })

  const report = await core.purgeTree(ctx, HOME, PARENT)

  assert.deepEqual(report.deleted.sort(), [PARENT, CHILD_A, CHILD_B].sort())
  assert.equal(await exists(sessionDir(PARENT)), false)
  assert.equal(await exists(sessionDir(CHILD_A)), false)
  assert.equal(await exists(projFile(PARENT)), false)
  assert.equal(await exists(projFile(CHILD_A)), false)
  assert.equal(await exists(projFile(CHILD_B)), false)
  assert.ok(report.freedBytes >= 4096, `freedBytes=${report.freedBytes}`)
  assert.equal(report.projRows, 3)

  const registry = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  assert.deepEqual(registry.tables.workspaces.ws1.sessionIds, [LONE])
  assert.deepEqual(registry.global.archivedSessionIds, [LONE])

  const removed = ctx.emitted.filter(([name]) => name === 'api-session/removed').map(([, id]) => id)
  assert.deepEqual(removed.sort(), [PARENT, CHILD_A, CHILD_B].sort())
})

test('purgeTree prefers the storage-domain service when present', async () => {
  await buildHome({
    sessions: [{ id: LONE }],
    workspaceState: { global: { archivedSessionIds: [LONE] }, tables: { workspaces: { ws1: { sessionIds: [LONE] } } } },
    projcache: false,
  })
  const storageDomain = makeStorageDomain({
    projRows: [LONE],
    workspaces: { ws1: { sessionIds: [LONE, 'other'] } },
    archived: [LONE],
  })
  const ctx = makeCtx({
    ...makeGraph([{ id: LONE, origin: 'human' }]),
    storageDomain,
  })

  const report = await core.purgeTree(ctx, HOME, LONE)

  assert.equal(report.projRows, 1)
  // domain pass drops workspace row + archived entry; the always-on
  // file-level belt-and-braces re-scrubs the same refs from the registry file
  assert.equal(report.wsRefs, 4)
  assert.equal(storageDomain.projTable.size, 0)
  assert.deepEqual(storageDomain.wsTable.get('ws1').sessionIds, ['other'])
  assert.deepEqual(storageDomain.globalState().archivedSessionIds, [])
  assert.equal(storageDomain.putCalls.length, 1)
  assert.equal(await exists(sessionDir(LONE)), false)
})

test('pinnedSessionIds are cleaned in both accounting paths', async () => {
  await buildHome({
    sessions: [{ id: LONE }],
    workspaceState: {
      global: { archivedSessionIds: [], pinnedSessionIds: [LONE, PARENT] },
      tables: { workspaces: { ws1: { sessionIds: [LONE] } } },
    },
  })
  const ctx = makeCtx({ ...makeGraph([{ id: LONE, origin: 'human' }]) })
  await core.purgeTree(ctx, HOME, LONE)
  const registry = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  assert.deepEqual(registry.global.pinnedSessionIds, [PARENT])
  assert.deepEqual(registry.tables.workspaces.ws1.sessionIds, [])
})

test('archive and pin refs are rolled through the workspace registry', async () => {
  await buildHome({
    sessions: [{ id: LONE }],
    workspaceState: {
      global: { archivedSessionIds: [LONE], pinnedSessionIds: [LONE] },
      tables: { workspaces: { ws1: { sessionIds: [LONE] } } },
    },
  })
  const storageDomain = makeStorageDomain({
    workspaces: { ws1: { sessionIds: [LONE] } },
    archived: [LONE],
    pinned: [LONE],
  })
  const calls = []
  const workspaceRegistry = {
    unarchiveSession: async (id) => {
      calls.push(['unarchive', id])
      const state = storageDomain.globalState()
      storageDomain.setGlobal({ ...state, archivedSessionIds: state.archivedSessionIds.filter((entry) => entry !== id) })
    },
    unpinSession: async (id) => {
      calls.push(['unpin', id])
      const state = storageDomain.globalState()
      storageDomain.setGlobal({ ...state, pinnedSessionIds: state.pinnedSessionIds.filter((entry) => entry !== id) })
    },
  }
  const ctx = makeCtx({ ...makeGraph([{ id: LONE, origin: 'human' }]), storageDomain, workspaceRegistry })

  await core.purgeTree(ctx, HOME, LONE)

  assert.deepEqual(calls, [['unarchive', LONE], ['unpin', LONE]])
  assert.deepEqual(storageDomain.globalState().archivedSessionIds, [])
  assert.deepEqual(storageDomain.globalState().pinnedSessionIds, [])
  assert.deepEqual(storageDomain.globalSets, [], 'the direct fallback must not write when the registry handled both lists')
})

test('a resident (previously opened) session is flushed and deleted, not refused', async () => {
  await buildHome({
    sessions: [{ id: LONE }],
    workspaceState: { global: { archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } },
  })
  const flushed = []
  const store = new Map([[LONE, { header: { id: LONE } }]])
  const ctx = makeCtx({
    ...makeGraph([{ id: LONE, origin: 'human' }]),
    sessions: {
      list: () => [],
      store,
      get: (id) => (id === LONE ? { header: { id: LONE } } : undefined),
      flush: async (session) => { flushed.push(session?.header?.id ?? LONE) },
    },
  })
  const report = await core.purgeTree(ctx, HOME, LONE)
  assert.deepEqual(report.deleted, [LONE])
  assert.deepEqual(flushed, [LONE])
  // no agent owns the resident object -> it is evicted from the live store
  assert.equal(report.live[0]?.evicted, true)
  assert.equal(store.size, 0)
  assert.equal(await exists(sessionDir(LONE)), false)
  assert.equal(await exists(projFile(LONE)), false)
})

test('accounting leftovers after cleanup are surfaced, not swallowed', async () => {
  await buildHome({
    sessions: [{ id: LONE }],
    workspaceState: { global: { archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } },
  })
  // make the projcache entry impossible to delete: a non-empty directory in
  // place of the file — stripStorageFiles swallows the rm error, and the
  // post-condition check must turn that into an explicit failure
  await rm(projFile(LONE), { force: true })
  await mkdir(join(projFile(LONE), 'stuck'), { recursive: true })
  await writeFile(join(projFile(LONE), 'stuck', 'keep.txt'), 'x')
  const ctx = makeCtx({ ...makeGraph([{ id: LONE, origin: 'human' }]) })
  await assert.rejects(() => core.purgeTree(ctx, HOME, LONE), /记账未清干净[\s\S]*投影缓存/)
  // the log itself is already gone — a retry only needs the accounting pass
  assert.equal(await exists(sessionDir(LONE)), false)
})

test('a cascade sweeps the temp tree exactly once for the whole tree', async () => {
  await buildHome({
    sessions: [{ id: PARENT }],
    workspaceState: { global: { archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } },
  })
  const tmp = join(HOME, 'tmp-cascade-tree')
  await mkdir(join(tmp, 'dsh-subprocess-P'), { recursive: true })
  await writeFile(join(tmp, 'dsh-subprocess-P', 'out.txt'), `parent ${PARENT} output`)
  await mkdir(join(tmp, 'dsh-spill-C'), { recursive: true })
  await writeFile(join(tmp, 'dsh-spill-C', 'out.txt'), `child ${CHILD_A} output`)
  await mkdir(join(tmp, 'dsh-spill-GC'), { recursive: true })
  await writeFile(join(tmp, 'dsh-spill-GC', 'out.txt'), `grandchild ${GRANDCHILD} output`)

  const previous = process.env.TEMP
  process.env.TEMP = tmp // tmpdir() reads TEMP on Windows, TMPDIR elsewhere
  process.env.TMPDIR = tmp
  try {
    const ctx = makeCtx({
      ...makeGraph([
        { id: PARENT, origin: 'human' },
        { id: CHILD_A, origin: 'subagent', parentSession: PARENT },
        { id: GRANDCHILD, origin: 'subagent', parentSession: CHILD_A },
      ]),
    })
    const report = await core.purgeTree(ctx, HOME, PARENT)

    // three sessions, one sweep covering all of them: every attributed
    // directory is reported under the session whose id it mentioned
    assert.deepEqual(report.tempSweep.map((item) => item.sessionId), [PARENT, CHILD_A, GRANDCHILD])
    for (const item of report.tempSweep) {
      assert.equal(item.dirs, 1)
      assert.equal(item.files, 1)
    }
    // the deduplicated totals see three unique directories, same as the sum
    // here — they diverge only when one directory mentions several sessions
    assert.deepEqual(report.tempSweepTotal, { dirs: 3, files: 3 })
    assert.equal(await exists(join(tmp, 'dsh-subprocess-P')), false)
    assert.equal(await exists(join(tmp, 'dsh-spill-C')), false)
    assert.equal(await exists(join(tmp, 'dsh-spill-GC')), false)
  } finally {
    process.env.TEMP = previous
    if (previous === undefined) delete process.env.TEMP
    await rm(tmp, { recursive: true, force: true })
  }
})

test('sameOriginReq: loopback authority + cross-site refusal + Origin agreement', () => {
  const req = (headers) => ({ headers })
  // The Desktop client's forwarder strips Origin and Sec-Fetch-Site: accepted.
  assert.equal(core.sameOriginReq(req({ host: '127.0.0.1:19387' })), true)
  assert.equal(core.sameOriginReq(req({ host: 'localhost:19387' })), true)
  assert.equal(core.sameOriginReq(req({ host: '[::1]:19387' })), true)
  // A browser's same-origin request carries both and must agree.
  assert.equal(core.sameOriginReq(req({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(core.sameOriginReq(req({ host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(core.sameOriginReq(req({ host: '127.0.0.1:19387', 'sec-fetch-site': 'none' })), true)
  // Cross-site markers and mismatching Origins are refused.
  assert.equal(core.sameOriginReq(req({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(core.sameOriginReq(req({ host: '127.0.0.1:19387', origin: 'https://evil.example' })), false)
  assert.equal(core.sameOriginReq(req({ host: '127.0.0.1:19387', origin: 'not a url' })), false)
  // Only loopback authorities are trusted.
  assert.equal(core.sameOriginReq(req({ host: 'evil.example' })), false)
  assert.equal(core.sameOriginReq(req({ host: 'evil.example', origin: 'http://evil.example' })), false)
  assert.equal(core.sameOriginReq(req({})), false)
})

test('sweepTempOutputs removes only dsh-* dirs whose content mentions the session', async () => {
  const tmp = join(HOME, 'tmp')
  await mkdir(join(tmp, 'dsh-subprocess-AAA'), { recursive: true })
  await writeFile(join(tmp, 'dsh-subprocess-AAA', 'out.txt'), `logs of ${LONE} run`)
  await mkdir(join(tmp, 'dsh-subprocess-AAA', 'nested'), { recursive: true })
  await writeFile(join(tmp, 'dsh-subprocess-AAA', 'nested', 'deep.txt'), 'more')
  await mkdir(join(tmp, 'dsh-spill-BBB'), { recursive: true })
  await writeFile(join(tmp, 'dsh-spill-BBB', 'out.txt'), 'unrelated output')
  await mkdir(join(tmp, 'dsh-unrelated-CCC'), { recursive: true })
  await writeFile(join(tmp, 'dsh-unrelated-CCC', 'out.txt'), `mentions ${LONE} but wrong prefix`)

  // The file count comes out of the matching walk itself. That is structural
  // now (0.5.6 removed the second traversal and the `countFile` probe seam
  // that existed only to prove it), so the assertion is on the counts: two
  // files in the swept directory, nothing read twice can inflate them.
  const result = await core.sweepTempOutputs(LONE, { tmpRoot: tmp })
  const found = result.sessions.get(LONE)

  assert.equal(found.dirs, 1)
  assert.equal(found.files, 2)
  assert.equal(found.scannedFiles, 2)
  assert.equal(found.budgetHit, false)
  assert.equal(result.budgetHit, false)
  assert.equal(await exists(join(tmp, 'dsh-subprocess-AAA')), false)
  assert.equal(await exists(join(tmp, 'dsh-spill-BBB')), true)
  assert.equal(await exists(join(tmp, 'dsh-unrelated-CCC')), true)
  await rm(tmp, { recursive: true, force: true })
})

test('one sweep covers every id of a cascade, attributing each directory', async () => {
  const tmp = join(HOME, 'tmp-cascade')
  await mkdir(join(tmp, 'dsh-subprocess-P'), { recursive: true })
  await writeFile(join(tmp, 'dsh-subprocess-P', 'out.txt'), `parent ${PARENT} output`)
  await mkdir(join(tmp, 'dsh-subprocess-C'), { recursive: true })
  await writeFile(join(tmp, 'dsh-subprocess-C', 'out.txt'), `child ${CHILD_A} output`)
  // One run can name the parent and the subagent it spawned: both are entitled
  // to the directory, and it is still removed once.
  await mkdir(join(tmp, 'dsh-subprocess-PC'), { recursive: true })
  await writeFile(join(tmp, 'dsh-subprocess-PC', 'out.txt'), `${PARENT} then ${CHILD_A}`)

  const result = await core.sweepTempOutputs([PARENT, CHILD_A], { tmpRoot: tmp })

  assert.equal(result.sessions.get(PARENT).dirs, 2)
  assert.equal(result.sessions.get(CHILD_A).dirs, 2)
  assert.equal(result.sessions.get(PARENT).files, 2)
  assert.equal(result.sessions.get(CHILD_A).files, 2)
  // The shared directory is attributed twice but removed once: the totals are
  // deduplicated, the per-session sums (4) deliberately exceed them.
  assert.deepEqual(result.dirsTotal, 3)
  assert.deepEqual(result.filesTotal, 3)
  assert.equal(await exists(join(tmp, 'dsh-subprocess-PC')), false)
  assert.equal(await exists(join(tmp, 'dsh-subprocess-P')), false)
  assert.equal(await exists(join(tmp, 'dsh-subprocess-C')), false)
  await rm(tmp, { recursive: true, force: true })
})

test('redactSession masks secrets and prefixes with the frame layout preserved', async (t) => {
  const zlib = await import('node:zlib')
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
    t.skip('runtime has no zstd support')
    return
  }
  const secret = 's3cret-value-EXAMPLE'
  const lines = [
    JSON.stringify({ n: 1, t: 'safe abcd1234 bare tail' }),
    JSON.stringify({ n: 2, t: `key ${secret} end` }),
    JSON.stringify({ n: 3, t: 'pref abcd1234XyZ9 end' }),
  ]
  const dir = sessionDir(LONE)
  await mkdir(dir, { recursive: true })
  const logFile = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(logFile, Buffer.concat(lines.map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')))))
  await writeFile(join(dir, 'other.zstd'), Buffer.concat([zlib.zstdCompressSync(Buffer.from('{"n":9,"t":"nothing"}\n'))]))

  const ctx = makeCtx({ ...makeGraph([{ id: LONE, origin: 'human' }]) })
  const report = await core.redactSession(ctx, HOME, LONE, { secrets: [secret], prefixes: ['abcd1234'] })

  assert.equal(report.changedFiles, 1)
  assert.equal(report.totalReplacements, 2) // one secret span + one prefix span
  const changed = report.files.find((f) => f.changed)
  assert.equal(changed.frames, 3)

  const read = await readFile(logFile)
  const starts = core.zstdFrameStarts(read, zlib.zstdDecompressSync)
  const text = Buffer.concat(starts.map((at, i) => zlib.zstdDecompressSync(read.subarray(at, i + 1 < starts.length ? starts[i + 1] : read.length)))).toString('utf8')
  assert.equal(starts.length, 3)
  assert.equal(text.includes(secret), false)
  assert.equal(text.includes('abcd1234XyZ9'), false)
  assert.equal(text.includes('abcd1234[REDACTED]'), true)
  assert.equal(text.includes('[REDACTED:s3cr…len20]'), true)
  assert.equal(text.includes('"safe abcd1234 bare tail"'), true) // bare prefix untouched
  for (const line of text.split('\n')) if (line.trim()) assert.doesNotThrow(() => JSON.parse(line))
  assert.equal(await exists(`${logFile}.dsh-session-purge.bak`), false) // backup must not survive
  const untouched = report.files.find((f) => !f.changed)
  assert.equal(untouched.changed, false)
  await rm(dir, { recursive: true, force: true })
})

test('redactSession refuses running sessions and bad input; residents are allowed', async () => {
  await buildHome({
    sessions: [{ id: LONE }],
    workspaceState: { global: { archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } },
  })
  const headers = [{ id: LONE, origin: 'human' }]
  const running = makeCtx({ ...makeGraph(headers), agents: { get: () => ({ status: 'running' }) } })
  await assert.rejects(() => core.redactSession(running, HOME, LONE, { secrets: ['whatever-value'] }), /正在运行/)
  // a resident (previously opened) session is no longer refused — only live
  // work can append during the rewrite, and `agents` covers exactly that
  const idle = makeCtx({ ...makeGraph(headers) })
  await assert.rejects(() => core.redactSession(idle, HOME, LONE, { secrets: ['short'] }), /长度/)
  await assert.rejects(() => core.redactSession(idle, HOME, LONE, {}), /至少提供一项/)
  await assert.rejects(() => core.redactSession(idle, HOME, LONE, { prefixes: ['ab'] }), /前缀/)
  // a session with no log is a 404, not a runtime-feature 501: the existence
  // check runs before the zstd feature detection
  await assert.rejects(() => core.redactSession(idle, HOME, CHILD_B, { secrets: ['whatever-value'] }), /未找到/)
})

test('a redaction whose backup cannot be removed keeps the redacted log', async (t) => {
  const zlib = await import('node:zlib')
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
    t.skip('runtime has no zstd support')
    return
  }
  const secret = 's3cret-value-EXAMPLE'
  const dir = sessionDir(LONE)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const logFile = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(logFile, zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ n: 1, t: `key ${secret} end` })}\n`, 'utf8')))
  const backup = `${logFile}.dsh-session-purge.bak`

  // This host removes an open file, so the failure cannot be staged with a
  // handle: fail the cleanup through the file-level seam instead. Every other
  // operation goes to the real filesystem.
  const fsp = await import('node:fs/promises')
  const saw = []
  const io = {
    readFile: (path) => fsp.readFile(path),
    writeFile: (path, data) => { saw.push(['write', path]); return fsp.writeFile(path, data) },
    rename: (from, to) => fsp.rename(from, to),
    rm: async (path, options) => {
      saw.push(['rm', path])
      throw Object.assign(new Error(`EPERM: staged cleanup failure: ${path}`), { code: 'EPERM' })
    },
  }

  try {
    const entry = await core.redactLogFile(logFile, { secrets: [secret], prefixes: [] }, zlib, io)
    assert.equal(entry.changed, true)
    assert.equal(entry.backupResidual, backup)
    assert.match(entry.backupError, /staged cleanup failure/)
    assert.deepEqual(saw, [['write', backup], ['write', logFile], ['rm', backup]])

    const read = await readFile(logFile)
    const starts = core.zstdFrameStarts(read, zlib.zstdDecompressSync)
    const text = Buffer.concat(starts.map((at, i) => zlib.zstdDecompressSync(read.subarray(at, i + 1 < starts.length ? starts[i + 1] : read.length)))).toString('utf8')
    assert.equal(text.includes(secret), false, 'the redaction must survive a failed backup cleanup')
    assert.equal(text.includes('[REDACTED:s3cr…len20]'), true)
    assert.equal(await exists(backup), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed write still rolls back from the backup', async (t) => {
  const zlib = await import('node:zlib')
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
    t.skip('runtime has no zstd support')
    return
  }
  const secret = 's3cret-value-EXAMPLE'
  const dir = sessionDir(LONE)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const logFile = join(dir, 'session.v4.jsonl.zstd')
  const original = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ n: 1, t: `key ${secret} end` })}\n`, 'utf8'))
  await writeFile(logFile, original)
  const backup = `${logFile}.dsh-session-purge.bak`

  const fsp = await import('node:fs/promises')
  let writeCount = 0
  const io = {
    readFile: (path) => fsp.readFile(path),
    writeFile: async (path, data) => {
      writeCount++
      if (writeCount === 2) throw Object.assign(new Error('ENOSPC: staged write failure'), { code: 'ENOSPC' })
      return fsp.writeFile(path, data)
    },
    rename: (from, to) => fsp.rename(from, to),
    rm: (path, options) => fsp.rm(path, options),
  }

  try {
    await assert.rejects(
      () => core.redactLogFile(logFile, { secrets: [secret], prefixes: [] }, zlib, io),
      /已回滚原文件[\s\S]*ENOSPC/,
    )
    assert.deepEqual(await readFile(logFile), original, 'a failed write must leave the original log in place')
    assert.equal(await exists(backup), false, 'the rollback consumes the backup')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('redactSession reads each log file at most once', async (t) => {
  const zlib = await import('node:zlib')
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
    t.skip('runtime has no zstd support')
    return
  }
  const secret = 's3cret-value-EXAMPLE'
  const dir = sessionDir(LONE)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const lines = [
    JSON.stringify({ n: 1, t: `key ${secret} end` }),
    JSON.stringify({ n: 2, t: 'nothing here' }),
    JSON.stringify({ n: 3, t: 'still nothing' }),
    JSON.stringify({ n: 4, t: `prefix abcd1234XyZ9 tail` }),
  ]
  const logFile = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(logFile, Buffer.concat(lines.map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')))))

  const entry = await core.redactLogFile(logFile, { secrets: [secret], prefixes: ['abcd1234'] }, zlib)
  assert.equal(entry.frames, 4)
  // both spans live in different frames; a whole-file pre-scan would have seen
  // them together, so a count of two proves the per-frame rewrite only ran once
  assert.equal(entry.replacements['[REDACTED:s3cr…len20]'], 1)
  assert.equal(entry.replacements['abcd1234[REDACTED]'], 1)
  assert.equal(entry.changed, true)
  await rm(dir, { recursive: true, force: true })
})

test('one failing log file does not abort the others, and corrupt files are noted', async (t) => {
  const zlib = await import('node:zlib')
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
    t.skip('runtime has no zstd support')
    return
  }
  const dir = sessionDir(LONE)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  // A secret whose mask has no newline but whose match spans one: replacing
  // 'abcd\nefgh' merges two lines, the structure guard refuses — a
  // deterministic per-file failure that must not sink the other files.
  const breaking = 'abcd\nefgh'
  const good = 'good-secret-123'
  const healthy = join(dir, 'healthy.zstd')
  await writeFile(healthy, zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ n: 1, t: `token ${good} end` })}\n`, 'utf8')))
  const breaker = join(dir, 'breaker.zstd')
  await writeFile(breaker, zlib.zstdCompressSync(Buffer.from(`key ${breaking} tail\n`, 'utf8')))
  const corrupt = join(dir, 'corrupt.zstd')
  await writeFile(corrupt, Buffer.from('this is not zstd'))

  const ctx = makeCtx({ ...makeGraph([{ id: LONE, origin: 'human' }]) })
  const report = await core.redactSession(ctx, HOME, LONE, { secrets: [good, breaking] })

  assert.equal(report.failures, 1)
  assert.equal(report.changedFiles, 1)
  assert.equal(report.totalReplacements, 1)
  const failed = report.files.find((f) => f.error !== undefined)
  assert.equal(failed.file, breaker)
  assert.match(failed.error, /破坏日志结构/)
  const done = report.files.find((f) => f.changed)
  assert.equal(done.file, healthy)
  const noted = report.files.find((f) => f.note !== undefined)
  assert.equal(noted.file, corrupt)
  assert.match(noted.note, /未检测到 zstd 帧/)
  assert.equal(noted.changed, false)
  // the healthy file really was redacted despite the failure elsewhere
  const read = await readFile(healthy)
  assert.equal(read.includes(Buffer.from(good)), false)
  await rm(dir, { recursive: true, force: true })
})

test('a running session is refused and nothing is touched', async () => {
  await buildHome({
    sessions: [{ id: LONE }],
    workspaceState: { global: { archivedSessionIds: [] }, tables: { workspaces: { ws1: { sessionIds: [LONE] } } } },
  })
  const ctx = makeCtx({
    ...makeGraph([{ id: LONE, origin: 'human' }]),
    agents: { get: (id) => (id === LONE ? { status: 'running' } : undefined) },
  })

  await assert.rejects(() => core.purgeTree(ctx, HOME, LONE), /正在运行/)
  assert.equal(await exists(sessionDir(LONE)), true)
  assert.equal(await exists(projFile(LONE)), true)
})

test('an invalid session id is rejected before any filesystem work', async () => {
  await buildHome({
    sessions: [],
    workspaceState: { global: { archivedSessionIds: [] }, tables: { workspaces: {} } },
  })
  const ctx = makeCtx({})
  await assert.rejects(() => core.purgeTree(ctx, HOME, 'session-../../evil'), /不合法/)
  await assert.rejects(() => core.purgeTree(ctx, HOME, 'x'), /不合法/)
})

test('a symbolic link in place of a session directory is refused', async (t) => {
  await buildHome({
    sessions: [{ id: LONE, dirs: false }],
    workspaceState: { global: { archivedSessionIds: [] }, tables: { workspaces: {} } },
  })
  const target = join(HOME, 'sessions', PROJECT, 'real-target')
  await mkdir(target, { recursive: true })
  try {
    await symlink(target, sessionDir(LONE), 'junction')
  } catch (error) {
    t.skip(`cannot create a link on this host: ${error.code ?? error.message}`)
    return
  }
  const ctx = makeCtx({ ...makeGraph([{ id: LONE, origin: 'human' }]) })
  await assert.rejects(() => core.purgeTree(ctx, HOME, LONE), /symbolic link|符号链接/)
})

test('listSessions reports size, existence and archive flags', async () => {
  await buildHome({
    sessions: [{ id: PARENT, bytes: 4096 }, { id: CHILD_A, dirs: false }],
    workspaceState: { global: { archivedSessionIds: [CHILD_A] }, tables: { workspaces: { ws1: { sessionIds: [PARENT, CHILD_A] } } } },
  })
  const storageDomain = makeStorageDomain({
    projRows: [PARENT, CHILD_A],
    workspaces: { ws1: { sessionIds: [PARENT, CHILD_A], title: '测试工作区' } },
    archived: [CHILD_A],
  })
  const ctx = makeCtx({
    ...makeGraph([
      { id: PARENT, origin: 'human', cwd: 'C:\\w', createdAt: 2 },
      { id: CHILD_A, origin: 'subagent', parentSession: PARENT, createdAt: 1 },
    ]),
    storageDomain,
  })

  const rows = await core.listSessions(ctx, HOME)
  const bySessionId = new Map(rows.map((row) => [row.id, row]))
  assert.equal(bySessionId.get(PARENT).exists, true)
  assert.ok(bySessionId.get(PARENT).sizeBytes >= 4096)
  assert.equal(bySessionId.get(PARENT).title, `T:${PARENT}`)
  assert.equal(bySessionId.get(PARENT).workspace, '测试工作区')
  assert.equal(bySessionId.get(PARENT).workspaceId, 'ws1')
  assert.equal(bySessionId.get(PARENT).archived, false)
  assert.equal(bySessionId.get(CHILD_A).exists, false)
  assert.equal(bySessionId.get(CHILD_A).archived, true)
  assert.equal(bySessionId.get(CHILD_A).parentSession, PARENT)
})

test('purgeWorkspace deletes every member session and the workspace record', async () => {
  await buildHome({
    sessions: [{ id: PARENT }, { id: CHILD_A }, { id: LONE, dirs: false }],
    // ws1 lists LONE too: a member with no on-disk log (仅缓存记账) is still
    // a member and its accounting must go with the workspace
    // the file mirrors the domain state in the real harness, so its order
    // list and its table are seeded consistently (ws2 in both)
    workspaceState: { global: { workspaceIds: ['ws1', 'ws2'] }, tables: { workspaces: { ws1: { title: '测试工作区', sessionIds: [PARENT, CHILD_A, LONE] }, ws2: { title: '别的工作区', sessionIds: [] } } } },
  })
  const storageDomain = makeStorageDomain({
    projRows: [PARENT, CHILD_A, LONE],
    workspaces: { ws1: { title: '测试工作区', sessionIds: [PARENT, CHILD_A, LONE] }, ws2: { title: '别的工作区', sessionIds: [] } },
    workspaceIds: ['ws1', 'ws2'],
  })
  const graph = makeGraph([{ id: PARENT, origin: 'human' }, { id: CHILD_A, origin: 'subagent', parentSession: PARENT }])
  let graphReads = 0
  const ctx = makeCtx({
    ...graph,
    // One session-graph read for the whole workspace (0.5.7): every member
    // tree used to re-list every header, i.e. N members → N full listings.
    sessionPersistence: { list: async () => { graphReads++; return graph.sessionPersistence.list() } },
    storageDomain,
  })

  const report = await core.purgeWorkspace(ctx, HOME, 'ws1')

  assert.equal(graphReads, 1, 'the session graph must be read once per workspace delete')

  assert.deepEqual(report.deleted.sort(), [PARENT, CHILD_A, LONE].sort())
  assert.deepEqual(report.failures, [])
  assert.equal(report.workspaceTitle, '测试工作区')
  assert.equal(report.workspaceRecordDeleted, true)
  assert.equal(storageDomain.wsTable.has('ws1'), false, 'the workspace record must be gone from the domain')
  assert.equal(storageDomain.wsTable.has('ws2'), true, 'other workspaces must survive')
  assert.deepEqual(storageDomain.wsDeleteCalls, ['ws1'])
  // the order list must lose the deleted id in BOTH layers — a leftover entry
  // fails the harness registry's startup validation (2026-10-15 incident)
  assert.deepEqual(storageDomain.globalState().workspaceIds, ['ws2'])
  assert.ok(
    storageDomain.globalSets.some((state) => state.pendingMutation?.operation === 'delete' && state.pendingMutation.workspaceId === 'ws1'),
    'the fallback must persist the harness pending-mutation marker before deleting the record',
  )
  assert.equal(storageDomain.globalState().pendingMutation, undefined, 'the marker must be cleared once the record is gone')
  assert.equal(storageDomain.projTable.size, 0)
  assert.equal(await exists(sessionDir(PARENT)), false)
  assert.equal(await exists(sessionDir(CHILD_A)), false)
  assert.equal(await exists(projFile(PARENT)), false)
  assert.equal(await exists(projFile(LONE)), false)
  const registry = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  assert.equal(registry.tables.workspaces.ws1, undefined, 'the record must be scrubbed from the file too')
  assert.deepEqual(registry.global.workspaceIds, ['ws2'])
  // the harness's own startup invariant holds after the delete: every id in
  // the order list resolves to a table record, in both layers
  for (const id of registry.global.workspaceIds) {
    assert.notEqual(registry.tables.workspaces[id], undefined)
    assert.notEqual(storageDomain.wsTable.get(id), undefined)
  }
})

test('purgeWorkspace prefers the transactional workspace registry', async () => {
  await buildHome({
    sessions: [],
    workspaceState: {
      global: { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: ['ws1', 'ws2'] },
      tables: { workspaces: { ws1: { title: '事务工作区', sessionIds: [] }, ws2: { title: '保留', sessionIds: [] } } },
    },
  })
  const storageDomain = makeStorageDomain({
    workspaces: { ws1: { title: '事务工作区', sessionIds: [] }, ws2: { title: '保留', sessionIds: [] } },
    workspaceIds: ['ws1', 'ws2'],
  })
  const registryCalls = []
  const workspaceRegistry = {
    delete: async (id) => {
      registryCalls.push(id)
      if (!storageDomain.wsTable.has(id)) return false
      storageDomain.wsTable.delete(id)
      const state = storageDomain.globalState()
      storageDomain.setGlobal({ ...state, workspaceIds: state.workspaceIds.filter((workspaceId) => workspaceId !== id) })
      return true
    },
  }
  const ctx = makeCtx({ ...makeGraph([]), storageDomain, workspaceRegistry })

  const report = await core.purgeWorkspace(ctx, HOME, 'ws1')

  assert.deepEqual(registryCalls, ['ws1'], 'the registry delete must be the live-domain path')
  assert.deepEqual(storageDomain.wsDeleteCalls, [], 'the two-write fallback must not run when the registry handled it')
  assert.deepEqual(storageDomain.globalSets, [], 'the fallback must not write the order list itself')
  assert.equal(report.workspaceRecordDeleted, true)
  const registry = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  assert.equal(registry.tables.workspaces.ws1, undefined)
  assert.deepEqual(registry.global.workspaceIds, ['ws2'])
})

test('a failing workspace registry delete does not fall back to direct writes', async () => {
  await buildHome({
    sessions: [],
    workspaceState: { global: { workspaceIds: ['ws1'] }, tables: { workspaces: { ws1: { title: '保留', sessionIds: [] } } } },
  })
  const storageDomain = makeStorageDomain({
    workspaces: { ws1: { title: '保留', sessionIds: [] } },
    workspaceIds: ['ws1'],
  })
  const workspaceRegistry = { delete: async () => { throw new Error('registry busy') } }
  const ctx = makeCtx({ ...makeGraph([]), storageDomain, workspaceRegistry })

  await assert.rejects(() => core.purgeWorkspace(ctx, HOME, 'ws1'), /registry busy/)

  assert.deepEqual(storageDomain.wsDeleteCalls, [], 'the fallback must not race a failed registry delete')
  assert.deepEqual(storageDomain.globalSets, [], 'the fallback must not touch the order list')
  const registry = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  assert.notEqual(registry.tables.workspaces.ws1, undefined)
  assert.deepEqual(registry.global.workspaceIds, ['ws1'])
})

test('purgeWorkspace refuses up front while a member session is running', async () => {
  await buildHome({
    sessions: [{ id: PARENT }, { id: CHILD_A }],
    workspaceState: { global: {}, tables: { workspaces: { ws1: { sessionIds: [PARENT, CHILD_A] } } } },
  })
  const ctx = makeCtx({
    ...makeGraph([{ id: PARENT, origin: 'human' }, { id: CHILD_A, origin: 'subagent', parentSession: PARENT }]),
    agents: { get: (id) => (id === CHILD_A ? { status: 'running' } : undefined) },
  })

  await assert.rejects(
    () => core.purgeWorkspace(ctx, HOME, 'ws1'),
    (error) => error.status === 409 && /正在运行/.test(error.message) && error.message.includes(CHILD_A),
  )
  // nothing touched
  assert.equal(await exists(sessionDir(PARENT)), true)
  assert.equal(await exists(sessionDir(CHILD_A)), true)
  assert.equal(await exists(projFile(CHILD_A)), true)
  const registry = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  assert.deepEqual(registry.tables.workspaces.ws1.sessionIds, [PARENT, CHILD_A])
})

test('purgeWorkspace keeps the workspace when a member purge fails', async () => {
  await buildHome({
    sessions: [{ id: PARENT }, { id: LONE }],
    workspaceState: { global: { workspaceIds: ['ws1'] }, tables: { workspaces: { ws1: { sessionIds: [PARENT, LONE] } } } },
  })
  // make LONE's projcache entry impossible to delete — its purge fails at the
  // accounting post-condition while PARENT purges cleanly
  await rm(projFile(LONE), { force: true })
  await mkdir(join(projFile(LONE), 'stuck'), { recursive: true })
  await writeFile(join(projFile(LONE), 'stuck', 'keep.txt'), 'x')
  const ctx = makeCtx({
    ...makeGraph([{ id: PARENT, origin: 'human' }, { id: LONE, origin: 'human' }]),
  })

  const report = await core.purgeWorkspace(ctx, HOME, 'ws1')

  assert.equal(report.failures.length, 1)
  assert.equal(report.failures[0].sessionId, LONE)
  assert.match(report.failures[0].error, /记账未清干净/)
  assert.deepEqual(report.deleted, [PARENT])
  assert.equal(report.workspaceRecordDeleted, false, 'a partial failure must keep the workspace for retry')
  const registry = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  // The per-session flow scrubs a member's refs BEFORE its accounting
  // post-condition fails, so the failed id is no longer listed in the kept
  // record — what "kept" guarantees is the workspace itself surviving (and
  // the failure report names the id for a per-row retry).
  assert.notEqual(registry.tables.workspaces.ws1, undefined)
  assert.equal(registry.tables.workspaces.ws1.sessionIds.includes(PARENT), false)
  // no record deletion was attempted, so the order list is untouched too
  assert.deepEqual(registry.global.workspaceIds, ['ws1'])
})

test('purgeWorkspace deletes an empty workspace through the file fallback', async () => {
  await buildHome({
    sessions: [],
    workspaceState: { global: { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: ['ws1'] }, tables: { workspaces: { ws1: { title: '空工作区', sessionIds: [] } } } },
  })
  const ctx = makeCtx({ ...makeGraph([]) })

  const report = await core.purgeWorkspace(ctx, HOME, 'ws1')

  assert.deepEqual(report.deleted, [])
  assert.deepEqual(report.failures, [])
  assert.equal(report.workspaceRecordDeleted, true)
  const registry = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  assert.equal(registry.tables.workspaces.ws1, undefined)
  assert.deepEqual(registry.global.workspaceIds, [], 'the order list must not keep a dangling id')
})

test('a failed fallback record delete rolls the order entry back', async () => {
  await buildHome({
    sessions: [],
    workspaceState: { global: { archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: ['ws1'] }, tables: { workspaces: { ws1: { title: '保留', sessionIds: [] } } } },
  })
  const storageDomain = makeStorageDomain({
    workspaces: { ws1: { title: '保留', sessionIds: [] } },
    workspaceIds: ['ws1'],
  })
  storageDomain.wsTable.delete = () => { throw new Error('disk full') }
  const ctx = makeCtx({ ...makeGraph([]), storageDomain })

  await assert.rejects(() => core.purgeWorkspace(ctx, HOME, 'ws1'), /工作区记录（域）删除失败：disk full/)

  assert.deepEqual(storageDomain.globalState().workspaceIds, ['ws1'], 'the filtered order must be rolled back with the record')
  assert.equal(storageDomain.globalState().pendingMutation, undefined, 'the rollback clears the pending marker as well')
  assert.equal(storageDomain.wsTable.has('ws1'), true)
  const registry = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  assert.notEqual(registry.tables.workspaces.ws1, undefined, 'the file must not diverge from the domain')
  assert.deepEqual(registry.global.workspaceIds, ['ws1'])
})

test('an unreadable workspace registry is reported, not treated as absent', async () => {
  await buildHome({
    sessions: [],
    workspaceState: { global: { workspaceIds: ['ws1'] }, tables: { workspaces: { ws1: { title: '损坏', sessionIds: [] } } } },
  })
  await writeFile(join(HOME, 'storages', 'workspace.json'), '{not json')
  const ctx = makeCtx({ ...makeGraph([]) })

  await assert.rejects(() => core.purgeWorkspace(ctx, HOME, 'ws1'), /工作区注册表无法解析/)
})

test('a foreign unit header blocks the file-level rewrite and the survivor is reported', async () => {
  await buildHome({
    sessions: [{ id: LONE }],
    workspaceState: {
      unit: { name: 'someone-else', version: 1 },
      global: { workspaceIds: [], archivedSessionIds: [LONE] },
      tables: { workspaces: {} },
    },
  })
  const ctx = makeCtx({ ...makeGraph([{ id: LONE, origin: 'human' }]) })

  await assert.rejects(() => core.purgeTree(ctx, HOME, LONE), /工作区注册表拒绝改写.*someone-else/s)

  const registry = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  assert.deepEqual(registry.unit, { name: 'someone-else', version: 1 }, 'the foreign document must be left untouched')
  assert.deepEqual(registry.global.archivedSessionIds, [LONE])
})

test('the rc.5 unit header survives file-level registry rewrites', async () => {
  await buildHome({
    sessions: [{ id: LONE }],
    workspaceState: {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['ws1'], archivedSessionIds: [LONE] },
      tables: { workspaces: { ws1: { sessionIds: [LONE] } } },
    },
  })
  const ctx = makeCtx({ ...makeGraph([{ id: LONE, origin: 'human' }]) })

  await core.purgeTree(ctx, HOME, LONE)

  const registry = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'))
  assert.deepEqual(registry.unit, { name: 'workspace', version: 2 }, 'the stamp must round-trip untouched')
  assert.deepEqual(registry.global.archivedSessionIds, [])
  assert.deepEqual(registry.tables.workspaces.ws1.sessionIds, [])
})

test('purgeWorkspace rejects a malformed workspace id', async () => {
  const ctx = makeCtx({ ...makeGraph([]) })
  await assert.rejects(() => core.purgeWorkspace(ctx, HOME, ''), /workspaceId 不合法/)
  await assert.rejects(() => core.purgeWorkspace(ctx, HOME, 'bad\nid'), /workspaceId 不合法/)
})
