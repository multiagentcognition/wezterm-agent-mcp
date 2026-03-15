# Test 01: Startup and Status Baseline

Verify that Wezterm can be started from scratch and that status/list tools
report correct initial state.

**Tools tested:** `wez_status`, `wez_list`, `wez_start`, `wez_kill_all`

## Setup

Ensure Wezterm is NOT running. If it is, call `wez_kill_all` first and wait
2 seconds. Call `wez_start` with `cwd: "/tmp/wez-test-01"` before doing any
spawn/split/launch operations — a stale socket race means `wez_spawn` fails
if called directly after `wez_kill_all` without `wez_start`.
Create `/tmp/wez-test-01/`.

## Steps

### Step 1 — Status before start

Call `wez_status`.

**Expected:** `installed: true`, `running: false`.

### Step 2 — List before start

Call `wez_list`.

**Expected:** `running: false`, `panes: []` (no `total` field when not running).

### Step 3 — Start Wezterm

Call `wez_start` with `cwd: "/tmp/wez-test-01"`.

**Expected:** `running: true`, `started: true`.

### Step 4 — Status after start

Call `wez_status`.

**Expected:**
- `installed: true`, `running: true`
- `total_panes: 1`, `total_windows: 1`
- `supported_clis` includes claude, gemini, codex, opencode, goose
- `screen_size` has numeric `cols` and `rows`

**Verify:** Check that the `installed` field is exactly `true` (boolean).
Check that `running` is exactly `true`. Check that `total_panes` is the
number `1`. Check that `supported_clis` is an array containing the string
`"claude"`. Check that `screen_size.cols` and `screen_size.rows` are
numbers greater than 0.

### Step 5 — List after start

Call `wez_list`.

**Expected:**
- `running: true`, `total: 1`
- Single pane with numeric `pane_id`, `state: "idle"`, `cli: null`

**Verify:** Check that `running` is exactly `true`. Check that `total` is the
number `1`. Check that the `panes` array has exactly 1 element. Check that
`panes[0].pane_id` is a number. Check that `panes[0].state` is the string
`"idle"`. Check that `panes[0].cli` is `null`.

## Pass Criteria

| # | Check                          | Expected                          |
|---|--------------------------------|-----------------------------------|
| 1 | Status before start            | `running: false`                  |
| 2 | List before start              | `panes: []`, no `total` field     |
| 3 | Start succeeds                 | `started: true`                   |
| 4 | Status after start             | `running: true`, `total_panes: 1` |
| 5 | List after start               | `total: 1`, pane is `idle`        |

## Cleanup

`wez_kill_all`. Remove `/tmp/wez-test-01/`.
