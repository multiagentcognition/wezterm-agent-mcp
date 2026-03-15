import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { OS } from './platform.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InitOptions = {
  /** Per-project mode: write config files into this directory */
  projectRoot?: string;
};

export type InitResult = {
  mode: 'global' | 'project';
  updatedFiles: string[];
  /** Only set in project mode */
  projectRoot?: string;
};

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  const raw = readFileSync(filePath, 'utf8').trim();
  return raw ? JSON.parse(raw) as T : undefined;
}

function writeJsonIfChanged(
  filePath: string,
  nextValue: Record<string, unknown>,
  existing: Record<string, unknown>,
  updatedFiles: string[],
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  if (JSON.stringify(existing) !== JSON.stringify(nextValue)) {
    writeFileSync(filePath, `${JSON.stringify(nextValue, null, 2)}\n`, 'utf8');
    updatedFiles.push(filePath);
  }
}

// ---------------------------------------------------------------------------
// Server entry builders
// ---------------------------------------------------------------------------

/** Global entry — no WEZ_PROJECT_ROOT, server uses process.cwd() at runtime */
function globalEntry(): Record<string, unknown> {
  return {
    command: 'wezterm-agent-mcp',
    args: [],
  };
}

/** Project entry — pins WEZ_PROJECT_ROOT to specific directory */
function projectEntry(projectRoot: string): Record<string, unknown> {
  return {
    command: 'wezterm-agent-mcp',
    args: [],
    env: { WEZ_PROJECT_ROOT: projectRoot },
  };
}

// ---------------------------------------------------------------------------
// Global config paths (per platform)
// ---------------------------------------------------------------------------

function home(): string {
  return homedir();
}

function globalVsCodeMcpPath(): string {
  switch (OS.name) {
    case 'macos':
      return join(home(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    case 'windows':
      return join(process.env['APPDATA'] ?? join(home(), 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json');
    default: // linux
      return join(process.env['XDG_CONFIG_HOME'] ?? join(home(), '.config'), 'Code', 'User', 'mcp.json');
  }
}

function globalOpenCodePath(): string {
  switch (OS.name) {
    case 'windows':
      return join(home(), '.config', 'opencode', 'opencode.json');
    default: // linux, macos
      return join(process.env['XDG_CONFIG_HOME'] ?? join(home(), '.config'), 'opencode', 'opencode.json');
  }
}

// ---------------------------------------------------------------------------
// Shared writers (work for both global and project paths)
// ---------------------------------------------------------------------------

function writeMcpServersFile(filePath: string, entry: Record<string, unknown>, updatedFiles: string[]): void {
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingServers = (existing['mcpServers'] ?? {}) as Record<string, unknown>;
  const nextValue = {
    ...existing,
    mcpServers: { ...existingServers, 'wezterm-agent-mcp': entry },
  };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

function writeVsCodeFile(filePath: string, entry: Record<string, unknown>, updatedFiles: string[]): void {
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingServers = (existing['servers'] ?? {}) as Record<string, unknown>;
  const nextValue = {
    ...existing,
    servers: {
      ...existingServers,
      'wezterm-agent-mcp': { type: 'stdio', ...entry },
    },
  };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

function writeOpenCodeFile(filePath: string, entry: Record<string, unknown>, updatedFiles: string[]): void {
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingMcp = (existing['mcp'] ?? {}) as Record<string, unknown>;
  const nextValue = {
    ...existing,
    mcp: {
      ...existingMcp,
      'wezterm-agent-mcp': {
        type: 'local',
        command: [String(entry.command), ...((entry.args ?? []) as string[])],
        enabled: true,
        ...(entry.env ? { environment: entry.env as Record<string, string> } : {}),
      },
    },
  };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function preflight(): void {
  if (!OS.isWezInstalled()) {
    console.error(`Error: Wezterm is not installed or not found in PATH.

Install Wezterm first: https://wezfurlong.org/wezterm/installation`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Global init — writes to user-level config files for all tools */
export function initGlobal(): InitResult {
  preflight();

  const entry = globalEntry();
  const updatedFiles: string[] = [];

  // Claude Code — ~/.claude.json (NOT ~/.claude/settings.json)
  writeMcpServersFile(join(home(), '.claude.json'), entry, updatedFiles);

  // Cursor — ~/.cursor/mcp.json
  writeMcpServersFile(join(home(), '.cursor', 'mcp.json'), entry, updatedFiles);

  // VS Code — platform-specific path
  writeVsCodeFile(globalVsCodeMcpPath(), entry, updatedFiles);

  // Gemini CLI — ~/.gemini/settings.json
  writeMcpServersFile(join(home(), '.gemini', 'settings.json'), entry, updatedFiles);

  // OpenCode — platform-specific path
  writeOpenCodeFile(globalOpenCodePath(), entry, updatedFiles);

  return { mode: 'global', updatedFiles };
}

/** Project init — writes to project-level config files */
export function initProject(options: InitOptions = {}): InitResult {
  preflight();

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const entry = projectEntry(projectRoot);
  const updatedFiles: string[] = [];

  // .mcp.json — Claude Code, Codex
  writeMcpServersFile(resolve(projectRoot, '.mcp.json'), entry, updatedFiles);

  // .cursor/mcp.json — Cursor
  writeMcpServersFile(resolve(projectRoot, '.cursor', 'mcp.json'), entry, updatedFiles);

  // .vscode/mcp.json — VS Code
  writeVsCodeFile(resolve(projectRoot, '.vscode', 'mcp.json'), entry, updatedFiles);

  // .gemini/settings.json — Gemini CLI
  writeMcpServersFile(resolve(projectRoot, '.gemini', 'settings.json'), entry, updatedFiles);

  // opencode.json — OpenCode
  writeOpenCodeFile(resolve(projectRoot, 'opencode.json'), entry, updatedFiles);

  return { mode: 'project', updatedFiles, projectRoot };
}
