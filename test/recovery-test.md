# Wezterm Session Recovery Test

Cross-platform test to verify that `wez_session_save` and `wez_session_recover`
correctly restore all windows, panes, CLI types, projects, agent conversation
history (session IDs), and auto-generated window/tab titles.

## Pre-Flight: Install and Auth Check

Before anything else, verify that all required CLIs are installed, on `PATH`,
and authenticated. If any check fails, stop and resolve it before continuing.

### Step 1 — Check installation

Run each binary with its version/help flag. Use the OS-appropriate command
to check if a binary exists (`which` on Linux/macOS, `where` on Windows).

| CLI      | Binary     | Check command         | Install if missing                          |
|----------|------------|-----------------------|---------------------------------------------|
| Claude   | `claude`   | `claude --version`    | `npm install -g @anthropic-ai/claude-code`  |
| Codex    | `codex`    | `codex --version`     | `npm install -g @openai/codex`              |
| Gemini   | `gemini`   | `gemini --version`    | `npm install -g @anthropic-ai/gemini-cli`   |
| OpenCode | `opencode` | `opencode --version`  | `go install github.com/opencode-ai/opencode@latest` |

For each CLI that is not found, install it using the command above.
Re-check after install to confirm it is on `PATH`.

### Step 2 — Check authentication

Each CLI requires its own API key or auth session. Run the auth check for each:

| CLI      | Auth check                                      | How to authenticate                              |
|----------|--------------------------------------------------|--------------------------------------------------|
| Claude   | `claude auth status` or launch and check output  | `claude login` or set `ANTHROPIC_API_KEY`        |
| Codex    | Launch and check for API key error                | Set `OPENAI_API_KEY` in environment              |
| Gemini   | `gemini auth status` or launch and check output   | `gemini login` or set `GEMINI_API_KEY`           |
| OpenCode | Launch and check for auth error                   | Set provider API key in `~/.config/opencode/opencode.json` |

For each CLI:
1. Run the auth check command
2. If not authenticated, run the authentication command or set the required env var
3. Re-check to confirm authentication succeeded

### Step 3 — Check Wezterm

Verify Wezterm is installed: `wezterm --version`

If not installed:
- Linux: package manager (e.g. `pacman -S wezterm`, `apt install wezterm`)
- macOS: `brew install --cask wezterm`
- Windows: download from https://wezfurlong.org/wezterm/installation

### Gate

**Do not proceed past this point unless all 4 CLIs and Wezterm are installed
and authenticated.** Report which ones failed and stop.

## Naming Convention Reference

Window and tab titles are generated dynamically by Lua callbacks in `wezterm.lua`.
They are NOT stored in the session manifest — they regenerate from live pane state
after recovery. This test verifies they regenerate correctly.

### Window Titles (`format-window-title`)

- Derived from the first pane's `cwd` — extracts the last path component as project name
- **Single window** for a project: just the folder name (e.g., `TidalCore`)
- **Multiple windows** for the same project: `NovaSpark 1/2`, `NovaSpark 2/2`
  - Numbered by sorted window ID, so ordering is deterministic
- Falls back to `pane.title` if no cwd is detected

### Tab Titles (`format-tab-title`)

- Auto-derived from pane contents by scanning each pane's title for CLI keywords
- Detection order: Claude, Gemini, Codex, OpenCode, Goose, then shell
- Format rules:
  - Single CLI: `Claude`
  - Multiple of same CLI: `Claude (3)`
  - Mixed CLIs: `Claude + Codex`
  - CLI + shell: `Claude + shell` (shell appended with `+`, never counted when mixed)
  - Shell only, single: `shell`
  - Shell only, multiple: `shell (3)`
  - Empty tab: `empty`
- Prefixed with tab index: `1: Claude + shell`

## Setup

Create a temporary test directory with 5 project subfolders:

    NovaSpark, TidalCore, VexForge, LunarPulse, ZenithArc

Use the OS temp directory (e.g. `/tmp`, `%TEMP%`, `$TMPDIR`).

## Launch

Open 7 windows with these pane layouts. One window has 2 tabs (multi-tab test).

| Window | Project     | Tab | Panes                             | Notes                    |
|--------|-------------|-----|------------------------------------|--------------------------|
| W1     | NovaSpark   | 1   | claude, shell, codex               |                          |
| W2     | TidalCore   | 1   | gemini, opencode, shell            |                          |
| W3     | VexForge    | 1   | codex, claude, gemini              | All CLI, no shell        |
| W3     | VexForge    | 2   | opencode, shell                    | Multi-tab window         |
| W4     | LunarPulse  | 1   | claude, shell                      | Minimal 2-pane           |
| W5     | ZenithArc   | 1   | opencode, codex, claude            | 3 different CLIs         |
| W6     | NovaSpark   | 1   | gemini, shell, claude              | 2nd NovaSpark window     |
| W7     | LunarPulse  | 1   | shell, shell, shell                | Shell-only, 2nd LunarPulse |

**Totals:** 7 windows, 8 tabs, 22 panes

| CLI      | Count |
|----------|-------|
| claude   | 5     |
| codex    | 3     |
| gemini   | 3     |
| opencode | 3     |
| shell    | 8     |

### Expected Naming After Launch

**Window titles:**

