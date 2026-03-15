# wezterm-mcp

Wezterm MCP Server — a programmable terminal control plane for multi-agent AI workflows.

Turns [Wezterm](https://wezfurlong.org/wezterm/) into a remote-controllable terminal multiplexer that any AI coding CLI can be orchestrated through. One orchestrator agent spawns, monitors, and communicates with any number of AI agents running in parallel across multiple projects.

## What This Does

- **Spawn AI agents** in Wezterm panes — Claude Code, Gemini CLI, Codex CLI, OpenCode, Goose
- **Inject prompts** into running agent sessions as if a human typed them
- **Read output** from any pane — passive (fast) or deep (asks agents for status)
- **Manage windows** — one window per project, auto-titled, with N/M numbering for duplicates
- **Session recovery** — save/restore full layouts including CLI session IDs after a crash
- **Auto-skip permissions** — each CLI's autonomous mode is handled automatically

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              Your AI Agent (Claude, etc.)                │
│                                                         │
│  "Launch 5 Claude agents for the auth-service project"  │
│                         │                               │
│                    MCP Tool Calls                       │
│                         │                               │
├─────────────────────────┼───────────────────────────────┤
│                  wezterm-mcp                             │
│              (this MCP server)                          │
│                         │                               │
│              wezterm cli commands                       │
│                         │                               │
├─────────────────────────┼───────────────────────────────┤
│                    Wezterm                              │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Window 1 │  │ Window 2 │  │ Window 3 │              │
│  │ auth-svc │  │ pay-api  │  │ dashboard│              │
│  │ ┌──┬──┐  │  │ ┌──┬──┐  │  │ ┌──┐     │              │
│  │ │C1│C2│  │  │ │C1│G1│  │  │ │C1│     │              │
│  │ ├──┼──┤  │  │ └──┴──┘  │  │ └──┘     │              │
│  │ │C3│C4│  │  │          │  │          │              │
│  │ └──┴──┘  │  │          │  │          │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install
npm run build
```

## Configuration

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "wezterm": {
      "command": "node",
      "args": ["/path/to/wezterm-mcp/build/wez-mcp.js"],
      "env": {
        "WEZ_PROJECT_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `WEZ_PROJECT_ROOT` | Default working directory for all panes | `process.cwd()` |
| `MACP_PROJECT_ROOT` | Fallback if `WEZ_PROJECT_ROOT` not set | — |
| `WEZ_GIT_BRANCH` | Informational git branch (not enforced) | auto-detected |

## Wezterm Lua Config

Copy `wezterm.lua` to `~/.config/wezterm/wezterm.lua`. It provides:

- **Auto-maximize** on startup
- **Window titles** derived from project directory (not overridden by CLI pane titles)
- **N/M numbering** for multiple windows of the same project (e.g., "WABro 1/2", "WABro 2/2")
- **Tab titles** auto-derived from pane contents (e.g., "Claude (3) + shell")
- **F11** toggles fullscreen

## Supported CLIs

| CLI | Binary | Skip-permissions | Session resume |
|---|---|---|---|
| **Claude Code** | `claude` | `--dangerously-skip-permissions` | `--resume <session-id>` or `--continue` |
| **Gemini CLI** | `gemini` | `--sandbox=none` | `--resume <session-id>` or `--resume` |
| **Codex CLI** | `codex` | `--approval-mode full-auto` | `codex resume <session-id>` or `resume --last` |
| **OpenCode** | `opencode` | Config: `~/.config/opencode/opencode.json` → `"permission": "allow"` | `--session <id>` or `--continue` |
| **Goose** | `goose` | Env: `GOOSE_MODE=auto` | `goose session --resume --session-id <id>` |

### Permission Handling

Each CLI has a different mechanism for autonomous mode. The MCP handles all of them automatically:

- **CLI flags** (Claude, Gemini, Codex): appended to the spawn command
- **Config file** (OpenCode): `~/.config/opencode/opencode.json` is created/updated with `"permission": "allow"` before launch
- **Environment variable** (Goose): `GOOSE_MODE=auto` is set via `bash -c` wrapper

## MCP Tools

### Lifecycle

| Tool | Description |
|---|---|
| `wez_status` | Check if Wezterm is installed/running. Shows all windows, tabs, panes with CLI detection and state (idle/ready/working/exited). |
| `wez_start` | Explicitly start Wezterm if not running. |
| `wez_list` | List all panes with detected CLI type and state. |

### Launching

| Tool | Description |
|---|---|
| `wez_launch_agents` | Open a project window. Optionally launch N agents with auto-grid layout. One window per project (unless `new_window: true`). |
| `wez_launch_mixed` | Launch agents with different CLIs in one tab (e.g., 2 Claude + 1 Gemini). |
| `wez_launch_grid` | Create a manual grid of panes with a specific command. |
| `wez_spawn` | Spawn a single new tab with an optional command. |
| `wez_split` | Split an existing pane horizontally or vertically. |

### Text I/O

| Tool | Description |
|---|---|
| `wez_send_text` | Type text into a pane (no Enter). |
| `wez_send_text_submit` | Type text + press Enter. The key method for injecting prompts into CLI agents. Uses `--no-paste` + `\x0d`. |
| `wez_send_text_all` | Send different texts to each pane in a tab. |
| `wez_send_text_submit_all` | Broadcast same text to all panes in a tab. |
| `wez_send_text_submit_some` | Send text to specific pane IDs (subset). |
| `wez_get_text` | Read text from a pane. Supports scrollback with negative `start_line`. |

### Reading / Monitoring

| Tool | Description |
|---|---|
| `wez_read_all` | **Quick passive read** of ALL panes across ALL windows and tabs. Does NOT interact with agents. Fast and safe. |
| `wez_read_all_deep` | **Deep read** — for idle CLI agents, prompts each one asking "what have you done?". For busy agents, reads output without interrupting. Returns agent summaries. |
| `wez_read_tab` | Read output from all panes in a specific tab. |

### Special Keys

| Tool | Description |
|---|---|
| `wez_send_key` | Send special keys: `ctrl+c`, `ctrl+d`, `escape`, `tab`, `enter`, arrow keys, etc. |
| `wez_send_key_all` | Send a key to ALL panes in a tab (e.g., `ctrl+c` to cancel all agents). |

### Navigation & Layout

| Tool | Description |
|---|---|
| `wez_focus_pane` | Focus a specific pane by ID. |
| `wez_focus_direction` | Focus pane in a direction (Up/Down/Left/Right). |
| `wez_focus_tab` | Switch to a tab by index. |
| `wez_resize_pane` | Resize a pane in a direction. |
| `wez_zoom_pane` | Toggle zoom (maximize/restore) on a pane. |
| `wez_move_to_tab` | Move a pane into its own new tab. |
| `wez_fullscreen` | Toggle fullscreen mode. |

### Metadata

| Tool | Description |
|---|---|
| `wez_set_tab_title` | Set a tab's title. |
| `wez_set_window_title` | Set a window's title. |
| `wez_rename_workspace` | Rename a workspace. |

### Bulk Operations

| Tool | Description |
|---|---|
| `wez_kill_pane` | Close a single pane. |
| `wez_kill_tab` | Kill all panes in a tab. |
| `wez_kill_all` | Kill all panes in all tabs. |
| `wez_restart_pane` | Kill a pane and relaunch the same CLI (auto-detected). Optionally resume the session. |

### Screenshots

| Tool | Description |
|---|---|
| `wez_screenshot` | Capture a screenshot of the active Wezterm window. |
| `wez_screenshot_all_tabs` | Screenshot each tab by switching and capturing. |

### Session Recovery

| Tool | Description |
|---|---|
| `wez_session_save` | Save current state (windows, tabs, panes, CLI types, session IDs) to `~/.macp/wez-session.json`. |
| `wez_session_recover` | Recreate all windows/tabs/panes from the saved manifest. Resumes each CLI with its specific session ID. |
| `wez_reconcile` | Compare saved manifest against live state. Reports disappeared, new, and changed panes. |

## Session Recovery — How It Works

### Session ID Capture

Each CLI stores its session differently. The MCP reads session IDs from the filesystem — no terminal scraping:

| CLI | Session ID Source |
|---|---|
| Claude | `~/.claude/sessions/{PID}.json` → `sessionId` field |
| Gemini | `~/.gemini/tmp/{hash}/chats/` → newest UUID directory |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-{id}.jsonl` → newest file |
| OpenCode | `~/.opencode/sessions/` → newest file |
| Goose | `goose session list --format json --limit 1` |

### Recovery Flow

1. **Save** — `wez_session_save` captures the full hierarchy: windows → tabs → panes, with CLI type, session ID, and cwd for each pane. Stored at `~/.macp/wez-session.json`.

2. **Crash** — Wezterm dies. All panes are gone. But the manifest and CLI session files persist on disk.

3. **Recover** — `wez_session_recover`:
   - Starts Wezterm if needed
   - Creates one new window per manifest window (no cwd-based merging)
   - Kills the default startup pane
   - For each pane: validates the session ID exists on disk. If yes → `claude --resume <id>`. If no → `claude --continue` (falls back to latest session).
   - Each CLI picks up its conversation history from before the crash.

### Session Validation

Before resuming, the MCP checks if the session's `.jsonl` file exists in `~/.claude/projects/`. If not (e.g., the session was too short-lived), it falls back to `--continue` instead of erroring with "No conversation found".

## Window Management

### One Window Per Project

`wez_launch_agents` enforces one window per project directory:

- If a window already exists for that cwd → adds tabs to it
- If no window exists → creates a new one
- `new_window: true` overrides this to force a separate window

### Window Titles

Derived from the working directory via a Lua `format-window-title` handler:

- Single window: `macp`
- Multiple windows same project: `WABro 1/2`, `WABro 2/2`
- Title reads from the first pane's cwd, not the active pane (doesn't change on focus)

