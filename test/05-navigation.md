# Test 05: Navigation — Focus Pane, Direction, Tab

Verify pane and tab navigation tools change the active pane correctly.

**Tools tested:** `wez_focus_pane`, `wez_focus_direction`, `wez_focus_tab`,
`wez_spawn`, `wez_split`, `wez_list`, `wez_kill_all`

## Setup

`wez_kill_all` to start clean. Wait 2 seconds. Call `wez_start` with
`cwd: "/tmp/wez-test-05"` before doing any spawn/split/launch operations —
a stale socket race means `wez_spawn` fails if called directly after
`wez_kill_all` without `wez_start`. Create `/tmp/wez-test-05/`.

**Note on `active` field:** `active` is per-tab — each tab has one active
pane. When checking after `focus_tab`, verify the active pane is in the
correct `tab_id`, not that other tabs' active panes changed. Multiple panes
across different tabs can all have `active: true` simultaneously.

## Steps

### Step 1 — Create 2 tabs with 2 panes each

`wez_spawn` with `new_window: true` → PANE_A (Tab 0).
`wez_split` PANE_A right → PANE_B (Tab 0).
`wez_spawn` (no new_window) → PANE_C (Tab 1).
`wez_split` PANE_C right → PANE_D (Tab 1).

### Step 2 — Focus specific pane

Call `wez_focus_pane` with `pane_id: PANE_A`.
Call `wez_list`.

**Expected:** PANE_A has `active: true`.

**Verify:** In the `wez_list` response, find the pane entry where `pane_id`
equals PANE_A and check that its `active` field is `true`. Do NOT just check
that the focus call succeeded.

### Step 3 — Focus direction Right

Call `wez_focus_direction` with `direction: "Right"`.
Call `wez_list`.

**Expected:** PANE_B has `active: true`.

**Verify:** In the `wez_list` response, find the pane entry where `pane_id`
equals PANE_B and check that its `active` field is `true`. Do NOT just check
that the focus call succeeded.

### Step 4 — Focus tab 1

Call `wez_focus_tab` with `tab_index: 1`.
Call `wez_list`.

**Expected:** Active pane is PANE_C or PANE_D (in tab 1).

**Verify:** In the `wez_list` response, find the pane with `active: true`
whose `tab_id` matches tab 1. Confirm its `pane_id` is either PANE_C or
PANE_D. Remember `active` is per-tab, so tab 0 may still show an active
pane — that is expected.

### Step 5 — Focus back to tab 0

Call `wez_focus_tab` with `tab_index: 0`.
Call `wez_list`.

**Expected:** Active pane is PANE_A or PANE_B (in tab 0).

**Verify:** In the `wez_list` response, find the pane with `active: true`
whose `tab_id` matches tab 0. Confirm its `pane_id` is either PANE_A or
PANE_B. Remember `active` is per-tab, so tab 1 may still show an active
pane — that is expected.

## Pass Criteria

| # | Check                         | Expected                     |
|---|-------------------------------|------------------------------|
| 1 | focus_pane activates pane     | PANE_A is `active: true`     |
| 2 | focus_direction Right         | PANE_B is `active: true`     |
| 3 | focus_tab switches to tab 1   | Active pane in tab 1         |
| 4 | focus_tab switches to tab 0   | Active pane in tab 0         |

## Cleanup

`wez_kill_all`. Remove `/tmp/wez-test-05/`.
