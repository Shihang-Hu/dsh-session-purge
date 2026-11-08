# dsh-session-purge

English | [简体中文](README.md)

> [!IMPORTANT]
> Community third-party plugin, not affiliated with DeepSeek. All touchpoints are internal Harness implementation surfaces (undocumented API).
> Compatibility baseline: `@deepseek-ai/dsh-desktop` **0.2.2-rc.1** (Windows x64, nightly channel; 0.2.1-rc.3/rc.5 touchpoint audits 2026-10-26/30; 0.2.2-rc.1 host touchpoints re-checked and the list route exercised 2026-11-09, delete/redact not re-run end-to-end). Nightly updates may **break compatibility silently** — after upgrading DSH, run `node --test test/purge.test.mjs` (expect 41/41).

> [!WARNING]
> **Deletion is permanent; there is no recycle bin.** Redaction only rewrites local log files and is **not a substitute for key rotation**.

Two operations for DeepSeek Harness session data:

- **Permanent delete**: on-disk logs + projection cache + workspace accounting + tool-output temp files, cascading to all subagent sessions;
- **In-place redaction**: masks secret values (full value / prefix) inside the session's zstd log, preserving history and the frame structure.

## Entry points

| Entry | Location |
|---|---|
| Settings → **Session cleanup** | Session list grouped by workspace, all groups collapsed by default (search opens them); single-session delete (two clicks in the same fixed slot, Esc/10 s auto-disarm), redaction dialog, "Delete workspace" (two clicks in a fixed group-header slot; any member running → 409 for the whole request; partial failure keeps the workspace and reports `failures[]`), search and "cache accounting only" filter; disk-only directories without a header are listed too (badge "disk log only") |
| Session row "…" menu | "Permanently delete session" item (icon + separator; running sessions open the dialog, which locks and explains; official slot `sidebar.workspaces.session.menu.item`); deletes the session without switching the current conversation |

The panel starts with a "Session cleanup" title, a one-line description and a divider. State colors: red = delete/armed, blue = running, amber = cache/disk residue, gray = archived/resident/metadata. Each session row has a dedicated "Copy ID" button (it shows "Copied" in place for a moment), and the delete button stays fixed at the far right. The completion dialog reports freed bytes, cascade counts and the temp-sweep summary; all dialog colors come from host theme tokens and follow light/dark themes.

## Page layout reset

The client has no built-in entry; the "Session cleanup" panel footer offers the instruction (F12 → Console, paste, execute; if the reload lands blank, restart the client manually):

```js
['dsh.sidebar-right.v1','dsh.sidebar-browser.v1','dsh.workspace.view.v5','dsh.conversation.contentWidth','dsh.trajectory'].forEach(p=>Object.keys(localStorage).filter(k=>k.startsWith(p)).forEach(k=>localStorage.removeItem(k)));
location.reload();
```

Clears the layout whitelist only (prefix matching covers per-session keys); keybindings, drafts, terminal and schedules untouched. Alternatives: wider `localStorage.clear()`; stricter (exact boundaries + legacy boot-flag key):

```js
['dsh.sidebar-right.v1','dsh.sidebar-browser.v1','dsh.workspace.view.v5','dsh.conversation.contentWidth','dsh.trajectory.duration','dsh.trajectory.jsonStringWrapping','dsh.session-purge.reset-layout-on-boot'].forEach((p)=>Object.keys(localStorage).filter((k)=>k===p||k.startsWith(p+'.')).forEach((k)=>localStorage.removeItem(k)));location.reload()
```

## Delete semantics

```
ctx.get('sessions')                              → live session: flush (resident object evicted when no proxy holds it)
ctx.get('storageDomain') → 'session_projcache'   → projection cache rows (domain + file, two layers)
ctx.get('storageDomain') → 'workspace'           → workspace accounting + archived/pinned sets (domain + file, two layers)
$DSH_HOME/sessions/<projectKey>/<id>/            → on-disk log directory
%TEMP%/dsh-{subprocess,spill,acl-skill,...}-*    → tool-output directories whose content mentions the session id (attributed sweep)
header.parentSession === id                      → subagent cascade
ctx.emit('api-session/removed')                  → notify all clients to refresh
```

- Ordering: logs are deleted and verified first, then the accounting (a half-deleted session never falls out of its group); post-verification per layer — anything not cleaned reports an explicit error and can be retried directly;
- Workspace records go through the harness's `workspaceRegistry.delete()` (pendingMutation protocol: a process that exits mid-delete is completed at next startup); without that service the fallback writes the same marker and rolls the order back when the record write fails;
- Guardrails: session id must match `session-<uuid>`, a bare uuid, or a bridge id (case-insensitive); **running sessions refuse (409)**; cascade depth cap `MAX_CASCADE_DEPTH = 8`, reported as `cascadeTruncated: true`; resident sessions are allowed (flushed first); paths must stay inside the expected roots; **symlinks always refused**; Node `fs` only, never a shell;
- Layout guard: before deleting or redacting, the host's `sessionPersistence.stat().location` is cross-checked; a log outside `$DSH_HOME/sessions/`, or not inside a directory about to be removed, is refused with **503** (fail closed instead of cleaning accounting or rewriting a stale file while the real log survives); hosts without that API skip the check;
- Missing targets stay idempotent: a session returns `ok` with `existed: false` (the client says it was already gone); a workspace reports `workspaceRecordDeleted: false` instead of claiming a record was removed;
- Disk-only residue: a directory that outlived both its header and its projection row is listed too (`headered: false`, badged "disk log only") and can be deleted on its own; its subagent parentage is unknown;
- `live[]` entries are `{ sessionId, flushed, evicted, existed }`: `flushed: true && evicted: false` means the host still holds the session, and the client says a restart is needed for it to disappear;
- The TEMP sweep is **content-attributed** (only directories whose content mentions the id are deleted), bounded by a file-count/byte budget (`budgetHit`); one sweep per cascade, so per-session `tempSweep[].dirs` can sum to more than actually deleted (the client summary uses the deduplicated `tempSweepTotal`).

