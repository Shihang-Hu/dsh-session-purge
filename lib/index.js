/**
 * dsh-session-purge — host half.
 *
 * Permanently purges one session end to end. The Harness ships no session
 * delete, so this plugin performs the missing operation against the same
 * owners the Harness itself uses:
 *
 *   - live sessions       ctx.get('sessions')  (dsh-session SessionStore)
 *   - projection cache    ctx.get('storageDomain') → domain 'session_projcache'
 *   - workspace registry  ctx.get('storageDomain') → domain 'workspace'
 *   - persisted logs      $DSH_HOME/sessions/<projectKey>/<encodedId>/
 *   - tool output         %TEMP%/dsh-{subprocess,spill,acl-skill,shell,
 *                         workspace-changes}-* directories whose content
 *                         mentions the session id (there is no
 *                         spill service call: those directories are keyed by
 *                         ephemeral run ids, so content is the only attribution)
 *   - subagents           child sessions whose header.parentSession === id
 *
 * Pipeline per session (descendants first):
 *   1. refuse while an agent still owns the session (ctx.get('agents')): live
 *      work is the only hard refusal. A session that is merely resident in the
 *      live store — opened at some point, window since navigated away — is NOT
 *      refused any more;
 *   2. flush the resident session so the log is complete on disk;
 *   3. remove the log directory (sweep, drop the cache row, sweep twice more:
 *      the dispose path may be mid-flight and re-create a directory);
 *   4. verify the log is gone — only then strip the workspace accounting,
 *      verify the accounting is clean too, evict the resident object when no
 *      agent owns it, and sweep the tool-output temp directories whose content
 *      mentions the session id.
 *
 * Besides purging, the plugin can REDACT a session in place: secret values
 * (and/or value prefixes) are masked inside the zstd log with the exact
 * frame layout preserved — see the "in-place redaction" section below.
 *
 * Every filesystem operation is Node `fs` (no shell), every candidate path is
 * proven to live inside the sessions root, and symbolic links are refused
 * rather than followed.
 *
 * HTTP surface (same-origin only, reads included):
 *   GET  /_dsh/session-purge/list    → every known session with metadata
 *   POST /_dsh/session-purge/delete  → { sessionId } → permanent purge
 *   POST /_dsh/session-purge/redact  → { sessionId, secrets?, prefixes? } → in-place masking
 *
 * @module dsh-session-purge
 */
import { readdir, rm, stat, lstat, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export const name = 'dsh-session-purge'

/** All services are optional: the plugin must load in terminal-only profiles. */
export const inject = []

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SESSION_ID_RE = new RegExp(`^(session-)?${UUID}$`, 'i')

/** Depth guard for the subagent cascade (the tree is shallow in practice). */
const MAX_CASCADE_DEPTH = 8

/** A single 8 MiB ceiling is enough for the body of a delete request. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

class PurgeError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.status = status
  }
}

// --- paths -------------------------------------------------------------------

/** Resolve the Harness home exactly like application boot does. */
function dshHome(ctx) {
  const homePath = ctx.get('dshHomePath')
  if (typeof homePath === 'function') {
    try {
      const value = homePath()
      if (typeof value === 'string' && value.length > 0) return value
    } catch { /* fall through to the environment */ }
  }
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh')
}

/** Both id spellings a store may use: `<uuid>` and `session-<uuid>`. */
function idVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) variants.add(sessionId.slice('session-'.length))
  else if (SESSION_ID_RE.test(sessionId)) variants.add(`session-${sessionId}`)
  return [...variants]
}

/** Whether `candidate` resolves inside `root` (defence in depth). */
function isInside(root, candidate) {
  const base = resolve(root)
  const full = resolve(candidate)
  return full === base || full.startsWith(base + sep)
}

