# Test 06: Layout — Resize, Zoom, Move to Tab, Fullscreen

Verify pane layout manipulation tools.

**Tools tested:** `wez_resize_pane`, `wez_zoom_pane`, `wez_move_to_tab`,
`wez_fullscreen`, `wez_spawn`, `wez_split`, `wez_list`, `wez_kill_all`

## Setup

`wez_kill_all` to start clean. Wait 2 seconds. Call `wez_start` with
`cwd: "/tmp/wez-test-06"` before doing any spawn/split/launch operations —
a stale socket race means `wez_spawn` fails if called directly after
`wez_kill_all` without `wez_start`. Create `/tmp/wez-test-06/`.

## Steps

### Step 1 — Create 2 side-by-side panes

`wez_spawn` with `new_window: true` → PANE_A.
`wez_split` PANE_A right → PANE_B.
Call `wez_list`. Record PANE_A `size` as SIZE_BEFORE.

### Step 2 — Resize pane

Call `wez_resize_pane` with `direction: "Right"`, `amount: 10`,
`pane_id: PANE_A`.

Call `wez_list`. Record PANE_A `size` as SIZE_AFTER.

**Expected:** Column count changed from SIZE_BEFORE.

**Verify:** In the `wez_list` response, find PANE_A and compare its `size`
(cols/rows) to SIZE_BEFORE. Check that the column count is a different
number. Do NOT just check that the resize call succeeded.

### Step 3 — Zoom pane

Call `wez_zoom_pane` with `pane_id: PANE_A`.
Call `wez_list`.

**Expected:** PANE_A size significantly larger (near full terminal width).

**Verify:** In the `wez_list` response, find PANE_A and check that its `size`
cols value is significantly larger than SIZE_AFTER (at least 2x). Do NOT
just check that the zoom call succeeded.

### Step 4 — Unzoom pane

Call `wez_zoom_pane` with `pane_id: PANE_A`.
Call `wez_list`.

**Expected:** PANE_A size returns close to SIZE_AFTER.

**Verify:** In the `wez_list` response, find PANE_A and check that its `size`
cols value is close to SIZE_AFTER (within a few columns). Do NOT just check
that the zoom call succeeded.

### Step 5 — Move pane to new tab

Call `wez_list`. Confirm 1 tab.
Call `wez_move_to_tab` with `pane_id: PANE_B`.
Call `wez_list`. Count distinct `tab_id` values.

**Expected:** Now 2 distinct tabs. PANE_A in one, PANE_B in another.

**Verify:** In the `wez_list` response, collect all distinct `tab_id` values.
Check that there are exactly 2. Check that PANE_A and PANE_B have different
`tab_id` values. Do NOT just check that the move call succeeded.

### Step 6 — Toggle fullscreen

Call `wez_fullscreen`.

**Expected:** `toggled: true`.

**Verify:** Check that the response contains `toggled: true` (boolean).

Call `wez_fullscreen` again to restore.

**Verify:** Check that the second response also contains `toggled: true`.

## Pass Criteria

| # | Check                     | Expected                          |
|---|---------------------------|-----------------------------------|
| 1 | Resize changes dimensions | SIZE_AFTER ≠ SIZE_BEFORE          |
| 2 | Zoom maximizes pane       | Size grows significantly          |
| 3 | Unzoom restores           | Size returns near SIZE_AFTER      |
| 4 | Move creates new tab      | Tab count 1 → 2                   |
| 5 | Fullscreen toggles        | `toggled: true` both times        |

## Cleanup

`wez_kill_all`. Remove `/tmp/wez-test-06/`.
