# Test 10: High-Level Launchers and Session Management

Verify compound launch tools and session save/recover/reconcile.

**Tools tested:** `wez_launch_agents`, `wez_launch_grid`, `wez_launch_mixed`,
`wez_session_save`, `wez_session_recover`, `wez_reconcile`,
`wez_list`, `wez_kill_all`

## Setup

`wez_kill_all` to start clean. Wait 2 seconds. Call `wez_start` with
`cwd: "/tmp/wez-test-10"` before doing any spawn/split/launch operations —
a stale socket race means `wez_spawn` fails if called directly after
`wez_kill_all` without `wez_start`. Create `/tmp/wez-test-10/projA/` and
`/tmp/wez-test-10/projB/`.

## Steps

### Step 1 — launch_agents (shell-only)

Call `wez_launch_agents` with `count: 0`,
`cwd: "/tmp/wez-test-10/projA"`, `project_name: "ProjA"`,
`new_window: true`.

**Expected:** Response has `pane_id`. Call `wez_list` → 1 pane in projA.

**Verify:** Check that the response has a numeric `pane_id` field. Call
`wez_list` and check that a pane exists with a `cwd` containing `"projA"`.
Do NOT just check that the call succeeded.

### Step 2 — launch_grid (2×2)

Call `wez_launch_grid` with `rows: 2`, `cols: 2`,
`cwd: "/tmp/wez-test-10/projB"`, `new_window: true`.

**Expected:** `total_panes: 4`, `pane_ids` has 4 IDs.

**Verify:** Check that `total_panes` is the number `4`. Check that `pane_ids`
is an array with exactly 4 numeric elements. Do NOT just check that the call
succeeded.

### Step 3 — launch_mixed

Call `wez_launch_mixed` with:
```json
{
  "agents": [
    {"cli": "claude", "label": "Writer"},
    {"cli": "claude", "label": "Reviewer"}
  ],
  "cwd": "/tmp/wez-test-10/projA",
  "new_window": true
}
```

**Expected:** `count: 2` with 2 pane entries. (If CLI not installed,
an error is acceptable — record and continue.)

**Verify:** If successful, check that `count` is `2` and the panes array has
2 entries. If an error occurred, record the error message and continue.

### Step 4 — Verify total

Call `wez_list`. Record total pane count as TOTAL_BEFORE.

**Expected:** At minimum 5 panes (1 + 4). If mixed succeeded, 7.

**Verify:** Call `wez_list` and check that `total` is at least `5`. Record
the exact number as TOTAL_BEFORE for later comparison. Do NOT just check
that the call succeeded.

### Step 5 — session_save

Call `wez_session_save`.

**Expected:** `saved: true`, `panes` equals TOTAL_BEFORE.

**Verify:** Check that `saved` is `true` (boolean). Check that `panes` is a
number equal to TOTAL_BEFORE. Do NOT just check that the call succeeded.

### Step 6 — reconcile after save

Call `wez_reconcile`.

**Expected:** `in_sync: true`.

**Verify:** Check that `in_sync` is `true` (boolean). Do NOT just check that
the call succeeded.

### Step 7 — Kill and recover

Call `wez_kill_all`. Wait 3s.
Call `wez_session_recover`.

**Expected:** `recovered: true`, `panes` equals TOTAL_BEFORE.

**Verify:** Check that `recovered` is `true` (boolean). Check that `panes`
is a number equal to TOTAL_BEFORE. Do NOT just check that the call
succeeded.

### Step 8 — Verify recovery

Call `wez_list`.

**Expected:** Pane count equals TOTAL_BEFORE. CWDs match projA and projB.

**Verify:** Check that `total` equals TOTAL_BEFORE. Check that across all
panes, `cwd` values include paths containing `"projA"` and `"projB"`.
Do NOT just check that the call succeeded.

### Step 9 — Save and reconcile after recovery

After `wez_session_recover`, call `wez_session_save` to save a fresh manifest
with the new pane IDs. THEN call `wez_reconcile`. Reconciling directly after
recovery will show drift because pane IDs changed.

Call `wez_session_save`.
Call `wez_reconcile`.

**Expected:** `in_sync: true`.

**Verify:** Check that `wez_session_save` returns `saved: true`. Then check
that `wez_reconcile` returns `in_sync: true` (boolean). If you skip the save
step, reconcile will report drift due to pane ID changes — this is expected
behavior, not a bug.

## Pass Criteria

| # | Check                         | Expected                      |
|---|-------------------------------|-------------------------------|
| 1 | launch_agents shell window    | 1 pane, correct cwd           |
| 2 | launch_grid 2×2               | 4 panes                       |
| 3 | launch_mixed                  | 2 panes or graceful error     |
| 4 | session_save captures all     | `panes` matches total         |
| 5 | reconcile in sync             | `in_sync: true`               |
| 6 | session_recover restores all  | `panes` matches total         |
| 7 | List matches after recovery   | Same count                    |
| 8 | Save + reconcile after recovery | `in_sync: true` (after save)  |

## Cleanup

`wez_kill_all`. Remove `/tmp/wez-test-10/`.
