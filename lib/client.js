/**
 * dsh-session-purge — client half (web bundle).
 *
 * Two dialogs (permanent delete, in-place redact) serve every entry point:
 *   - sidebar session-row menu     (`sidebar.workspaces.session.menu.item`, 官方槽位)
 *   - Settings panel               (`settings.section`，批量列表)
 *
 * The conversation header action was removed: its only possible target is the
 * conversation being viewed, and the client cannot recognise the selected
 * session (the session store exposes no selection), so the sidebar row menu is
 * the honest place to delete from. The host refuses only sessions that are
 * RUNNING; a session merely held by this window is not refused.
 * In-conversation deletion goes through the sidebar row menu.
 *
 * The dialog lives in `shell.overlay` and opens on the window event
 * `dsh-session-purge:open` carrying { sessionId, title }. Every entry hands the
 * dialog the row's session id directly; no title-based id resolution.
 *
 * Bundle format: classic script registering a factory with the module loader;
 * only `react` is required, all styling is inline with theme-variable
 * fallbacks so a UI update cannot break the plugin on a missing icon export.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-purge',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    // react-dom is part of the frozen platform module table the shell seeds for
    // every dynamic bundle (the shipped boot table carries react-dom and
    // react-dom/client); the fallback only guards a future table change.
    const createPortal = (() => {
      try {
        const reactDom = require('react-dom')
        return typeof reactDom?.createPortal === 'function' ? reactDom.createPortal : null
      } catch {
        return null
      }
    })()
    // The loader resolves ui-primitives as an implicit baseline external, so a
    // native menu item is available when the shell provides it; the self-styled
    // fallback keeps the row menu working in older shells.
    const MenuItemButton = (() => {
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        return primitives?.MenuItemButton ?? null
      } catch {
        return null
      }
    })()

    const EVENT = 'dsh-session-purge:open'
    const REDACT_EVENT = 'dsh-session-purge:redact'
    /** Announced after a confirmed purge so the settings list can re-read the host. */
    const DELETED_EVENT = 'dsh-session-purge:deleted'
    const LIST_URL = '/_dsh/session-purge/list'
    const DELETE_URL = '/_dsh/session-purge/delete'
    const DELETE_WORKSPACE_URL = '/_dsh/session-purge/delete-workspace'
    const REDACT_URL = '/_dsh/session-purge/redact'

    const SLOT_OVERLAY = 'shell.overlay'
    const SLOT_SETTINGS = 'settings.section'
    const SLOT_ROW_MENU = 'sidebar.workspaces.session.menu.item'

    /**
     * Bounded waits for the dangerous routes. The dialogs refuse to close
     * while a request is in flight and fetch would happily wait for minutes,
     * so a hung host would lock the dialog up for that long. On timeout the
     * request is abandoned CLIENT-SIDE only: the dialog unlocks and says the
     * operation may still be running server-side.
     */
    const DELETE_TIMEOUT_MS = 180000
    const REDACT_TIMEOUT_MS = 600000
    // A workspace delete purges every member tree plus one union temp sweep,
    // so it can legitimately take longer than a single session delete.
    const WORKSPACE_TIMEOUT_MS = 600000

    // --- helpers ---------------------------------------------------------------

    /** The client session store, adopted in apply() (may appear later). */
    let sessionStore

    /**
     * The session-list snapshot lives on the store's `list` snapshot store
     * (`{ ids, byId, phase, projectionsBySession }`), not on the store face.
     * Removed sessions arrive through the `api-session/removed` remote event,
     * which the store applies itself — no manual refresh call exists.
     */
    function snapshot() {
      const list = sessionStore?.list
      if (list && typeof list.getSnapshot === 'function') {
        try { return list.getSnapshot() ?? {} } catch { return {} }
      }
      return {}
    }

    function byId() {
      return snapshot().byId ?? {}
    }

    function titleOf(id) {
      const summary = byId()[id]
      const title = summary?.title ?? summary?.displayTitle
      return typeof title === 'string' && title.length > 0 ? title : null
    }

    /** One POST-and-parse shared by every route call; gives up after `timeoutMs`. */
    async function postJson(url, body, timeoutMs) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        if (error?.name === 'AbortError') {
          return { ok: false, error: `请求超时：宿主 ${Math.round(timeoutMs / 1000)}s 内未响应；操作可能仍在后台执行，请稍后确认结果` }
        }
        return { ok: false, error: `请求失败：${String(error?.message ?? error)}` }
      } finally {
        clearTimeout(timer)
      }
      const payload = await response.json().catch(() => null)
      if (payload && payload.ok) return { ok: true, payload }
      return { ok: false, error: payload?.reason ?? `HTTP ${response.status}` }
    }

    /**
     * Human summary of a delete report's temp-output sweep, '' when none.
     * Prefers the host's deduplicated `tempSweepTotal`: per-session entries
     * attribute a shared directory to every session that mentioned it, so
     * summing those can overstate what was actually removed.
     */
    function tempSweepNote(report) {
      const total = report?.tempSweepTotal
      if (total && typeof total === 'object') {
        if (!(Number(total.dirs) > 0)) return ''
        return `，清扫临时输出 ${total.dirs} 个目录（${Number(total.files) || 0} 个文件）`
      }
      const sweeps = Array.isArray(report?.tempSweep) ? report.tempSweep : []
      const dirs = sweeps.reduce((sum, item) => sum + (Number(item?.dirs) || 0), 0)
      if (dirs === 0) return ''
      const files = sweeps.reduce((sum, item) => sum + (Number(item?.files) || 0), 0)
      return `，清扫临时输出 ${dirs} 个目录（${files} 个文件）`
    }

    /**
     * Note for a session the host still holds after the purge: flushed but not
     * evicted means the root object survived, so the ghost row returns after a
     * reload. '' when it was not resident, or was evicted.
     */
    function residentNote(report) {
      const entries = Array.isArray(report?.live) ? report.live : []
      const root = entries.find((entry) => entry?.sessionId === report?.sessionId)
      return root?.flushed === true && root?.evicted === false
        ? '宿主仍驻留该会话，彻底消失需重启客户端'
        : ''
    }

    /** One wording for every completed purge (panel notice and dialog share it). */
    function deleteSummary(sessionId, report) {
      const cascaded = Array.isArray(report?.descendants) ? report.descendants.length : 0
      if (report?.existed === false) {
        return `会话 ${sessionId} 原本已不存在${cascaded > 0 ? `，已级联清理 ${cascaded} 个子代理会话` : '，未做改动'}`
      }
      const truncated = report?.cascadeTruncated === true ? '，级联已达深度上限（可能仍有更深的子代理未删除）' : ''
      const resident = residentNote(report)
      return `已删除 ${sessionId}（释放 ${formatBytes(report?.freedBytes)}${cascaded > 0 ? `，级联 ${cascaded} 个子代理会话` : ''}${truncated}${tempSweepNote(report)}${resident !== '' ? `，${resident}` : ''}）`
    }

    /** One wording for a completed workspace delete (panel notice). */
    function deleteWorkspaceSummary(report) {
      const title = typeof report?.workspaceTitle === 'string' && report.workspaceTitle !== '' ? report.workspaceTitle : (report?.workspaceId ?? '工作区')
      const count = Array.isArray(report?.deleted) ? report.deleted.length : 0
      const failedIds = Array.isArray(report?.failures)
        ? report.failures.map((item) => item?.sessionId).filter((id) => typeof id === 'string' && id !== '')
        : []
      // `workspaceRecordDeleted === false` with no failures means the record was
      // already absent; a partial failure keeps the record on purpose and must
      // not be reported as "missing".
      const recordMissing = report?.workspaceRecordDeleted === false && failedIds.length === 0
      if (recordMissing && count === 0) return `工作区「${title}」不存在或已被删除，未做任何改动`
      const recordNote = recordMissing ? '（工作区记录本就不存在）' : ''
      return `已删除工作区「${title}」：${count} 个会话（释放 ${formatBytes(report?.freedBytes)}${tempSweepNote(report)}）${recordNote}${
        failedIds.length > 0 ? `，${failedIds.length} 个会话删除失败：${failedIds.join('、')}（可单独重试删除）` : ''}`
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let size = value
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit++
      }
      return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
    }

    function formatTime(ms) {
      if (!Number.isFinite(Number(ms))) return ''
      const date = new Date(Number(ms))
      const pad = (n) => (n < 10 ? `0${n}` : String(n))
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    // --- styles ----------------------------------------------------------------
    // Every colour comes from a token the client actually declares (verified
    // against the shipped theme sheets): surfaces `--dsw-alias-bg-layer-*`,
    // text `--dsw-alias-label-primary`, inputs `--dsw-specific-input-major`.
    // The earlier names (`bg-elevated`, `text-primary`, `bg-sunken`) exist
    // nowhere, so their dark/light literals froze the dialog in dark mode
    // while the rest of the client followed the system theme.

    const backdrop = {
      position: 'fixed', inset: 0, zIndex: 2400,
      background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.32))', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 24,
    }
    const panel = {
      width: 'min(560px, 100%)', maxHeight: '80vh', overflow: 'auto',
      background: 'var(--dsw-alias-bg-layer-2, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      borderRadius: 'var(--dsw-radius-lg, 12px)', padding: 20, fontSize: 13, lineHeight: 1.7,
      boxShadow: 'var(--dsw-elevation-panel, 0 18px 48px rgba(0,0,0,.28))',
    }
    const danger = 'var(--dsw-alias-state-error-primary, #e5484d)'
    // Danger is reserved for destructive actions; running is its own (business)
    // state, residue is warning, archived/resident are muted. The armed wash uses
    // the host's danger-hover surface token so custom themes keep matching.
    const dangerWash = 'var(--dsw-alias-interactive-bg-hover-danger, rgba(229,72,77,.06))'
    const runningColor = 'var(--dsw-alias-state-business-primary, #4176e6)'
    const warnText = 'var(--dsw-alias-state-warn-label, #b26b00)'
    const warnDot = 'var(--dsw-alias-state-warn-primary, #f59e0b)'
    const mutedStatus = 'var(--dsw-alias-label-tertiary, #81858c)'
    const muted = { color: 'var(--dsw-alias-label-secondary, currentColor)', opacity: .8, fontSize: 12 }
    // Shipped theme values, read from dsh-client-ui-theme:
    //   border-l1 #0000000a (4% black) · l2 #0000001a (10%) · l3 #0000001f (12%)
    //   dark: l1 #ffffff0f · l2 #ffffff1f · l3 #ffffff29
    // The workspace card deliberately uses l3 for its outline and l2 for the
    // inner rules — the earlier l1 outline was a 4% line that visually vanished.
    const cardBorder = 'var(--dsw-alias-border-l3, rgba(128,128,128,.45))'
    const ruleBorder = 'var(--dsw-alias-border-l2, rgba(128,128,128,.32))'
    const btn = {
      padding: '4px 12px', borderRadius: 'var(--dsw-radius-md, 6px)', fontSize: 12, cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent', color: 'inherit', boxSizing: 'border-box',
    }
    const btnDanger = { ...btn, border: `1px solid ${danger}`, color: danger }
    const btnDisabled = { ...btnDanger, opacity: .4, cursor: 'default' }
    // Fixed width/height keeps the same-position two-click delete from shifting
    // the row or the workspace header when the label changes.
    const rowAction = {
      ...btn, padding: '5px 8px', minHeight: 28, lineHeight: '16px', fontSize: 11,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      whiteSpace: 'nowrap', flexShrink: 0,
    }
    const rowCopy = { ...rowAction, width: 72, padding: '5px 6px', gap: 4 }
    const rowRedact = { ...rowAction, width: 56 }
    const rowDelete = {
      ...btnDanger, width: 72, minHeight: 28, padding: '5px 0', lineHeight: '16px',
      fontSize: 11, textAlign: 'center', flexShrink: 0, whiteSpace: 'nowrap',
    }
    const rowDeleteArmed = { ...rowDelete, background: danger, color: 'var(--dsw-alias-label-primary-foreground, #fff)' }
    const rowDeleteDisabled = { ...rowDelete, opacity: .4, cursor: 'default' }
    const wsDelete = { ...rowDelete, width: 96 }
    const wsDeleteArmed = { ...wsDelete, background: danger, color: 'var(--dsw-alias-label-primary-foreground, #fff)' }
    const wsDeleteDisabled = { ...wsDelete, opacity: .4, cursor: 'default' }
    const actionDivider = {
      width: 1, alignSelf: 'stretch', background: ruleBorder, margin: '2px 0', flexShrink: 0,
    }

    /** A 5px status dot + label; colour carries the state, no pill border. */
    function statusBadge(key, text, dotColor, textColor) {
      return React.createElement('span', {
        key,
        style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: textColor, whiteSpace: 'nowrap', flexShrink: 0 },
      },
        React.createElement('span', { style: { width: 5, height: 5, borderRadius: '50%', background: dotColor, flexShrink: 0 } }),
        text,
      )
    }

    const COPY_ICON = React.createElement('svg', {
      width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
    }, React.createElement('path', {
      d: 'M5.5 5.5V3.5A1.5 1.5 0 0 1 7 2h5A1.5 1.5 0 0 1 13.5 3.5v5A1.5 1.5 0 0 1 12 10h-2M2.5 6.5A1.5 1.5 0 0 1 4 5h5A1.5 1.5 0 0 1 10.5 6.5v5A1.5 1.5 0 0 1 9 13H4A1.5 1.5 0 0 1 2.5 11.5v-5Z',
      stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
    }))

    const CHECK_ICON = React.createElement('svg', {
      width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
    }, React.createElement('path', {
      d: 'm3 8.5 3.2 3.2L13 5',
      stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
    }))

    // --- shared dialog plumbing --------------------------------------------------

    /** Lock facts for one dialog target, enriched from the session snapshot. */
    function dialogFacts(target) {
      const sessionId = typeof target?.sessionId === 'string' ? target.sessionId : null
      const title = target?.title ?? (sessionId !== null ? titleOf(sessionId) : null)
      const running = target?.running === true || (sessionId !== null && byId()[sessionId]?.running === true)
      return { sessionId, title, running }
    }

    /** The lock hint for a dialog verb ('删除' / '脱敏'); null when runnable. */
    function lockHint(verb, facts) {
      if (facts.sessionId === null) return '未能定位该会话，请刷新后重试。'
      if (facts.running) return `该会话正在运行任务，请先停止后再${verb}。`
      return null
    }

    /**
     * Open-event subscription, Escape/backdrop dismissal and the shared lock
     * facts for one dialog. `resetOnOpen` restores the dialog's own fields.
     * The only client lock is a live run — the host's 409 responses (running
     * included) stay the authoritative second line for every other case.
     */
    function useDialogShell(eventName, verb, resetOnOpen) {
      const [target, setTarget] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [done, setDone] = useState(null)
      const resetRef = useRef(resetOnOpen)
      resetRef.current = resetOnOpen

      useEffect(() => {
        const onOpen = (event) => {
          setTarget(event?.detail ?? {})
          setBusy(false)
          setError(null)
          setDone(null)
          if (resetRef.current) resetRef.current()
        }
        window.addEventListener(eventName, onOpen)
        return () => window.removeEventListener(eventName, onOpen)
      }, [eventName])

      const close = useCallback(() => {
        if (busy) return
        setTarget(null)
      }, [busy])

      useEffect(() => {
        if (target === null) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [target, close])

      const facts = target === null ? null : dialogFacts(target)
      const hint = facts === null ? null : lockHint(verb, facts)
      const locked = facts === null || facts.running
      return { target, setTarget, busy, setBusy, error, setError, done, setDone, close, facts, hint, locked }
    }

    function DialogShell(props) {
      const dialog = React.createElement('div', {
        style: backdrop,
        onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose() },
      }, React.createElement('div', { style: panel, role: 'dialog', 'aria-modal': 'true' },
        React.createElement('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 10 } }, props.title),
        props.children,
      ))
      // Portal to <body>. The overlay slot sits deep inside the conversation
      // tree, and an ancestor stacking context there can paint below the
      // settings page, which put the dialog behind it. As a direct child of
      // body its z-index competes only at the root, above the app's own
      // overlay layer (<= 1100).
      return createPortal ? createPortal(dialog, document.body) : dialog
    }

    function PurgeDialog() {
      const shell = useDialogShell(EVENT, '删除')
      if (shell.target === null) return null
      const { facts, hint, locked } = shell
      const sessionId = facts.sessionId

      const confirm = async () => {
        if (sessionId === null || shell.busy) return
        shell.setBusy(true)
        shell.setError(null)
        const result = await postJson(DELETE_URL, { sessionId }, DELETE_TIMEOUT_MS)
        if (result.ok) {
          shell.setDone(result.payload)
          window.dispatchEvent(new CustomEvent(DELETED_EVENT, { detail: { sessionId, payload: result.payload } }))
        } else {
          shell.setError(result.error)
        }
        shell.setBusy(false)
      }

      const done = shell.done
      const cascaded = Array.isArray(done?.descendants) ? done.descendants.length : 0
      const resident = done === null ? '' : residentNote(done)

      return DialogShell({
        title: '永久删除会话',
        onClose: shell.close,
        children: done !== null
          ? React.createElement('div', null,
              React.createElement('div', { style: { marginBottom: 10 } },
                done.existed === false
                  ? (cascaded > 0 ? `根会话原本已不存在；已级联清理 ${cascaded} 个子代理会话。` : '该会话原本已不存在，未做改动。')
                  : '已永久删除，无法恢复。'),
              React.createElement('div', { style: muted },
                `会话：${facts.title ?? sessionId ?? '(未知)'}`,
                React.createElement('br'),
                `释放空间：${formatBytes(done.freedBytes)}${tempSweepNote(done)}`,
                cascaded > 0
                  ? React.createElement(React.Fragment, null, React.createElement('br'), `级联删除子代理会话：${cascaded} 个`)
                  : null,
                done.cascadeTruncated === true
                  ? React.createElement(React.Fragment, null, React.createElement('br'), '级联已达深度上限：可能仍有更深的子代理未删除')
                  : null,
                resident !== ''
                  ? React.createElement(React.Fragment, null, React.createElement('br'), resident)
                  : null,
              ),
              React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 16 } },
                React.createElement('button', { type: 'button', style: btn, onClick: () => shell.setTarget(null) }, '关闭')),
            )
          : React.createElement('div', null,
              React.createElement('div', { style: { marginBottom: 6 } },
                React.createElement('span', { style: { fontWeight: 600 } }, facts.title ?? '（未命名会话）')),
              React.createElement('div', { style: muted },
                sessionId !== null ? `id：${sessionId}` : 'id：未能定位',
              ),
              React.createElement('div', { style: { marginTop: 12, color: danger } },
                '删除将清除磁盘日志、投影缓存、工作区记账与临时工具输出，并级联删除其全部子代理会话；此操作不可恢复。'),
              hint !== null ? React.createElement('div', { style: { marginTop: 8, ...muted } }, hint) : null,
              shell.error !== null
                ? React.createElement('div', { style: { marginTop: 10, color: danger, whiteSpace: 'pre-wrap' }, role: 'alert' }, shell.error)
                : null,
              React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
                React.createElement('button', { type: 'button', style: shell.busy ? { ...btn, opacity: .5 } : btn, disabled: shell.busy, onClick: shell.close }, '取消'),
                React.createElement('button', {
                  type: 'button',
                  style: locked || shell.busy ? btnDisabled : btnDanger,
                  disabled: locked || shell.busy,
                  autoFocus: true,
                  onClick: confirm,
                }, shell.busy ? '删除中…' : '永久删除')),
            ),
      })
    }

    // --- redact dialog -----------------------------------------------------------

    /**
     * One line per processed log file in the redact completion view: failures
     * say so, frameless (corrupt/empty) files carry the host's note, changed
     * files list the masks with their hit counts.
     */
    function redactFileLine(file) {
      const name = (file?.file ?? '').split(/[\\/]/).pop()
      if (file?.error) return `${name}：失败（${file.error}）`
      const detail = Object.entries(file?.replacements ?? {}).map(([mask, hits]) => `${mask} × ${hits}`).join('，') || '无匹配'
      if (file?.changed) return `${name}：${file.frames} 帧，${detail}`
      if (file?.note) return `${name}：${file.note}`
      return `${name}：无需改动，${detail}`
    }

    /** One secret per line; prefixes keep their head and mask the rest. */
    function RedactDialog() {
      const [secrets, setSecrets] = useState('')
      const [prefixes, setPrefixes] = useState('')
      const shell = useDialogShell(REDACT_EVENT, '脱敏', () => { setSecrets(''); setPrefixes('') })
      if (shell.target === null) return null
      const { facts, hint, locked } = shell
      const sessionId = facts.sessionId
      // The confirm gate replaces the old acknowledgement checkbox: there must
      // be something to mask, and the host still validates every value.
      const hasInput = secrets.trim() !== '' || prefixes.trim() !== ''

      const inputStyle = {
        width: '100%', boxSizing: 'border-box', marginTop: 4, marginBottom: 8,
        padding: '6px 8px', borderRadius: 'var(--dsw-radius-md, 6px)', fontSize: 12, fontFamily: 'inherit',
        background: 'var(--dsw-specific-input-major, rgba(128,128,128,.10))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))', color: 'inherit',
      }

      const confirm = async () => {
        if (sessionId === null || shell.busy) return
        const secretList = secrets.split('\n').map((line) => line.trim()).filter(Boolean)
        const prefixList = prefixes.split('\n').map((line) => line.trim()).filter(Boolean)
        shell.setBusy(true)
        shell.setError(null)
        const result = await postJson(REDACT_URL, { sessionId, secrets: secretList, prefixes: prefixList }, REDACT_TIMEOUT_MS)
        if (result.ok) shell.setDone(result.payload)
        else shell.setError(result.error)
        shell.setBusy(false)
      }

      const done = shell.done
      const residuals = done !== null && Array.isArray(done.files)
        ? done.files.filter((file) => typeof file?.backupResidual === 'string' && file.backupResidual !== '')
        : []

      return DialogShell({
        title: '会话日志脱敏',
        onClose: shell.close,
        children: done !== null
          ? React.createElement('div', null,
              React.createElement('div', { style: { marginBottom: 10 } },
                `完成：${done.changedFiles ?? 0} 个文件被改写，共替换 ${done.totalReplacements ?? 0} 处。${
                  (done.failures ?? 0) > 0 ? `另有 ${done.failures} 个文件处理失败（其余文件不受影响）。` : ''}`),
              residuals.length > 0
                ? React.createElement('div', { style: { marginBottom: 10, color: danger, whiteSpace: 'pre-wrap' }, role: 'alert' },
                    `警告：${residuals.length} 个备份文件未能删除，其中仍是脱敏前的明文，请手动删除：`,
                    residuals.map((file) => React.createElement('div', {
                      key: file.backupResidual, style: { wordBreak: 'break-all' },
                    }, `${file.backupResidual}${typeof file.backupError === 'string' && file.backupError !== '' ? `（${file.backupError}）` : ''}`)))
                : null,
              React.createElement('div', { style: muted },
                `会话：${facts.title ?? sessionId}`,
                Array.isArray(done.files) ? done.files.map((file, index) => React.createElement('div', {
                  key: index, style: { marginTop: 6, wordBreak: 'break-all' },
                }, redactFileLine(file))) : null,
              ),
              React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 16 } },
                React.createElement('button', { type: 'button', style: btn, onClick: () => shell.setTarget(null) }, '关闭')),
            )
          : React.createElement('div', null,
              React.createElement('div', { style: { marginBottom: 6 } },
                React.createElement('span', { style: { fontWeight: 600 } }, facts.title ?? '（未命名会话）')),
              React.createElement('div', { style: muted }, sessionId !== null ? `id：${sessionId}` : 'id：未能定位'),
              React.createElement('div', { style: { marginTop: 10 } },
                '敏感值（每行一个，完整值将被替换为掩码）：'),
              React.createElement('textarea', {
                style: { ...inputStyle, minHeight: 64 }, value: secrets, disabled: shell.busy,
                onChange: (event) => setSecrets(event.target.value),
                placeholder: '例如从凭据文件复制的完整密钥（不会在结果中回显）',
              }),
              React.createElement('div', null, '前缀（可选，每行一个：保留前缀、清除其后的连续字母数字）：'),
              React.createElement('textarea', {
                style: { ...inputStyle, minHeight: 48 }, value: prefixes, disabled: shell.busy,
                onChange: (event) => setPrefixes(event.target.value),
                placeholder: '例如已公开的密钥前 8–10 位',
              }),
              React.createElement('div', { style: { marginTop: 8, color: danger } },
                '将原地把磁盘日志中的匹配值替换为掩码（保留对话历史，帧结构不变，写回前备份、校验失败自动回滚）。此操作不可逆；若为密钥泄露，脱敏不能替代轮换。'),
              React.createElement('div', { style: { marginTop: 6, ...muted } },
                '掩码保留值的前 4 位与长度，便于核对替换的是哪个值——因此 6–8 位的短值会泄露大半；短值建议改用「前缀」方式，或考虑全部轮换。'),
              hint !== null ? React.createElement('div', { style: { marginTop: 8, ...muted } }, hint) : null,
              shell.error !== null
                ? React.createElement('div', { style: { marginTop: 10, color: danger, whiteSpace: 'pre-wrap' }, role: 'alert' }, shell.error)
                : null,
              React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
                React.createElement('button', { type: 'button', style: shell.busy ? { ...btn, opacity: .5 } : btn, disabled: shell.busy, onClick: shell.close }, '取消'),
                React.createElement('button', {
                  type: 'button',
                  style: locked || !hasInput || shell.busy ? btnDisabled : btnDanger,
                  disabled: locked || !hasInput || shell.busy,
                  title: hasInput ? '' : '请先填写至少一个敏感值或前缀',
                  onClick: confirm,
                }, shell.busy ? '脱敏中…' : '执行脱敏')),
            ),
      })
    }

    // --- settings panel --------------------------------------------------------

    function PurgePanel() {
      const [state, setState] = useState({ loading: true, rows: [], error: null })
      const [confirmId, setConfirmId] = useState(null)
      const [busyId, setBusyId] = useState(null)
      const [confirmWsId, setConfirmWsId] = useState(null)
      const [busyWs, setBusyWs] = useState(null)
      // Expanded workspace ids — groups always start collapsed (no auto-expand);
      // the set only remembers explicit opens for the lifetime of this mount.
      // A search still opens every group so matches are never hidden.
      const [expanded, setExpanded] = useState(() => new Set())
      const [copied, setCopied] = useState(false)
      const [copiedId, setCopiedId] = useState(null)
      const [notice, setNotice] = useState(null)
      const [showAll, setShowAll] = useState(true)
      const [query, setQuery] = useState('')

      const load = useCallback(async () => {
        setState((prev) => ({ ...prev, loading: true, error: null }))
        try {
          const response = await fetch(LIST_URL, { headers: { Accept: 'application/json' } })
          const payload = await response.json().catch(() => null)
          if (payload && payload.ok) setState({ loading: false, rows: payload.sessions ?? [], error: null })
          else setState({ loading: false, rows: [], error: payload?.reason ?? `HTTP ${response.status}` })
        } catch (err) {
          setState({ loading: false, rows: [], error: String(err?.message ?? err) })
        }
      }, [])

      useEffect(() => { load() }, [load])

      // A purge confirmed in the sidebar's dialog must refresh this open list.
      useEffect(() => {
        const onDeleted = (event) => {
          const payload = event?.detail?.payload
          if (payload) setNotice(deleteSummary(event.detail.sessionId, payload))
          load()
        }
        window.addEventListener(DELETED_EVENT, onDeleted)
        return () => window.removeEventListener(DELETED_EVENT, onDeleted)
      }, [load])

      const q = query.trim().toLowerCase()
      const searching = q !== ''

      const titleOfRow = (row) => (typeof row?.title === 'string' && row.title !== '' ? row.title : null)

      // Subagent sessions are deliberately not listed here: they carry no
      // per-subagent lifecycle in this panel and are removed together with
      // their parent by the cascade in every main-session delete.
      const rows = state.rows
        .filter((row) => row.origin !== 'subagent')
        .filter((row) => (showAll ? true : !row.exists))
      const matched = q === ''
        ? rows
        : rows.filter((row) => [titleOfRow(row), row.id, row.cwd, row.workspace]
            .some((value) => typeof value === 'string' && value.toLowerCase().includes(q)))

      // One destructive request at a time: the row buttons and the keyboard
      // confirm both read this, so a second Enter cannot start a parallel
      // delete while the first is still in flight.
      const anyBusy = busyId !== null || busyWs !== null

      const remove = async (id) => {
        if (busyId !== null || busyWs !== null) return
        setBusyId(id)
        setState((prev) => ({ ...prev, error: null }))
        const result = await postJson(DELETE_URL, { sessionId: id }, DELETE_TIMEOUT_MS)
        if (result.ok) {
          setNotice(deleteSummary(id, result.payload))
          setConfirmId(null)
          await load()
        } else {
          setNotice(null)
          setState((prev) => ({ ...prev, error: result.error }))
        }
        setBusyId(null)
      }

      const removeWorkspace = async (workspaceId) => {
        if (busyId !== null || busyWs !== null) return
        setBusyWs(workspaceId)
        setState((prev) => ({ ...prev, error: null }))
        const result = await postJson(DELETE_WORKSPACE_URL, { workspaceId }, WORKSPACE_TIMEOUT_MS)
        if (result.ok) {
          setNotice(deleteWorkspaceSummary(result.payload))
          setConfirmWsId(null)
          await load()
        } else {
          setNotice(null)
          setState((prev) => ({ ...prev, error: result.error }))
        }
        setBusyWs(null)
      }

      const toggleGroup = (id) => {
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const copyId = async (id) => {
        try {
          await navigator.clipboard.writeText(id)
          setCopiedId(id)
          setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500)
        } catch {
          setNotice(`复制失败；会话 ID：${id}`)
        }
      }

      const copyResetCommand = async () => {
        try {
          await navigator.clipboard.writeText(RESET_UI_COMMAND)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch { /* clipboard unavailable: the command text is selectable anyway */ }
      }

      // The armed row disarms itself after a while, so a stale "确认删除" can
      // never be hit by a later stray click. The armed button itself is the
      // same fixed-position control (second click confirms); Enter on an
      // interactive control is left to that control, while Enter on empty space
      // still confirms and Escape cancels. Exactly one confirm can be armed —
      // a session row OR a workspace — so one keydown listener decides.
      useEffect(() => {
        if (confirmId === null && confirmWsId === null) return undefined
        const timer = setTimeout(() => { setConfirmId(null); setConfirmWsId(null) }, 10000)
        const onKey = (event) => {
          if (busyId !== null || busyWs !== null) return
          if (event.key === 'Escape') { setConfirmId(null); setConfirmWsId(null); return }
          if (event.key !== 'Enter' || event.defaultPrevented) return
          const tag = String(event.target?.tagName ?? '').toUpperCase()
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'A') return
          if (confirmId !== null) remove(confirmId)
          else if (confirmWsId !== null) removeWorkspace(confirmWsId)
        }
        window.addEventListener('keydown', onKey)
        return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey) }
      }, [confirmId, confirmWsId, busyId, busyWs])

      // 全部会话 / 仅缓存记账 as one segmented control: the active side gets
      // the tinted background, which reads as a state rather than two buttons.
      const segmented = React.createElement('div', {
        style: {
          display: 'inline-flex', overflow: 'hidden',
          border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
          borderRadius: 'var(--dsw-radius-md, 6px)',
        },
      },
        React.createElement('button', {
          type: 'button',
          style: {
            padding: '3px 10px', fontSize: 12, border: 'none', cursor: 'pointer', color: 'inherit',
            background: showAll ? 'var(--dsw-specific-input-major, rgba(128,128,128,.18))' : 'transparent',
          },
          onClick: () => setShowAll(true),
        }, '全部会话'),
        React.createElement('button', {
          type: 'button',
          style: {
            padding: '3px 10px', fontSize: 12, border: 'none', borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))', cursor: 'pointer', color: 'inherit',
            background: !showAll ? 'var(--dsw-specific-input-major, rgba(128,128,128,.18))' : 'transparent',
          },
          onClick: () => setShowAll(false),
        }, '仅缓存记账'),
      )

      const head = React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 } },
        segmented,
        React.createElement('button', { type: 'button', style: btn, onClick: load }, state.loading ? '刷新中…' : '刷新'),
        React.createElement('input', {
          type: 'search',
          value: query,
          placeholder: '搜索标题 / id / 目录…',
          onChange: (event) => setQuery(event.target.value),
          style: { ...btn, flex: '0 1 220px', minWidth: 140, padding: '3px 8px', cursor: 'text' },
        }),
        React.createElement('span', { style: muted }, `共 ${matched.length} 条`),
      )

      // A session renders as a flat list item INSIDE its workspace container:
      // hairline separators instead of boxed cards, so the group reads as one
      // unit. `ri === 0` skips the divider under the header's own separator.
      const renderRow = (row, ri) => {
        const locked = row.running || anyBusy
        const busyHint = anyBusy && !row.running && busyId !== row.id ? '另一个删除操作正在进行，请稍候' : null
        const armed = confirmId === row.id
        const badges = []
        if (row.running) badges.push(statusBadge('running', '运行中', runningColor, runningColor))
        if (row.open === true) badges.push(statusBadge('resident', '驻留', mutedStatus, mutedStatus))
        if (row.archived) badges.push(statusBadge('archived', '已归档', mutedStatus, mutedStatus))
        if (!row.exists) badges.push(statusBadge('cache', '仅缓存记账', warnDot, warnText))
        else if (row.headered === false) badges.push(statusBadge('disk', '仅磁盘日志', warnDot, warnText))
        const title = row.title ?? '（未命名会话）'
        const detail = `id：${row.id}${typeof row.cwd === 'string' && row.cwd !== '' ? `\ncwd：${row.cwd}` : ''}`
        const meta = [formatBytes(row.sizeBytes), formatTime(row.createdAt)].filter(Boolean).join(' · ')
        const shortId = row.id.length > 12 ? `…${row.id.slice(-10)}` : row.id
        const deleteStyle = locked ? rowDeleteDisabled : (armed ? rowDeleteArmed : rowDelete)
        return React.createElement('div', {
          key: row.id,
          title: detail,
          style: {
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px 8px 32px',
            borderTop: ri === 0 ? undefined : `1px solid ${ruleBorder}`,
            transition: 'background .12s ease',
            background: armed ? dangerWash : 'transparent',
          },
          onMouseEnter: (event) => { event.currentTarget.style.background = armed ? dangerWash : 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08))' },
          onMouseLeave: (event) => { event.currentTarget.style.background = armed ? dangerWash : 'transparent' },
        },
          React.createElement('div', { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 } },
              React.createElement('span', {
                title,
                style: { fontWeight: 600, lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '0 1 auto' },
              }, title),
              badges.length > 0 ? badges : null,
            ),
            React.createElement('div', { style: { ...muted, marginTop: 2, lineHeight: '16px', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
              React.createElement('span', { style: { whiteSpace: 'nowrap', flexShrink: 0 } }, meta),
              React.createElement('span', {
                title: row.id,
                style: { fontFamily: 'Consolas, Menlo, monospace', fontSize: 11, opacity: .65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
              }, shortId),
            ),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' } },
            React.createElement('button', {
              type: 'button',
              style: rowCopy,
              title: copiedId === row.id ? '已复制会话 ID' : '复制会话 ID',
              onClick: () => copyId(row.id),
              onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08))' },
              onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
            }, copiedId === row.id ? CHECK_ICON : COPY_ICON, copiedId === row.id ? '已复制' : '复制 ID'),
            React.createElement('button', {
              type: 'button',
              style: locked ? { ...rowRedact, opacity: .4, cursor: 'default' } : rowRedact,
              disabled: locked,
              title: row.running ? '运行中的会话不可操作' : (busyHint ?? '把敏感值掩码写入该会话日志（保留会话）'),
              onMouseEnter: (event) => {
                if (locked) return
                event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08))'
              },
              onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
              onClick: () => {
                setNotice(null)
                setConfirmId(null)
                window.dispatchEvent(new CustomEvent(REDACT_EVENT, {
                  detail: { sessionId: row.id, title: row.title, running: row.running, open: row.open },
                }))
              },
            }, '脱敏'),
            React.createElement('span', { key: 'divider', style: actionDivider, 'aria-hidden': true }),
            React.createElement('button', {
              type: 'button',
              style: deleteStyle,
              disabled: locked,
              title: armed
                ? '再次点击确认永久删除（Esc / 10 秒后取消）'
                : row.running
                  ? '运行中的会话不可删除'
                  : (busyHint ?? '删除需点击两次：第一次进入确认，第二次执行'),
              onMouseEnter: (event) => {
                if (locked) return
                event.currentTarget.style.background = armed ? danger : 'var(--dsw-alias-interactive-bg-hover-danger, rgba(229,72,77,.06))'
              },
              onMouseLeave: (event) => {
                event.currentTarget.style.background = armed ? danger : 'transparent'
              },
              onClick: () => {
                if (armed) remove(row.id)
                else {
                  // Keep the previous notice while arming: removing a line above
                  // the list changes the pane's scroll height, and the browser's
                  // scroll anchoring then moves the pane before the second click.
                  // A successful delete replaces it; a failed one clears it.
                  setConfirmWsId(null)
                  setConfirmId(row.id)
                }
              },
            }, busyId === row.id ? '删除中…' : (armed ? '确认删除' : '删除')),
          ),
        )
      }

      // Group the matched rows by their workspace. Named groups come first
      // (Chinese collation), the ungrouped tail last; rows inside a group keep
      // the global newest-first order.
      const groupList = []
      const groupsById = new Map()
      for (const row of matched) {
        const key = typeof row.workspaceId === 'string' && row.workspaceId !== '' ? row.workspaceId : ''
        let group = groupsById.get(key)
        if (group === undefined) {
          group = { id: key, name: key === '' ? null : (row.workspace ?? key), rows: [] }
          groupsById.set(key, group)
          groupList.push(group)
        }
        group.rows.push(row)
      }
      const collator = new Intl.Collator('zh')
      groupList.sort((a, b) => {
        if (a.id === '') return 1
        if (b.id === '') return -1
        return collator.compare(a.name ?? a.id, b.name ?? b.id)
      })

      // A workspace renders as ONE container card: a single toggle row (the
      // whole left side expands/collapses) and a fixed-position delete control.
      // The delete keeps the same slot across its two clicks: first click arms,
      // second click deletes; Escape / 10 s cancel. No separate cancel button
      // and no layout shift. Ungrouped stays deliberately quieter.
      const renderGroup = (group, isFirst) => {
        const bytes = group.rows.reduce((sum, row) => sum + (Number(row.sizeBytes) || 0), 0)
        const running = group.rows.some((row) => row.running)
        const residue = group.rows.filter((row) => !row.exists || row.headered === false).length
        const busy = busyWs === group.id
        const otherBusy = busyId !== null || (busyWs !== null && !busy)
        const armed = confirmWsId === group.id
        // A non-empty search forces every group open: matches hidden inside a
        // collapsed group would look like the filter lost them.
        const open = searching || expanded.has(group.id)
        const container = {
          border: `1px solid ${armed ? danger : (group.id === '' ? ruleBorder : cardBorder)}`,
          borderRadius: 'var(--dsw-radius-md, 8px)',
          // Default settings card lists use 8–10px (models 8, plugins 10);
          // 16px made a column of collapsed groups read as separate pages.
          marginTop: isFirst ? 0 : 10,
          overflow: 'hidden',
          background: armed ? dangerWash : 'transparent',
        }
        const headerBox = {
          display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
          borderBottom: open ? `1px solid ${ruleBorder}` : undefined,
        }
        const name = group.id === '' ? '未分组' : (group.name ?? group.id)
        const toggleTitle = open ? `收起「${name}」的会话列表` : `展开「${name}」的会话列表`
        const nameStyle = group.id === ''
          ? { fontWeight: 600, fontSize: 14, color: 'var(--dsw-alias-label-secondary, inherit)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '0 1 auto' }
          : { fontWeight: 700, fontSize: 14, letterSpacing: '.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '0 1 auto' }
        const toggle = React.createElement('div', {
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          style: { flex: 1, minWidth: 0, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3 },
          title: toggleTitle,
          onClick: () => toggleGroup(group.id),
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            toggleGroup(group.id)
          },
        },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, lineHeight: '20px' } },
            React.createElement('span', {
              style: { flexShrink: 0, width: 12, textAlign: 'center', color: 'var(--dsw-alias-label-secondary, inherit)' },
            }, open ? '▾' : '▸'),
            React.createElement('span', { style: nameStyle }, name),
            residue > 0 ? React.createElement('span', {
              style: { fontSize: 11, color: warnText, whiteSpace: 'nowrap', flexShrink: 0 },
            }, `⚠ ${residue} 残留`) : null,
          ),
          React.createElement('div', {
            style: { ...muted, marginLeft: 20, lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
          }, `${group.rows.length} 个会话 · ${formatBytes(bytes)}`, running ? React.createElement('span', { style: { color: runningColor } }, ' · 有运行中') : null),
        )
        const deleteButton = group.id !== '' ? React.createElement('button', {
          type: 'button',
          style: (busy || otherBusy || running)
            ? wsDeleteDisabled
            : (armed ? wsDeleteArmed : wsDelete),
          disabled: busy || otherBusy || running,
          title: otherBusy
            ? '另一个删除操作正在进行，请稍候'
            : running
              ? '工作区内有运行中的会话，请先停止'
              : armed
                ? '再次点击确认永久删除工作区（Esc / 10 秒后取消）'
                : '删除该工作区及其全部会话（含子代理级联），不可恢复；点击两次确认',
          onMouseEnter: (event) => {
            if (busy || otherBusy || running) return
            event.currentTarget.style.background = armed ? danger : 'var(--dsw-alias-interactive-bg-hover-danger, rgba(229,72,77,.06))'
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.background = armed ? danger : 'transparent'
          },
          onClick: () => {
            if (armed) removeWorkspace(group.id)
            else {
              // Same reason as the row delete: do not drop the notice line while
              // the two-click confirm is armed.
              setConfirmId(null)
              setConfirmWsId(group.id)
            }
          },
        }, busy ? '删除中…' : (armed ? '确认删除工作区' : '删除工作区')) : null
        const header = React.createElement('div', { style: headerBox }, toggle, deleteButton)
        return React.createElement('div', { key: `ws:${group.id}`, style: container },
          [header, ...(open ? group.rows.map((row, ri) => renderRow(row, ri)) : [])])
      }

      const body = state.loading && state.rows.length === 0
        ? React.createElement('div', { style: muted }, '加载中…')
        : matched.length === 0
          ? React.createElement('div', { style: muted }, q !== '' ? '没有匹配的会话。' : (showAll ? '没有任何会话。' : '没有仅剩缓存记账的残留会话。'))
          : groupList.flatMap((group, gi) => [renderGroup(group, gi === 0)])

      const preStyle = {
        flex: 1, minWidth: 0, margin: 0, padding: '6px 8px', fontSize: 11, lineHeight: 1.5,
        fontFamily: 'Consolas, Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        userSelect: 'all', color: 'inherit',
        background: 'var(--dsw-specific-input-major, rgba(128,128,128,.10))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        borderRadius: 'var(--dsw-radius-md, 6px)',
      }

      const intro = React.createElement('div', {
        style: {
          marginBottom: 12, paddingBottom: 10,
          borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
        },
      },
        React.createElement('div', {
          role: 'heading',
          'aria-level': 2,
          style: { fontSize: 15, fontWeight: 600, letterSpacing: '.1px' },
        }, '会话清理'),
        React.createElement('div', { style: { ...muted, marginTop: 4, lineHeight: 1.7 } },
          '按工作区分组查看会话。删除不可恢复；脱敏只改写本地日志。'),
      )

      return React.createElement('div', { style: { padding: '10px 0 24px', fontSize: 13 } },
        intro,
        head,
        notice !== null ? React.createElement('div', { role: 'status', style: { ...muted, marginBottom: 8 } }, notice) : null,
        state.error !== null ? React.createElement('div', { style: { color: danger, marginBottom: 8, whiteSpace: 'pre-wrap' }, role: 'alert' }, state.error) : null,
        body,
        React.createElement('div', { style: { marginTop: 18, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))' } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '重置页面 UI 布局'),
          React.createElement('div', { style: { ...muted, marginBottom: 6, lineHeight: 1.7 } },
            '按 F12 打开控制台，粘贴下面两行并回车：清除布局记录后立即重载界面。不动快捷键与草稿；若重载后页面空白，手动重启客户端。'),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'stretch' } },
            React.createElement('pre', { style: preStyle }, RESET_UI_COMMAND),
            React.createElement('button', {
              type: 'button',
              style: copied ? { ...btn, opacity: .6 } : btn,
              title: '复制指令到剪贴板',
              onClick: copyResetCommand,
            }, copied ? '已复制' : '复制'),
          ),
        ),
      )
    }

    // --- sidebar row-menu slot -----------------------------------------------
    // The shipped row menu renders from the `sidebar.workspaces.session.menu.item`
    // slot list; an entry receives the row identity (sessionId, displayTitle)
    // directly. Prefer the shell's native MenuItemButton when the loader exposes
    // it; the self-styled fallback keeps older shells working.

    const TRASH_ICON = React.createElement('svg', {
      width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
    }, React.createElement('path', {
      d: 'M6 2h4M3.5 4h9M5 4l.5 8.5h5L11 4M7 6.5v4M9 6.5v4',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    }))

    function SidebarRowAction(props) {
      const menuState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null
      const setMenuOpen = Array.isArray(menuState) ? menuState[1] : null
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : null
      // Running sessions stay selectable: the dialog locks itself and explains
      // that the task must stop first, instead of a menu item that silently
      // changes shape.
      const label = React.createElement('span', {
        title: '永久删除该会话（不可恢复）',
        style: { display: 'inline-flex', alignItems: 'center', gap: 8, width: '100%', color: danger },
      }, TRASH_ICON, '永久删除会话')
      const activate = () => {
        if (typeof setMenuOpen === 'function') setMenuOpen(false)
        window.dispatchEvent(new CustomEvent(EVENT, {
          detail: { sessionId, title: typeof props.displayTitle === 'string' ? props.displayTitle : null },
        }))
      }
      if (MenuItemButton !== null) {
        return React.createElement(MenuItemButton, { separatorBefore: true, onSelect: activate }, label)
      }
      return React.createElement(React.Fragment, null,
        React.createElement('div', { style: { height: 1, background: ruleBorder, margin: '4px 8px' } }),
        React.createElement('button', {
          role: 'menuitem',
          type: 'button',
          style: {
            display: 'flex', alignItems: 'center', width: '100%',
            padding: '6px 12px', border: 'none', background: 'transparent',
            font: 'inherit', fontSize: 13, lineHeight: '20px', textAlign: 'left',
            borderRadius: 6, cursor: 'pointer',
          },
          onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))' },
          onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
          onClick: activate,
        }, label))
    }

    // --- layout reset (console command) ------------------------------------------
    // The panel only offers the instruction: resetting the page layout is a
    // rare, console-shaped operation. The command clears ONLY the layout
    // whitelist (shortcuts and drafts stay) and is two semicolon-terminated
    // statements on two lines, because the DevTools console executes a pasted
    // multi-line input on the next Enter.
    const RESET_UI_COMMAND = "['dsh.sidebar-right.v1','dsh.sidebar-browser.v1','dsh.workspace.view.v5','dsh.conversation.contentWidth','dsh.trajectory'].forEach(p=>Object.keys(localStorage).filter(k=>k.startsWith(p)).forEach(k=>localStorage.removeItem(k)));\nlocation.reload();"

    // --- apply -----------------------------------------------------------------

    function apply(ctx) {
      sessionStore = ctx.get('sessions')
      if (!sessionStore) {
        ctx.inject(['sessions'], (scope) => { sessionStore = scope.sessions })
      }
      ctx.slots.inject(SLOT_OVERLAY, () => ctx.slots.register({
        name: SLOT_OVERLAY,
        id: 'session-purge-dialog',
        order: 120,
      }, PurgeDialog))
      ctx.slots.inject(SLOT_OVERLAY, () => ctx.slots.register({
        name: SLOT_OVERLAY,
        id: 'session-purge-redact',
        order: 121,
      }, RedactDialog))
      ctx.slots.inject(SLOT_SETTINGS, () => ctx.slots.register({
        name: SLOT_SETTINGS,
        id: 'session-purge',
        order: 45,
        label: '会话清理',
      }, PurgePanel))
      ctx.slots.inject(SLOT_ROW_MENU, () => ctx.slots.register({
        name: SLOT_ROW_MENU,
        id: 'session-purge-row-delete',
        order: 500,
      }, SidebarRowAction))
    }

    return { apply, inject: ['slots'] }
  },
})
