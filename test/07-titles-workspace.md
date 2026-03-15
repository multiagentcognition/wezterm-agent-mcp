# Test 07: Titles and Workspace

Verify tab title, window title, and workspace renaming tools.

**Tools tested:** `wez_set_tab_title`, `wez_set_window_title`,
`wez_rename_workspace`, `wez_spawn`, `wez_status`, `wez_list`, `wez_kill_all`

## Setup

`wez_kill_all` to start clean. Wait 2 seconds. Call `wez_start` with
`cwd: "/tmp/wez-test-07"` before doing any spawn/split/launch operations —
a stale socket race means `wez_spawn` fails if called directly after
`wez_kill_all` without `wez_start`. Create `/tmp/wez-test-07/`.

## Steps

### Step 1 — Spawn a pane

`wez_spawn` with `new_window: true`, `cwd: "/tmp/wez-test-07"` → PANE_A.
Call `wez_list`. Record `window_id` as WIN_ID.

### Step 2 — Set tab title

Call `wez_set_tab_title` with `title: "My Custom Tab"`,
`pane_id: PANE_A`.

**Expected:** Response contains the title.

**Verify:** Check that the response includes the string `"My Custom Tab"`.
Do NOT just check that the call succeeded.

### Step 3 — Set window title

Call `wez_set_window_title` with `title: "Test Window 07"`,
`window_id: WIN_ID`.

**Expected:** Response confirms the title.

**Verify:** Check that the response includes the string `"Test Window 07"`.
Do NOT just check that the call succeeded.

### Step 4 — Rename workspace

Call `wez_status`. Record the current workspace name (usually `"default"`).

Call `wez_rename_workspace` with `new_name: "test-workspace"`.

**Expected:** Response confirms the new name.

**Verify:** Check that the response includes the string `"test-workspace"`.
Do NOT just check that the call succeeded.

### Step 5 — Verify workspace changed

Call `wez_status`.

**Expected:** Windows section shows workspace `"test-workspace"`.

**Verify:** In the `wez_status` response, find the workspace field in the
windows section and check that it equals the string `"test-workspace"`.
Do NOT just check that the call succeeded.

## Pass Criteria

| # | Check               | Expected                          |
|---|---------------------|-----------------------------------|
| 1 | Tab title set       | Tool confirms title               |
| 2 | Window title set    | Tool confirms title               |
| 3 | Workspace renamed   | Tool confirms new name            |
| 4 | Status reflects it  | Status shows `"test-workspace"`   |

## Cleanup

`wez_kill_all`. Remove `/tmp/wez-test-07/`.
