#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { initProject } from './init.js';
import { runServer } from './wez-mcp.js';

function printHelp(): void {
  console.log(`wezterm-agent-mcp — terminal control plane for multi-agent AI workflows

Usage:
  wezterm-agent-mcp init [options]
  wezterm-agent-mcp [server options]
  wezterm-agent-mcp help

Commands:
  init      Configure MCP server entries for all supported AI coding tools
  help      Show this help

When no command is given, the stdio MCP server starts (default behavior).

Examples:
  npx wezterm-agent-mcp init
  npx wezterm-agent-mcp init --root /path/to/project
  npx wezterm-agent-mcp
`);
}

function runInitCli(args: string[]): void {
  const parsed = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      root: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });

  if (parsed.values.help) {
    console.log(`Configure MCP server entries for all supported AI coding tools

Usage:
  wezterm-agent-mcp init [options]

Options:
  --root <path>  Project root directory (default: current directory)
  -h, --help     Show help

Creates or updates these config files (merges with existing content):
  .mcp.json             Claude Code, Codex
  .cursor/mcp.json      Cursor
  .vscode/mcp.json      VS Code
  .gemini/settings.json  Gemini CLI
  opencode.json          OpenCode
`);
    return;
  }

  const result = initProject({
    projectRoot: parsed.values.root,
  });

  if (result.updatedFiles.length === 0) {
    console.log(`wezterm-agent-mcp already configured — no changes needed.

Project root: ${result.projectRoot}
`);
    return;
  }

  console.log(`wezterm-agent-mcp configured for this project

Project root: ${result.projectRoot}

Updated files:
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