/** Every on-disk directory owned by one session id, across project buckets. */
async function locateSessionDirs(home, sessionId) {
  const root = join(home, 'sessions')
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const found = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const variant of idVariants(sessionId)) {
      const candidate = join(root, project.name, variant)
      if (!isInside(root, candidate)) continue
      let info
      try {
        info = await lstat(candidate)
      } catch { continue }
      if (info.isSymbolicLink()) throw new PurgeError(`refusing to delete through symbolic link "${candidate}"`)
      if (info.isDirectory() && !found.includes(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * `readdir(…, { withFileTypes: true })` or `undefined` when the path is gone.
 * The returned dirents already carry the type, which is why no caller of this
 * helper needs a second `lstat` just to tell a directory from a link.
 */
async function readdirDirents(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return undefined
  }
}

/** A fixed pool of `limit` workers pulling the next index off a shared cursor. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

/** Subdirectories walked concurrently while measuring; the work is I/O-bound. */
const WALK_CONCURRENCY = 8

/**
 * Recursive size; symbolic links are measured as links, never followed, and
 * subdirectories are walked through a bounded worker pool — a serial walk costs
 * one awaited `lstat` per entry, which is pure latency on a large session tree.
 */
async function directorySize(root) {
  let info
  try {
    info = await lstat(root)
  } catch { return 0 }
  if (info.isSymbolicLink()) return info.size
  if (!info.isDirectory()) return info.size
  const entries = await readdirDirents(root)
  if (entries === undefined) return 0
  const sizes = await mapLimit(entries, WALK_CONCURRENCY, (entry) => directorySize(join(root, entry.name)))
  let total = 0
  for (const size of sizes) total += size
  return total
}

// --- live store --------------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Breather between the log-directory `rm` retries: the dispose path can be
 * mid-flight and re-create a directory right after the previous sweep.
 */
const RM_RETRY_SETTLE_MS = 30

/** Whether the agents registry still owns a live agent for this session. */
function agentActive(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  let agent
  for (const variant of idVariants(sessionId)) {
    try {
      agent = agents.get(variant)
    } catch { agent = undefined }
    if (agent !== undefined && agent !== null) break
  }
  if (agent === undefined || agent === null) return false
  const status = typeof agent.status === 'string' ? agent.status : undefined
  // AgentStatus is exactly 'idle' | 'running' (dsh-agent runtime-types).
  if (status === undefined) return true
  return status !== 'idle'
}

/**
 * Ids resident in the host's live session store — every session a client has
 * opened since host start. The store retains sessions after their window
 * navigates away, so residency is NOT "currently viewed": it only means the
 * Session object is warm and must be flushed before its files are removed.
 */
function enteredIds(ctx) {
  const sessions = ctx.get('sessions')
  let store
  try {
    store = sessions && sessions.store
  } catch { store = undefined }
  const ids = new Set()
  if (!store) return ids
  try {
    if (typeof store.keys === 'function') {
      for (const key of store.keys()) if (typeof key === 'string') ids.add(key)
    } else if (typeof store.entries === 'function') {
      for (const [key] of store.entries()) if (typeof key === 'string') ids.add(key)
    }
  } catch { /* undetectable composition */ }
  return ids
}

/**
 * Whether this session is resident in the host's live session store. Callers
 * that test many ids in a row enumerate the store once and pass the result in;
 * without `entered` the whole store is re-keyed per call.
 */
function sessionEntered(ctx, sessionId, entered = enteredIds(ctx)) {
  if (entered.size === 0) return false
  return idVariants(sessionId).some((variant) => entered.has(variant))
}

/**
 * Durability barrier before deletion: `ctx.sessions.flush(session)` is the
 * documented checkpoint ("Flush durable state") — every persistence listener
 * settles before this call resolves, so the on-disk log is complete when the
 * sweep removes it.
 */
async function quiesceLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return { flushed: false }
  let flushed = false
  for (const variant of idVariants(sessionId)) {
    let session
    try {
      session = typeof sessions.get === 'function' ? sessions.get(variant) : undefined
    } catch { session = undefined }
    if (session === undefined || session === null) continue
    if (typeof sessions.flush === 'function') {
      try {
        await sessions.flush(session)
        flushed = true
      } catch { /* deletion proceeds; the sweep below removes the files */ }
    }
  }
  return { flushed }
}

/**
 * Drop a purged session's resident object from the live store, so the list
 * stops showing a ghost row (exists=false, no title) until the next host
 * restart. Conservative: the eviction fires only when the agents registry
 * holds NO agent object for the session — an idle agent still owns its
 * session and the ghost stays until restart. Returns whether anything was
 * evicted.
 */
function evictResident(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const store = sessions && sessions.store
  if (!store || typeof store.delete !== 'function') return false
  const agents = ctx.get('agents')
  if (agents && typeof agents.get === 'function') {
    for (const variant of idVariants(sessionId)) {
      let agent
      try { agent = agents.get(variant) } catch { agent = undefined }
      if (agent !== undefined && agent !== null) return false
    }
  }
  let evicted = false
  for (const variant of idVariants(sessionId)) {
    try {
      if (store.has(variant)) {
        store.delete(variant)
        evicted = true
      }
    } catch { /* best-effort */ }
  }
  return evicted
}

// --- storage domains ---------------------------------------------------------

/**
 * Live in-memory authority, split in two because the delete pipeline needs the
 * halves at different moments: projection rows are cheap to drop and a
 * mid-flight dispose may repopulate one (so they are stripped before AND after
 * the log is verified gone), while the workspace accounting is touched only
 * after that verify — a half-deleted session must not fall out of its group.
 */

/** Projection-cache rows of one session; returns the number of rows dropped. */
async function stripProjectionRows(ctx, sessionId) {
  const storageDomain = ctx.get('storageDomain')
  let projRows = 0
  if (!storageDomain || typeof storageDomain.get !== 'function') return projRows
  const proj = storageDomain.get('session_projcache')
  if (proj && typeof proj.table === 'function') {
    try {
      const table = proj.table('sessions')
      for (const variant of idVariants(sessionId)) {
        if (table.get(variant) !== undefined) {
          await table.delete(variant)
          projRows++
        }
      }
    } catch { /* domain closed or table absent: nothing to clean */ }
  }
  return projRows
}

/**
 * Workspace membership plus archive/pin lists; returns the number of refs dropped.
 *
 * Membership is written straight through the domain: the registry offers no
 * "remove an already-gone session" call that does not also re-filter the
 * record's other members (`detachSession` prunes by candidate match), so the
 * direct write is the safer half even though the registry's entity snapshot
 * only refreshes on its next own mutation.
 *
 * The archive/pin sets are global state the registry keeps an in-memory copy
 * of. A direct `global.set` would leave that copy stale, and the next
 * pin/archive write (which serializes `this.state`) would resurrect the
 * purged ids. So those two lists go through `unarchiveSession` /
 * `unpinSession` when the service is live (both are removal-only and need no
 * session-existence check); a direct pass afterwards still sweeps entries the
 * registry snapshot did not know about, and is the whole implementation on a
 * profile without the service.
 */
async function stripWorkspaceRefs(ctx, sessionId) {
  const storageDomain = ctx.get('storageDomain')
  let wsRefs = 0
  if (!storageDomain || typeof storageDomain.get !== 'function') return wsRefs
  const ws = storageDomain.get('workspace')
  if (!ws || typeof ws.table !== 'function') return wsRefs
  const variants = idVariants(sessionId)
  try {
    const table = ws.table('workspaces')
    for (const [workspaceId, record] of table.entries()) {
      if (record && Array.isArray(record.sessionIds) && record.sessionIds.some((id) => variants.includes(id))) {
        await table.put(workspaceId, {
          ...record,
          sessionIds: record.sessionIds.filter((id) => !variants.includes(id)),
        })
        wsRefs++
      }
    }
  } catch { /* unit closed */ }

  const archived = []
  const pinned = []
  try {
    const global = ws.global
    if (global && typeof global.get === 'function') {
      const state = global.get()
      if (state) {
        for (const id of variants) {
          if (Array.isArray(state.archivedSessionIds) && state.archivedSessionIds.includes(id)) archived.push(id)
          if (Array.isArray(state.pinnedSessionIds) && state.pinnedSessionIds.includes(id)) pinned.push(id)
        }
        if (archived.length > 0) wsRefs++
        if (pinned.length > 0) wsRefs++
      }
    }
  } catch { /* no global slot */ }

  const registry = ctx.get('workspaceRegistry')
  if (registry && typeof registry.unarchiveSession === 'function') {
    for (const id of archived) {
      try { await registry.unarchiveSession(id) } catch { /* not started; the direct pass below still sweeps the domain */ }
    }
  }
  if (registry && typeof registry.unpinSession === 'function') {
    for (const id of pinned) {
      try { await registry.unpinSession(id) } catch { /* same */ }
    }
  }

  // Direct pass: only entries still there. When the registry handled an id
  // this is a no-op; when it did not know it, its snapshot is already clean,
  // so removing the domain entry here cannot be resurrected.
  if (archived.length > 0 || pinned.length > 0) {
    try {
      const global = ws.global
      if (global && typeof global.get === 'function' && typeof global.set === 'function') {
        const state = global.get()
        if (state) {
          const next = { ...state }
          let touched = false
          for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
            if (Array.isArray(state[key]) && state[key].some((id) => variants.includes(id))) {
              next[key] = state[key].filter((id) => !variants.includes(id))
              touched = true
            }
          }
          if (touched) await global.set(next)
        }
      }
    } catch { /* no global slot */ }
  }
  return wsRefs
}

/**
 * Read the workspace registry document. Returns `{ state, error }`: `state` is
 * `undefined` when the document is absent (ENOENT — a legitimate empty
 * history), and a present-but-unparseable document returns its `error` so the
 * callers can report it instead of silently treating it as absent. Every
 * file-level accounting pass goes through this pair so the parse and the
 * atomic rewrite have exactly one implementation.
 */
