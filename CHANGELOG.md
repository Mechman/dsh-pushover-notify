# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## 0.1.0 — 2026-11-13

First public release.

### Added

- Pushover notification for `ask_user_question` tool calls, with the question
  text, priority 1 and the `cosmic` sound.
- Pushover notification for pending permission decisions (`approval/asked`),
  with the tool name and reason, priority 1 and the `siren` sound.
- Deferred notification for finished turns (`turn/end`) carrying the last
  assistant text; cancelled when the next `turn:start` arrives so goal rounds and
  scheduled follow-ups stay quiet.
- Failed-turn notification with the error text and a higher priority.
- Session-scoped labelling: session title plus workspace directory name.
- Sound and priority settings per event class, `en`/`ru` copy, `dryRun`,
  optional deep link, and an optional quiet startup message.
- Settings are re-read per event from `$DSH_HOME/pushover.json`, with
  `PUSHOVER_TOKEN`/`PUSHOVER_USER` and an OpenCode `pushover.json` fallback.
- Dedupe by question `callId`, `approval.id` and turn number.
- Subagent sessions silenced by default.
- Bundle manifest (`dsh.bundle.patch`) so `dsh plugin add dsh-pushover-notify`
  mounts the row, plus a direct `file://` row for clone-based installs.
- 13 behavioural tests over synthetic Session events with a stubbed `fetch`.
