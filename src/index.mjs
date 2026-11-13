/**
 * dsh-pushover-notify — Pushover push notifications for DeepSeek Harness.
 *
 * DeepSeek Harness is designed to be left alone: it works for minutes at a
 * time and only needs a human when the agent asks a question, a permission
 * decision is pending, or a turn is finished. Those are exactly the three
 * moments this plugin reports to Pushover, so the harness can stay a
 * background process and your phone becomes the status bar.
 *
 * Design notes:
 * - One subscription to the durable Session event feed
 *   (`ctx.on('session/event', ...)`) is enough. The plugin never touches the
 *   Web client, the agent presets, or any other plugin's internals, so it also
 *   works in `dsh --headless` profiles.
 * - Subagent sessions stay silent: only a session a human can actually answer
 *   announces itself.
 * - A completion notification is delayed briefly and cancelled by the next
 *   `turn/start`, so goal rounds and scheduled follow-ups never ping you twice.
 * - Every distinct wait is announced once, keyed by the Session event that
 *   caused it (question call id, approval id, turn number).
 * - Zero dependencies: Node builtins and the global `fetch` only.
 *
 * Settings are read from a JSON document on every event, so they can be edited
 * while the harness runs: `$DSH_HOME/pushover.json`
 * (override with `DSH_PUSHOVER_CONFIG`), falling back to the OpenCode
 * `~/.config/opencode/pushover.json` for a machine that already talks to
 * Pushover from another agent.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** Loader row id and cordis fiber name. */
export const name = 'pushover-notify'

const ENDPOINT = 'https://api.pushover.net/1/messages.json'

/** Notification copy, selected by the `language` setting. */
const TEXT = {
  en: {
    questionTitle: '❓ Answer needed',
    questionFallback: 'The agent asked a question',
    approvalTitle: '🔐 Approval needed',
    approvalFallback: 'An action needs your approval',
    approvalSubject: (tool) => `Requested: ${tool}`,
    doneTitle: '✅ Agent finished',
    doneFallback: 'Turn finished, waiting for your next task.',
    errorTitle: '⚠️ Agent stopped with an error',
    errorFallback: 'The turn failed.',
    startupTitle: '🚀 DeepSeek Harness',
    startupBody: 'Pushover notifications are on: you will hear about questions, approvals and finished turns.',
  },
  ru: {
    questionTitle: '❓ Нужен твой ответ',
    questionFallback: 'Агент задал вопрос',
    approvalTitle: '🔐 Нужно разрешение',
    approvalFallback: 'Запрос на действие',
    approvalSubject: (tool) => `Запрос на: ${tool}`,
    doneTitle: '✅ Агент закончил',
    doneFallback: 'Ход завершён, жду следующую задачу.',
    errorTitle: '⚠️ Агент остановился с ошибкой',
    errorFallback: 'Ход завершился ошибкой.',
    startupTitle: '🚀 DeepSeek Harness',
    startupBody: 'Pushover-уведомления включены: сообщу о вопросах, разрешениях и завершённых ходах.',
  },
}

/** Resolve the Harness home the same way the launcher does. */
function harnessHome() {
  const value = process.env.DSH_HOME
  return value !== undefined && value.length > 0 ? value : join(homedir(), '.dsh')
}

/** Ordered candidate settings files; the first readable one wins. */
function configPaths() {
  const override = process.env.DSH_PUSHOVER_CONFIG
  if (override !== undefined && override.length > 0) return [override]
  return [
    join(harnessHome(), 'pushover.json'),
    // Reuse credentials an OpenCode setup already ships.
    join(homedir(), '.config', 'opencode', 'pushover.json'),
  ]
}

/** Read the settings document, or `undefined` when none is readable. */
function readConfigFile() {
  for (const path of configPaths()) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // Missing or malformed: try the next candidate.
    }
  }
  return undefined
}

/** Environment variables as a last-resort credential source (headless hosts). */
function environmentConfig() {
  const token = process.env.PUSHOVER_TOKEN
  const user = process.env.PUSHOVER_USER
  if (token === undefined && user === undefined) return {}
  return {
    ...token === undefined ? {} : { token },
    ...user === undefined ? {} : { user },
  }
}