async function readWorkspaceRegistry(home) {
  try {
    return { state: JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8')) }
  } catch (error) {
    return { state: undefined, error: error?.code === 'ENOENT' ? undefined : error }
  }
}

/** Rewrite the registry through a same-directory staging file + rename. */
async function writeWorkspaceRegistry(home, state) {
  const registry = join(home, 'storages', 'workspace.json')
  const staging = `${registry}.dsh-session-purge.tmp`
  await writeFile(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(staging, registry)
}

/**
 * File-level belt-and-braces, always run after the storage-domain pass:
 * projection-cache files are removed outright (the in-memory authority has
 * already dropped the row, so the backing file must go too), and any
 * reference still present in the registry document is scrubbed through a
 * same-directory rename so a reader never observes a torn document.
 * Failures here are not fatal — `verifyAccountingClean` decides that.
 */
async function stripStorageFiles(home, sessionId) {
  const variants = idVariants(sessionId)
  let projRows = 0
  let wsRefs = 0
  for (const variant of variants) {
    const file = join(home, 'storages', 'session_projcache', 'sessions', `${variant}.json`)
    try {
      await stat(file)
      await rm(file, { force: true })
      projRows++
    } catch { /* absent */ }
  }
  const { state } = await readWorkspaceRegistry(home)
  if (state === undefined) return { projRows, wsRefs }
  const drop = (ids) => {
    const next = ids.filter((id) => !variants.includes(id))
    wsRefs += ids.length - next.length
    return next
  }
  if (Array.isArray(state?.global?.archivedSessionIds)) state.global.archivedSessionIds = drop(state.global.archivedSessionIds)
  if (Array.isArray(state?.global?.pinnedSessionIds)) state.global.pinnedSessionIds = drop(state.global.pinnedSessionIds)
  const workspaces = state?.tables?.workspaces
  if (workspaces && typeof workspaces === 'object') {
    for (const record of Object.values(workspaces)) {
      if (Array.isArray(record?.sessionIds)) record.sessionIds = drop(record.sessionIds)
    }
  }
  if (wsRefs > 0) await writeWorkspaceRegistry(home, state)
  return { projRows, wsRefs }
}

/**
 * Post-condition check for the accounting pass: after both the storage-domain
 * and the file-level cleanup, no projection row/file and no registry
 * reference (workspace membership, archive list, pin list) may survive.
 * Any survivor is reported so the caller can surface an error — the logs are
 * already gone at this point, so a retry simply re-runs the accounting pass.
 */
async function verifyAccountingClean(ctx, home, sessionId) {
  const variants = idVariants(sessionId)
  const problems = []
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain && typeof storageDomain.get === 'function') {
    try {
      const proj = storageDomain.get('session_projcache')
      const table = proj && typeof proj.table === 'function' ? proj.table('sessions') : undefined
      for (const variant of variants) {
        try {
          if (table && table.get(variant) !== undefined) problems.push(`投影缓存行仍在：${variant}`)
        } catch { /* table closed: the file check below still applies */ }
      }
    } catch { /* domain closed */ }
  }
  for (const variant of variants) {
    const file = join(home, 'storages', 'session_projcache', 'sessions', `${variant}.json`)
    try {
      await stat(file)
      problems.push(`投影缓存文件仍在：${file}`)
    } catch { /* gone, as it should be */ }
  }
  const { state, error } = await readWorkspaceRegistry(home)
  if (error) problems.push(`工作区注册表无法解析：${join(home, 'storages', 'workspace.json')}`)
  else if (state !== undefined) {
    const referenced = [
      ...(Array.isArray(state?.global?.archivedSessionIds) ? state.global.archivedSessionIds : []),
      ...(Array.isArray(state?.global?.pinnedSessionIds) ? state.global.pinnedSessionIds : []),
    ]
    for (const record of Object.values(state?.tables?.workspaces ?? {})) {
      if (Array.isArray(record?.sessionIds)) referenced.push(...record.sessionIds)
    }
    for (const variant of variants) if (referenced.includes(variant)) problems.push(`工作区记账仍引用：${variant}`)
  }
  return problems
}

// --- session graph -----------------------------------------------------------

/** parentId → childIds from the live store and the persisted headers. */
async function childMap(ctx) {
  const map = new Map()
  const add = (header) => {
    if (!header || typeof header.id !== 'string') return
    const parent = header.parentSession
    if (typeof parent !== 'string' || parent.length === 0) return
    const list = map.get(parent) ?? []
    if (!list.includes(header.id)) list.push(header.id)
    map.set(parent, list)
  }
  const sessions = ctx.get('sessions')
  if (sessions && typeof sessions.list === 'function') {
    try {
      for (const session of sessions.list()) add(session?.header)
    } catch { /* ignore */ }
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence && typeof persistence.list === 'function') {
    try {
      for (const item of await persistence.list()) add(item?.header ?? item)
    } catch { /* ignore */ }
  }
  return map
}

/**
 * Root first, then descendants breadth-first (deletion runs in reverse).
 * `truncated` is exact, not a guess: it is set only when a child edge was
 * actually left untraversed because the depth ceiling cut the walk. A merely
 * non-empty frontier proves nothing — its nodes may simply have no children.
 *
 * `map` lets a caller that walks several trees in one operation (a workspace
 * delete) read the session graph ONCE instead of re-listing every header per
 * member. Reusing a snapshot is safe here: deleting logs never re-parents a
 * session, and a member already covered by an earlier tree is skipped by the
 * caller's own visited set.
 */
async function cascadeOrder(ctx, rootId, map) {
  const tree = map ?? await childMap(ctx)
  const order = [rootId]
  const seen = new Set([rootId])
  let frontier = [rootId]
  for (let depth = 0; depth < MAX_CASCADE_DEPTH && frontier.length > 0; depth++) {
    const next = []
    for (const parent of frontier) {
      for (const child of tree.get(parent) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        order.push(child)
        next.push(child)
      }
    }
    frontier = next
  }
  const truncated = frontier.some((parent) => (tree.get(parent) ?? []).some((child) => !seen.has(child)))
  return { order, truncated }
}

/** Every persisted header, keyed by id (for the list endpoint). */
async function persistedHeaders(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.list !== 'function') return new Map()
  const out = new Map()
  try {
    for (const item of await persistence.list()) {
      const header = item?.header ?? item
      if (header && typeof header.id === 'string') out.set(header.id, header)
    }
  } catch { /* ignore */ }
  return out
}

/** Titles and archive flags from the projection cache + workspace registry. */
async function catalogSnapshot(ctx) {
  const titles = new Map()
  const archived = new Set()
  const groups = new Map()
  const workspaceIds = new Map()
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain && typeof storageDomain.get === 'function') {
    try {
      const proj = storageDomain.get('session_projcache')
      const table = proj && typeof proj.table === 'function' ? proj.table('sessions') : undefined
      for (const [id, record] of table?.entries() ?? []) {
        const rows = record?.rows ?? record?.values?.rows
        const title = rows?.title?.val
        if (typeof title === 'string' && title.length > 0) titles.set(id, title)
      }
    } catch { /* ignore */ }
    try {
      const ws = storageDomain.get('workspace')
      const table = ws && typeof ws.table === 'function' ? ws.table('workspaces') : undefined
      for (const [workspaceId, record] of table?.entries() ?? []) {
        const name = record?.title ?? record?.name ?? workspaceId
        for (const id of record?.sessionIds ?? []) {
          groups.set(id, name)
          workspaceIds.set(id, workspaceId)
        }
      }
      const state = ws?.global?.get?.()
      for (const id of state?.archivedSessionIds ?? []) archived.add(id)
    } catch { /* ignore */ }
  }
  return { titles, archived, groups, workspaceIds }
}

/**
 * One pass over the sessions root: every on-disk directory keyed by its id
 * spelling. Symbolic links are skipped — listing never deletes, and the
 * purge/redact paths re-locate with explicit symlink refusal.
 */
async function indexSessionDirs(home) {
  const root = join(home, 'sessions')
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    throw error
  }
  const index = new Map()
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const bucket = join(root, project.name)
    let entries
    try {
      entries = await readdir(bucket, { withFileTypes: true })
    } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dirs = index.get(entry.name) ?? []
      dirs.push(join(bucket, entry.name))
      index.set(entry.name, dirs)
    }
  }
  return index
}

/** All sessions known to the host, for the settings panel. */
async function listSessions(ctx, home) {
  const [headers, catalog, dirIndex] = await Promise.all([persistedHeaders(ctx), catalogSnapshot(ctx), indexSessionDirs(home)])
  const sessions = ctx.get('sessions')
  const ids = new Set(headers.keys())
  if (sessions && typeof sessions.list === 'function') {
    try {
      for (const session of sessions.list()) {
        const header = session?.header
        if (header && typeof header.id === 'string') {
          ids.add(header.id)
          if (!headers.has(header.id)) headers.set(header.id, header)
        }
      }
    } catch { /* ignore */ }
  }
  for (const id of catalog.titles.keys()) ids.add(id)

  // Residency is one immutable property of the whole listing: enumerate the
  // live store once here instead of re-keying it inside every row.
  const entered = enteredIds(ctx)

  const entries = []
  for (const id of ids) {
    const header = headers.get(id) ?? {}
    entries.push({ id, header, dirs: idVariants(id).flatMap((variant) => dirIndex.get(variant) ?? []) })
  }

  // Size every directory in ONE flat pool. Measuring row by row awaited each
  // session's whole tree before starting the next; flattening the work keeps
  // the same concurrency bound while the rows stop serialising behind it.
  const jobs = []
  for (const [rowIndex, entry] of entries.entries()) {
    for (const dir of entry.dirs) jobs.push({ rowIndex, dir })
  }
  const jobSizes = await mapLimit(jobs, WALK_CONCURRENCY, (job) => directorySize(job.dir))
  const totals = new Array(entries.length).fill(0)
  for (const [index, job] of jobs.entries()) totals[job.rowIndex] += jobSizes[index]

  const rows = entries.map((entry, index) => {
    const { id, header, dirs } = entry
    return {
      id,
      title: catalog.titles.get(id) ?? null,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      workspace: catalog.groups.get(id) ?? null,
      workspaceId: catalog.workspaceIds.get(id) ?? null,
      origin: typeof header.origin === 'string' ? header.origin : null,
      parentSession: typeof header.parentSession === 'string' ? header.parentSession : null,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
      archived: catalog.archived.has(id),
      running: agentActive(ctx, id),
      open: sessionEntered(ctx, id, entered),
      exists: dirs.length > 0,
      sizeBytes: totals[index],
    }
  })
  rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return rows
}

