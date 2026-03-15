# Test 03: Input Methods — Text, Submit, Keys

Verify all single-pane text input and key-sending tools.

**Tools tested:** `wez_send_text`, `wez_send_text_submit`, `wez_send_key`,
`wez_get_text`, `wez_spawn`, `wez_split`, `wez_kill_all`

## Setup

`wez_kill_all` to start clean. Wait 2 seconds. Call `wez_start` with
`cwd: "/tmp/wez-test-03"` before doing any spawn/split/launch operations —
a stale socket race means `wez_spawn` fails if called directly after
`wez_kill_all` without `wez_start`. Create `/tmp/wez-test-03/`.

## Steps

### Step 1 — Create two panes

`wez_spawn` with `new_window: true`, `cwd: "/tmp/wez-test-03"` → PANE_A.
`wez_split` with `pane_id: PANE_A`, `direction: "right"` → PANE_B.

### Step 2 — send_text without Enter

Call `wez_send_text` with `pane_id: PANE_A`, `text: "echo PARTIAL"`.

Wait 1s. Call `wez_get_text` on PANE_A.

**Expected:** `echo PARTIAL` visible on the command line but the command
has NOT executed (no bare `PARTIAL` output line).

**Verify:** Call `wez_get_text` and check that the `output` field contains
the string `"echo PARTIAL"` but does NOT contain a standalone line with just
`"PARTIAL"` as command output. Do NOT just check that the call succeeded —
inspect the actual `output` text.

### Step 3 — send_key to submit

Call `wez_send_key` with `pane_id: PANE_A`, `key: "enter"`.

Wait 1s. Call `wez_get_text` on PANE_A.

**Expected:** `PARTIAL` now appears as executed output.

**Verify:** Call `wez_get_text` and check that the `output` field contains
`"PARTIAL"` as a command output line. Do NOT just check that the call
succeeded — inspect the actual `output` text.

### Step 4 — send_text_submit

Call `wez_send_text_submit` with `pane_id: PANE_B`,
`text: "echo FULL_SUBMIT"`.

Wait 1s. Call `wez_get_text` on PANE_B.

**Expected:** Output contains `FULL_SUBMIT`.

**Verify:** Call `wez_get_text` and check that the `output` field contains
the string `"FULL_SUBMIT"`. Do NOT just check that the call succeeded —
inspect the actual `output` text.

### Step 5 — ctrl+c interrupts a command

Send `sleep 999` + enter to PANE_A via `wez_send_text` + `wez_send_key`.
Wait 1s. Send `wez_send_key` with `key: "ctrl+c"`.
Wait 1s. Send `wez_send_text_submit` with `text: "echo RECOVERED"`.
Wait 1s. Read PANE_A.

**Expected:** Output contains `RECOVERED`.

**Verify:** Call `wez_get_text` and check that the `output` field contains
the string `"RECOVERED"`. Do NOT just check that the call succeeded —
inspect the actual `output` text.

## Pass Criteria

| # | Check                           | Expected                        |
|---|---------------------------------|---------------------------------|
| 1 | send_text does not execute      | No `PARTIAL` output line yet    |
| 2 | send_key enter executes         | `PARTIAL` appears as output     |
| 3 | send_text_submit one-step       | `FULL_SUBMIT` in output         |
| 4 | ctrl+c interrupts + recovery    | `RECOVERED` in output           |

## Cleanup

`wez_kill_all`. Remove `/tmp/wez-test-03/`.