/** Collapse whitespace and bound a snippet to a push-friendly length. */
function snippet(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

/** Human label for a Session: its title, else the workspace directory name. */
function sessionLabel(session, cache) {
  const known = cache.get(session.id)
  const title = known !== undefined && known.title !== undefined ? snippet(known.title, 80) : ''
  const cwd = session.header !== undefined && session.header !== null && typeof session.header.cwd === 'string' ? session.header.cwd : ''
  const directory = cwd.length > 0 ? basename(cwd) : ''
  if (title.length > 0 && directory.length > 0 && title !== directory) return `«${title}» — ${directory}`
  if (title.length > 0) return title
  if (directory.length > 0) return directory
  return `session ${String(session.id).slice(-6)}`
}

/** A session a human can answer: not a delegated child agent. */
function isAnswerable(session) {
  const header = session.header
  if (header === undefined || header === null) return true
  return header.origin !== 'subagent' && header.parentSession === undefined
}

/** POST one message to Pushover; rejects on an API-level refusal. */
async function deliver(config, payload) {
  const priority = Number.isInteger(payload.priority) ? payload.priority : 0
  const form = {
    token: config.token,
    user: config.user,
    title: payload.title,
    message: payload.message,
    priority: String(priority),
  }
  if (typeof payload.sound === 'string' && payload.sound.length > 0) form.sound = payload.sound
  if (typeof config.device === 'string' && config.device.length > 0) form.device = config.device
  if (typeof config.guiUrl === 'string' && config.guiUrl.length > 0) {
    form.url = config.guiUrl
    form.url_title = config.urlTitle ?? 'Open DeepSeek Harness'
  }
  // Priority 2 (emergency) additionally requires retry/expire.
  if (priority === 2) {
    form.retry = String(config.retrySeconds ?? 60)
    form.expire = String(config.expireSeconds ?? 3600)
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(config.timeoutMs ?? 12000),
  })
  const result = await response.json().catch(() => undefined)
  if (!response.ok || result === undefined || result.status !== 1) {
    const detail = Array.isArray(result?.errors) ? result.errors.join('; ') : response.statusText
    throw new Error(`Pushover rejected the message (${response.status}): ${detail}`)
  }
  return result
}

/**
 * Mount the notifier.
 * @param ctx - Host-plane Context; the plugin only reads the Session event feed.
 * @param rowConfig - Optional overrides from the profile row's `config`.
 */
