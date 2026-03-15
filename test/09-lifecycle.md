# Test 09: Lifecycle — Kill, Restart, GUI, Mux, Sockets

Verify all pane and process lifecycle management tools.

**Tools tested:** `wez_kill_pane`, `wez_kill_tab`, `wez_restart_pane`,
`wez_kill_gui`, `wez_kill_mux`, `wez_clean_sockets`,
`wez_spawn`, `wez_split`, `wez_send_text_submit`, `wez_get_text`,
`wez_start`, `wez_list`, `wez_kill_all`

## Setup

`wez_kill_all` to start clean. Wait 2 seconds. Call `wez_start` with
`cwd: "/tmp/wez-test-09"` before doing any spawn/split/launch operations —
a stale socket race means `wez_spawn` fails if called directly after
`wez_kill_all` without `wez_start`. Create `/tmp/wez-test-09/`.

## Steps

### Step 1 — Create 4 panes across 2 tabs

`wez_spawn` new_window → PANE_A.
`wez_split` right → PANE_B.
`wez_split` PANE_A bottom → PANE_C.
`wez_spawn` (new tab) → PANE_D.

Confirm `total: 4`. Record TAB_1 (A, B, C) and TAB_2 (D).

### Step 2 — kill_pane

Call `wez_kill_pane` with `pane_id: PANE_B`.
Call `wez_list`.

**Expected:** `total: 3`. PANE_B gone. A, C, D remain.

**Verify:** Check that `total` is the number `3`. Check that the `panes`
array does NOT contain a pane with `pane_id` equal to PANE_B. Check that
panes with IDs PANE_A, PANE_C, and PANE_D are present. Do NOT just check
that the kill call succeeded.

### Step 3 — kill_tab

Call `wez_kill_tab` with `tab_id: TAB_1`.
Call `wez_list`.

**Expected:** `total: 1`. Only PANE_D remains.

**Verify:** Check that `total` is the number `1`. Check that the only pane
in the `panes` array has `pane_id` equal to PANE_D. Do NOT just check that
the kill call succeeded.

### Step 4 — Stamp and restart_pane

`wez_restart_pane` requires a CLI pane, not a shell pane. Launch a claude
pane via `wez_split` with `pane_id: PANE_D`, `direction: "right"`,
`cli: "claude"`. Wait for it to reach `cli-ready` state (check with
`wez_list`). Record this pane as PANE_CLI.

Send `echo BEFORE_RESTART` to PANE_D (the shell pane, for reference). Wait 1s.
Call `wez_restart_pane` with `pane_id: PANE_CLI`. The tool auto-detects the CLI.

**Expected:** New `pane_id` → PANE_E ≠ PANE_CLI.

**Verify:** Check that the returned `pane_id` is a different number than
PANE_CLI. Call `wez_get_text` on PANE_E and check that the `output` field
does NOT contain `BEFORE_RESTART`. Do NOT just check that the restart call
succeeded — inspect the actual `output` text.

### Step 5 — kill_gui

Call `wez_kill_gui`.

**Expected:** `killed: true`. Wait 2s.

**Verify:** Check that the response contains `killed: true` (boolean).
Do NOT just check that the call succeeded.

### Step 6 — kill_mux

Call `wez_kill_mux`.

**Expected:** Response confirms kill or notes no mux process.

**Verify:** Check that the response indicates the mux was killed or that no
mux process was found. Do NOT just check that the call succeeded.

### Step 7 — clean_sockets

Call `wez_clean_sockets`.

**Expected:** `sockets_cleaned` is a number (0 or more).

**Verify:** Check that `sockets_cleaned` is a number (integer >= 0).
Do NOT just check that the call succeeded.

### Step 8 — Fresh start after cleanup

Call `wez_start` with `cwd: "/tmp/wez-test-09"`.

**Expected:** `started: true`. Call `wez_list` → `total: 1`, fresh pane.

**Verify:** Check that the `wez_start` response contains `started: true`.
Then call `wez_list` and check that `total` is `1` and the single pane has
`state: "idle"`. Do NOT just check that the calls succeeded.

## Pass Criteria

| # | Check                      | Expected                        |
|---|----------------------------|---------------------------------|
| 1 | kill_pane removes one      | 4 → 3 panes                    |
| 2 | kill_tab removes tab       | 3 → 1 pane                     |
| 3 | restart_pane (CLI pane)     | New ID, no old output           |
| 4 | kill_gui stops GUI         | `killed: true`                  |
| 5 | kill_mux stops mux         | Confirmed or no process         |
| 6 | clean_sockets runs         | Numeric count                   |
| 7 | Fresh start works          | `started: true`, 1 fresh pane   |

## Cleanup

`wez_kill_all`. Remove `/tmp/wez-test-09/`.
