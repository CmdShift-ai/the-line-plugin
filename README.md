# The Line — plugin

Runs your [Line](https://line.cmdshift.ai) crew's work **on your own machine**.

The Line is a wall of AI agents you talk to — ask for something and the crew
does it: draft the email, dig through the research, work the browser, build the
feature. This plugin is what lets them do that work *here*, with your own Claude
Code tools and your own files, instead of only talking about it.

## Install

```bash
claude plugin marketplace add CmdShift-ai/the-line-plugin
claude plugin install the-line@cmdshift
```

Then start a Claude Code session. The first time it runs, the poller prints a
short code and a link:

```
  Open:  https://line.cmdshift.ai/device?code=XXXX-XXXX
  Code:  XXXX-XXXX
```

Approve it in a browser where you are signed in to The Line, and the crew wakes
up. Nothing to paste, no token file to create.

## What it does

Claude Code has **one conversation thread**. The Line's work queue is drained by
calling `get_pending_tasks`, so the moment that thread starts a long task nobody
is polling and mechanical work stalls behind whatever the model is doing.

This plugin runs **monitors** — separate processes that live for the session:

- `line-poller` takes mechanical work (folder listings, file reads, diffs) so it
  never queues behind a long turn.
- `line-agent` answers the crew's turns on this machine, each one a real Claude
  Code session with your tools.

## Authentication

The plugin uses the **OAuth 2.1 device authorization grant** (RFC 8628). The
pollers are background processes with no browser, so they ask the server for a
code, show it to you, and wait while you approve it somewhere you are already
signed in. What they end up holding is an ordinary access/refresh pair —
short-lived, scoped, and revocable from your account at any time.

Tokens are cached in `~/.the-line/tokens.json`, readable only by you (`0600`).

## What it can reach

Turns run as Claude Code sessions on this machine, so the crew has the tools you
have given Claude Code — files, commands, the web, a browser, and any MCP
servers you have connected. It talks to `line.cmdshift.ai` to pull tasks and
report results. It sends nowhere else.

Set `LINE_URL` in `~/.the-line/poller.env` to point at a different server.

## A note on `experimental.monitors`

The self-starting behaviour relies on Claude Code's `experimental.monitors`
field. It is documented but explicitly experimental: the API may change between
Claude Code versions, and monitors only run in interactive sessions. If a
release breaks it, the plugin stops starting itself until this is updated.

## Requirements

- Claude Code with an active Claude subscription
- Node.js 18+
- An account at [line.cmdshift.ai](https://line.cmdshift.ai)

## License

MIT — see [LICENSE](./LICENSE).
