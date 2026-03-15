# Test 08: Reading Tools — read_tab, read_all, read_all_deep, Screenshots

Verify all reading and screenshot tools across multiple tabs.

**Tools tested:** `wez_read_tab`, `wez_read_all`, `wez_read_all_deep`,
`wez_screenshot`, `wez_screenshot_all_tabs`,
`wez_spawn`, `wez_split`, `wez_send_text_submit`, `wez_list`, `wez_kill_all`

## Setup

`wez_kill_all` to start clean. Wait 2 seconds. Call `wez_start` with
`cwd: "/tmp/wez-test-08"` before doing any spawn/split/launch operations —
a stale socket race means `wez_spawn` fails if called directly after
`wez_kill_all` without `wez_start`. Create `/tmp/wez-test-08/` and
`/tmp/wez-test-08/screenshots/`.

## Steps

### Step 1 — Create 2 tabs with 2 panes each

`wez_spawn` new_window → PANE_A. `wez_split` right → PANE_B. (Tab 1)
`wez_spawn` → PANE_C. `wez_split` right → PANE_D. (Tab 2)

### Step 2 — Stamp each pane

Send `echo MARKER_ALPHA` to PANE_A.
Send `echo MARKER_BETA` to PANE_B.
Send `echo MARKER_GAMMA` to PANE_C.
Send `echo MARKER_DELTA` to PANE_D.
Wait 2s.

### Step 3 — read_tab

Call `wez_list` to identify TAB_1 (PANE_A + PANE_B).
Call `wez_read_tab` with `tab_id: TAB_1`, `lines: 20`.

**Expected:** `panes` array has 2 entries. One contains `MARKER_ALPHA`,
the other `MARKER_BETA`.

**Verify:** Check that the `panes` array has exactly 2 elements. Check that
one pane's `output` field contains `"MARKER_ALPHA"` and the other's contains
`"MARKER_BETA"`. Do NOT just check that the call succeeded — inspect the
actual `output` text of each pane.

### Step 4 — read_all

Call `wez_read_all` with `lines: 20`.

**Expected:** `total_panes: 4`. All 4 markers appear across outputs.

**Verify:** Check that `total_panes` is the number `4`. Check that across all
pane outputs, the strings `"MARKER_ALPHA"`, `"MARKER_BETA"`,
`"MARKER_GAMMA"`, and `"MARKER_DELTA"` each appear at least once. Do NOT
just check that the call succeeded.

### Step 5 — read_all_deep

Call `wez_read_all_deep` with `lines: 20`.

**Expected:** `total_panes: 4`. Each pane has `cli: null`, `state: "idle"`.
Each has `output` with its marker. `agents_queried: 0`.

**Verify:** Check that `total_panes` is `4`. For each pane entry, check that
`cli` is `null`, `state` is `"idle"`, and `output` contains the expected
marker string. Check that `agents_queried` is `0`. Do NOT just check that
the call succeeded.

### Step 6 — screenshot

Call `wez_screenshot` with `output_dir: "/tmp/wez-test-08/screenshots"`.

**Expected:** Response has `screenshot` path ending `.png`. File exists.

**Verify:** Check that the response has a `screenshot` field whose value is
a string ending in `".png"`. Verify the file exists on disk. Do NOT just
check that the call succeeded.

### Step 7 — screenshot_all_tabs

Call `wez_screenshot_all_tabs` with
`output_dir: "/tmp/wez-test-08/screenshots"`.

**Expected:** `tabs_captured: 2`, `total_tabs: 2`. Both PNG files exist.

**Soft/Flaky:** `screenshot_all_tabs` may capture 0 tabs due to timing
issues with tab switching. This is a known flaky check — verify manually if
it fails. If `tabs_captured` is 0, log it as a soft failure and continue.

**Verify:** Check that `total_tabs` is `2`. If `tabs_captured` is `2`, verify
both PNG files exist on disk. If `tabs_captured` is less than `2`, log the
discrepancy as a known timing issue but do not fail the entire test.

## Pass Criteria

| # | Check                       | Expected                            |
|---|-----------------------------|-------------------------------------|
| 1 | read_tab correct panes      | 2 panes with ALPHA + BETA           |
| 2 | read_all covers all         | 4 panes, all 4 markers              |
| 3 | read_all_deep correct state | `cli: null`, `idle`, all outputs     |
| 4 | screenshot creates file     | PNG exists                           |
| 5 | screenshot_all_tabs (soft)   | `tabs_captured: 2` or soft fail (timing) |

## Cleanup

`wez_kill_all`. Remove `/tmp/wez-test-08/`.
