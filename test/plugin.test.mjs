/**
 * Behavioural tests for the notifier, driven by the same Session event feed the
 * harness publishes. No network: the global `fetch` is replaced with a sink.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'dsh-pushover-'))
const CONFIG_PATH = join(CONFIG_DIR, 'pushover.json')
process.env.DSH_PUSHOVER_CONFIG = CONFIG_PATH

const { apply, name } = await import('../src/index.mjs')

const originalFetch = globalThis.fetch
let sent
let logged

/** Fresh plugin instance with a recording context. */
function mount(rowConfig = {}) {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    on(type, handler) {
      listeners.set(type, handler)
      return () => listeners.delete(type)
    },
    effect(body) {
      const disposer = body()
      disposers.push(disposer)
      return disposer
    },
    logger: {
      info: (message) => logged.push({ level: 'info', message }),
      warn: (message) => logged.push({ level: 'warn', message }),
      error: (message) => logged.push({ level: 'error', message }),
    },
  }
  apply(ctx, rowConfig)
  return {
    emit: (session, type, data) => listeners.get('session/event')?.(session, { type, data }),
    unmount: () => {
      for (const disposer of disposers) disposer()
    },
  }
}

const root = { id: 'session-root', header: { id: 'session-root', cwd: 'C:\\work\\project-x' } }
const child = {
  id: 'session-child',
  header: { id: 'session-child', cwd: 'C:\\work\\project-x', parentSession: 'session-root', origin: 'subagent' },
}
const options = { token: 'app-token', user: 'user-key', notifyOnStartup: false, completionDelayMs: 5 }
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  sent = []
  logged = []
  writeFileSync(CONFIG_PATH, JSON.stringify(options), 'utf8')
  globalThis.fetch = async (_url, init) => {
    sent.push(Object.fromEntries(init.body.entries()))
    return new Response(JSON.stringify({ status: 1, request: 'test' }), { status: 200 })
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('exports the cordis row identity', () => {
  assert.equal(name, 'pushover-notify')
})

test('announces a question once, with its text and the session label', async () => {
  const plugin = mount()
  plugin.emit(root, 'session/title', { title: 'Fix the parser' })
  const call = {
    name: 'ask_user_question',
    callId: 'call-1',
    arguments: { questions: [{ id: 'q1', question: 'Which log format?' }, { id: 'q2', question: 'Retry on failure?' }] },
  }
  plugin.emit(root, 'tool/call', call)
  plugin.emit(root, 'tool/call', call)
  await wait()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].title, '❓ Answer needed')
  assert.match(sent[0].message, /Which log format\? \(\+1\)/)
  assert.match(sent[0].message, /Fix the parser/)
  assert.match(sent[0].message, /project-x/)
  assert.equal(sent[0].priority, '1')
  assert.equal(sent[0].sound, 'cosmic')
  plugin.unmount()
})

test('announces an approval once per approval id', async () => {
  const plugin = mount()
  plugin.emit(root, 'approval/asked', { id: 'ap-1', toolName: 'pwsh', reason: 'Write outside the workspace' })
  plugin.emit(root, 'approval/asked', { id: 'ap-1', toolName: 'pwsh' })
  plugin.emit(root, 'approval/asked', { id: 'ap-2', toolName: 'edit' })
  await wait()

  assert.equal(sent.length, 2)
  assert.equal(sent[0].title, '🔐 Approval needed')
  assert.match(sent[0].message, /Requested: pwsh \(Write outside the workspace\)/)
  assert.match(sent[1].message, /Requested: edit/)
  plugin.unmount()
})

test('stays silent for subagent sessions', async () => {
  const plugin = mount()
  plugin.emit(child, 'tool/call', { name: 'ask_user_question', callId: 'c', arguments: { questions: [{ id: 'q', question: '?' }] } })
  plugin.emit(child, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await wait()

  assert.equal(sent.length, 0)
  plugin.unmount()
})

test('reports a finished turn with the last assistant text', async () => {
  const plugin = mount()
  plugin.emit(root, 'session/title', { title: 'Fix the parser' })
  plugin.emit(root, 'assistant/message', {
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done: fixed the parser and added a test.' }] },
  })
  plugin.emit(root, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await wait()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].title, '✅ Agent finished')
  assert.match(sent[0].message, /fixed the parser and added a test/)
  assert.equal(sent[0].priority, '0')
  assert.equal(sent[0].sound, 'pushover')
  plugin.unmount()
})

test('a next turn cancels the pending completion notification', async () => {
  const plugin = mount({ completionDelayMs: 30 })
  plugin.emit(root, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  plugin.emit(root, 'turn/start', { turn: 4 })
  await wait(60)

  assert.equal(sent.length, 0)
  plugin.unmount()
})

test('an interruption is not announced', async () => {
  const plugin = mount()
  plugin.emit(root, 'turn/end', { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await wait()

  assert.equal(sent.length, 0)
  plugin.unmount()
})

test('a failed turn is announced with the error text', async () => {
  const plugin = mount()
  plugin.emit(root, 'turn/end', { turn: 5, reason: { kind: 'error', error: { message: 'LLM 500' } } })
  await wait()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].title, '⚠️ Agent stopped with an error')
  assert.match(sent[0].message, /LLM 500/)
  assert.equal(sent[0].priority, '1')
  plugin.unmount()
})

test('a skipped-by-config completion stays silent', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...options, notifyOnCompletion: false }), 'utf8')
  const plugin = mount()
  plugin.emit(root, 'turn/end', { turn: 6, reason: { kind: 'completed' } })
  await wait()

  assert.equal(sent.length, 0)
  plugin.unmount()
})

test('without credentials nothing is sent', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ notifyOnStartup: false }), 'utf8')
  const plugin = mount()
  plugin.emit(root, 'tool/call', { name: 'ask_user_question', callId: 'c', arguments: { questions: [{ id: 'q', question: '?' }] } })
  plugin.emit(root, 'turn/end', { turn: 7, reason: { kind: 'completed' } })
  await wait()

  assert.equal(sent.length, 0)
  plugin.unmount()
})

test('speaks Russian when configured', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...options, language: 'ru' }), 'utf8')
  const plugin = mount()
  plugin.emit(root, 'tool/call', { name: 'ask_user_question', callId: 'c', arguments: { questions: [{ id: 'q', question: 'Какой формат?' }] } })
  await wait()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].title, '❓ Нужен твой ответ')
  plugin.unmount()
})

test('a refused API response is logged, not thrown', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 0, errors: ['invalid token'] }), { status: 400 })
  const plugin = mount()
  plugin.emit(root, 'tool/call', { name: 'ask_user_question', callId: 'c', arguments: { questions: [{ id: 'q', question: '?' }] } })
  await wait()

  assert.equal(logged.filter((entry) => entry.level === 'warn').length, 1)
  assert.match(logged.find((entry) => entry.level === 'warn').message, /invalid token/)
  plugin.unmount()
})

test('the startup message respects notifyOnStartup', async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...options, notifyOnStartup: true }), 'utf8')
  mount()
  await wait()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].title, '🚀 DeepSeek Harness')
  assert.equal(sent[0].priority, '-1')
})
