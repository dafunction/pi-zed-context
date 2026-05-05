# pi-zed-context

A [Pi](https://pi.dev) extension that makes your active Zed editor file and selection available to the agent.

The extension registers a `zed_context` tool and also injects the current Zed editor context into the system prompt when available. This lets you ask things like “fix this code” or “explain my selection” while working in Zed.

## Inspiration and attribution

This extension was inspired by Kit Langton's tweet demoing support for this very feature in opencode:

- https://x.com/kitlangton/status/2048783495439188091

The implementation is also broadly informed by Zed editor-context support in the opencode repository:

- https://github.com/anomalyco/opencode

```text
   625aca49d Kit Langton feat(tui): read Zed editor context from state db
   5290e9ca7 Kit Langton fix(tui): stabilize Zed editor context polling
   45eac589f Kit Langton fix(tui): preserve Zed context on terminal focus
   1ff8d289a Kit Langton fix(tui): handle Zed selection byte offsets
   320527a3e Kit Langton Support multiple Zed selections in TUI context
   4c70ea28d Kit Langton fix(tui): scope Zed editor context to containing workspaces
   4d74849c1 Kit Langton fix(tui): keep Zed context polling responsive
 ```

In particular, this project follows the same general approach of reading Zed's local SQLite state database, resolving the active editor/workspace, and converting Zed's UTF-8 byte offsets into editor positions.

## Requirements

- Pi coding agent
- [Zed editor](https://zed.dev/)
- `sqlite3` CLI available on your `PATH`

The extension reads Zed's local state database. By default it checks common macOS and Linux paths:

- `~/Library/Application Support/Zed/db/0-stable/db.sqlite`
- `~/.local/share/zed/db/0-stable/db.sqlite`

You can override the database path with either environment variable:

- `PI_ZED_DB=/path/to/db.sqlite`
- `OPENCODE_ZED_DB=/path/to/db.sqlite`

## Install

From a local checkout:

```bash
pi install /absolute/path/to/pi-zed-context
```

Or try it for one run:

```bash
pi -e /absolute/path/to/pi-zed-context
```

Install from GitHub:

```bash
pi install git:github.com/dafunction/pi-zed-context
```

From a future npm publish:

```bash
pi install npm:pi-zed-context
```

## Usage

Open a file in Zed, select some code or place your cursor, then ask Pi about the active file or selection:

```text
explain this code
```

```text
tell me about this file
```

```text
refactor my selected function
```

The agent can also explicitly call the `zed_context` tool when it needs the current editor context.

## Package manifest

This package declares its Pi extension in `package.json`:

```json
{
  "pi": {
    "extensions": ["./zed-context.ts"]
  }
}
```

## Additional notes

No long term support intended, please feel free to fork this repo or remix to your hearts content!

## License

MIT
