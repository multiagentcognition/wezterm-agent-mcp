# Setup

To finalize this repo from the MACP project source:

```bash
cd /home/dev/Code/wezterm-mcp

# 1. Copy source file
mkdir -p src
cp /home/dev/Code/multiagentcognition/macp/src/wez-mcp.ts src/wez-mcp.ts

# 2. Install deps
npm install

# 3. Build
npm run build

# 4. Init git and push to panbergco
git init
git add -A
git commit -m "Initial commit: Wezterm MCP Server

Programmable terminal control plane for multi-agent AI workflows.
35 MCP tools for spawning, monitoring, and recovering AI agent sessions
across Wezterm windows/tabs/panes. Supports Claude, Gemini, Codex,
OpenCode, and Goose CLIs with auto-permission handling and session recovery."

gh repo create panbergco/wezterm-mcp --private --source=. --push
```

# Optional: clean up the old wez-mcp folder
```bash
rm -rf /home/dev/Code/wez-mcp
```