// --- core purge --------------------------------------------------------------

/** Purge one session (no cascade); the caller orders the cascade. */
async function purgeOne(ctx, home, sessionId, report) {
  // The only hard refusal: live work. A session that is merely resident in
  // the live store (opened some time, window since navigated away) is safe
  // to delete through the flush barrier below.
  if (agentActive(ctx, sessionId)) {
    throw new PurgeError(`会话正在运行（有任务进行中），请先停止后再删除：${sessionId}`, 409)
  }
  const live = await quiesceLive(ctx, sessionId)

  // One locating pass; deletion is retried over the SAME known paths — the
  // dispose path may recreate a directory mid-flight, so `rm` reruns three
  // times (recreation at a different bucket is impossible: buckets derive
  // from the session's fixed cwd). A final locate verifies nothing survived.
  const dirs = await locateSessionDirs(home, sessionId)
  const sizes = await mapLimit(dirs, WALK_CONCURRENCY, directorySize)
  let freedBytes = 0
  for (const size of sizes) freedBytes += size
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  const projBefore = await stripProjectionRows(ctx, sessionId)
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  await sleep(RM_RETRY_SETTLE_MS)
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })

  const remaining = await locateSessionDirs(home, sessionId)
  if (remaining.length > 0) {
    throw new PurgeError(`无法完全删除会话文件，已保留账目以便重试：${remaining.join(', ')}`)
  }

  const projAfter = await stripProjectionRows(ctx, sessionId)
  const wsDomainRefs = await stripWorkspaceRefs(ctx, sessionId)
  const files = await stripStorageFiles(home, sessionId)
  const projRows = projBefore + projAfter + files.projRows
  const wsRefs = wsDomainRefs + files.wsRefs

  const problems = await verifyAccountingClean(ctx, home, sessionId)
  if (problems.length > 0) {
    throw new PurgeError(`会话日志已删除，但记账未清干净（可直接重试删除）：${problems.join('；')}`)
  }

  // The temp-output sweep is NOT per session: `purgeTree` runs one sweep for
  // the whole cascade once every log is gone (see `sweepTreeTempOutputs`).

  const evicted = evictResident(ctx, sessionId)

  try {
    ctx.emit('api-session/removed', sessionId)
  } catch { /* notification is best-effort */ }

  report.deleted.push(sessionId)
  report.freedBytes += freedBytes
  report.projRows += projRows
  report.wsRefs += wsRefs
  report.live.push({ sessionId, ...live, evicted })
  return report
}

// --- temp output sweep ---------------------------------------------------------

/**
 * Tool-output temp directories (`%TEMP%/dsh-subprocess-*` — including the
 * `dsh-subprocess-launch-*` runner dirs — `dsh-spill-*`, `dsh-acl-skill-*`,
 * `dsh-workspace-changes-*`, and POSIX-only `dsh-shell-*`) keep the full
 * stdout of commands and long tool results. All are confirmed against live
 * `%TEMP%` on the 0.2.1-rc.2 build. The `dsh-acl-skill-*` creator — unresolved
 * at 0.5.8 — is identified in the extracted 0.2.1-rc.3 sources:
 * `@deepseek-ai/dsh-sandbox-windows-acl` runs
 * `mkdtempSync(join(tmpdir(), "dsh-acl-skill-"))` per skill-bundle sandbox.
 * They are keyed by ephemeral run ids, not
 * by the session uuid, so the only reliable attribution is content: a run
 * that echoed the session id (paths, logs, headers) belongs to that session.
 * Every file in a matching directory is covered because one directory is one
 * run. Files that never mention the id survive — documented limitation.
 *
 * One sweep covers a whole cascade: the caller passes every id of the tree and
 * the temp tree is scanned exactly once, regardless of how many subagents the
 * parent owns.
 */
const TEMP_PREFIXES = ['dsh-subprocess-', 'dsh-spill-', 'dsh-acl-skill-', 'dsh-shell-', 'dsh-workspace-changes-']
const SWEEP_MAX_FILES = 4000
const SWEEP_MAX_TOTAL_BYTES = 512 * 1024 * 1024
const SWEEP_MAX_FILE_BYTES = 32 * 1024 * 1024
const SWEEP_MAX_DEPTH = 10

/** Read `file` as latin1 so byte-level matching needs no decoding. */
async function readTextBestEffort(file) {
  try {
    return await readFile(file, 'latin1')
  } catch {
    return null
  }
}

/**
 * Content-attributed sweep of the tool-output temp directories for one session
 * tree. Bounded by file count and total bytes so a huge temp tree can never
 * stall a delete; `budgetHit` reports when the bound was reached.
 *
 * Each candidate directory is traversed exactly once: the walk both matches the
 * ids and tallies what it read, so there is no separate file-count pass to
 * re-walk the tree the matcher just walked, and the dirent types come from
 * `readdir` instead of a second `lstat` per entry. A directory is attributed to
 * every id of the tree whose variant it mentions — one run can name a parent
 * and its subagent — so returning per-session results stays possible without a
 * second scan. (The old `countFile` injection point existed only so a test
 * could prove that property; with the re-walk gone it is true by construction.)
 */
