# The Line — background poller

Claude Code has **one conversation thread**. The Line's work queue is drained by
calling `get_pending_tasks`, so the moment that thread starts a long task nobody
is polling: the connection light flips to SERVER and mechanical work (folder
listings, file reads, diffs) stalls behind whatever the model is doing.

This plugin runs a **monitor** — a separate process that lives for the session —
which polls continuously and does the work itself. It never asks the model for
anything, because a monitor can emit notifications but cannot make Claude call a
tool; anything that must happen reliably has to happen in the process.

It takes **mechanical work only** (`execOnly`). An agent turn needs a
conversation someone is actually reading, and this has none, so those stay with
the main thread.

## Setup

Create `~/.the-line/poller.env` (mode 600 — it holds a token):

```sh
LINE_URL=https://line.cmdshift.ai
LINE_TOKEN=<your Line token>
LINE_WORKER_ID=plugin-poller
```

Then install:

```sh
claude plugin marketplace add /path/to/Constellation/plugin
claude plugin install the-line@line-local
```

With no token configured the monitor exits quietly rather than erroring in a
loop — the plugin is inert until it is set up.

## What it does

| Op | Command it runs | Confined to |
|---|---|---|
| `list-dir` | `readdir` | the project root |
| `read-file` | `readFile` (skips binary / >600KB) | the project root |
| `diff` | `git diff <base>...<branch>` | the project root |

Every op is **enumerated, not a shell string** — the server names an op and a
path, so nothing reaching this process can widen it into arbitrary command
execution. Paths that escape the project root are refused rather than clamped.

## Measured effect

| | before | after |
|---|---|---|
| folder listing | ~12.8s | **92ms** |
| file read | ~11.7s | **86ms** |
| 181-file diff | minutes (agent turn) | **~400ms** |
