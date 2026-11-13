# dsh-pushover-notify

Pushover push notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DeepSeek Harness is built to be left alone — it works for minutes at a time and
only needs a human at three moments. This plugin reports exactly those moments to
your phone, so the harness can stay a background process and Pushover becomes
its status bar:

| Harness event | Notification |
|---|---|
| The agent calls `ask_user_question` | **❓ Answer needed** + the question text, priority 1, sound `cosmic` |
| A permission decision is pending (`approval/asked`) | **🔐 Approval needed** + tool and reason, priority 1, sound `siren` |
| The turn finished (`turn/end`, `completed`/`max-tokens`) | **✅ Agent finished** + the last assistant text, priority 0 |
| The turn failed (`turn/end`, `error`) | **⚠️ Agent stopped with an error** + the error text, priority 1 |

Silent by construction: subagent sessions, turns you interrupted yourself, and
completions that are overtaken by the next `turn:start` (goal rounds, scheduled
follow-ups) never send anything.

## Why another notifier?

The DSH ecosystem already has excellent multi-channel notification plugins
(`dsh-notifier`, `dsh-notification`, `cc-notify-hooks`). This one is deliberately
the opposite trade-off:

- **One channel, done properly.** Pushover priorities, sounds, devices, receipt
  of API errors — instead of a channel abstraction.
- **Zero runtime dependencies.** Node builtins and the global `fetch` only. No
  shell scripts, no `jq`, no native modules, no build step.
- **Pure Session event feed.** It subscribes to `ctx.on('session/event', …)`,
  so it works in every profile (Desktop, Web, headless) and never touches tool
  pipelines or other plugins.
- **Config is a JSON file you can edit while it runs.** No restart, no wizard.
- **Small enough to audit in one sitting** — one ~330-line module and a test
  suite that runs on `node --test`.

## Install

### From npm, with the DSH plugin manager

```bash
dsh plugin add dsh-pushover-notify --profile <profile-name>
```

Then restart the surface once (or just wait for the profile reload): the package
declares a bundle patch that mounts the plugin row `pushover-notify`.

In the Desktop app the same operation is available from **Plugins**, which
installs bundles into the current profile.

### From a clone (no registry, good for hacking)

```bash
git clone https://github.com/Mechman/dsh-pushover-notify.git
```

