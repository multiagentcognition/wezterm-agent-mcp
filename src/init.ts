import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { OS } from './platform.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InitOptions = {
  projectRoot?: string;
};

export type InitResult = {
  projectRoot: string;
  updatedFiles: string[];
};

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
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
// Server entry builders (per config format)
// ---------------------------------------------------------------------------

function stdioEntry(projectRoot: string): Record<string, unknown> {
  return {
    command: 'wezterm-agent-mcp',
    args: [],
    env: { WEZ_PROJECT_ROOT: projectRoot },
  };
}

// ---------------------------------------------------------------------------
// Per-file writers
// ---------------------------------------------------------------------------

/** .mcp.json — Claude Code, Codex */
function writeMcpJson(projectRoot: string, updatedFiles: string[]): void {
  const filePath = resolve(projectRoot, '.mcp.json');
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingServers = (existing['mcpServers'] ?? {}) as Record<string, unknown>;
  const nextValue = {
    ...existing,
    mcpServers: { ...existingServers, 'wezterm-agent-mcp': stdioEntry(projectRoot) },
  };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

/** .cursor/mcp.json — Cursor */
function writeCursorMcpJson(projectRoot: string, updatedFiles: string[]): void {
  const filePath = resolve(projectRoot, '.cursor', 'mcp.json');
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingServers = (existing['mcpServers'] ?? {}) as Record<string, unknown>;
  const nextValue = {
    ...existing,
    mcpServers: { ...existingServers, 'wezterm-agent-mcp': stdioEntry(projectRoot) },
  };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

/** .vscode/mcp.json — VS Code */
function writeVsCodeMcpJson(projectRoot: string, updatedFiles: string[]): void {
  const filePath = resolve(projectRoot, '.vscode', 'mcp.json');
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingServers = (existing['servers'] ?? {}) as Record<string, unknown>;
  const nextValue = {
    ...existing,
    servers: {
      ...existingServers,
      'wezterm-agent-mcp': { type: 'stdio', ...stdioEntry(projectRoot) },
    },
  };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

/** .gemini/settings.json — Gemini CLI */
function writeGeminiSettings(projectRoot: string, updatedFiles: string[]): void {
  const filePath = resolve(projectRoot, '.gemini', 'settings.json');
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingServers = (existing['mcpServers'] ?? {}) as Record<string, unknown>;
  const nextValue = {
    ...existing,
    mcpServers: { ...existingServers, 'wezterm-agent-mcp': stdioEntry(projectRoot) },
  };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

/** opencode.json — OpenCode */
function writeOpenCodeJson(projectRoot: string, updatedFiles: string[]): void {
  const filePath = resolve(projectRoot, 'opencode.json');
  const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
  const existingMcp = (existing['mcp'] ?? {}) as Record<string, unknown>;
  const entry = stdioEntry(projectRoot);
  const nextValue = {
    ...existing,
    mcp: {
      ...existingMcp,
      'wezterm-agent-mcp': {
        type: 'local',
        command: [String(entry.command), ...((entry.args ?? []) as string[])],
        enabled: true,
        environment: (entry.env ?? {}) as Record<string, string>,
      },
    },
  };
  writeJsonIfChanged(filePath, nextValue, existing, updatedFiles);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initProject(options: InitOptions = {}): InitResult {
  if (!OS.isWezInstalled()) {
    console.error(`Error: Wezterm is not installed or not found in PATH.

Install Wezterm first: https://wezfurlong.org/wezterm/installation`);
    process.exit(1);
  }

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const updatedFiles: string[] = [];

  writeMcpJson(projectRoot, updatedFiles);
  writeCursorMcpJson(projectRoot, updatedFiles);
  writeVsCodeMcpJson(projectRoot, updatedFiles);
  writeGeminiSettings(projectRoot, updatedFiles);
  writeOpenCodeJson(projectRoot, updatedFiles);

  return { projectRoot, updatedFiles };
}
