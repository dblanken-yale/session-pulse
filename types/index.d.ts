export type PulseBg = {
  id: string
  kind: 'shell' | 'monitor' | 'subagent' | 'workflow' | 'task'
  label: string
  startedAt: number
  status: string
  endedAt?: number
  /** Hard limit on the task, in ms, when one is known. */
  limitMs?: number
  /** A watcher with no end of its own: it never keeps the pane open. */
  persistent?: boolean
  outputPath?: string
  tail: string[]
  /** Key into the duration history. */
  histKey: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-pulse': {
      bg: PulseBg[]
      now: number
      history: Record<string, number[]>
      /** Who opened the pane: '' while closed, 'auto' or 'manual'. */
      shownBy: '' | 'auto' | 'manual'
    }
  }
}

