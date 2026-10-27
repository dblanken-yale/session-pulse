import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { PulseBg } from '../types'

// Session pulse: a band above the prompt that shows progress on background
// work, and only while there is some. It appears when a background task starts
// and clears a short while after the last one ends. /pulse opens the same rows
// in a side pane, with each task's latest output line. Every hook passes its event straight
// on; bookkeeping is never awaited ahead of the work it watches, and nothing
// leaves the machine.

const PANE = 'session-pulse'
const TITLE = 'Background work'
const TICK_MS = 2000
// How long a finished task stays on screen before the band clears.
const LINGER_MS = 15_000
const HISTORY_KEY = 'history'
const HISTORY_RUNS = 6
const BAR_WIDTH = 16
// Running tasks drawn in the band before the rest fold into "+N more".
const BAND_TASKS = 3
const MONITOR_DEFAULT_TIMEOUT = 300_000

const bg = atom({ plugin: 'session-pulse', key: 'bg' } as const, [])
const now = atom({ plugin: 'session-pulse', key: 'now' } as const, 0)
const history = atom({ plugin: 'session-pulse', key: 'history' } as const, {})
const shownBy = atom({ plugin: 'session-pulse', key: 'shownBy' } as const, '')

type $ = EngineInterface
type Loose = Record<string, unknown>

const quiet = (p: Promise<unknown>) => void p.catch(() => undefined)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

// A task keeps the pane open while it runs, unless it is an endless watcher.
const isLive = (t: PulseBg) => !t.endedAt && !t.persistent

function describe(tool: string, input: Loose): string {
  switch (tool) {
    case 'Bash':
      return str(input.description) || str(input.command)
    case 'Agent':
      return `subagent: ${str(input.description) || str(input.subagent_type) || 'task'}`
    case 'Workflow':
      return `workflow: ${str(input.name) || base(str(input.scriptPath)) || 'script'}`
    case 'Monitor':
      return `monitor: ${str(input.description) || str(input.command)}`
    default:
      return tool
  }
}

// Runs before under the same key are the basis for an estimate.
function keyOf(tool: string, input: Loose): string {
  const what =
    tool === 'Bash' || tool === 'Monitor'
      ? str(input.command)
      : tool === 'Agent'
        ? `${str(input.subagent_type)}:${str(input.description)}`
        : tool === 'Workflow'
          ? str(input.name) || str(input.scriptPath)
          : ''
  return `bg:${tool}:${clip(what, 200)}`
}

function remember($: $, key: string, ms: number) {
  if (key.endsWith(':')) return
  quiet(
    update($, history, h => {
      const next = { ...h, [key]: [...(h[key] ?? []), ms].slice(-HISTORY_RUNS) }
      const keys = Object.keys(next)
      // Keep the history small: drop the oldest keys past 300.
      for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete next[k]
      quiet($.store.set(HISTORY_KEY, next))
      return next
    }),
  )
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

// The last "3/7", "3 of 7" or "42%" in the output, as a fraction.
function progressOf(lines: string[]): { frac: number; text: string } | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    const pct = /(\d{1,3}(?:\.\d+)?)\s?%/.exec(line)
    if (pct) {
      const v = Number(pct[1])
      if (v >= 0 && v <= 100) return { frac: v / 100, text: `${pct[1]}%` }
    }
    const of = /\b(\d+)\s*(?:\/|of)\s*(\d+)\b/.exec(line)
    if (of) {
      const a = Number(of[1])
      const b = Number(of[2])
      if (b > 0 && a <= b) return { frac: a / b, text: `${a}/${b}` }
    }
  }
  return undefined
}

type Progress = {
  /** 0..1 when known; undefined draws no bar. */
  frac?: number
  /** What sits after the bar: percent, time left, or why there is none. */
  text: string
}

// Progress from the task's own output first, then from how long it usually
// takes, then from its time limit. Past runs and limits only estimate.
function progress(t: PulseBg, at: number, hist: Record<string, number[]>): Progress {
  const elapsed = at - t.startedAt
  const out = progressOf(t.tail)
  if (out && out.frac > 0) {
    const left = out.frac < 1 ? ` · ~${fmt((elapsed * (1 - out.frac)) / out.frac)} left` : ''
    return { frac: out.frac, text: `${out.text}${left}` }
  }
  const past = hist[t.histKey]
  if (past && past.length > 0) {
    const usual = median(past)
    if (elapsed < usual) {
      return { frac: elapsed / usual, text: `~${fmt(usual - elapsed)} left (usually ${fmt(usual)})` }
    }
    return { frac: 0.99, text: `longer than usual (${fmt(usual)})` }
  }
  if (t.limitMs) return { text: `times out at ${fmt(t.limitMs)}` }
  return { text: 'first run, no estimate yet' }
}

