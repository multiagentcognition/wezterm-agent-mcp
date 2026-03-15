#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { initGlobal, initProject } from './init.js';
import { runServer } from './wez-mcp.js';

function printHelp(): void {
  console.log(`wezterm-agent-mcp — terminal control plane for multi-agent AI workflows

Usage:
  wezterm-agent-mcp init [options]
  wezterm-agent-mcp [server options]
  wezterm-agent-mcp help

Commands:
  init      Register wezterm-agent-mcp with all AI coding tools
  help      Show this help

When no command is given, the stdio MCP server starts (default behavior).

Examples:
  npx wezterm-agent-mcp init              # global setup (all projects)
  npx wezterm-agent-mcp init --project    # per-project setup (current dir)
  npx wezterm-agent-mcp
`);
}

function runInitCli(args: string[]): void {
  const parsed = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      project: { type: 'boolean' },
      root: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });

  if (parsed.values.help) {
    console.log(`Register wezterm-agent-mcp with all AI coding tools

Usage:
  wezterm-agent-mcp init [options]

Options:
  --project      Per-project mode (write config into project directory)
  --root <path>  Project root directory (implies --project, default: cwd)
  -h, --help     Show help

Default (no flags) registers globally for all projects:
  ~/.claude/settings.json      Claude Code, Codex
  ~/.cursor/mcp.json           Cursor
  VS Code user mcp.json        VS Code (platform-specific path)
  ~/.gemini/settings.json      Gemini CLI
  ~/.config/opencode/...       OpenCode (platform-specific path)

With --project, writes per-project config files:
  .mcp.json                    Claude Code, Codex
  .cursor/mcp.json             Cursor
  .vscode/mcp.json             VS Code
  .gemini/settings.json        Gemini CLI
  opencode.json                OpenCode
`);
    return;
  }

  const isProjectMode = parsed.values.project === true || parsed.values.root !== undefined;

  const result = isProjectMode
    ? initProject({ projectRoot: parsed.values.root })
    : initGlobal();

  if (result.updatedFiles.length === 0) {
    console.log(`wezterm-agent-mcp already configured — no changes needed.`);
    return;
  }

  const header = result.mode === 'global'
    ? 'wezterm-agent-mcp registered globally for all projects'
    : `wezterm-agent-mcp configured for ${result.projectRoot}`;

  console.log(`${header}

Updated:
${result.updatedFiles.map((f) => `  ${f}`).join('\n')}
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'init') {
    runInitCli(args.slice(1));
    return;
  }

  // Default: run the MCP server (preserves existing behavior for `npx wezterm-agent-mcp`)
  await runServer();
}

main().catch((err) => {
  console.error('wezterm-agent-mcp failed:', err);
  process.exit(1);
});
