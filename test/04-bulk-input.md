# Test 04: Bulk Input — Broadcast and Selective Send

Verify all bulk/broadcast text input tools across multiple panes.

**Tools tested:** `wez_send_text_all`, `wez_send_text_submit_all`,
`wez_send_text_submit_some`, `wez_send_key_all`,
`wez_launch_grid`, `wez_get_text`, `wez_list`, `wez_kill_all`

## Setup

`wez_kill_all` to start clean. Wait 2 seconds. Call `wez_start` with
`cwd: "/tmp/wez-test-04"` before doing any spawn/split/launch operations —
a stale socket race means `wez_spawn` fails if called directly after
`wez_kill_all` without `wez_start`. Create `/tmp/wez-test-04/`.

## Steps

### Step 1 — Launch a 1×3 grid

Call `wez_launch_grid` with `rows: 3`, `cols: 1`,
`cwd: "/tmp/wez-test-04"`, `new_window: true`.

**Expected:** `total_panes: 3`, `pane_ids` has 3 IDs → P1, P2, P3.

Note: `wez_launch_grid` creates panes in a NEW tab, but `wez_start` already
created pane 0 in tab 0. So total panes across all tabs will be
4 (grid = 3 + 1 for the grid's base pane) + 1 (start pane) = 5 total, not 3.
The `total_panes: 3` in the launch_grid response refers only to the grid
panes. When calling `wez_list` later, expect 5 total panes. Use the
`tab_id` from the grid response to identify the 3 grid panes.

### Step 2 — Get the tab_id

Call `wez_list`. Find the shared `tab_id` → TAB_ID.

### Step 3 — Broadcast same text

Call `wez_send_text_submit_all` with `tab_id: TAB_ID`,
`text: "echo BROADCAST"`.

Wait 2s. Read all 3 panes.

**Expected:** All 3 contain `BROADCAST`.

**Verify:** For each of P1, P2, P3, call `wez_get_text` and check that the
`output` field contains the string `"BROADCAST"`. Do NOT just check that
the send call succeeded — inspect the actual `output` text of each pane.

### Step 4 — Different text per pane

Call `wez_send_text_all` with `tab_id: TAB_ID`,
`texts: ["echo AAA", "echo BBB", "echo CCC"]`.

Wait 2s. Read all 3 panes.

**Expected:** P1 has `AAA`, P2 has `BBB`, P3 has `CCC`.

**Verify:** For each pane, call `wez_get_text` and check that the `output`
field contains the expected string (`"AAA"`, `"BBB"`, or `"CCC"`
respectively). Do NOT just check that the send call succeeded — inspect the
actual `output` text of each pane.

### Step 5 — Selective send

Call `wez_send_text_submit_some` with `pane_ids: [P1, P3]`,
`text: "echo SELECTIVE"`.

Wait 2s. Read all 3 panes.

**Expected:** P1 and P3 contain `SELECTIVE`. P2 does NOT.

**Verify:** Call `wez_get_text` on each pane. Check that P1's and P3's
`output` fields contain `"SELECTIVE"`. Check that P2's `output` field does
NOT contain `"SELECTIVE"`. Do NOT just check that the send call succeeded.

### Step 6 — Key broadcast

Call `wez_send_key_all` with `tab_id: TAB_ID`, `key: "ctrl+l"`.

Wait 1s. Read P1.

**Expected:** Screen cleared — `SELECTIVE` no longer in visible area.

**Verify:** Call `wez_get_text` on P1 and check that the `output` field does
NOT contain `"SELECTIVE"` in the visible area. Do NOT just check that the
key send succeeded — inspect the actual `output` text.

## Pass Criteria

| # | Check                            | Expected                          |
|---|----------------------------------|-----------------------------------|
| 1 | Grid launches 3 panes            | `total_panes: 3`                  |
| 2 | Broadcast reaches all            | All 3 contain `BROADCAST`         |
| 3 | Per-pane text is distinct         | AAA, BBB, CCC respectively        |
| 4 | Selective targets only chosen     | P1+P3 have it, P2 does not        |
| 5 | Key broadcast clears screens     | Visible area cleared              |

## Cleanup

`wez_kill_all`. Remove `/tmp/wez-test-04/`.