async function sweepTempOutputs(sessionIds, { tmpRoot } = {}) {
  const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds]
  const variantsOf = new Map(ids.map((id) => [id, idVariants(id)]))
  const allVariants = [...new Set([...variantsOf.values()].flat())]
  const root = resolve(tmpRoot ?? tmpdir())
  const empty = () => ({ dirs: 0, files: 0, scannedFiles: 0, budgetHit: false })
  // `dirsTotal`/`filesTotal` count every removed directory exactly once, while
  // the per-session entries attribute shared directories to EACH session that
  // mentioned them — summing those can exceed the totals, by design.
  const result = { scannedFiles: 0, budgetHit: false, dirsTotal: 0, filesTotal: 0, sessions: new Map(ids.map((id) => [id, empty()])) }
  const entries = await readdirDirents(root)
  if (entries === undefined) return result
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (!TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue
    const dir = join(root, entry.name)
    if (isInside(root, dir)) candidates.push(dir)
  }

  // One budget for the whole sweep, shared by every candidate directory.
  const scan = { files: 0, bytes: 0, overBudget: false }

  /**
   * Walk one candidate, reading every file once. Returns the ids it mentions
   * and the number of files it holds (`files` counts everything the walk saw,
   * `read` only what was small enough to read under the per-file ceiling).
   */
  const scanDir = async (folder, depth) => {
    if (depth > SWEEP_MAX_DEPTH) return undefined
    const list = await readdirDirents(folder)
    if (list === undefined) return undefined
    const mentions = new Set()
    let files = 0
    let read = 0
    for (const entry of list) {
      if (scan.overBudget) return { mentions, files, read }
      if (entry.isSymbolicLink()) continue
      const p = join(folder, entry.name)
      if (entry.isDirectory()) {
        const nested = await scanDir(p, depth + 1)
        if (nested === undefined) continue
        files += nested.files
        read += nested.read
        for (const id of nested.mentions) mentions.add(id)
        continue
      }
      const info = await stat(p).catch(() => undefined)
      if (info === undefined) continue
      files++
      if (info.size > SWEEP_MAX_FILE_BYTES) continue
      scan.files++
      scan.bytes += info.size
      if (scan.files > SWEEP_MAX_FILES || scan.bytes > SWEEP_MAX_TOTAL_BYTES) {
        scan.overBudget = true
        result.budgetHit = true
        return { mentions, files, read }
      }
      read++
      const text = await readTextBestEffort(p)
      if (text === null) continue
      for (const variant of allVariants) {
        if (!text.includes(variant)) continue
        for (const [id, variants] of variantsOf) if (variants.includes(variant)) mentions.add(id)
      }
    }
    return { mentions, files, read }
  }

  for (const dir of candidates) {
    if (scan.overBudget) break
    const found = await scanDir(dir, 0)
    if (found === undefined || found.mentions.size === 0) continue
    await rm(dir, { recursive: true, force: true })
    result.dirsTotal++
    result.filesTotal += found.files
    for (const id of found.mentions) {
      const entry = result.sessions.get(id)
      entry.dirs++
      entry.files += found.files
      entry.scannedFiles += found.read
      entry.budgetHit = result.budgetHit
    }
  }
  for (const entry of result.sessions.values()) entry.scannedFiles = entry.scannedFiles || 0
  result.scannedFiles = scan.files
  return result
}

/**
 * One temp sweep for a whole cascade, folded into the delete report. Entries
 * keep the shape the client and the README describe: one row per session that
 * had output swept, omitted when nothing was found for it.
 */
async function sweepTreeTempOutputs(order, report) {
  if (order.length === 0) return report
  const sweep = await sweepTempOutputs(order)
  for (const sessionId of order) {
    const found = sweep.sessions.get(sessionId)
    if (!found) continue
    if (found.dirs === 0 && !found.budgetHit) continue
    report.tempSweep.push({ sessionId, ...found })
  }
  // The deduplicated truth for the UI note: per-session entries above may
  // double-count a directory that mentioned both a parent and its subagent.
  if (sweep.dirsTotal > 0 || sweep.budgetHit) {
    report.tempSweepTotal = { dirs: sweep.dirsTotal, files: sweep.filesTotal }
  }
  return report
}

/**
 * Purge one session tree into a shared report WITHOUT the temp sweep — the
 * sweep is the caller's job, so a workspace delete can purge many trees and
 * still scan the temp tree exactly once. `graph` forwards a session-graph
 * snapshot so a multi-tree caller lists headers once (see `cascadeOrder`).
 * Returns the visited order and whether the depth ceiling truncated it.
 */
async function purgeTreeInto(ctx, home, rootId, report, graph) {
  if (typeof rootId !== 'string' || !SESSION_ID_RE.test(rootId)) {
    throw new PurgeError(`会话 id 不合法：${String(rootId).slice(0, 80)}`, 400)
  }
  const { order, truncated } = await cascadeOrder(ctx, rootId, graph)
  for (const id of [...order].reverse()) {
    await purgeOne(ctx, home, id, report)
  }
  return { order, truncated }
}

/**
 * Purge one session together with every descendant, deepest last. The temp
 * sweep runs once for the whole tree (see `sweepTempOutputs`), then its
 * per-session results are handed to the report in delete order. Descendants
 * beyond MAX_CASCADE_DEPTH are left on disk and reported (`cascadeTruncated`)
 * instead of being silently dropped.
 */
async function purgeTree(ctx, home, rootId) {
  const report = { sessionId: rootId, deleted: [], freedBytes: 0, projRows: 0, wsRefs: 0, live: [], tempSweep: [] }
  const graph = await childMap(ctx)
  const { order, truncated } = await purgeTreeInto(ctx, home, rootId, report, graph)
  await sweepTreeTempOutputs(order, report)
  report.descendants = order.slice(1)
  report.cascadeTruncated = truncated
  return report
}

// --- workspace purge ----------------------------------------------------------

/**
 * Resolve a workspace's member session ids and its display title. The live
 * storage domain is authoritative; the registry file is read as belt and
 * braces so ids recorded only on disk are not missed.
 */
async function workspaceMembers(ctx, home, workspaceId) {
  const ids = new Set()
  let title = null
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain && typeof storageDomain.get === 'function') {
    try {
      const ws = storageDomain.get('workspace')
      const table = ws && typeof ws.table === 'function' ? ws.table('workspaces') : undefined
      const record = table && typeof table.get === 'function' ? table.get(workspaceId) : undefined
      if (record) {
        title = typeof record.title === 'string' ? record.title : (typeof record.name === 'string' ? record.name : null)
        for (const id of record.sessionIds ?? []) if (typeof id === 'string') ids.add(id)
      }
    } catch { /* unit closed */ }
  }
  const { state } = await readWorkspaceRegistry(home)
  const record = state?.tables?.workspaces?.[workspaceId]
  if (record) {
    title = title ?? (typeof record.title === 'string' ? record.title : (typeof record.name === 'string' ? record.name : null))
    for (const id of record.sessionIds ?? []) if (typeof id === 'string') ids.add(id)
  }
  return { title, ids: [...ids] }
}

/**
 * Remove the workspace record itself, then verify. THREE layers must agree,
 * because the harness registry validates at startup that EVERY id in the
 * `global.workspaceIds` order list has a table record — leaving the id in the
 * list after the record is gone throws "workspace domain is inconsistent:
 * registry order references missing workspace" and keeps workspaceController
 * from ever loading (the incident of 2026-10-15):
 *   1. the live domain's table row;
 *   2. the live domain's `global.workspaceIds` (mirrors the harness's own
 *      `deleteKnown`, which filters exactly this list; `defaultWorkspaceId`
 *      is deliberately retained, as in the harness);
 *   3. the registry file — record AND order list scrubbed in one atomic
 *      read-modify-write (belt and braces behind the domain's memory
 *      authority).
 * The live domain layer prefers `workspaceRegistry.delete()`, whose pending
 * mutation marker makes an interrupted delete recoverable at next startup and
 * whose in-memory authority is the only writer allowed to touch the domain
 * (a direct write would leave a stale registry order behind — the 2026-10-29
 * incident). Without that service the fallback mirrors the same two-write
 * protocol and rolls the order write back when the record write fails.
 * Returns `{ problems, removed }` — `removed` counts the layers actually
 * scrubbed, for the report's `wsRefs` accounting.
 */
async function deleteWorkspaceRecord(ctx, home, workspaceId) {
  const problems = []
  let removed = 0
  const registry = ctx.get('workspaceRegistry')
  if (registry && typeof registry.delete === 'function') {
    try {
      if (await registry.delete(workspaceId)) removed++
    } catch (error) {
      // The registry owns its own recovery protocol; do not race a failed
      // delete with direct domain/file writes. Retrying the route is safe.
      problems.push(`工作区记录（域）删除失败：${String(error?.message ?? error).slice(0, 120)}`)
      return { problems, removed }
    }
  } else {
    const fallback = await deleteWorkspaceInDomain(ctx, workspaceId)
    problems.push(...fallback.problems)
    removed += fallback.removed
  }
  const verify = verifyWorkspaceDomain(ctx, workspaceId)
  problems.push(...verify.problems)
  // A record the domain still holds is the one case where the file layer must
  // NOT run: scrubbing the document while the domain keeps the record only
  // moves the divergence, it does not heal it.
  if (verify.present) return { problems, removed }
  const file = await scrubWorkspaceFile(home, workspaceId)
  problems.push(...file.problems)
  removed += file.removed
  return { problems, removed }
}