export function apply(ctx, rowConfig = {}) {
  const log = (level, message) => {
    const sink = ctx.logger !== undefined && typeof ctx.logger[level] === 'function' ? ctx.logger[level] : undefined
    if (sink !== undefined) sink.call(ctx.logger, `[pushover-notify] ${message}`)
  }

  /** Per-session presentation cache: title and last assistant text. */
  const cache = new Map()
  /** Pending delayed completion notifications, keyed by session id. */
  const timers = new Map()
  /** Announced waits, so a repeated event never pings twice. */
  const seen = new Set()
  let disposed = false

  const settings = () => ({ ...environmentConfig(), ...(readConfigFile() ?? {}), ...rowConfig })

  /** The translation table for the configured language, English as fallback. */
  const text = (config) => TEXT[config.language] ?? TEXT.en

  const stateOf = (session) => {
    let state = cache.get(session.id)
    if (state === undefined) {
      state = {}
      cache.set(session.id, state)
    }
    return state
  }

  /** True the first time a key is offered; bounded so long runs cannot leak. */
  const once = (key) => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > 500) {
      const oldest = seen.values().next()
      if (!oldest.done) seen.delete(oldest.value)
    }
    return true
  }

  const notify = (key, session, build) => {
    if (disposed) return
    const config = settings()
    if (typeof config.token !== 'string' || config.token.length === 0) return
    if (typeof config.user !== 'string' || config.user.length === 0) return
    if (!isAnswerable(session) && config.notifySubagents !== true) return
    if (!once(key)) return
    const payload = build()
    if (config.dryRun === true) {
      log('info', `dry run: ${payload.title} | ${payload.message}`)
      return
    }
    void deliver(config, {
      ...payload,
      title: snippet(payload.title, 120),
      message: snippet(payload.message, 900),
    }).catch((error) => log('warn', `notification failed: ${error?.message ?? String(error)}`))
  }

  const onEvent = (session, event) => {
    if (disposed || session === undefined || session === null || event === undefined) return
    const type = event.type
    const data = event.data ?? {}

    if (type === 'session/title') {
      if (typeof data.title === 'string' && data.title.length > 0) stateOf(session).title = data.title
      return
    }

    if (type === 'assistant/message') {
      const content = data.message !== undefined && Array.isArray(data.message.content) ? data.message.content : []
      const body = content
        .filter((block) => block !== null && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (body.length > 0) stateOf(session).lastText = snippet(body, 400)
      return
    }

    if (type === 'turn/start') {
      // A new turn means the human (or a goal round / scheduled follow-up)
      // already moved on: drop the completion notification still pending.
      const pending = timers.get(session.id)
      if (pending !== undefined) {
        clearTimeout(pending)
        timers.delete(session.id)
      }
      stateOf(session).lastText = ''
      return
    }

    if (type === 'tool/call') {
      if (data.name !== 'ask_user_question') return
      const questions = data.arguments !== undefined && Array.isArray(data.arguments.questions) ? data.arguments.questions : []
      const first = questions[0] ?? {}
      const question = snippet(first.question ?? first.header ?? '', 300)
      const extra = questions.length > 1 ? ` (+${questions.length - 1})` : ''
      notify(`question:${session.id}:${data.callId ?? ''}`, session, () => {
        const config = settings()
        const words = text(config)
        return {
          title: words.questionTitle,
          message: `${question.length > 0 ? question : words.questionFallback}${extra} — ${sessionLabel(session, cache)}`,
          priority: config.questionPriority ?? 1,
          sound: config.questionSound ?? 'cosmic',
        }
      })
      return
    }

    if (type === 'approval/asked') {
      const toolName = typeof data.toolName === 'string' ? data.toolName : ''
      const reason = snippet(data.reason ?? '', 180)
      notify(`approval:${session.id}:${data.id ?? ''}`, session, () => {
        const config = settings()
        const words = text(config)
        const subject = toolName.length > 0 ? words.approvalSubject(toolName) : words.approvalFallback
        return {
          title: words.approvalTitle,
          message: `${subject}${reason.length > 0 ? ` (${reason})` : ''} — ${sessionLabel(session, cache)}`,
          priority: config.approvalPriority ?? 1,
          sound: config.approvalSound ?? 'siren',
        }
      })
      return
    }

    if (type === 'turn/end') {
      const reason = data.reason ?? {}
      // An interruption is the human's own doing — nothing to announce.
      if (reason.kind === 'aborted') return
      const delay = Math.max(0, settings().completionDelayMs ?? 2500)
      const existing = timers.get(session.id)
      if (existing !== undefined) clearTimeout(existing)
      const timer = setTimeout(() => {
        timers.delete(session.id)
        if (disposed) return
        if (settings().notifyOnCompletion === false) return
        const state = cache.get(session.id) ?? {}
        const failed = reason.kind === 'error'
        const errorText = reason.error !== undefined && typeof reason.error.message === 'string' ? reason.error.message : ''
        notify(`turn-end:${session.id}:${data.turn ?? ''}`, session, () => {
          const config = settings()
          const words = text(config)
          const label = sessionLabel(session, cache)
          if (failed) {
            return {
              title: words.errorTitle,
              message: `${snippet(errorText, 300) || words.errorFallback} — ${label}`,
              priority: config.errorPriority ?? 1,
              sound: config.errorSound ?? 'siren',
            }
          }
          return {
            title: words.doneTitle,
            message: `${snippet(state.lastText ?? '', 400) || words.doneFallback} — ${label}`,
            priority: config.completionPriority ?? 0,
            sound: config.completionSound ?? 'pushover',
          }
        })
      }, delay)
      if (typeof timer.unref === 'function') timer.unref()
      timers.set(session.id, timer)
      return
    }

    if (type === 'session/disposed') {
      const pending = timers.get(session.id)
      if (pending !== undefined) clearTimeout(pending)
      timers.delete(session.id)
      cache.delete(session.id)
    }
  }

  ctx.on('session/event', onEvent)

  ctx.effect(() => () => {
    disposed = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    cache.clear()
    seen.clear()
  })

  const initial = settings()
  if (initial.notifyOnStartup !== false) {
    if (typeof initial.token === 'string' && initial.token.length > 0 && typeof initial.user === 'string' && initial.user.length > 0) {
      const words = text(initial)
      void deliver(initial, {
        title: words.startupTitle,
        message: words.startupBody,
        priority: initial.startupPriority ?? -1,
      }).catch((error) => log('warn', `startup notification failed: ${error?.message ?? String(error)}`))
    }
  }
}