| Window | Expected Title     | Rule                                       |
|--------|--------------------|---------------------------------------------|
| W1     | NovaSpark 1/2      | Two windows share NovaSpark, this is 1st    |
| W2     | TidalCore          | Only window for this project                |
| W3     | VexForge           | Only window for this project                |
| W4     | LunarPulse 1/2     | Two windows share LunarPulse, this is 1st   |
| W5     | ZenithArc          | Only window for this project                |
| W6     | NovaSpark 2/2      | Two windows share NovaSpark, this is 2nd    |
| W7     | LunarPulse 2/2     | Two windows share LunarPulse, this is 2nd   |

**Tab titles:**

| Window | Tab | Expected Tab Title                  | Rule                                    |
|--------|-----|-------------------------------------|-----------------------------------------|
| W1     | 1   | 1: Claude + Codex + shell           | 1 claude, 1 codex, 1 shell              |
| W2     | 1   | 1: Gemini + OpenCode + shell        | 1 gemini, 1 opencode, 1 shell           |
| W3     | 1   | 1: Claude + Gemini + Codex          | 1 codex, 1 claude, 1 gemini, no shell   |
| W3     | 2   | 2: OpenCode + shell                 | 1 opencode, 1 shell                     |
| W4     | 1   | 1: Claude + shell                   | 1 claude, 1 shell                       |
| W5     | 1   | 1: Claude + Codex + OpenCode        | 1 opencode, 1 codex, 1 claude, no shell |
| W6     | 1   | 1: Claude + Gemini + shell          | 1 gemini, 1 shell, 1 claude             |
| W7     | 1   | 1: shell (3)                        | 3 shells, no CLIs                       |

## Stamp

After all panes are up, get pane IDs via `wez_list`.

For each CLI pane (claude, codex, gemini, opencode), send via `wez_send_text_submit`:

    RECOVERY TEST: You are pane_id={PANE_ID}, project={PROJECT_NAME}.
    Remember this token exactly: RT:{PANE_ID}:{PROJECT_NAME}
    Confirm by repeating the token back.

Wait for all 14 CLI agents to confirm their token.

## Snapshot A — Pre-Save Baseline

1. Run `wez_status` — save as **STATUS_A**
2. Run `wez_list` — save as **LIST_A**
3. Run `wez_read_all_deep` — save as **DEEP_A**

Record from these:

- Total windows, tabs, panes
- Per-pane: pane_id, project (cwd), cli type, state
- Per-agent: recovery token reported
- Per-window: window title
- Per-tab: tab title

## Save

Call `wez_session_save`.

Verify the save output reports:
- 7 windows
- 8 tabs
- 22 panes
- 14 sessions captured (one per CLI pane)
- 8 sessions missing (the shell panes — expected)

## Reconcile

Call `wez_reconcile` immediately after save.

Verify: `in_sync: true`, no disappeared or appeared panes, no changed fields.
This confirms the manifest accurately reflects live state before we destroy it.

## Destroy

Call `wez_kill_all`.

Verify: all 22 panes killed.

## Recover

Call `wez_session_recover`.

Verify the recovery output reports:
- 7 windows
- 8 tabs
- 22 panes
- 14 resumed with specific session IDs
- 8 resumed latest (shells)

## Snapshot B — Post-Recovery

1. Run `wez_status` — save as **STATUS_B**
2. Run `wez_list` — save as **LIST_B**
3. Run `wez_read_all_deep`, asking each agent: "What is your recovery token?" — save as **DEEP_B**

Record the same fields as Snapshot A, including window and tab titles.

## Compare and Report

Compare Snapshot A vs Snapshot B field by field:

| #  | Check                     | Pass Criteria                                          |
|----|---------------------------|--------------------------------------------------------|
| 1  | Window count              | A == B (7)                                             |
| 2  | Tab count                 | A == B (8)                                             |
| 3  | Pane count                | A == B (22)                                            |
| 4  | Per-pane project (cwd)    | Same project folder per logical pane position          |
| 5  | Per-pane CLI type         | Same cli (claude/codex/gemini/opencode/null) per pane  |
| 6  | Per-pane state            | All CLI panes `cli-ready`, all shells `idle`           |
| 7  | Recovery tokens           | Every CLI agent returns its original `RT:{ID}:{PROJECT}` |
| 8  | Window titles             | Same title per window (including N/M numbering)        |
| 9  | Tab titles                | Same auto-generated title per tab (CLI mix matches)    |
| 10 | Multi-tab preserved       | W3 still has exactly 2 tabs after recovery             |
| 11 | Shell-only tab title      | W7 tab title is `1: shell (3)` after recovery          |
| 12 | Duplicate project naming  | NovaSpark shows 1/2, 2/2; LunarPulse shows 1/2, 2/2   |
| 13 | Session IDs in manifest   | All 14 CLI panes have non-null session_id in manifest  |

Checks 8-12 verify that the Lua `format-window-title` and `format-tab-title`
callbacks regenerate correctly from the recovered pane state, even though titles
are not stored in the manifest.

Check 13 verifies that the session save captured real session IDs, not nulls,
for every CLI pane. This is a prerequisite for conversation history recovery.

## Output

Print a comparison table showing A vs B values for each of the 13 checks.

End with a single verdict:

    PASS — All 13 checks matched. Session recovery is correct.
    FAIL — List mismatched checks with A vs B values.

## Cleanup

After the test completes (pass or fail):

1. `wez_kill_all` — tear down all recovered panes
2. Remove the temporary project directories created during setup