/**
 * Fallback for a profile without the workspace registry service: mirror the
 * harness's recoverable protocol — persist the filtered order and the pending
 * marker in ONE global write, remove the record, then clear the marker. A
 * failed record write rolls the order write back (as `deleteKnown` does) so a
 * live record never sits behind a pending marker; should that rollback itself
 * fail, the marker stays and the next startup completes the delete.
 */
async function deleteWorkspaceInDomain(ctx, workspaceId) {
  const problems = []
  let removed = 0
  const storageDomain = ctx.get('storageDomain')
  if (!storageDomain || typeof storageDomain.get !== 'function') return { problems, removed }
  try {
    const ws = storageDomain.get('workspace')
    const table = ws && typeof ws.table === 'function' ? ws.table('workspaces') : undefined
    const global = ws && ws.global
    if (!table || typeof table.delete !== 'function') return { problems, removed }
    const canMark = Boolean(global && typeof global.get === 'function' && typeof global.set === 'function')
    const before = canMark ? global.get() : undefined
    let marked = false
    if (canMark && before && Array.isArray(before.workspaceIds) && before.workspaceIds.includes(workspaceId)) {
      await global.set({
        ...before,
        workspaceIds: before.workspaceIds.filter((id) => id !== workspaceId),
        pendingMutation: { operation: 'delete', workspaceId },
      })
      marked = true
      removed++
    }
    try {
      await table.delete(workspaceId)
      removed++
    } catch (error) {
      if (marked) {
        try {
          await global.set(before)
        } catch { /* leave the marker: the next startup completes the delete */ }
      }
      throw error
    }
    if (marked) {
      const after = global.get()
      if (after?.pendingMutation?.operation === 'delete' && after.pendingMutation.workspaceId === workspaceId) {
        await global.set({ ...after, pendingMutation: undefined })
      }
    }
  } catch (error) {
    problems.push(`工作区记录（域）删除失败：${String(error?.message ?? error).slice(0, 120)}`)
  }
  return { problems, removed }
}

/** Domain-level post-condition: neither the record nor its order entry may survive. */
function verifyWorkspaceDomain(ctx, workspaceId) {
  const problems = []
  let present = false
  const storageDomain = ctx.get('storageDomain')
  if (!storageDomain || typeof storageDomain.get !== 'function') return { problems, present }
  try {
    const ws = storageDomain.get('workspace')
    const table = ws && typeof ws.table === 'function' ? ws.table('workspaces') : undefined
    const global = ws && ws.global
    if (table && typeof table.get === 'function') {
      try {
        if (table.get(workspaceId) !== undefined) {
          present = true
          problems.push(`工作区记录仍在（域）：${workspaceId}`)
        }
      } catch { /* table closed */ }
    }
    if (global && typeof global.get === 'function') {
      try {
        const state = global.get()
        if (state && Array.isArray(state.workspaceIds) && state.workspaceIds.includes(workspaceId)) {
          present = true
          problems.push(`工作区仍在 order 列表（域）：${workspaceId}`)
        }
      } catch { /* no global slot */ }
    }
  } catch (error) {
    present = true
    problems.push(`工作区状态校验失败（域）：${String(error?.message ?? error).slice(0, 120)}`)
  }
  return { problems, present }
}

/**
 * File-level belt-and-braces behind the domain delete: scrub the record and
 * its order entry in one atomic read-modify-write, then re-read to prove both
 * are gone. A document that exists but cannot be parsed is reported — treating
 * it as absent would let the verification pass over real damage.
 */
async function scrubWorkspaceFile(home, workspaceId) {
  const registry = join(home, 'storages', 'workspace.json')
  const problems = []
  let removed = 0
  const { state, error } = await readWorkspaceRegistry(home)
  if (error) {
    problems.push(`工作区注册表无法解析：${registry}`)
    return { problems, removed }
  }
  if (state !== undefined) {
    let dirty = false
    const tables = state?.tables?.workspaces
    if (tables && typeof tables === 'object' && tables[workspaceId] !== undefined) {
      delete tables[workspaceId]
      dirty = true
    }
    if (state?.global && Array.isArray(state.global.workspaceIds) && state.global.workspaceIds.includes(workspaceId)) {
      state.global.workspaceIds = state.global.workspaceIds.filter((id) => id !== workspaceId)
      dirty = true
    }
    if (dirty) {
      await writeWorkspaceRegistry(home, state)
      removed++
    }
  }
  const { state: reread, error: rereadError } = await readWorkspaceRegistry(home)
  if (rereadError) {
    problems.push(`工作区注册表无法解析：${registry}`)
  } else if (reread !== undefined) {
    if (reread?.tables?.workspaces?.[workspaceId] !== undefined) problems.push(`工作区记录仍在（文件）：${registry}`)
    if (Array.isArray(reread?.global?.workspaceIds) && reread.global.workspaceIds.includes(workspaceId)) {
      problems.push(`工作区仍在 order 列表（文件）：${registry}`)
    }
  }
  return { problems, removed }
}

/**
 * Delete a whole workspace: every member session tree first (one temp sweep
 * for the union), then the workspace record itself.
 *
 * Safety rails:
 *   - refused up front (409, nothing touched) while ANY member session has a
 *     live agent;
 *   - the record is only removed when EVERY member was purged — a partial
 *     failure keeps the workspace visible for retry, so surviving sessions
 *     never fall out of their group;
 *   - a stuck workspace record throws AFTER the sessions are gone, mirroring
 *     the session flow's "logs deleted, accounting retryable" behaviour.
 */
async function purgeWorkspace(ctx, home, workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '' || workspaceId.length > 200 || /[\r\n]/.test(workspaceId)) {
    throw new PurgeError(`workspaceId 不合法：${String(workspaceId).slice(0, 80)}`, 400)
  }
  const { title, ids } = await workspaceMembers(ctx, home, workspaceId)
  const running = ids.filter((id) => agentActive(ctx, id))
  if (running.length > 0) {
    throw new PurgeError(`工作区内有会话正在运行，请先停止后再删除工作区：${running.join('、')}`, 409)
  }
  const report = {
    sessionId: workspaceId,
    workspaceId,
    workspaceTitle: title,
    deleted: [],
    failures: [],
    freedBytes: 0,
    projRows: 0,
    wsRefs: 0,
    live: [],
    tempSweep: [],
  }
  const unionOrder = []
  const visited = new Set()
  let truncated = false
  // One graph snapshot for the whole workspace: every member tree would
  // otherwise re-list every session header (N members → N full listings).
  const graph = await childMap(ctx)
  for (const id of ids) {
    // A member can already be gone: it may have been purged as part of an
    // earlier member's cascade (a subagent listed alongside its parent).
    // Re-purging it would succeed as a no-op and double-count the report.
    if (visited.has(id)) continue
    try {
      const tree = await purgeTreeInto(ctx, home, id, report, graph)
      for (const visitedId of tree.order) visited.add(visitedId)
      unionOrder.push(...tree.order)
      truncated = truncated || tree.truncated
    } catch (error) {
      report.failures.push({ sessionId: id, error: String(error?.message ?? error).slice(0, 300) })
    }
  }
  await sweepTreeTempOutputs(unionOrder, report)
  if (report.failures.length > 0) {
    // Keep the workspace record so surviving sessions stay in their group.
    report.workspaceRecordDeleted = false
    report.cascadeTruncated = truncated
    return report
  }
  const { problems, removed } = await deleteWorkspaceRecord(ctx, home, workspaceId)
  report.wsRefs += removed
  if (problems.length > 0) {
    throw new PurgeError(`工作区内会话已删除，但工作区记录未删净（可直接重试删除）：${problems.join('；')}`)
  }
  report.workspaceRecordDeleted = true
  report.cascadeTruncated = truncated
  return report
}