// A bar in eighths of a cell, so short tasks still move every step. The
// filled part and the track come back apart, to colour them apart.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
function bar(frac: number, width = BAR_WIDTH): { fill: string; track: string } {
  const f = Math.min(1, Math.max(0, frac))
  const eighths = Math.round(f * width * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8] ?? ''
  const fill = '█'.repeat(full) + part
  return { fill, track: '─'.repeat(Math.max(0, width - full - (part ? 1 : 0))) }
}

const SPIN = ['◐', '◓', '◑', '◒']
const isBad = (status: string) => /failed|killed|error|timed/.test(status)

// Where a background shell writes its output, from the result or its text.
function outputPathOf(result: Loose, text: string): string | undefined {
  const own = str(result.backgroundOutputPath)
  if (own) return own
  const m = /(\/[^\s'"`]+\.output)\b/.exec(text) ?? /written to:?\s*(\/\S+)/i.exec(text)
  return m?.[1]
}

const ENDED = /^(completed|failed|killed|stopped|done|error|cancelled|canceled|timed[ _-]?out|expired)$/i

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => {
      const block = b as Loose
      if (typeof block.text === 'string') return block.text
      if (block.content !== undefined) return textOf(block.content)
      return ''
    })
    .join('\n')
}


// A notification names its task and, once it ended, how it ended.
function absorbNotification($: $, text: string) {
  const ids = [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(m => (m[1] ?? '').trim())
  if (ids.length === 0) return
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim() ?? ''
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim() ?? ''
  const event = /<event>([\s\S]*?)<\/event>/.exec(text)?.[1]?.trim() ?? ''
  const at = Date.now()
  quiet(
    update($, bg, list =>
      list.map(task => {
        if (!ids.includes(task.id) || task.endedAt) return task
        const extra = (event || (ENDED.test(status) ? '' : summary))
          .split('\n')
          .map(l => l.trimEnd())
          .filter(Boolean)
        const tail = extra.length ? [...task.tail, ...extra].slice(-5) : task.tail
        if (ENDED.test(status)) {
          remember($, task.histKey, at - task.startedAt)
          return { ...task, tail, status: status.toLowerCase(), endedAt: at }
        }
        return { ...task, tail }
      }),
    ),
  )
}

function finishBg($: $, id: string, status: string) {
  const at = Date.now()
  quiet(
    update($, bg, list =>
      list.map(t => (t.id === id && !t.endedAt ? { ...t, status, endedAt: at } : t)),
    ),
  )
}

let checks = 0

// Called every tick: refresh the clock, output tails and task status, and
// let the band clear once nothing has run for a while.
async function tick($: $) {
  const at = Date.now()
  const list = await read($, bg)
  const running = list.filter(t => !t.endedAt)

  if (!running.some(isLive)) {
    const lastEnd = Math.max(0, ...list.map(t => t.endedAt ?? 0))
    if (running.length === 0) {
      // Keep the clock still while idle, so nothing redraws for no reason,
      // but move it once past the linger so the finished rows clear.
      if (at - lastEnd <= LINGER_MS + TICK_MS) await update($, now, () => at)
      return
    }
  }
  await update($, now, () => at)

  const tails = new Map<string, string[]>()
  for (const task of running) {
    if (!task.outputPath) continue
    try {
      const st = await $.fs.stat(task.outputPath)
      let body: string
      if (st.size <= 256 * 1024) body = await $.fs.read(task.outputPath)
      else body = (await $.process.run(['tail', '-n', '10', task.outputPath])).stdout
      const tail = body
        .split('\n')
        .map(l => l.replace(/\r/g, '').trimEnd())
        .filter(Boolean)
        .slice(-5)
      if (tail.join('\n') !== task.tail.join('\n')) tails.set(task.id, tail)
    } catch {
      // The file may not exist yet, or is gone: leave the tail as it was.
    }
  }

  const ended = new Map<string, string>()
  if (running.some(t => t.kind === 'subagent')) {
    try {
      const agents = await $.agent.list()
      for (const task of running.filter(t => t.kind === 'subagent')) {
        const agent = agents.find(a => a.id === task.id)
        if (agent && !/^(running|idle|waiting|pending|starting)$/.test(String(agent.status))) {
          ended.set(task.id, String(agent.status))
        }
      }
    } catch {
      // No agent list here: notifications still end the task.
    }
  }

  // A background shell is finished once nothing holds its output file open.
  // This needs no hook, so it works where other plugins pass hooks by.
  // Checked every few ticks, and only while the output is not moving.
  checks += 1
  if (checks % 3 === 0) {
    for (const task of running) {
      if (task.kind !== 'shell' || !task.outputPath || tails.has(task.id)) continue
      if (at - task.startedAt < 5000) continue
      try {
        const held = await $.process.run(['lsof', '-t', '--', task.outputPath])
        if (held.stdout.trim() === '') ended.set(task.id, 'done')
      } catch {
        // No lsof: notifications still end the task.
      }
    }
  }
  for (const task of running) {
    if (task.kind === 'monitor' && task.limitMs && at - task.startedAt > task.limitMs + 5000) {
      ended.set(task.id, 'timed out')
    }
  }

  if (tails.size === 0 && ended.size === 0) return
  await update($, bg, all =>
    all.map(t => {
      const tail = tails.get(t.id)
      const end = ended.get(t.id)
      if (!tail && !end) return t
      return {
        ...t,
        ...(tail ? { tail } : {}),
        ...(end && !t.endedAt ? { status: end, endedAt: at } : {}),
      }
    }),
  )
  for (const [id] of ended) {
    const t = list.find(x => x.id === id)
    if (t) remember($, t.histKey, at - t.startedAt)
  }
}

// The background task a call launched, if it launched one.
function launched(tool: string, input: Loose, result: Loose, text: string, startedAt: number): PulseBg | undefined {
  const label = clip(describe(tool, input), 160) || tool
  const histKey = keyOf(tool, input)
  const shellId = str(result.backgroundTaskId)
  if (tool === 'Bash' && shellId) {
    return {
      id: shellId,
      kind: 'shell',
      label,
      // A foreground call that timed into the background started earlier.
      startedAt: input.run_in_background === true ? startedAt : Date.now() - (Number(result.timedOutAfterMs) || 0),
      status: 'running',
      tail: [],
      outputPath: outputPathOf(result, text),
      histKey,
    }
  }
  if (tool === 'Monitor' && str(result.taskId)) {
    const persistent = result.persistent === true
    const limit = Number(result.timeoutMs) || Number(input.timeout_ms) || MONITOR_DEFAULT_TIMEOUT
    return {
      id: str(result.taskId),
      kind: 'monitor',
      label,
      startedAt,
      status: 'watching',
      tail: [],
      histKey,
      ...(persistent ? { persistent } : { limitMs: limit }),
    }
  }
  if (tool === 'Agent' && result.status === 'async_launched' && str(result.agentId)) {
    return { id: str(result.agentId), kind: 'subagent', label, startedAt, status: 'running', tail: [], histKey }
  }
  if (tool === 'Workflow' && str(result.taskId)) {
    return {
      id: str(result.taskId),
      kind: 'workflow',
      label: str(result.workflowName) ? `workflow: ${str(result.workflowName)}` : label,
      startedAt,
      status: 'running',
      tail: [],
      histKey,
    }
  }
  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    try {
      await $.command.register({
        name: 'pulse',
        description: 'Open the Background work pane (progress on background tasks)',
      })
      const saved = await $.store.get(HISTORY_KEY)
      if (saved && typeof saved === 'object') {
        await update($, history, () => saved as Record<string, number[]>)
      }
      $.clock.every(TICK_MS, () => quiet(tick($)))
    } catch {
      // Visibility only: never stand in the session's way.
    }
    return ran
  })

  on('command.run', { command: 'pulse' }, async $ => {
    await update($, shownBy, () => 'manual' as const)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Background work pane opened.' }
  })

  // The person closed it: forget that it was open.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    quiet(update($, shownBy, () => '' as const))
    return next(e)
  })

  // A turn a background task's notification starts carries its text, which
  // also covers sessions where another plugin passes session.append by.
  on('turn.start', async ($, e, next) => {
    try {
      if (!e.agentId && e.text.includes('<task-id>')) absorbNotification($, e.text)
    } catch {
      // Only reading.
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const startedAt = Date.now()
    const ran = await next(e)
    try {
      const input = e as unknown as Loose
      const tool = String(e.tool)
      const result = (ran.result ?? {}) as Loose
      if (tool === 'TaskStop') {
        const stopped = str(input.task_id) || str(input.shell_id)
        if (stopped) finishBg($, stopped, 'stopped')
        return ran
      }
      const task = launched(tool, input, result, ran.text ?? '', startedAt)
      if (task) {
        quiet(update($, bg, list => [...list.filter(x => x.id !== task.id), task].slice(-30)))
        quiet(update($, now, () => Date.now()))
      }
    } catch {
      // Bookkeeping failed: the call's own result still goes back untouched.
    }
    return ran
  }).catch(($, e, next) => next(e))

  // A background task's notification says when it ended (and a monitor's
  // events arrive this way too). The row is read, never changed.
  on('session.append', async ($, e, next) => {
    try {
      const kind = (e.origin as { kind?: string }).kind
      const text = textOf(e.message.content)
      if (kind === 'task-notification' || text.includes('<task-notification>')) {
        absorbNotification($, text)
      }
    } catch {
      // Only reading.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // At the end of each main turn the engine lists the work still in flight:
  // anything tracked as running that is not on that list has ended.
  on('classic.Stop', async ($, e, next) => {
    try {
      const live = e.background_tasks
      if (Array.isArray(live)) {
        const ids = new Set(live.map(t => t.id))
        const list = await read($, bg)
        for (const t of list) {
          if (!t.endedAt && !ids.has(t.id) && Date.now() - t.startedAt > 5000) {
            finishBg($, t.id, 'ended')
            remember($, t.histKey, Date.now() - t.startedAt)
          }
        }
      }
    } catch {
      // Only reading.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The band: one line per running task, then finished ones for a moment.
  //   ◐ Pulse demo (12 steps)  ████████▌───────  8/12 · ~40s left   1m 20s
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Another plugin's band (usage-bar) is drawn under these rows, not lost.
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const at = (await read($, now)) || Date.now()
    const tasks = await read($, bg)
    const running = tasks.filter(t => !t.endedAt && !t.persistent)
    const finished = tasks.filter(t => t.endedAt && at - t.endedAt <= LINGER_MS)
    if (running.length === 0 && finished.length === 0) return below

    const { Box, Text } = $.ui.resolve(e)
    const hist = await read($, history)
    const cols = Math.max(30, e.props.bodyColumns)
    const narrow = cols < 70
    const barWidth = narrow ? 8 : BAR_WIDTH
    const labelWidth = Math.max(12, Math.min(40, cols - barWidth - 34))
    const spin = SPIN[Math.floor(at / TICK_MS) % SPIN.length]

    const rows: RenderChildren[] = []
    for (const t of running.slice(0, BAND_TASKS)) {
      const p = progress(t, at, hist)
      const b = p.frac !== undefined ? bar(p.frac, barWidth) : undefined
      rows.push(
        <Box key={t.id} flexDirection="row" columnGap={2}>
          <Text wrap="truncate-end">
            <Text color="cyan">{spin} </Text>
            <Text bold>{clip(t.label, labelWidth)}</Text>
          </Text>
          {b ? (
            <Text>
              <Text color="green">{b.fill}</Text>
              <Text dimColor>{b.track}</Text>
            </Text>
          ) : null}
          <Text dimColor wrap="truncate-end">{p.text}</Text>
          <Box flexGrow={1} />
          <Text dimColor>{fmt(at - t.startedAt)}</Text>
        </Box>,
      )
    }
    if (running.length > BAND_TASKS) {
      rows.push(
        <Text key="more" dimColor>
          {'  '}+{running.length - BAND_TASKS} more · /pulse for all
        </Text>,
      )
    }
    for (const t of finished.slice(-2)) {
      const bad = isBad(t.status)
      rows.push(
        <Text key={t.id} wrap="truncate-end" color={bad ? 'red' : 'green'}>
          {bad ? '✗' : '✓'} <Text dimColor>{clip(t.label, labelWidth)} · {t.status} in {fmt((t.endedAt ?? at) - t.startedAt)}</Text>
        </Text>,
      )
    }
    return (
      <Box flexDirection="column">
        {rows}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const at = (await read($, now)) || Date.now()
    const tasks = await read($, bg)
    const hist = await read($, history)
    const inner = Math.max(20, e.props.bodyColumns - 2)

    const running = tasks.filter(t => !t.endedAt)
    const finished = tasks.filter(t => t.endedAt && at - t.endedAt <= LINGER_MS)

    const rows: RenderChildren[] = []
    for (const t of running) {
      const p = progress(t, at, hist)
      const last = t.tail[t.tail.length - 1]
      rows.push(
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Text bold wrap="truncate-end">
              {clip(t.label, inner - 10)}
            </Text>
            <Text dimColor>{fmt(at - t.startedAt)}</Text>
          </Box>
          <Text wrap="truncate-end">
            {p.frac !== undefined ? (
              <Text>
                <Text color="green">{bar(p.frac).fill}</Text>
                <Text dimColor>{bar(p.frac).track} </Text>
              </Text>
            ) : (
              <Text dimColor>{t.status} · </Text>
            )}
            <Text dimColor>{p.text}</Text>
          </Text>
          {last ? (
            <Text dimColor wrap="truncate-end">
              {'› '}
              {clip(last, inner - 2)}
            </Text>
          ) : null}
        </Box>,
      )
    }
    for (const t of finished) {
      const bad = isBad(t.status)
      rows.push(
        <Text wrap="truncate-end" color={bad ? 'red' : undefined} dimColor={!bad}>
          {bad ? '✗' : '✓'} {clip(t.label, inner - 20)} · {t.status} in {fmt((t.endedAt ?? at) - t.startedAt)}
        </Text>,
      )
    }

    return (
      <Box flexDirection="column">
        {rows.length === 0 ? <Text dimColor>No background work running.</Text> : rows}
      </Box>
    )
  })
}