and point a profile row at the module directly — `~/.dsh/cordis.patch.yml`
(or the profile's own `cordis.patch.yml`):

```yaml
- insert:
    - id: pushover-notify
      name: file:///C:/src/dsh-pushover-notify/src/index.mjs
```

Patch files are watched, so the harness picks the row up without a restart.

Check that the row is part of the composition with `dsh --profile <name> --dump-config`.

## Configure

Create `~/.dsh/pushover.json` (`$DSH_HOME/pushover.json` when `DSH_HOME` is set):

```json
{
  "token": "your-application-api-token",
  "user": "your-user-key",
  "language": "en",
  "device": "",
  "notifyOnStartup": true,
  "notifyOnCompletion": true,
  "notifySubagents": false,
  "completionDelayMs": 2500,
  "questionPriority": 1,
  "questionSound": "cosmic",
  "approvalPriority": 1,
  "approvalSound": "siren",
  "completionPriority": 0,
  "completionSound": "pushover",
  "errorPriority": 1,
  "errorSound": "siren",
  "timeoutMs": 12000
}
```

Credentials come from [pushover.net](https://pushover.net): register, create an
application, and use its **API token** plus your **user key**.

The file is re-read on every event, so edits apply immediately. Precedence:
`PUSHOVER_TOKEN`/`PUSHOVER_USER` environment variables → this file → the row's
`config` in the profile patch (strictest wins last). If the file is missing, the
plugin falls back to `~/.config/opencode/pushover.json`, so a machine that
already notifies from OpenCode works with no extra setup. A complete example
lives in [`examples/pushover.example.json`](examples/pushover.example.json).

### Options

| Field | Default | Meaning |
|---|---|---|
| `token`, `user` | — | Pushover application token and user key. Both are required; without them the plugin is a silent no-op. |
| `language` | `en` | Notification copy: `en` or `ru`. |
| `device` | all | Target a single Pushover device name. |
| `notifyOnStartup` | `true` | One quiet message (priority −1) when the plugin loads, proving the wiring works. |
| `notifyOnCompletion` | `true` | Send the finished-turn message at all. |
| `notifySubagents` | `false` | Also report delegated child agents. Off by default — you cannot answer them anyway. |
| `completionDelayMs` | `2500` | Grace period before the finished-turn message; the next `turn:start` cancels it. |
| `questionPriority` / `questionSound` | `1` / `cosmic` | Pushover priority and sound for questions. |
| `approvalPriority` / `approvalSound` | `1` / `siren` | …for approvals. |
| `completionPriority` / `completionSound` | `0` / `pushover` | …for finished turns. |
| `errorPriority` / `errorSound` | `1` / `siren` | …for failed turns. |
| `startupPriority` | `-1` | Priority of the startup message. |
| `guiUrl`, `urlTitle` | — | Optional link attached to every message (for example a LAN address of the Web GUI — `127.0.0.1` will not open from a phone). |
| `timeoutMs` | `12000` | HTTP timeout for the Pushover call. |
| `dryRun` | `false` | Log instead of sending; credentials and the whole pipeline stay exercised. |

Priorities follow Pushover: `-2` silent, `-1` quiet, `0` normal, `1` high
(bypasses quiet hours), `2` emergency (requires acknowledgement; the plugin adds
`retry`/`expire` automatically).

## How it decides

- **Which sessions**: a session with `header.origin === 'subagent'` or a
  `header.parentSession` is a delegated child and stays silent unless
  `notifySubagents` is on.
- **Which events**: `tool/call` with `name === 'ask_user_question'`,
  `approval/asked`, and `turn/end`. `turn/end` with `reason.kind === 'aborted'`
  is treated as your own doing and ignored.
- **Once per wait**: question notifications are keyed by the tool `callId`,
  approvals by `approval.id`, completions by turn number. Replayed or duplicated
  events cannot ping twice.
- **No goal-round spam**: a `turn/end` schedules its message `completionDelayMs`
  later; a `turn:start` for the same session cancels it, so autonomous
  continuations never produce "finished" noise.
- **Message shape**: title (bounded to 120 chars) plus one line —
  content `— «session title» — workspace directory`. The session title comes from
  the `session/title` event, the directory from the session header.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing arrives | Is `token`/`user` filled? Is `notifyOnStartup` on and the harness restarted/reloaded after install? |
| Startup message arrives, turns do not | `notifyOnCompletion` must not be `false`, and the plugin ignores interrupted (`aborted`) turns. |
| No question notification | The agent must call `ask_user_question`; plain prose questions are not events. |
| `Pushover rejected the message (4xx)` in the host log | Wrong token/user pair, or the application is not enabled for your user. |
| Everything arrives twice | Another plugin or a duplicate row is mounted — remove one (`--dump-config` shows the rows). |

Host warnings are logged with the `[pushover-notify]` prefix.

## Compatibility

- DeepSeek Harness `>=0.2.2-alpha.1` (tested against the Desktop `0.2.2-rc.1`
  composition: `dsh-base` + `dsh-web-app`, HMR enabled).
- Node.js `>=22.19` (global `fetch`, `AbortSignal.timeout`).
- No `client` half, so nothing changes in the browser UI.

## Development

```bash
npm test           # node --test, no network, global fetch stubbed
npm run pack:check # verify the published file set
```

The suite drives the plugin through synthetic Session events and asserts the
exact Pushover payloads: question/approval/completion/error paths, dedupe,
subagent silence, cancellation by the next turn, localized copy, missing
credentials, and API refusals.

## License

MIT