// --- in-place redaction --------------------------------------------------------

/**
 * Redacts secret values inside a session log without deleting the session —
 * the middle ground between "keep everything" and "purge". The log is a
 * concatenation of independent zstd frames (roughly one per write), so the
 * rewrite preserves the exact frame layout: every frame is decompressed on
 * its own, redacted, recompressed, and the result must round-trip apart
 * from the masked spans.
 *
 * Hard rules (each one earned the hard way):
 *   - refuse sessions an agent is running on or a client holds open: an
 *     append during the rewrite corrupts the log;
 *   - never recompress as one big frame or one frame per line — both alter
 *     the layout (frame count, trailing newline) and break re-reads;
 *   - verify on disk (decompress again, compare, prove the secrets are
 *     gone) and roll back from the in-place backup if anything fails; the
 *     backup is deleted on success because it contains the secrets.
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const REDACT_MAX_SECRETS = 64
const REDACT_MAX_PREFIXES = 64

/** Node >= 23.8 exposes zstd in zlib; older runtimes get a clean 501. */
async function loadZstd() {
  const zlib = await import('node:zlib')
  if (typeof zlib.zstdDecompressSync !== 'function' || typeof zlib.zstdCompressSync !== 'function') return undefined
  return zlib
}

const maskOf = (secret) => `[REDACTED:${secret.slice(0, 4)}…len${secret.length}]`

/** Validate the request body; values never appear in logs or responses. */
function collectSecrets(body) {
  const raw = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value])
  const secrets = []
  for (const item of raw(body?.secrets)) {
    if (typeof item !== 'string') throw new PurgeError('secrets 数组内必须是字符串', 400)
    const value = item.trim()
    if (value.length < 6 || value.length > 512) throw new PurgeError('每个敏感值长度须在 6–512 之间', 400)
    if (!secrets.includes(value)) secrets.push(value)
    if (secrets.length > REDACT_MAX_SECRETS) throw new PurgeError(`敏感值过多（>${REDACT_MAX_SECRETS}）`, 400)
  }
  const prefixes = []
  for (const item of raw(body?.prefixes)) {
    if (typeof item !== 'string') throw new PurgeError('prefixes 数组内必须是字符串', 400)
    const value = item.trim()
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(value)) throw new PurgeError('每个前缀须为 4–32 位字母/数字/_/-（保留前缀、清除后续）', 400)
    if (!prefixes.includes(value)) prefixes.push(value)
    if (prefixes.length > REDACT_MAX_PREFIXES) throw new PurgeError(`前缀过多（>${REDACT_MAX_PREFIXES}）`, 400)
  }
  if (secrets.length === 0 && prefixes.length === 0) throw new PurgeError('secrets 与 prefixes 至少提供一项', 400)
  return { secrets, prefixes }
}

/**
 * Frame starts of a concatenated-zstd log, in file order.
 *
 * Relies on Node's `zstdDecompressSync` stopping at the first frame end of its
 * input — verified on Node 24 (a concatenated stream decodes to the first
 * frame's payload only; a mid-frame offset throws
 * `ZSTD_error_prefix_unknown`; magic bytes inside a payload do not validate as
 * a frame, 0 false positives in 300 trials). That behaviour is not in the zlib
 * documentation; should a runtime change it, the structural checks in
 * `redactLogFile` (frame count, line invariants, secret absence after reread)
 * are the second line of defence.
 */
function zstdFrameStarts(buf, decompressSync) {
  const starts = []
  let off = 0
  while (off < buf.length) {
    const at = off === 0 && buf.subarray(0, 4).equals(ZSTD_MAGIC) ? 0 : buf.indexOf(ZSTD_MAGIC, off)
    if (at === -1) break
    try {
      decompressSync(buf.subarray(at))
      starts.push(at)
    } catch { /* magic bytes inside a payload: not a frame boundary */ }
    off = at + 1
  }
  return starts
}

/** Lines of a session log that fail JSON.parse — a structure invariant. */
const parseFailures = (text) => {
  let count = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { JSON.parse(line) } catch { count++ }
  }
  return count
}

/**
 * Redact one log file in place; the report is masked, never the values.
 *
 * `io` exists so tests can force the one failure this host cannot stage: a
 * backup whose removal fails. The default is the real `node:fs/promises`
 * readFile/writeFile/rename/rm set, and production never passes anything else.
 */
const REDACT_IO = { readFile, writeFile, rename, rm }

async function redactLogFile(file, { secrets, prefixes }, zlib, io = REDACT_IO) {
  const original = await io.readFile(file)
  const starts = zstdFrameStarts(original, zlib.zstdDecompressSync)
  const segments = starts.map((at, index) => zlib.zstdDecompressSync(original.subarray(at, index + 1 < starts.length ? starts[index + 1] : original.length)))
  const before = Buffer.concat(segments).toString('utf8')
  const prefixRules = prefixes.map((prefix) => ({
    prefix,
    source: `${prefix.replace(/[-_]/g, '\\$&')}[A-Za-z0-9_-]+`,
  }))
  const apply = (text) => {
    for (const secret of secrets) text = text.split(secret).join(maskOf(secret))
    for (const rule of prefixRules) {
      text = text.replace(new RegExp(rule.source, 'g'), `${rule.prefix}[REDACTED]`)
    }
    return text
  }
  const redactedSegments = segments.map((segment) => Buffer.from(apply(segment.toString('utf8')), 'utf8'))
  const after = Buffer.concat(redactedSegments).toString('utf8')

  const replacements = {}
  for (const secret of secrets) {
    const hits = before.split(secret).length - 1
    if (hits > 0) replacements[maskOf(secret)] = hits
  }
  for (const rule of prefixRules) {
    const hits = (before.match(new RegExp(rule.source, 'g')) ?? []).length
    if (hits > 0) replacements[`${rule.prefix}[REDACTED]`] = hits
  }
  const entry = { file, changed: false, frames: starts.length, bytesBefore: original.length, bytesAfter: original.length, replacements }
  if (starts.length === 0) {
    // Not a concatenated-zstd stream (empty or corrupt): reporting "no match"
    // would hide that, so the entry carries an explicit note instead.
    entry.note = '未检测到 zstd 帧（文件可能为空或已损坏），未做改写'
    return entry
  }
  if (Object.keys(replacements).length === 0) return entry
  if (after.split('\n').length !== before.split('\n').length || parseFailures(after) !== parseFailures(before)) {
    throw new PurgeError(`替换会破坏日志结构，已放弃：${file}`)
  }
  if (secrets.some((secret) => after.includes(secret))) {
    throw new PurgeError(`脱敏后仍检测到敏感值，已放弃：${file}`)
  }

  // The whole file is replaced, so the written buffer's length IS the new
  // on-disk size — no stat needed.
  const written = Buffer.concat(redactedSegments.map((segment) => zlib.zstdCompressSync(segment)))
  const backup = `${file}.dsh-session-purge.bak`
  await io.writeFile(backup, original)
  try {
    await io.writeFile(file, written)
    const reread = await io.readFile(file)
    const rereadStarts = zstdFrameStarts(reread, zlib.zstdDecompressSync)
    const rereadText = Buffer.concat(rereadStarts.map((at, index) => zlib.zstdDecompressSync(reread.subarray(at, index + 1 < rereadStarts.length ? rereadStarts[index + 1] : reread.length)))).toString('utf8')
    if (rereadText !== after || rereadStarts.length !== starts.length) throw new PurgeError(`写回校验失败：${file}`)
    if (secrets.some((secret) => rereadText.includes(secret))) throw new PurgeError(`写回后仍检测到敏感值：${file}`)
  } catch (error) {
    // Only a failed WRITE may roll back — at this point the file is either
    // still the original (the write never started) or torn, never a verified
    // redaction.
    try { await io.rename(backup, file) } catch { /* the original is intact */ }
    throw error instanceof PurgeError ? error : new PurgeError(`脱敏写回失败（已回滚原文件）：${String(error?.message ?? error)}`)
  }
  entry.changed = true
  entry.bytesAfter = written.length

  // Cleanup is NOT part of the write transaction. Rolling back here would
  // restore the very secrets that were just removed and verified gone, while
  // the caller still reported an error — the redaction succeeded, so a stuck
  // backup is reported instead: the original file is fully redacted and only
  // the backup still holds the unmasked values.
  try {
    await io.rm(backup, { force: true })
  } catch (error) {
    entry.backupResidual = backup
    entry.backupError = String(error?.message ?? error)
  }
  return entry
}

