# wezterm-agent-mcp

Wezterm MCP Server — a programmable terminal control plane for multi-agent AI workflows.

Turns [Wezterm](https://wezfurlong.org/wezterm/) into a remote-controllable terminal multiplexer that any AI coding CLI can be orchestrated through. One orchestrator agent spawns, monitors, and communicates with any number of AI agents running in parallel across multiple projects.

## What This Does

- **Spawn AI agents** in Wezterm panes — Claude Code, Gemini CLI, Codex CLI, OpenCode, Goose
- **Inject prompts** into running agent sessions as if a human typed them
- **Read output** from any pane — passive (fast) or deep (asks agents for status)
- **Manage windows** — one window per project, auto-titled, with N/M numbering for duplicates
- **Session recovery** — save/restore full layouts including CLI session IDs after a crash
- **Auto-skip permissions** — each CLI's autonomous mode is handled automatically
- **Cross-platform** — Linux, macOS, and Windows via a platform abstraction layer

## Architecture

```
+---------------------------------------------------+
|         Your AI Agent (Claude, etc.)              |
|                                                   |
|  "Launch 5 agents for the auth-service project"   |
|                       |                           |
|                  MCP Tool Calls                   |
|                       |                           |
+---------------------------------------------------+
|              wezterm-agent-mcp                    |
|             (this MCP server)                     |
|                       |                           |
|             wezterm cli commands                  |
|                       |                           |
+---------------------------------------------------+
|                    Wezterm                        |
|                                                   |
|  +-----------+ +-----------+ +-----------+        |
|  | Window 1  | | Window 2  | | Window 3  |        |
|  | auth-svc  | | pay-api   | | dashboard |        |
|  | +--+--+   | | +--+--+   | | +--+      |        |
|  | |C1|C2|   | | |C1|G1|   | | |C1|      |        |
|  | +--+--+   | | +--+--+   | | +--+      |        |
|  | |C3|C4|   | |           | |           |        |
|  | +--+--+   | |           | |           |        |
|  +-----------+ +-----------+ +-----------+        |
+---------------------------------------------------+
```

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v22.5+)
- [Wezterm](https://wezfurlong.org/wezterm/installation)

### Install and configure

One command:

```bash
npx wezterm-agent-mcp init
```

This checks that Wezterm is installed, then registers the MCP server globally for all AI coding tools:

| Config file | For |
|---|---|
| `~/.claude/settings.json` | Claude Code, Codex |
| `~/.cursor/mcp.json` | Cursor |
| VS Code user `mcp.json` | VS Code (platform-specific path) |
| `~/.gemini/settings.json` | Gemini CLI |
| `~/.config/opencode/...` | OpenCode (platform-specific path) |

One run, every project, every tool. Existing config files are merged — other MCP servers won't be touched. Re-running is safe (idempotent).

For per-project setup instead (writes config into the project directory):

```bash
npx wezterm-agent-mcp init --project
npx wezterm-agent-mcp init --root /path/to/project
```

### Wezterm Lua config (optional)

The package includes a `wezterm.lua` with auto-maximize, project-derived window titles, N/M numbering, auto tab titles, and F11 fullscreen. To use it:

```bash
# After npx downloads the package, copy from the npm cache:
npx -y wezterm-agent-mcp --help  # ensures package is cached
cp $(npm root -g)/wezterm-agent-mcp/wezterm.lua ~/.config/wezterm/wezterm.lua

# Or from a cloned repo:
cp wezterm.lua ~/.config/wezterm/wezterm.lua
```

### Install from source

```bash
git clone https://github.com/multiagentcognition/wezterm-agent-mcp.git
cd wezterm-agent-mcp
npm install && npm run build
npx . init  # configure MCP for this project
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `WEZ_PROJECT_ROOT` | Default working directory for all panes | `process.cwd()` |
| `MACP_PROJECT_ROOT` | Fallback if `WEZ_PROJECT_ROOT` not set | — |
| `WEZ_GIT_BRANCH` | Informational git branch (not enforced) | auto-detected |

## Supported CLIs

| CLI | Binary | Skip-permissions | Session resume |
|---|---|---|---|
| **Claude Code** | `claude` | `--dangerously-skip-permissions` | `--resume <session-id>` or `--continue` |
| **Gemini CLI** | `gemini` | `--sandbox=none` | `--resume latest` |
| **Codex CLI** | `codex` | `-a never` | `codex resume <session-id>` or `resume --last` |
| **OpenCode** | `opencode` | Config: `permission: "allow"` | `--session <id>` or `--continue` |
| **Goose** | `goose` | Env: `GOOSE_MODE=auto` | `goose session --resume --session-id <id>` |

Each CLI's autonomous mode is handled automatically — flags, config files, and env vars are set before launch. Directory trust is pre-configured for Claude Code, Gemini, and Codex so no interactive prompts block startup.

## MCP Tools (41 total)

### Status & Lifecycle

| Tool | Description |
|---|---|
| `wez_status` | Full status: windows, tabs, panes with CLI detection and state |
| `wez_list` | List all panes with CLI type, state, CWD |
| `wez_start` | Start Wezterm if not running |

### Launching

| Tool | Description |
|---|---|
| `wez_launch_agents` | Open a project window with N agents (auto-grid layout) |
| `wez_launch_mixed` | Multiple different CLIs in one tab |
| `wez_launch_grid` | Manual grid of panes (rows × cols) |
| `wez_spawn` | New window/tab with optional CLI or command |
| `wez_split` | Split a pane (right/bottom) with optional CLI |

### Text I/O

| Tool | Description |
|---|---|
| `wez_send_text` | Type text into a pane (no Enter) |
| `wez_send_text_submit` | Type text + Enter (primary method for injecting prompts) |
| `wez_send_text_all` | Different text to each pane in a tab |
| `wez_send_text_submit_all` | Broadcast same text to all panes in a tab |
| `wez_send_text_submit_some` | Send text to specific pane IDs |
| `wez_get_text` | Read text from a pane (supports scrollback) |

### Reading & Monitoring

| Tool | Description |
|---|---|
| `wez_read_all` | Quick passive read of ALL panes — fast, never interrupts |
| `wez_read_all_deep` | Deep read — prompts idle agents for status summaries |
| `wez_read_tab` | Read all panes in a specific tab |
| `wez_screenshot` | Screenshot the active Wezterm window |
| `wez_screenshot_all_tabs` | Screenshot each tab |

### Special Keys

| Tool | Description |
|---|---|
| `wez_send_key` | Send ctrl+c, ctrl+d, escape, enter, arrow keys, etc. |
| `wez_send_key_all` | Send a key to all panes in a tab |

### Navigation & Layout

| Tool | Description |
|---|---|
| `wez_focus_pane` | Focus a pane by ID |
| `wez_focus_direction` | Focus Up/Down/Left/Right |
| `wez_focus_tab` | Switch to tab by index |
| `wez_resize_pane` | Resize a pane |
| `wez_zoom_pane` | Toggle zoom (maximize/restore) |
| `wez_move_to_tab` | Move a pane into its own tab |
| `wez_fullscreen` | Toggle fullscreen |

### Titles & Workspace

| Tool | Description |
|---|---|
| `wez_set_tab_title` | Set a tab's title |
| `wez_set_window_title` | Set a window's title |
| `wez_rename_workspace` | Rename a workspace |

### Pane Management

| Tool | Description |
|---|---|
| `wez_kill_pane` | Close a single pane |
| `wez_kill_tab` | Kill all panes in a tab |
| `wez_kill_all` | Full shutdown (panes + GUI + mux + sockets) |
| `wez_kill_gui` | Kill GUI process only |
| `wez_kill_mux` | Kill mux-server only |
| `wez_clean_sockets` | Remove stale socket files |
| `wez_restart_pane` | Kill + relaunch same CLI in place |

### Session Recovery

| Tool | Description |
|---|---|
| `wez_session_save` | Save state (windows, tabs, panes, CLIs, session IDs) to manifest |
| `wez_session_recover` | Recreate full layout from manifest, resume each CLI session |
| `wez_reconcile` | Compare manifest vs live state, report drift |

## Session Recovery — How It Works

### Session ID Capture

Each CLI stores sessions differently. The MCP reads session IDs from the filesystem:

| CLI | Session ID Source |
|---|---|
| Claude | `~/.claude/projects/{encoded}/` → session `.jsonl` files |
| Gemini | `~/.gemini/projects.json` → slug → chats directory |
| Codex | `~/.codex/sessions/` → rollout `.jsonl` files |
| OpenCode | SQLite DB → session table with directory column |
| Goose | `goose session list --format json` |

### Recovery Flow

1. **Save** — captures windows → tabs → panes with CLI type, session ID, and CWD
2. **Crash** — Wezterm dies but manifest and CLI session files persist
3. **Recover** — recreates windows/tabs/panes, validates each session ID exists on disk, resumes with `--resume <id>` or falls back to `--continue`

## Platform Support

All OS-specific behavior is centralised in `src/platform.ts` with three implementations sharing a Unix base:

| Concern | Linux | macOS | Windows |
|---|---|---|---|
| Socket dir | `/run/user/{uid}/wezterm` | `~/.local/share/wezterm` | `~/.local/share/wezterm` |
| WezTerm binary | PATH | `/Applications/WezTerm.app/...` | `Program Files\WezTerm\` |
| Screenshot | import/scrot/grim/gnome-screenshot | screencapture | PowerShell |
| Process mgmt | pgrep/pkill | pgrep/pkill | tasklist/taskkill |
| Enter key | CR (PTY translates to LF) | CR | LF (ConPTY) |
| Shell | bash | bash | cmd.exe |
| CLI wrapping | direct exec | direct exec | cmd.exe /c (npm shims) |

## Testing

The `test/` directory contains 11 test suites covering all 41 tools:

| Test | Focus |
|---|---|
| `recovery-test.md` | Full session recovery (7 windows, 22 panes, 14 CLI agents) |
| `01-startup-status.md` | Status, list, start |
| `02-spawn-split-read.md` | Spawn, split, get_text |
| `03-input-methods.md` | send_text, send_text_submit, send_key |
| `04-bulk-input.md` | Broadcast, per-pane, selective send |
| `05-navigation.md` | Focus pane, direction, tab |
| `06-layout.md` | Resize, zoom, move_to_tab, fullscreen |
| `07-titles-workspace.md` | Tab/window titles, workspace rename |
| `08-reading-screenshots.md` | read_tab, read_all, read_all_deep, screenshots |
| `09-lifecycle.md` | kill_pane, kill_tab, restart_pane, kill_gui/mux |
| `10-launchers-sessions.md` | launch_agents, launch_grid, launch_mixed, save/recover |

Tests are designed to be run by an AI agent via MCP tool calls — each test doc describes the steps, expected outputs, and pass criteria.

## Known Limitations

- **Wezterm version**: Tested with 20240203. The `format-window-title` callback parameter types vary between versions.
- **Session resume**: Only works if the CLI's session file persists on disk. Short-lived sessions that get cleaned up before save can't be resumed.
- **Deep read timeout**: `wez_read_all_deep` waits up to 30 seconds per idle agent.
- **screenshot_all_tabs**: Flaky due to tab-switching timing — may capture 0 tabs.
- **Stale mux servers**: Wezterm can leave stale mux servers. After `wez_kill_all`, use `wez_start` before spawning new panes.

## Disclaimer

**USE AT YOUR OWN RISK.** This software launches AI coding agents in autonomous mode with permissions to read, write, and execute files on your system. By design, it bypasses each CLI's safety prompts (`--dangerously-skip-permissions`, `--sandbox=none`, `-a never`, etc.) so agents can operate without human approval of individual actions.

This means:
- Agents **can and will** modify files, run shell commands, and make network requests without asking
- Multiple agents running in parallel can produce unexpected interactions
- There is no undo — changes agents make to your filesystem are immediate and permanent
- Session recovery resumes agents with full conversation context, which may include stale or incorrect instructions

**Do not run this on production systems, with access to sensitive data, or in environments where unreviewed code execution is unacceptable.** Use isolated directories, sandboxed environments, or disposable VMs when possible. The authors accept no liability for any damage, data loss, or unintended consequences resulting from use of this software.

## License

[PolyForm Strict 1.0.0](https://polyformproject.org/licenses/strict/1.0.0) — personal and non-commercial use only. No modifications, no commercial/enterprise use. See [LICENSE](LICENSE) for full terms.