### Tab Titles

Auto-derived from pane contents:

- `Claude (2)` — two Claude Code agents
- `Claude (3) + shell` — three Claude agents and a shell
- `Gemini + Codex` — one of each
- `shell` — plain shell

### Auto-Grid Layout

`wez_launch_agents` calculates the optimal grid based on screen size:

- Minimum pane size: 40 cols × 10 rows
- If count exceeds what fits in one tab → spills to multiple tabs
- Example: 400-col screen → max 10 columns → max 80 agents per tab

## Prompt Injection — How It Works

Wezterm's `send-text` command types into a pane's PTY as if a human pressed keys:

```
wezterm cli send-text --pane-id 3 --no-paste "your prompt here"
wezterm cli send-text --pane-id 3 --no-paste $'\x0d'   # Enter key
```

The `--no-paste` flag is critical — without it, text is pasted (triggers bracketed paste mode). `\x0d` is the raw Enter key that Claude Code's TUI recognizes as "submit".

This works with any CLI that accepts keyboard input. No API, no SDK, no special integration.

## Git Strategy

When used with MACP (Multi-Agent Cognition Protocol), all agents work on the **same branch** in the **same working directory**:

- **No per-agent branches** — agents communicate via MACP, not git
- **File claims** (`macp_ext_claim_files`) prevent edit conflicts
- **Frequent commits + `git pull --rebase`** before pushing
- Branch enforcement is informational, not enforced by the MCP