/**
 * Redact every log file of one session; masked report only.
 *
 * Files are independent, so one failing file neither aborts the others nor
 * discards their results: the failure is recorded on the file's entry
 * (`error`) and counted in `failures`, and the session report still comes
 * back. Only request-level problems (bad id, live agent, missing log, no
 * zstd runtime) throw.
 */
async function redactSession(ctx, home, sessionId, body) {
  if (!SESSION_ID_RE.test(sessionId)) throw new PurgeError(`会话 id 不合法：${String(sessionId).slice(0, 80)}`, 400)
  // Only a live agent can append during the rewrite; mere store residency is
  // harmless for an in-place rewrite of files the store does not hold.
  if (agentActive(ctx, sessionId)) throw new PurgeError(`会话正在运行，须待其空闲后再脱敏：${sessionId}`, 409)
  const { secrets, prefixes } = collectSecrets(body)
  // Locate before feature-detecting the runtime: a session with no log is a
  // 404 whatever the Node version, and a 501 first would hide that.
  const dirs = await locateSessionDirs(home, sessionId)
  if (dirs.length === 0) throw new PurgeError(`未找到该会话的磁盘日志：${sessionId}`, 404)
  const zlib = await loadZstd()
  if (!zlib) throw new PurgeError('当前 Node 运行时无 zstd 支持（需 ≥ 23.8），脱敏不可用', 501)
  const report = { sessionId, files: [], totalReplacements: 0, backupsResidual: 0, failures: 0 }
  for (const dir of dirs) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch { continue }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.zstd')) continue
      const path = join(dir, entry.name)
      try {
        const result = await redactLogFile(path, { secrets, prefixes }, zlib)
        report.files.push(result)
        if (result.backupResidual !== undefined) report.backupsResidual++
        for (const hits of Object.values(result.replacements)) report.totalReplacements += hits
      } catch (error) {
        report.failures++
        report.files.push({ file: path, changed: false, error: String(error?.message ?? error).slice(0, 300) })
      }
    }
  }
  report.changedFiles = report.files.filter((item) => item.changed).length
  return report
}

// --- http helpers ------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Whether a WHATWG authority's hostname is loopback. The plugin trusts no
 * configured host list, so loopback is the whole trusted set.
 */
function loopbackHostname(hostname) {
  const name = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/**
 * Request-trust guard shared by every route, reads included. It mirrors the
 * Harness's own `api-request-trust`: the authority must be loopback, a
 * `sec-fetch-site: cross-site` marker is always refused (DNS rebinding and
 * cross-site browser requests), and an attached `Origin` must equal that
 * authority. That is the whole rule — an Origin-less request is accepted.
 *
 * Why an absent Origin cannot be treated as suspicious here: the Desktop
 * client serves its page from the `dsh-app://app` scheme and forwards every
 * HTTP request through the app's own fetch handler, which strips `host`,
 * `origin`, `cookie` and `sec-fetch-site` before the loopback server sees the
 * request. Requiring an explicit Origin therefore rejects the only legitimate
 * client while adding nothing against a browser, whose cross-site requests
 * carry `sec-fetch-site: cross-site` and a mismatching Origin.
 */
function sameOriginReq(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  let authority
  try {
    authority = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!loopbackHostname(authority.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === authority.host
  } catch {
    return false
  }
}

function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((done, fail) => {
    const chunks = []
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > limit) {
        fail(new PurgeError('请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return done({})
      try {
        done(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        fail(new PurgeError('请求体不是合法 JSON', 400))
      }
    })
    req.on('error', () => fail(new PurgeError('请求读取失败', 400)))
  })
}

// --- plugin ------------------------------------------------------------------

export function apply(ctx) {
  /**
   * One mount shape for every route: method check, request-trust guard, body
   * parse (POST only) and the ok/error envelope are shared; the handler just
   * returns the payload. Any thrown PurgeError maps to its status, anything
   * else to 500 with the message truncated.
   */
  const mount = (host, scope, path, method, handler) => scope.effect(() => host.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== method) return sendJson(res, 405, { ok: false, reason: 'method not allowed' })
      if (!sameOriginReq(req)) return sendJson(res, 403, { ok: false, reason: 'same-origin required' })
      try {
        const body = method === 'POST' ? await readJson(req) : undefined
        sendJson(res, 200, { ok: true, ...(await handler(body)) })
      } catch (error) {
        sendJson(res, error instanceof PurgeError ? error.status : 500, {
          ok: false,
          reason: String(error?.message ?? error).slice(0, 300),
        })
      }
    },
  }), `dsh-session-purge: ${path} route`)

  const requireSessionId = (body) => {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId === '') throw new PurgeError('sessionId 必填', 400)
    if (!SESSION_ID_RE.test(sessionId)) throw new PurgeError(`会话 id 不合法：${sessionId.slice(0, 80)}`, 400)
    return sessionId
  }

  const requireWorkspaceId = (body) => {
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : ''
    if (workspaceId === '') throw new PurgeError('workspaceId 必填', 400)
    if (workspaceId.length > 200 || /[\r\n]/.test(workspaceId)) throw new PurgeError(`workspaceId 不合法：${workspaceId.slice(0, 80)}`, 400)
    return workspaceId
  }

  const mountAll = (host, scope) => {
    mount(host, scope, '/_dsh/session-purge/list', 'GET', async () => ({
      sessions: await listSessions(ctx, dshHome(ctx)),
    }))
    mount(host, scope, '/_dsh/session-purge/delete', 'POST', async (body) =>
      purgeTree(ctx, dshHome(ctx), requireSessionId(body)))
    mount(host, scope, '/_dsh/session-purge/delete-workspace', 'POST', async (body) =>
      purgeWorkspace(ctx, dshHome(ctx), requireWorkspaceId(body)))
    mount(host, scope, '/_dsh/session-purge/redact', 'POST', async (body) =>
      redactSession(ctx, dshHome(ctx), requireSessionId(body), body))
  }

  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    mountAll(webServer, ctx)
  } else {
    // A terminal-only profile has no web surface: wait for one to appear
    // (never, in that case) instead of failing to load.
    ctx.inject(['webServer'], (scope) => mountAll(scope.webServer, scope))
  }
}

/**
 * Internal helpers exposed for the unit tests only — not part of the plugin
 * API (Cordis consumes `name`, `inject` and `apply`). Keep this list to what
 * the tests actually import.
 */
export const __internals = {
  SESSION_ID_RE,
  idVariants,
  cascadeOrder,
  listSessions,
  purgeTree,
  purgeWorkspace,
  redactSession,
  redactLogFile,
  sameOriginReq,
  sweepTempOutputs,
  zstdFrameStarts,
}
