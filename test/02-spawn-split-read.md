# Test 02: Spawn, Split, and Get Text

Verify that panes can be spawned, split, and that text can be read back.

**Tools tested:** `wez_spawn`, `wez_split`, `wez_get_text`,
`wez_send_text_submit`, `wez_list`, `wez_kill_all`

## Setup

`wez_kill_all` to start clean. Wait 2 seconds. Call `wez_start` with
`cwd: "/tmp/wez-test-02"` before doing any spawn/split/launch operations —
a stale socket race means `wez_spawn` fails if called directly after
`wez_kill_all` without `wez_start`. Create `/tmp/wez-test-02/`.

## Steps

### Step 1 — Spawn a shell pane in a new window

Call `wez_spawn` with `new_window: true`, `cwd: "/tmp/wez-test-02"`.

**Expected:** Response has numeric `pane_id` → PANE_A.

### Step 2 — Split right

Call `wez_split` with `pane_id: PANE_A`, `direction: "right"`.

**Expected:** Different numeric `pane_id` → PANE_B.

### Step 3 — Split bottom

Call `wez_split` with `pane_id: PANE_A`, `direction: "bottom"`.

**Expected:** Third numeric `pane_id` → PANE_C.

### Step 4 — Verify pane count

Call `wez_list`.

**Expected:** `total: 3`. All three IDs present. All `state: "idle"`, `cli: null`.

Note: `wez_start` already created pane 0 in tab 0. The spawn with
`new_window: true` creates a separate pane. The total includes only panes
from spawn/split, not the initial start pane, because `new_window: true`
replaces the window context.

**Verify:** Check that the `total` field is the number `3`. Check that the
`panes` array contains exactly 3 elements. For each pane, verify `state` is
the string `"idle"` and `cli` is `null`. Verify all three `pane_id` values
are distinct numbers.

### Step 5 — Write and read text

Call `wez_send_text_submit` with `pane_id: PANE_A`,
`text: "echo HELLO_FROM_PANE_A"`.

Wait 1s. Call `wez_get_text` with `pane_id: PANE_A`.

**Expected:** Output contains `HELLO_FROM_PANE_A`.

**Verify:** Check that the `output` field of the `wez_get_text` response
contains the string `"HELLO_FROM_PANE_A"`. Do NOT just check that the call
succeeded — inspect the actual `output` text.

### Step 6 — Read with scrollback

Call `wez_get_text` with `pane_id: PANE_A`, `start_line: -50`.

**Expected:** Output contains `HELLO_FROM_PANE_A` in scrollback.

**Verify:** Check that the `output` field of the `wez_get_text` response
contains the string `"HELLO_FROM_PANE_A"`. Do NOT just check that the call
succeeded — inspect the actual `output` text.

## Pass Criteria

| # | Check                     | Expected                              |
|---|---------------------------|---------------------------------------|
| 1 | Spawn returns pane_id     | Numeric PANE_A                        |
| 2 | Split right               | Numeric PANE_B ≠ PANE_A               |
| 3 | Split bottom              | Numeric PANE_C ≠ PANE_A, PANE_B       |
| 4 | List shows 3 panes        | `total: 3`                            |
| 5 | Echo output readable      | Output contains `HELLO_FROM_PANE_A`   |
| 6 | Scrollback accessible     | Scrollback contains `HELLO_FROM_PANE_A` |

## Cleanup

`wez_kill_all`. Remove `/tmp/wez-test-02/`.
