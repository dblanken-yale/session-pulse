import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'session-pulse',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 90, scroll: { offset: 0, bodyRows: 9 } },
} as const

const PANE = {
  plugin: 'session-pulse',
  component: 'Pane',
  requestId: 'session-pulse',
  props: {
    title: 'Background work',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the band shows a background task, and the pane stays shut until /pulse', async ($, on) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', (_, e) => {
    opened.push((e as { id: string }).id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Stands for the engine's own drawing beneath the band.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', (_, e) =>
    (e as { run_in_background?: boolean }).run_in_background
      ? { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: 'Output is being written to: /tmp/x/b1.output' }
      : { result: { stdout: 'a', stderr: '', interrupted: false } },
  )

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened.length).toBe(0)

  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
  expect(opened.length).toBe(0)

  await $.tool.call({ tool: 'Bash', command: 'sleep 70', description: 'Long loop', run_in_background: true })
  await new Promise(r => setTimeout(r, 50))
  expect(opened.length).toBe(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /Long loop/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /List files/ })).toBeUndefined()
    await band.unmount()

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Long loop/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no estimate yet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /List files/ })).toBeUndefined()
    await ui.unmount()
  }
})


test('a task notification that starts a turn marks the task finished', async ($, on) => {
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b2' },
    text: 'Output is being written to: /tmp/x/b2.output',
  }))
  on('turn.start', () => ({ turnId: 't1' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 70', description: 'Short job', run_in_background: true })
  await new Promise(r => setTimeout(r, 50))

  const running = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await running.find({ type: 'Text', text: /Short job/ })).toBeDefined()
  expect(await running.find({ type: 'Text', text: /completed in/ })).toBeUndefined()
  await running.unmount()

  await $.turn.start({
    text: '<task-notification><task-id>b2</task-id><status>completed</status><summary>done</summary></task-notification>',
  })
  await new Promise(r => setTimeout(r, 50))

  const ended = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ended.find({ type: 'Text', text: /completed in/ })).toBeDefined()
  await ended.unmount()
})