## Known Limitations

- **Wezterm version**: Tested with 20240203. The `format-window-title` callback parameter types vary between versions.
- **Socket discovery**: The MCP looks for `gui-sock-*` in `/run/user/{uid}/wezterm/`. On macOS the path is different (`~/Library/Application Support/wezterm/`). Windows uses named pipes.
- **Screenshots**: Use `import` (ImageMagick) with `xprop` fallback. macOS would need `screencapture`, Windows needs `snippingtool`.
- **Session resume**: Only works if the CLI's session file persists on disk. Short-lived sessions that get cleaned up before save can't be resumed — falls back to `--continue`.
- **Deep read timeout**: `wez_read_all_deep` waits up to 30 seconds per idle agent. With many agents, this can be slow.
- **Stale mux servers**: Wezterm can leave stale mux servers running. The MCP handles this by preferring `gui-sock-*` over the default `sock`.

## Platform Support

| Component | Linux | macOS | Windows |
|---|---|---|---|
| Core MCP tools | Yes | Yes | Yes |
| Socket discovery | `/run/user/{uid}/wezterm/` | `~/Library/...` | Named pipes |
| Screenshots | `import`/`scrot` | `screencapture` | `snippingtool` |
| `wez_start` | `bash` | `bash` | `cmd`/`powershell` |
| `wez_fullscreen` | `xdotool`/F11 | Native | Native |

## License

Apache-2.0