## Redaction semantics

Frame-by-frame decompress → replace → recompress; frame count and line structure preserved. Backup before write-back, full re-read verification after (content identical + secrets absent + frame count identical); failure rolls back automatically; **the backup is deleted immediately on success**. A failed backup cleanup does not roll back (that would restore plaintext); it reports `backupResidual`/`backupError`, and the completion dialog lists the backup paths that could not be removed. One file failing never interrupts the others.

- `secrets`: full values (6–512 chars, ≤64 items) → masked as `[REDACTED:xxxx…lenNN]` (first 4 chars + total length kept); 6–8 char values leak most of themselves — prefer `prefixes` or key rotation;
- `prefixes`: known prefixes (4–32 chars of `[A-Za-z0-9_-]`, ≤64 items); prefix kept, the trailing `[A-Za-z0-9_-]` run cleared;
- Only "running" is refused (409); do not redact the session you are **currently viewing** (UI state unverified);
- Requires the zlib zstd API of Node ≥ 23.8 (feature-detected; without it the route returns 501, everything else works).

## Layout and interface

```
dsh-session-purge/
├── package.json          # manifest: dsh.bundle.patch + dsh.client declarations
├── cordis.patch.yml      # bundle layer: inserts the plugin row into a profile
├── lib/index.js          # host half: delete/redact pipelines + four same-origin HTTP routes
├── lib/client.js         # client half: dialogs / settings panel / sidebar row menu
└── test/purge.test.mjs   # unit tests (fake ctx + temp DSH home)
```

Trust model identical to the host's `api-request-trust`: principal must be loopback; `sec-fetch-site: cross-site` always refused; when `Origin` is present it must equal the principal (the desktop client forwards via `dsh-app://`, which strips `Origin`, hence missing-Origin passes).

```
GET  /_dsh/session-purge/list             → { ok, sessions: [...] } (rows carry workspaceId / workspace / headered)
POST /_dsh/session-purge/delete           → { sessionId } → { ok, deleted[], freedBytes, projRows, wsRefs, tempSweep[], tempSweepTotal, live[], descendants[], cascadeTruncated, existed }
POST /_dsh/session-purge/delete-workspace → { workspaceId } → { ok, workspaceId, workspaceTitle, deleted[], failures[], freedBytes, projRows, wsRefs, tempSweep[], tempSweepTotal, workspaceRecordDeleted, cascadeTruncated }
POST /_dsh/session-purge/redact           → { sessionId, secrets?, prefixes? } → { ok, files[], totalReplacements, backupsResidual, failures }
```

## Install (modifies your DSH profile)

Clone or download this repository (no npm dependencies), then **choose exactly one**: add `dsh-session-purge` to the profile's bundles list, or `insert` a row `name: 'dsh-session-purge'` into the profile's `cordis.patch.yml`. Doing both loads the plugin twice. On desktop no restart is needed (the `dsh-hmr` hot-loads the plugin row).

## Tests

```powershell
node --test test/purge.test.mjs
```

Currently **41/41** (Node 24.21; runtimes without zstd skip the redaction cases).

## Known limitations (stated as-is)

- **No recycle bin**; `attachments` reference counting is not reclaimed;
- The TEMP sweep is content-attributed: outputs that never mention the session id survive;
- **Deleting the currently viewed session is not blocked host-side** (no window guard); its subsequent UI behavior is unverified end-to-end;
- Subagents are not listed in the panel (cleanup relies on the main-session cascade); the conversation page's subagent family entries are a derived projection of the parent log and linger until rebuilt (disk and accounting are already clean); header-less orphan subagents are listed as "disk log only" rows and can be deleted individually, but cannot cascade by parent;
- After deleting a resident session: if the host still holds an agent object, it is conservatively skipped; the client says the host still holds it and a restart is needed for it to disappear; the ghost row stays until restart;
- Electron render cache may retain recently rendered content briefly (inferred, not verified end-to-end);
- End-to-end status: the three routes and two entries were verified on a real DSH 0.2.0-rc.2; since 0.2.1-rc.3 compatibility rests on the static touchpoint audit (2026-10-26); on 0.2.2-rc.1 (2026-11-09) the host touchpoints were re-checked and the list route exercised, but delete/redact and guards like "running refusal" were not re-triggered against real data.

Change history: [CHANGELOG.md](CHANGELOG.md) (from 0.3.4).
