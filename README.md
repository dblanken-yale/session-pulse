# Session Pulse

A Claude Code mod that puts a small band above the prompt whenever background work is running (background Bash, Monitor, async subagents, workflows). Each task gets a progress bar and a time-left estimate. `/pulse` opens a side pane that also shows each task's latest output line. The band clears about 15 seconds after the last task ends. Everything runs locally; nothing leaves the machine.

```
◐ Checking repos         ████████▌───────  8/12 · ~40s left   1m 20s
◓ Building assets        ██████──────────  40% · ~1m left       32s
◑ Slow job                                 first run, no estimate yet  12s
✓ Lint · done in 18s
```

Based on Michael's session-pulse 0.3.2.

## Install

At the prompt of a terminal session:

```
/plugin install session-pulse --marketplace dblanken-yale/session-pulse
```

Answer `y` to add the marketplace, then pick a scope (user is first).

From a shell:

```bash
claude plugin install session-pulse --marketplace dblanken-yale/session-pulse
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `dblanken-yale/session-pulse`, then Add plugin.

Requires a Claude Code build with mod hooks support, and `lsof` on the PATH (macOS has it) for the shell-finished fallback.

## Where progress comes from

In order of preference:

1. **The task's own output.** The last `3/7`, `3 of 7`, or `42%` in its output becomes the bar, and time left is worked out from the pace so far.
2. **Past runs.** The last 6 durations per command are stored; the median becomes "~Xs left (usually Ys)".
3. **A time limit.** A Monitor task with a timeout shows "times out at 5m".
4. Otherwise: "first run, no estimate yet".

Tip: scripts that print `N/M` or `N%` get a real progress bar for free. To try it, ask Claude to run this in the background:

```bash
for i in $(seq 1 12); do echo "step $i/12"; sleep 5; done
```

## How a task is marked finished

- a task notification arrives (`turn.start` / `session.append`)
- the `Stop` hook's list of background tasks no longer includes it
- for shells, `lsof` shows nothing holds the output file open (needs no hook, so it still works when another plugin's hook runs first)

## Development

```bash
claude plugin validate .
claude plugin test .
```
