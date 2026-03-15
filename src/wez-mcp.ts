#!/usr/bin/env node

/**
 * Wezterm MCP Server
 *
 * Exposes Wezterm's terminal multiplexer as MCP tools.
 * Agents can spawn panes, inject prompts, read output,
 * and manage layouts without knowing the CLI syntax.
 */

import { execSync, execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OS, sleepMs } from './platform.js';

// ---------------------------------------------------------------------------
// Server Configuration — resolved from env or CLI args
// ---------------------------------------------------------------------------

/**
 * Git/coordination mode:
 * All agents work in the SAME branch and SAME working directory.
 * MACP handles coordination — file claims prevent conflicts,
 * channel messages keep agents aligned, atomic task claiming
 * prevents duplicate work. No worktrees, no per-agent branches.
 */
const GIT_MODE = 'shared-branch' as const;

/** Project root — all panes default to this cwd */
const PROJECT_ROOT: string | undefined =
  process.env['WEZ_PROJECT_ROOT'] ??
  process.env['MACP_PROJECT_ROOT'] ??
  process.cwd();

/** Git branch agents should stay on (informational, not enforced) */
const GIT_BRANCH: string | undefined = process.env['WEZ_GIT_BRANCH'];

// ---------------------------------------------------------------------------
// CLI Definitions — all supported AI coding CLIs
// ---------------------------------------------------------------------------

type CliDef = {
  /** Binary name */
  bin: string;
  /** Flags to skip permission prompts / run autonomously */
  skipPermFlags: string[];
  /** Environment variables to set for autonomous mode */
  skipPermEnv?: Record<string, string>;
  /** Config file setup needed before launch (for CLIs that use config-based permissions) */
  configSetup?: {
    path: string;
    settings: Record<string, unknown>;
  };
  /** Pre-trust working directory so the CLI doesn't prompt on launch */
  trustSetup?: 'claude' | 'gemini' | 'codex';
  /** Human-readable name */
  label: string;
};

const CLI_DEFS: Record<string, CliDef> = {
  claude: {
    bin: 'claude',
    skipPermFlags: ['--dangerously-skip-permissions'],
    trustSetup: 'claude',
    label: 'Claude Code',
  },
  gemini: {
    bin: 'gemini',
    skipPermFlags: ['--no-sandbox'],
    trustSetup: 'gemini',
    label: 'Gemini CLI',
  },
  codex: {
    bin: 'codex',
    skipPermFlags: ['-a', 'never'],
    trustSetup: 'codex',
    label: 'Codex CLI',
  },
  opencode: {
    bin: 'opencode',
    skipPermFlags: [],
    configSetup: {
      path: '~/.config/opencode/opencode.json',
      settings: { permission: 'allow' },
    },
    label: 'OpenCode',
  },
  goose: {
    bin: 'goose',
    skipPermFlags: [],
    skipPermEnv: { GOOSE_MODE: 'auto' },
    label: 'Goose',
  },
};

// ---------------------------------------------------------------------------
// Session Manifest — tracks what's running for crash recovery
// ---------------------------------------------------------------------------

type PaneManifest = {
  pane_id: number;
  cli: string;
  session_id: string | null;
  cwd: string;
};

type TabManifest = {
  tab_id: number;
  title: string;
  panes: PaneManifest[];
};

type WindowManifest = {
  window_id: number;
  workspace: string;
  tabs: TabManifest[];
};

type SessionManifest = {
  saved_at: string;
  project_root: string;
  git_branch: string | null;
  windows: WindowManifest[];
};

const MANIFEST_DIR = PROJECT_ROOT ? join(PROJECT_ROOT, '.wezterm') : join(homedir(), '.macp');
const MANIFEST_PATH = join(MANIFEST_DIR, 'wez-session.json');

function saveManifest(manifest: SessionManifest): void {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  // Back up existing manifest before overwriting
  if (existsSync(MANIFEST_PATH)) {
    const backupPath = join(MANIFEST_DIR, 'wez-session.backup.json');
    try { renameSync(MANIFEST_PATH, backupPath); } catch { /* ignore */ }
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

function loadManifest(): SessionManifest | null {
  try {
    if (!existsSync(MANIFEST_PATH)) return null;
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Capture the current wezterm state into a manifest.
 * Detects CLIs and scrapes session IDs from pane output.
 */
function captureManifest(): SessionManifest {
  const panes = listPanes();
  let branch: string | null = null;
  try {
    branch = execFileSync('git', ['-C', PROJECT_ROOT ?? '.', 'branch', '--show-current'], {
      encoding: 'utf8', timeout: 5000,
    }).trim() || null;
  } catch { /* ignore */ }

  // Pre-compute all pane contexts once (avoids redundant subprocess calls in getSessionId)
  const contexts = new Map<number, PaneContext>();
  for (const p of panes) {
    const state = detectPaneState(p);
    contexts.set(p.pane_id, { cli: state.cli, cwd: normalizeCwd(p.cwd), ttyName: p.tty_name });
  }

  const windows = new Map<number, WindowManifest>();

  for (const p of panes) {
    if (!windows.has(p.window_id)) {
      windows.set(p.window_id, { window_id: p.window_id, workspace: p.workspace, tabs: [] });
    }
    const win = windows.get(p.window_id)!;

    let tab = win.tabs.find(t => t.tab_id === p.tab_id);
    if (!tab) {
      tab = { tab_id: p.tab_id, title: '', panes: [] };
      win.tabs.push(tab);
    }

    const ctx = contexts.get(p.pane_id)!;
    const sessionId = ctx.cli ? getSessionId(p.pane_id, ctx.cli, contexts) : null;

    tab.panes.push({
      pane_id: p.pane_id,
      cli: ctx.cli ?? 'shell',
      session_id: sessionId,
      cwd: ctx.cwd,
    });
  }

  return {
    saved_at: new Date().toISOString(),
    project_root: PROJECT_ROOT ?? process.cwd(),
    git_branch: branch,
    windows: Array.from(windows.values()),
  };
}

/** Pre-computed pane context for efficient session ID resolution. */
type PaneContext = { cli: string | null; cwd: string; ttyName: string };

/**
 * Get session ID for a CLI running in a pane.
 * Accepts pre-computed pane contexts to avoid redundant subprocess calls.
 *
 * Per-CLI session storage:
 * - Claude: ~/.claude/sessions/{PID}.json → { sessionId, cwd }
 * - Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl → first line has session_meta with cwd
 * - Gemini: ~/.gemini/projects.json maps CWD→slug, ~/.gemini/tmp/{slug}/chats/*.json
 * - OpenCode: ~/.local/share/opencode/opencode.db (SQLite, session table with directory column)
 * - Goose: goose session list --format json
 */
function getSessionId(paneId: number, cli: string, allContexts: Map<number, PaneContext>): string | null {
  try {
    const ctx = allContexts.get(paneId);
    if (!ctx) return null;

    const paneCwd = ctx.cwd;
    const bin = CLI_DEFS[cli]?.bin ?? cli;
    const cliPid = OS.getCliPid(ctx.ttyName, bin);

    // Count how many panes run the same CLI type in the SAME CWD.
    // CWD-based session matching is safe when each instance has a unique CWD.
    // Only when 2+ instances of the same CLI share a CWD do we bail out,
    // since the filesystem fallback can't distinguish them.
    const sameCliSameCwd = [...allContexts.values()].filter(
      c => c.cli === cli && pathsEqual(c.cwd, paneCwd),
    );
    const multipleInstances = sameCliSameCwd.length > 1;

    switch (cli) {
      case 'claude': {
        // ~/.claude/sessions/{PID}.json contains { sessionId: "uuid" }
        // Per-PID lookup is precise — safe even with multiple instances.
        if (cliPid) {
          const sessionFile = join(homedir(), '.claude', 'sessions', `${cliPid}.json`);
          if (existsSync(sessionFile)) {
            const data = JSON.parse(readFileSync(sessionFile, 'utf8'));
            return data.sessionId ?? null;
          }
        }
        // Fallback: find session file matching this pane's CWD.
        // Only safe when a single instance runs.
        if (multipleInstances) return null;
        const sessionsDir = join(homedir(), '.claude', 'sessions');
        if (!existsSync(sessionsDir)) return null;
        try {
          const files = readdirSync(sessionsDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
              const full = join(sessionsDir, f);
              try {
                const data = JSON.parse(readFileSync(full, 'utf8'));
                return { name: f, mtime: statSync(full).mtimeMs, cwd: data.cwd, sessionId: data.sessionId };
              } catch { return null; }
            })
            .filter((f): f is NonNullable<typeof f> => f !== null)
            .sort((a, b) => b.mtime - a.mtime);
          // Match by CWD first (normalize for backslash/forward-slash differences)
          const cwdMatch = files.find(f => f.cwd && pathsEqual(f.cwd, paneCwd));
          if (cwdMatch) return cwdMatch.sessionId ?? null;
          // Global fallback (Windows or single-instance)
          if (files.length > 0) return files[0]!.sessionId ?? null;
        } catch { /* ignore */ }
        return null;
      }

      case 'codex': {
        // Walk ~/.codex/sessions/ for rollout files, match by CWD from session_meta.
        // Fallback (no CWD match) is not safe with multiple instances.
        if (multipleInstances) return null;
        const codexDir = join(homedir(), '.codex', 'sessions');
        if (!existsSync(codexDir)) return null;
        try {
          const files: { mtime: number; path: string }[] = [];
          const walk = (dir: string) => {
            for (const entry of readdirSync(dir)) {
              const full = join(dir, entry);
              const st = statSync(full);
              if (st.isDirectory()) { walk(full); }
              else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
                files.push({ mtime: st.mtimeMs, path: full });
              }
            }
          };
          walk(codexDir);
          files.sort((a, b) => b.mtime - a.mtime);

          // Try to match by CWD from session_meta in the first line
          for (const file of files) {
            try {
              const firstLine = readFileSync(file.path, 'utf8').split('\n')[0];
              if (!firstLine) continue;
              const meta = JSON.parse(firstLine);
              if (meta.type === 'session_meta' && meta.payload?.cwd) {
                const fileCwd = meta.payload.cwd.replace(/\/$/, '');
                if (pathsEqual(fileCwd, paneCwd)) {
                  return meta.payload.id ?? null;
                }
              }
            } catch { continue; }
          }
          // No CWD match — return newest as fallback
          if (files.length > 0) {
            try {
              const firstLine = readFileSync(files[0]!.path, 'utf8').split('\n')[0];
              if (firstLine) {
                const meta = JSON.parse(firstLine);
                return meta.payload?.id ?? null;
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        return null;
      }

      case 'gemini': {
        // Gemini maps CWD→slug in ~/.gemini/projects.json
        // Sessions stored in ~/.gemini/tmp/{slug}/chats/session-*.json
        // Each JSON has { sessionId: "uuid", ... }
        const projectsFile = join(homedir(), '.gemini', 'projects.json');
        const geminiDir = join(homedir(), '.gemini', 'tmp');
        if (!existsSync(geminiDir)) return null;
        try {
          // Try to find the project slug for this CWD
          let targetSlug: string | null = null;
          if (existsSync(projectsFile)) {
            const raw = JSON.parse(readFileSync(projectsFile, 'utf8'));
            const mapping: Record<string, string> = raw.projects ?? raw;
            // Try exact match first, then path-normalized match
            targetSlug = mapping[paneCwd] ?? null;
            if (!targetSlug) {
              for (const [path, slug] of Object.entries(mapping)) {
                if (pathsEqual(path, paneCwd)) { targetSlug = slug; break; }
              }
            }
          }

          // Search for sessions — prioritize matching slug, fall back to all dirs
          const dirsToSearch = targetSlug
            ? [join(geminiDir, targetSlug)]
            : readdirSync(geminiDir).map(d => join(geminiDir, d));

          for (const dir of dirsToSearch) {
            const chatsDir = join(dir, 'chats');
            if (!existsSync(chatsDir)) continue;
            const sessions = readdirSync(chatsDir)
              .filter(f => f.endsWith('.json'))
              .map(f => ({ name: f, mtime: statSync(join(chatsDir, f)).mtimeMs, path: join(chatsDir, f) }))
              .sort((a, b) => b.mtime - a.mtime);
            if (sessions.length > 0) {
              // Read the JSON to extract the real sessionId UUID
              const data = JSON.parse(readFileSync(sessions[0]!.path, 'utf8'));
              return data.sessionId ?? null;
            }
          }
        } catch { /* ignore */ }
        return null;
      }

      case 'opencode': {
        // OpenCode stores sessions in SQLite at ~/.local/share/opencode/opencode.db
        const dbPaths = [
          join(homedir(), '.local', 'share', 'opencode', 'opencode.db'),
          join(homedir(), '.opencode', 'opencode.db'),
        ];
        // Try all path variants (forward/backslash on Windows)
        const cwdVariants = OS.pathVariants(paneCwd);
        for (const dbPath of dbPaths) {
          if (!existsSync(dbPath)) continue;
          for (const cwdVar of cwdVariants) {
            try {
              const escaped = cwdVar.replace(/'/g, "''");
              const result = execFileSync('sqlite3', [dbPath,
                `SELECT id FROM session WHERE directory = '${escaped}' ORDER BY rowid DESC LIMIT 1;`
              ], { encoding: 'utf8', timeout: 5000 }).trim();
              if (result) return result;
            } catch { /* ignore */ }
          }
        }
        // Fallback: try without CWD filter — only safe with one instance.
        if (multipleInstances) return null;
        try {
          const result = execFileSync('sqlite3', [dbPaths[0]!,
            `SELECT id FROM session ORDER BY rowid DESC LIMIT 1;`
          ], { encoding: 'utf8', timeout: 5000 }).trim();
          if (result) return result;
        } catch { /* ignore */ }
        // Fallback: null means buildResumeCommand will use --continue
        return null;
      }

      case 'goose': {
        // Goose uses SQLite — query for most recent session
        if (multipleInstances) return null;
        try {
          const result = execFileSync('goose', ['session', 'list', '--format', 'json', '--limit', '1'], {
            encoding: 'utf8', timeout: 5000,
          });
          const sessions = JSON.parse(result);
          if (Array.isArray(sessions) && sessions.length > 0) {
            return sessions[0].session_id ?? sessions[0].id ?? null;
          }
        } catch { /* ignore */ }
        return null;
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Build the resume command for a CLI with a specific session ID.
 * Pass cwd to ensure the directory is pre-trusted before launching.
 */
function buildResumeCommand(cli: string, sessionId: string | null, cwd?: string): ResolvedCommand {
  const def = CLI_DEFS[cli];
  if (!def) {
    const defaultShell = OS.defaultShell;
    return { parts: [defaultShell], shellCommand: defaultShell, needsShell: false };
  }
  // Pre-trust the directory so the CLI doesn't prompt on resume
  if (cwd) ensureCliTrust(cli, cwd);

  // Validate session exists on disk before trying to resume it
  let validSessionId = sessionId;
  if (validSessionId) {
    switch (cli) {
      case 'claude': {
        // Claude needs a .jsonl file in the project directory
        const projectsDir = join(homedir(), '.claude', 'projects');
        let found = false;
        try {
          for (const projDir of readdirSync(projectsDir)) {
            const jsonl = join(projectsDir, projDir, `${validSessionId}.jsonl`);
            if (existsSync(jsonl)) {
              found = true;
              break;
            }
          }
        } catch { /* ignore */ }
        if (!found) validSessionId = null;
        break;
      }
      case 'codex': {
        // Codex session ID is the rollout UUID — verify the rollout file exists
        const codexDir = join(homedir(), '.codex', 'sessions');
        let found = false;
        try {
          const walk = (dir: string): boolean => {
            for (const entry of readdirSync(dir)) {
              const full = join(dir, entry);
              if (statSync(full).isDirectory()) { if (walk(full)) return true; }
              else if (entry.includes(validSessionId!)) return true;
            }
            return false;
          };
          found = existsSync(codexDir) && walk(codexDir);
        } catch { /* ignore */ }
        if (!found) validSessionId = null;
        break;
      }
      // Gemini and OpenCode: trust the session ID (validated at detection time)
    }
  }

  // Start with skip-permissions command
  const base = resolveCliCommand(cli, true);

  // Helper: append resume flags to a resolved command.
  // When needsShell is true (cmd.exe /c "..." or bash -c "..."), flags must
  // go INSIDE the shell command string (parts[2]), not as separate array elements.
  const appendFlags = (target: ResolvedCommand, ...flags: string[]): void => {
    const suffix = ' ' + flags.join(' ');
    if (target.needsShell) {
      target.parts[2] += suffix;
    } else {
      target.parts.push(...flags);
    }
    target.shellCommand += suffix;
  };

  if (!validSessionId) {
    // No valid session ID — try "resume latest" with fallback to fresh start.
    // The fallback handles cases where no previous session exists in the CWD
    // (e.g. first launch in a new directory, or temp directories).
    const fresh = resolveCliCommand(cli, true);
    switch (cli) {
      case 'claude':
        appendFlags(base, '--continue');
        return wrapWithFreshFallback(base, fresh);
      case 'gemini':
        appendFlags(base, '--resume', 'latest');
        return wrapWithFreshFallback(base, fresh);
      case 'codex': {
        const resumeCmd = OS.wrapCliForSpawn('codex', ['codex', 'resume', '--last']);
        return wrapWithFreshFallback(resumeCmd, fresh);
      }
      case 'opencode':
        appendFlags(base, '--continue');
        return wrapWithFreshFallback(base, fresh);
      case 'goose': {
        const envCmd = `${OS.setEnvCmd('GOOSE_MODE', 'auto')} && goose session --resume`;
        const resumeCmd = OS.wrapCliForSpawn('goose', OS.shellExec(envCmd));
        return wrapWithFreshFallback(resumeCmd, fresh);
      }
    }
    return wrapWithFreshFallback(base, fresh);
  }

  // Specific session ID — use targeted resume
  switch (cli) {
    case 'claude':
      appendFlags(base, '--resume', validSessionId);
      break;
    case 'gemini':
      // Gemini --resume only accepts "latest" or an index number, not UUIDs.
      // We store the UUID for reconcile/verification but always resume latest.
      appendFlags(base, '--resume', 'latest');
      break;
    case 'codex':
      return OS.wrapCliForSpawn('codex', ['codex', 'resume', validSessionId]);
    case 'opencode':
      appendFlags(base, '--session', validSessionId);
      break;
    case 'goose':
      if (base.needsShell) {
        const envCmd = `${OS.setEnvCmd('GOOSE_MODE', 'auto')} && goose session --resume --session-id ${validSessionId}`;
        return OS.wrapCliForSpawn('goose', OS.shellExec(envCmd));
      }
      return OS.wrapCliForSpawn('goose', ['goose', 'session', '--resume', '--session-id', validSessionId]);
  }

  return base;
}

// ---------------------------------------------------------------------------
// CLI Config Setup
// ---------------------------------------------------------------------------

/**
 * Ensure config-based permissions are set for CLIs that need it.
 * Called before launching agents.
 */
function ensureCliConfig(cli: string): void {
  const def = CLI_DEFS[cli];
  if (!def?.configSetup) return;

  const { path: configPath, settings } = def.configSetup;
  const resolved = configPath.replace('~', homedir());
  const dir = dirname(resolved);

  try {
    mkdirSync(dir, { recursive: true });

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(resolved, 'utf8'));
    } catch { /* file doesn't exist yet */ }

    const updated = { ...existing, ...settings };
    writeFileSync(resolved, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  } catch { /* ignore — best effort */ }
}

/**
 * Pre-trust a working directory so the CLI doesn't prompt on launch.
 * Each CLI stores trust config differently:
 * - Claude: ~/.claude/projects/{encoded-path}/  (directory existence = trusted)
 * - Gemini: ~/.gemini/trustedFolders.json  { "/path": "TRUST_FOLDER" }
 * - Codex:  ~/.codex/config.toml           [projects."/path"] trust_level = "trusted"
 */
function ensureCliTrust(cli: string, cwd: string): void {
  const def = CLI_DEFS[cli];
  if (!def?.trustSetup || !cwd) return;

  try {
    switch (def.trustSetup) {
      case 'claude': {
        // Claude Code trusts a directory once ~/.claude/projects/{encoded}/ exists.
        const encoded = OS.encodeTrustPath(cwd);
        const projectDir = join(homedir(), '.claude', 'projects', encoded);
        mkdirSync(projectDir, { recursive: true });
        break;
      }
      case 'gemini': {
        const trustFile = join(homedir(), '.gemini', 'trustedFolders.json');
        let existing: Record<string, string> = {};
        try {
          existing = JSON.parse(readFileSync(trustFile, 'utf8'));
        } catch { /* file doesn't exist yet */ }
        // Check all path variants (forward/backslash on Windows)
        const alreadyTrusted = OS.pathVariants(cwd).some(v => existing[v]);
        if (!alreadyTrusted) {
          const fwdCwd = cwd.replace(/\\/g, '/');
          existing[fwdCwd] = 'TRUST_FOLDER';
          mkdirSync(dirname(trustFile), { recursive: true });
          writeFileSync(trustFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
        }
        break;
      }
      case 'codex': {
        const configFile = join(homedir(), '.codex', 'config.toml');
        let content = '';
        try {
          content = readFileSync(configFile, 'utf8');
        } catch { /* file doesn't exist yet */ }
        // Check if this project is already trusted (handle all path variants)
        // On Windows, CWD may have forward slashes (C:/path) or backslashes (C:\path).
        // TOML entries may use single quotes (safe) or double quotes (breaks with backslashes).
        const fwdCwd = cwd.replace(/\\/g, '/');
        const bkCwd = cwd.replace(/\//g, '\\');
        const variants = [
          `[projects.'${fwdCwd}']`, `[projects."${fwdCwd}"]`,
          `[projects.'${bkCwd}']`,  `[projects."${bkCwd}"]`,
        ];
        if (!variants.some(v => content.includes(v))) {
          mkdirSync(dirname(configFile), { recursive: true });
          // Always write single-quoted with forward slashes (safe on all platforms)
          const entry = `\n[projects.'${fwdCwd}']\ntrust_level = "trusted"\n`;
          writeFileSync(configFile, content + entry, 'utf8');
        }
        break;
      }
    }
  } catch { /* ignore — best effort */ }
}

type ResolvedCommand = {
  /** Full command parts to pass to wezterm spawn */
  parts: string[];
  /** Shell command string (includes env var exports if needed) */
  shellCommand: string;
  /** Whether this needs to be run via shell (due to env vars) */
  needsShell: boolean;
};

/**
 * Wrap a resume command with a fallback to fresh start.
 * If the resume command exits non-zero (e.g. "no session to continue"),
 * the fallback starts the CLI fresh instead of leaving a dead pane.
 */
function wrapWithFreshFallback(resume: ResolvedCommand, fresh: ResolvedCommand): ResolvedCommand {
  const resumeInner = resume.needsShell ? resume.parts[2] : resume.parts.join(' ');
  const freshInner = fresh.needsShell ? fresh.parts[2] : fresh.parts.join(' ');
  const fallbackCmd = `(${resumeInner}) || (${freshInner})`;
  return {
    parts: OS.shellExec(fallbackCmd),
    shellCommand: `${resume.shellCommand} || ${fresh.shellCommand}`,
    needsShell: true,
  };
}

function resolveCliCommand(cli: string, skipPermissions: boolean, cwd?: string): ResolvedCommand {
  const def = CLI_DEFS[cli];
  if (!def) {
    throw new Error(`Unknown CLI "${cli}". Supported: ${Object.keys(CLI_DEFS).join(', ')}`);
  }
  if (skipPermissions) {
    ensureCliConfig(cli);
    if (cwd) ensureCliTrust(cli, cwd);
  }

  const parts = [def.bin];
  if (skipPermissions && def.skipPermFlags.length > 0) {
    parts.push(...def.skipPermFlags);
  }

  // If env vars are needed, we must run via shell wrapper
  if (skipPermissions && def.skipPermEnv && Object.keys(def.skipPermEnv).length > 0) {
    const envParts = Object.entries(def.skipPermEnv)
      .map(([k, v]) => OS.setEnvCmd(k, v));
    const shellCommand = OS.envShellCommand(envParts, parts.join(' '));
    return OS.wrapCliForSpawn(cli, OS.shellExec(shellCommand));
  }

  // Wrap for platform (Windows npm .cmd shims, OSC 1337 CLI tagging)
  return OS.wrapCliForSpawn(cli, parts);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// sleepMs imported from ./platform.js

/**
 * Check if wezterm binary exists on PATH or in common install locations.
 */
function isWezInstalled(): boolean {
  return OS.isWezInstalled();
}

/**
 * Check if the wezterm mux server is running and responsive.
 * Uses GUI socket discovery to find the right instance.
 */
function isWezRunning(): boolean {
  try {
    wez('list');
    return true;
  } catch {
    return false;
  }
}

/**
 * Start wezterm GUI if not running. Returns true if it was started.
 */
function isGuiRunning(): boolean {
  return OS.isProcessRunning('wezterm-gui');
}

function ensureWezRunning(): { running: boolean; started: boolean } {
  // Both mux and GUI must be running — a headless mux-server alone is not enough
  if (isWezRunning() && isGuiRunning()) {
    return { running: true, started: false };
  }

  if (!isWezInstalled()) {
    return { running: false, started: false };
  }

  // Kill orphaned mux-server with no GUI attached
  if (isWezRunning() && !isGuiRunning()) {
    killMuxProcess();
    cleanSockets();
    sleepMs(500);
  }

  // Launch WezTerm GUI as a detached process (cross-platform)
  const cwd = PROJECT_ROOT ?? process.cwd();
  if (!launchWeztermDetached(cwd)) {
    return { running: false, started: false };
  }

  // Wait for GUI + mux socket to come up
  for (let i = 0; i < 20; i++) {
    sleepMs(500);
    if (isWezRunning()) {
      return { running: true, started: true };
    }
  }

  return { running: false, started: false };
}

/**
 * Find the active Wezterm GUI socket.
 * Wezterm can have multiple mux servers (stale + active).
 * The GUI socket is the one that has actual panes.
 * We prefer gui-sock-* over the default sock.
 */
function findGuiSocket(): string | undefined {
  const socketDir = OS.socketDir();
  try {
    const entries = readdirSync(socketDir);
    const guiSock = entries.find(e => e.startsWith('gui-sock-'));
    if (guiSock) return join(socketDir, guiSock);
    if (entries.includes('sock')) return join(socketDir, 'sock');
  } catch { /* ignore */ }
  return undefined;
}

function weztermBin(): string {
  return OS.weztermBin();
}

function weztermGuiBin(): string {
  return OS.weztermGuiBin();
}

/**
 * Launch WezTerm GUI as a detached process. Works on all platforms.
 * Uses child_process.spawn with detached+unref so it outlives the MCP process.
 */
function launchWeztermDetached(cwd: string): boolean {
  try {
    const bin = weztermGuiBin();
    const child = nodeSpawn(bin, ['start', '--cwd', cwd], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function wez(...args: string[]): string {
  try {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    const guiSocket = findGuiSocket();
    if (guiSocket) {
      env['WEZTERM_UNIX_SOCKET'] = guiSocket;
    }
    return execFileSync(weztermBin(), ['cli', ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env,
    }).trim();
  } catch (err: any) {
    throw new Error(`wezterm cli ${args.join(' ')} failed: ${err.stderr || err.message}`);
  }
}

function wezJson(...args: string[]): any {
  const raw = wez(...args, '--format', 'json');
  return JSON.parse(raw);
}

/** Normalize CWD from wezterm's file:// URI to a local path. */
function normalizeCwd(cwd: string): string {
  return OS.normalizeCwd(cwd);
}

/** Compare two paths ignoring slash direction and trailing slashes. */
function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

type PaneInfo = {
  window_id: number;
  tab_id: number;
  pane_id: number;
  workspace: string;
  size: { rows: number; cols: number; pixel_width: number; pixel_height: number };
  title: string;
  cwd: string;
  is_active: boolean;
  is_zoomed: boolean;
  tty_name: string;
  cursor_x: number;
  cursor_y: number;
};

function listPanes(): PaneInfo[] {
  return wezJson('list') as PaneInfo[];
}

function panesInTab(tabId: number): PaneInfo[] {
  return listPanes().filter(p => p.tab_id === tabId);
}

/**
 * Build spawn args that route to the correct project window.
 * - If new_window is true, always creates a new window.
 * - Otherwise, looks for an existing window with matching cwd and adds a tab there.
 * - If no matching window exists, creates a new window automatically.
 * Returns the args array to prepend to wez('spawn', ...args).
 */
function projectSpawnArgs(dir: string | undefined, newWindow?: boolean): string[] {
  const args: string[] = [];
  if (newWindow) {
    args.push('--new-window');
  } else {
    const targetCwd = (dir ?? '').replace(/\/$/, '');
    if (targetCwd) {
      const allPanes = listPanes();
      let existingPaneId: number | undefined;
      for (const p of allPanes) {
        if (pathsEqual(normalizeCwd(p.cwd), targetCwd)) {
          existingPaneId = p.pane_id;
          break;
        }
      }
      if (existingPaneId !== undefined) {
        // Add tab to the existing project window
        args.push('--pane-id', String(existingPaneId));
      } else {
        // No window for this project yet — create one
        args.push('--new-window');
      }
    }
  }
  if (dir) args.push('--cwd', dir);
  return args;
}

function sendTextAndSubmit(paneId: number, text: string): void {
  // Send text via paste mode (fast, atomic) then Enter via --no-paste.
  // TUI apps (codex, gemini, opencode) use alternate screen buffers where
  // --no-paste types char-by-char; paste mode delivers the text as a block
  // so the TUI processes it fully before the Enter arrives.
  // A small delay is needed between paste and Enter — without it, TUIs like
  // Claude Code and Gemini receive the Enter before the paste is processed.
  // On Linux, PTY icrnl translates CR→LF so \x0d works. On Windows ConPTY
  // there's no such translation — TUIs expect \n (LF), not \x0d (CR).
  wez('send-text', '--pane-id', String(paneId), text);
  sleepMs(150);
  wez('send-text', '--pane-id', String(paneId), '--no-paste', OS.enterKey);
}

/**
 * Detect what process is running in a pane by checking its title and output.
 * Returns a structured description of the pane's state.
 */
function detectPaneState(pane: PaneInfo): {
  cli: string | null;
  state: 'idle' | 'cli-ready' | 'cli-working' | 'exited';
  lastOutput: string;
} {
  const title = pane.title.toLowerCase();

  // Detect CLI from pane title
  let cli: string | null = null;
  if (title.includes('claude')) cli = 'claude';
  else if (title.includes('gemini') || title.includes('◇')) cli = 'gemini';
  else if (title.includes('codex')) cli = 'codex';
  else if (title.includes('opencode') || title.startsWith('oc |')) cli = 'opencode';
  else if (title.includes('goose')) cli = 'goose';

  // Read pane output
  let lastOutput = '';
  let fullOutput = '';
  try {
    const raw = wez('get-text', '--pane-id', String(pane.pane_id));
    fullOutput = raw;
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    lastOutput = lines.slice(-5).join('\n');
  } catch { /* ignore */ }

  // Fallback: detect CLI from full pane output when title doesn't match
  // (e.g. codex shows title "node" since it's a Node.js app,
  //  gemini shows "Ready (Project)" — banners may scroll off last 5 lines)
  if (!cli) {
    const allOutput = fullOutput.toLowerCase();
    if (allOutput.includes('openai codex') || allOutput.includes('>_ codex')) cli = 'codex';
    else if (allOutput.includes('claude code')) cli = 'claude';
    else if (allOutput.includes('gemini cli')) cli = 'gemini';
    else if (allOutput.includes('opencode')) cli = 'opencode';
    else if (allOutput.includes('goose')) cli = 'goose';
  }

  // Detect state
  let state: 'idle' | 'cli-ready' | 'cli-working' | 'exited' = 'idle';
  if (lastOutput.includes('exit_behavior="Hold"') ||
      /Process ".*" .* completed/.test(lastOutput) ||
      lastOutput.includes('exited with code')) {
    state = 'exited';
  } else if (cli) {
    // CLI is running — check if it's waiting for input or working
    if (lastOutput.includes('❯') && lastOutput.match(/❯\s*$/m)) {
      state = 'cli-ready'; // waiting for prompt
    } else if (cli === 'codex' && lastOutput.match(/›\s*$/m)) {
      state = 'cli-ready'; // codex uses › prompt
    } else {
      state = 'cli-working';
    }
  }

  return { cli, state, lastOutput };
}

function resolveCwd(cwd: string | undefined): string | undefined {
  return cwd ?? PROJECT_ROOT;
}

/**
 * Get the current terminal size from wezterm.
 * Returns the size of the first/active pane.
 */
function getTerminalSize(): { cols: number; rows: number } {
  try {
    const panes = listPanes();
    if (panes.length > 0) {
      const p = panes[0]!;
      return { cols: p.size.cols, rows: p.size.rows };
    }
  } catch { /* ignore */ }
  return { cols: 200, rows: 50 }; // sensible fallback
}

/**
 * Calculate optimal grid layout based on terminal size and agent count.
 *
 * Each pane needs a minimum size to be usable:
 * - Min width: 40 cols (enough for a CLI prompt)
 * - Min height: 10 rows (enough to see output)
 *
 * The grid is sized so panes don't go below these minimums.
 * If more agents are requested than fit, they get spread across multiple tabs.
 */
function calculateGrid(count: number): { cols: number; rows: number; perTab: number; tabs: number } {
  const size = getTerminalSize();

  const MIN_PANE_COLS = 40;
  const MIN_PANE_ROWS = 10;

  const maxCols = Math.max(1, Math.floor(size.cols / MIN_PANE_COLS));
  const maxRows = Math.max(1, Math.floor(size.rows / MIN_PANE_ROWS));
  const maxPerTab = maxCols * maxRows;

  if (count <= maxPerTab) {
    // Fits in one tab — optimize for squareness
    const cols = Math.min(maxCols, Math.ceil(Math.sqrt(count)));
    const rows = Math.min(maxRows, Math.ceil(count / cols));
    return { cols, rows, perTab: count, tabs: 1 };
  }

  // Needs multiple tabs — fill each tab to capacity
  const tabs = Math.ceil(count / maxPerTab);
  return { cols: maxCols, rows: maxRows, perTab: maxPerTab, tabs };
}

function ok(data: Record<string, unknown> = {}): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'wezterm-mcp', version: '0.1.0' });

// --- Wezterm lifecycle ------------------------------------------------------

server.tool(
  'wez_status',
  'Check if Wezterm is installed and running. Shows project config, git mode, screen size, and all running panes with detected CLI state (idle, ready, working, exited).',
  {},
  async () => {
    const installed = isWezInstalled();
    const running = installed ? isWezRunning() : false;

    if (!running) {
      return ok({
        installed,
        running: false,
        project_root: PROJECT_ROOT ?? '(not set)',
        git_mode: GIT_MODE,
        note: installed
          ? 'Wezterm is installed but not running. Use wez_launch_agents to start it automatically.'
          : 'Wezterm is not installed. Install with: sudo pacman -S wezterm (Arch), brew install wezterm (macOS), or winget install wez.wezterm (Windows)',
      });
    }

    const panes = listPanes();
    const size = getTerminalSize();

    // Get git branch
    let branch = GIT_BRANCH;
    if (!branch) {
      try {
        branch = execFileSync('git', ['-C', PROJECT_ROOT ?? '.', 'branch', '--show-current'], {
          encoding: 'utf8',
          timeout: 5000,
        }).trim() || undefined;
      } catch { /* ignore */ }
    }

    // Group by window → tab → pane
    type PaneStatus = { pane_id: number; title: string; cli: string | null; state: string };
    type TabStatus = { tab_id: number; panes: PaneStatus[] };
    type WindowStatus = { window_id: number; workspace: string; tabs: TabStatus[] };

    const windows = new Map<number, WindowStatus>();
    for (const p of panes) {
      if (!windows.has(p.window_id)) {
        windows.set(p.window_id, { window_id: p.window_id, workspace: p.workspace, tabs: [] });
      }
      const win = windows.get(p.window_id)!;
      let tab = win.tabs.find(t => t.tab_id === p.tab_id);
      if (!tab) {
        tab = { tab_id: p.tab_id, panes: [] };
        win.tabs.push(tab);
      }
      const state = detectPaneState(p);
      tab.panes.push({
        pane_id: p.pane_id,
        title: p.title,
        cli: state.cli,
        state: state.state,
      });
    }

    const totalTabs = Array.from(windows.values()).reduce((sum, w) => sum + w.tabs.length, 0);

    return ok({
      installed: true,
      running: true,
      project_root: PROJECT_ROOT ?? '(not set)',
      git_mode: GIT_MODE,
      git_mode_description: 'All agents share same branch + working directory. MACP file claims prevent conflicts.',
      git_branch: branch ?? '(unknown)',
      screen_size: size,
      supported_clis: Object.keys(CLI_DEFS),
      total_windows: windows.size,
      total_tabs: totalTabs,
      total_panes: panes.length,
      windows: Array.from(windows.values()),
    });
  },
);

server.tool(
  'wez_list',
  'List all panes with their detected CLI and state. Use this to poll what agents are doing.',
  {},
  async () => {
    if (!isWezRunning()) {
      return ok({ running: false, panes: [] });
    }

    const panes = listPanes();
    const results = panes.map(p => {
      const state = detectPaneState(p);
      return {
        pane_id: p.pane_id,
        tab_id: p.tab_id,
        title: p.title,
        cwd: p.cwd,
        size: `${p.size.cols}x${p.size.rows}`,
        active: p.is_active,
        cli: state.cli,
        state: state.state,
      };
    });

    return ok({ running: true, total: panes.length, panes: results });
  },
);

server.tool(
  'wez_read_tab',
  'Read the latest output from ALL panes in a specific tab.',
  {
    tab_id: z.number().describe('Tab to read from'),
    lines: z.number().optional().describe('Lines per pane (default: 10)'),
  },
  async ({ tab_id, lines }) => {
    const panes = panesInTab(tab_id);
    const n = lines ?? 10;
    const results = panes.map(p => {
      const raw = wez('get-text', '--pane-id', String(p.pane_id));
      const allLines = raw.split('\n');
      return {
        pane_id: p.pane_id,
        title: p.title,
        output: allLines.slice(-n).join('\n'),
      };
    });
    return ok({ tab_id, panes: results });
  },
);

server.tool(
  'wez_screenshot',
  'Capture a screenshot of the Wezterm window. Saves to a file and returns the path.',
  {
    output_dir: z.string().optional().describe('Directory to save screenshot (defaults to project root)'),
    filename: z.string().optional().describe('Filename (defaults to wez-screenshot-<timestamp>.png)'),
  },
  async ({ output_dir, filename }) => {
    const dir = output_dir ?? PROJECT_ROOT ?? process.cwd();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = filename ?? `wez-screenshot-${ts}.png`;
    const filePath = join(dir, file);

    const tools = OS.screenshotCmds(filePath);
    for (const cmd of tools) {
      try {
        execSync(cmd, { timeout: 10_000, shell: OS.shell as string, stdio: 'pipe' });
        if (existsSync(filePath)) {
          return ok({ screenshot: filePath, tool: cmd.split(' ')[0] });
        }
      } catch { /* try next */ }
    }

    return ok({ error: OS.screenshotErrorMsg });
  },
);

server.tool(
  'wez_screenshot_all_tabs',
  'Screenshot each tab by switching to it, capturing, and moving to the next. Returns paths to all screenshots.',
  {
    output_dir: z.string().optional().describe('Directory to save screenshots (defaults to project root)'),
  },
  async ({ output_dir }) => {
    const dir = output_dir ?? PROJECT_ROOT ?? process.cwd();
    const panes = listPanes();
    const tabIds = [...new Set(panes.map(p => p.tab_id))];
    const screenshots: { tab_id: number; path: string }[] = [];
    const windowId = panes[0]?.window_id;

    for (let i = 0; i < tabIds.length; i++) {
      try {
        const args = ['--tab-index', String(i)];
        if (windowId !== undefined) args.push('--window-id', String(windowId));
        wez('activate-tab', ...args);
      } catch { continue; }

      sleepMs(300);

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `wez-tab-${i + 1}-${ts}.png`;
      const filePath = join(dir, file);

      const tools = OS.screenshotCmds(filePath);
      for (const cmd of tools) {
        try {
          execSync(cmd, { timeout: 10_000, shell: OS.shell as string, stdio: 'pipe' });
          if (existsSync(filePath)) {
            screenshots.push({ tab_id: tabIds[i]!, path: filePath });
            break;
          }
        } catch { /* try next */ }
      }
    }

    try { wez('activate-tab', '--tab-index', '0'); } catch { /* ignore */ }

    return ok({
      tabs_captured: screenshots.length,
      total_tabs: tabIds.length,
      screenshots,
    });
  },
);

// --- Overview / Briefing ---------------------------------------------------

const STATUS_PROMPT = 'give me a one paragraph summary of what you have done in this session so far and what your current status is. be brief, no tools needed.';

/**
 * Ask an idle CLI agent for a status summary.
 * Sends a prompt, waits for response, returns it.
 * ONLY safe to call on panes in cli-ready state.
 */
function queryAgentStatus(paneId: number): string | null {
  try {
    sendTextAndSubmit(paneId, STATUS_PROMPT);

    // Poll for response — wait up to 30 seconds
    // Look for ● lines that appear AFTER our STATUS_PROMPT in the output
    for (let i = 0; i < 30; i++) {
      OS.sleep(1);
      const text = wez('get-text', '--pane-id', String(paneId));

      // Find our prompt in the output, then look for ● response lines after it
      const promptIdx = text.lastIndexOf(STATUS_PROMPT);
      if (promptIdx === -1) continue;

      const afterPrompt = text.slice(promptIdx + STATUS_PROMPT.length);
      const responseLines = afterPrompt.split('\n')
        .filter(l => l.includes('●'))
        .map(l => l.replace(/^[●\s]*/, '').trim())
        .filter(l => l.length > 0);

      // Check if agent is back at the prompt (❯ appears after the response)
      const hasNewPrompt = afterPrompt.split('\n').some(l => l.includes('❯') && !l.includes(STATUS_PROMPT));

      if (responseLines.length > 0 && hasNewPrompt) {
        return responseLines.join(' ');
      }
    }

    // Timeout — try to extract whatever response appeared
    const text = wez('get-text', '--pane-id', String(paneId));
    const promptIdx = text.lastIndexOf(STATUS_PROMPT);
    if (promptIdx >= 0) {
      const afterPrompt = text.slice(promptIdx + STATUS_PROMPT.length);
      const responseLines = afterPrompt.split('\n')
        .filter(l => l.includes('●'))
        .map(l => l.replace(/^[●\s]*/, '').trim())
        .filter(l => l.length > 0);
      if (responseLines.length > 0) return responseLines.join(' ');
    }
    return null;
  } catch {
    return null;
  }
}

type PaneResult = {
  pane_id: number;
  title: string;
  cli: string | null;
  state: string;
  cwd: string;
  summary?: string | null;
  output?: string;
  queried?: boolean;
  skipped_reason?: string;
};
type TabResult = { tab_id: number; panes: PaneResult[] };
type WindowResult = { window_id: number; workspace: string; tabs: TabResult[] };

function buildWindowMap(panes: PaneInfo[]): Map<number, WindowResult> {
  const windows = new Map<number, WindowResult>();
  for (const p of panes) {
    if (!windows.has(p.window_id)) {
      windows.set(p.window_id, { window_id: p.window_id, workspace: p.workspace, tabs: [] });
    }
    const win = windows.get(p.window_id)!;
    if (!win.tabs.find(t => t.tab_id === p.tab_id)) {
      win.tabs.push({ tab_id: p.tab_id, panes: [] });
    }
  }
  return windows;
}

function getTab(windows: Map<number, WindowResult>, windowId: number, tabId: number): TabResult {
  return windows.get(windowId)!.tabs.find(t => t.tab_id === tabId)!;
}

server.tool(
  'wez_read_all',
  'Quick passive read of ALL panes across ALL windows and tabs. Does NOT interact with agents — just reads what is on screen. Fast and safe, never interrupts running work. Use this for a quick glance.',
  {
    lines: z.number().optional().describe('Lines of output per pane (default: 20)'),
  },
  async ({ lines }) => {
    if (!isWezRunning()) {
      return ok({ running: false, windows: [] });
    }

    const panes = listPanes();
    const n = lines ?? 20;
    const windows = buildWindowMap(panes);

    for (const p of panes) {
      const state = detectPaneState(p);
      let output = '';
      try {
        const raw = wez('get-text', '--pane-id', String(p.pane_id));
        const allLines = raw.split('\n');
        while (allLines.length > 0 && allLines[allLines.length - 1]!.trim() === '') {
          allLines.pop();
        }
        output = allLines.slice(-n).join('\n');
      } catch { /* ignore */ }

      getTab(windows, p.window_id, p.tab_id).panes.push({
        pane_id: p.pane_id,
        title: p.title,
        cli: state.cli,
        state: state.state,
        cwd: normalizeCwd(p.cwd),
        output,
      });
    }

    const totalTabs = Array.from(windows.values()).reduce((sum, w) => sum + w.tabs.length, 0);
    return ok({ running: true, total_windows: windows.size, total_tabs: totalTabs, total_panes: panes.length, windows: Array.from(windows.values()) });
  },
);

server.tool(
  'wez_read_all_deep',
  'Deep read of ALL panes. For idle CLI agents (cli-ready), it prompts each agent asking what it has done and returns the agent\'s own summary. For busy agents (cli-working), it does NOT interrupt — returns last N lines instead. For non-CLI panes, returns last N lines. This is slower (waits for each agent to respond) but gives you a real briefing from each agent.',
  {
    lines: z.number().optional().describe('Lines of output for non-queryable panes (default: 20)'),
  },
  async ({ lines }) => {
    if (!isWezRunning()) {
      return ok({ running: false, windows: [] });
    }

    const panes = listPanes();
    const n = lines ?? 20;
    const windows = buildWindowMap(panes);

    let queried = 0;
    let skippedBusy = 0;
    let skippedNoCli = 0;

    for (const p of panes) {
      const state = detectPaneState(p);
      const tab = getTab(windows, p.window_id, p.tab_id);

      if (state.cli && state.state === 'cli-ready') {
        // Agent is idle — safe to ask
        const summary = queryAgentStatus(p.pane_id);
        tab.panes.push({
          pane_id: p.pane_id,
          title: p.title,
          cli: state.cli,
          state: state.state,
          cwd: normalizeCwd(p.cwd),
          summary: summary ?? '(agent did not respond within 30s)',
          queried: true,
        });
        queried++;
      } else if (state.cli && state.state === 'cli-working') {
        // Agent is busy — do NOT interrupt, just read output
        let output = '';
        try {
          const raw = wez('get-text', '--pane-id', String(p.pane_id));
          const allLines = raw.split('\n');
          while (allLines.length > 0 && allLines[allLines.length - 1]!.trim() === '') {
            allLines.pop();
          }
          output = allLines.slice(-n).join('\n');
        } catch { /* ignore */ }

        tab.panes.push({
          pane_id: p.pane_id,
          title: p.title,
          cli: state.cli,
          state: state.state,
          cwd: normalizeCwd(p.cwd),
          output,
          queried: false,
          skipped_reason: 'Agent is currently working. Not interrupted.',
        });
        skippedBusy++;
      } else {
        // No CLI or exited — just read output
        let output = '';
        try {
          const raw = wez('get-text', '--pane-id', String(p.pane_id));
          const allLines = raw.split('\n');
          while (allLines.length > 0 && allLines[allLines.length - 1]!.trim() === '') {
            allLines.pop();
          }
          output = allLines.slice(-n).join('\n');
        } catch { /* ignore */ }

        tab.panes.push({
          pane_id: p.pane_id,
          title: p.title,
          cli: state.cli,
          state: state.state,
          cwd: normalizeCwd(p.cwd),
          output,
          queried: false,
          skipped_reason: state.cli ? 'Agent exited.' : 'No CLI detected — plain shell.',
        });
        skippedNoCli++;
      }
    }

    const totalTabs = Array.from(windows.values()).reduce((sum, w) => sum + w.tabs.length, 0);
    return ok({
      running: true,
      total_windows: windows.size,
      total_tabs: totalTabs,
      total_panes: panes.length,
      agents_queried: queried,
      agents_busy_not_interrupted: skippedBusy,
      non_cli_panes: skippedNoCli,
      windows: Array.from(windows.values()),
    });
  },
);

// --- Pane management -------------------------------------------------------

server.tool(
  'wez_spawn',
  'Spawn a new window, tab, or pane with an optional command. Use new_window=true to create a separate window. Returns the new pane ID.',
  {
    cli: z.enum(['claude', 'gemini', 'codex', 'opencode', 'goose']).optional()
      .describe('Launch a known CLI with correct flags. Mutually exclusive with command.'),
    command: z.string().optional().describe('Raw command to run. Ignored if cli is set. Defaults to shell.'),
    cwd: z.string().optional().describe('Working directory'),
    new_window: z.boolean().optional().describe('Create a new window instead of a tab (default: false)'),
    tab_title: z.string().optional().describe('Title for the new tab'),
  },
  async ({ cli, command, cwd, new_window, tab_title }) => {
    const dir = resolveCwd(cwd);
    const args = projectSpawnArgs(dir, new_window);
    if (cli) {
      const resolved = resolveCliCommand(cli, true, dir);
      args.push('--', ...resolved.parts);
    } else if (command) {
      args.push('--', ...command.split(' '));
    }
    const paneId = wez('spawn', ...args);
    if (tab_title) {
      wez('set-tab-title', '--pane-id', paneId, tab_title);
    }
    return ok({ pane_id: Number(paneId), tab_title, cli: cli ?? null });
  },
);

server.tool(
  'wez_split',
  'Split a pane horizontally or vertically. Returns the new pane ID.',
  {
    pane_id: z.number().describe('Pane to split'),
    direction: z.enum(['right', 'bottom']).describe('Split direction'),
    cli: z.enum(['claude', 'gemini', 'codex', 'opencode', 'goose']).optional()
      .describe('Launch a known CLI with correct flags. Mutually exclusive with command.'),
    command: z.string().optional().describe('Raw command to run. Ignored if cli is set.'),
    cwd: z.string().optional().describe('Working directory'),
  },
  async ({ pane_id, direction, cli, command, cwd }) => {
    const args: string[] = [
      direction === 'right' ? '--right' : '--bottom',
      '--pane-id', String(pane_id),
    ];
    const dir = resolveCwd(cwd);
    if (dir) args.push('--cwd', dir);
    if (cli) {
      const resolved = resolveCliCommand(cli, true, dir);
      args.push('--', ...resolved.parts);
    } else if (command) {
      args.push('--', ...command.split(' '));
    }
    const newPaneId = wez('split-pane', ...args);
    return ok({ pane_id: Number(newPaneId), cli: cli ?? null });
  },
);

server.tool(
  'wez_kill_pane',
  'Close a pane',
  { pane_id: z.number().describe('Pane to kill') },
  async ({ pane_id }) => {
    wez('kill-pane', '--pane-id', String(pane_id));
    return ok({ killed: pane_id });
  },
);

// --- Text I/O --------------------------------------------------------------

server.tool(
  'wez_send_text',
  'Type text into a pane as if a human typed it. Does NOT press Enter.',
  {
    pane_id: z.number().describe('Target pane'),
    text: z.string().describe('Text to type'),
  },
  async ({ pane_id, text }) => {
    wez('send-text', '--pane-id', String(pane_id), '--no-paste', text);
    return ok({ sent: true, pane_id });
  },
);

server.tool(
  'wez_send_text_submit',
  'Type text into a pane and press Enter to submit it.',
  {
    pane_id: z.number().describe('Target pane'),
    text: z.string().describe('Text to type and submit'),
  },
  async ({ pane_id, text }) => {
    sendTextAndSubmit(pane_id, text);
    return ok({ sent: true, submitted: true, pane_id });
  },
);

server.tool(
  'wez_send_text_all',
  'Send text and submit to ALL panes in a tab.',
  {
    tab_id: z.number().describe('Tab containing the panes'),
    texts: z.array(z.string()).describe('Array of texts, one per pane (in pane order)'),
  },
  async ({ tab_id, texts }) => {
    const panes = panesInTab(tab_id);
    const results: { pane_id: number; text: string }[] = [];
    for (let i = 0; i < Math.min(panes.length, texts.length); i++) {
      sendTextAndSubmit(panes[i]!.pane_id, texts[i]!);
      results.push({ pane_id: panes[i]!.pane_id, text: texts[i]! });
    }
    return ok({ sent: results.length, results });
  },
);

server.tool(
  'wez_send_text_submit_all',
  'Send the SAME text and submit to ALL panes in a tab. Useful for broadcasting instructions.',
  {
    tab_id: z.number().describe('Tab containing the panes'),
    text: z.string().describe('Text to send to all panes'),
  },
  async ({ tab_id, text }) => {
    const panes = panesInTab(tab_id);
    for (const p of panes) {
      sendTextAndSubmit(p.pane_id, text);
    }
    return ok({ sent_to: panes.length, text });
  },
);

// --- Navigation & layout ---------------------------------------------------

server.tool(
  'wez_focus_pane',
  'Focus (activate) a specific pane',
  { pane_id: z.number().describe('Pane to focus') },
  async ({ pane_id }) => {
    wez('activate-pane', '--pane-id', String(pane_id));
    return ok({ focused: pane_id });
  },
);

server.tool(
  'wez_focus_direction',
  'Focus the pane in a direction relative to current',
  { direction: z.enum(['Up', 'Down', 'Left', 'Right']).describe('Direction') },
  async ({ direction }) => {
    wez('activate-pane-direction', direction);
    return ok({ direction });
  },
);

server.tool(
  'wez_focus_tab',
  'Switch to a specific tab by index (0-based)',
  {
    tab_index: z.number().describe('Tab index'),
    window_id: z.number().optional().describe('Window ID (default: current)'),
  },
  async ({ tab_index, window_id }) => {
    const args = ['--tab-index', String(tab_index)];
    if (window_id !== undefined) args.push('--window-id', String(window_id));
    wez('activate-tab', ...args);
    return ok({ tab_index });
  },
);

server.tool(
  'wez_resize_pane',
  'Resize a pane in a direction',
  {
    direction: z.enum(['Up', 'Down', 'Left', 'Right']).describe('Direction to resize'),
    amount: z.number().optional().describe('Number of cells (default: 5)'),
    pane_id: z.number().optional().describe('Pane to resize (default: active)'),
  },
  async ({ direction, amount, pane_id }) => {
    const args = [direction, '--amount', String(amount ?? 5)];
    if (pane_id !== undefined) args.push('--pane-id', String(pane_id));
    wez('adjust-pane-size', ...args);
    return ok({ direction, amount: amount ?? 5 });
  },
);

server.tool(
  'wez_zoom_pane',
  'Toggle zoom on a pane (maximize/restore)',
  { pane_id: z.number().optional().describe('Pane to zoom (default: active)') },
  async ({ pane_id }) => {
    const args = ['--toggle'];
    if (pane_id !== undefined) args.push('--pane-id', String(pane_id));
    wez('zoom-pane', ...args);
    return ok({ toggled: true });
  },
);

server.tool(
  'wez_move_to_tab',
  'Move a pane into its own new tab',
  { pane_id: z.number().describe('Pane to move') },
  async ({ pane_id }) => {
    wez('move-pane-to-new-tab', '--pane-id', String(pane_id));
    return ok({ moved: pane_id });
  },
);

// --- Titles & metadata -----------------------------------------------------

server.tool(
  'wez_set_tab_title',
  'Set the title of a tab',
  {
    title: z.string().describe('New title'),
    pane_id: z.number().optional().describe('Any pane in the tab (default: active)'),
  },
  async ({ title, pane_id }) => {
    const args = [title];
    if (pane_id !== undefined) args.push('--pane-id', String(pane_id));
    wez('set-tab-title', ...args);
    return ok({ title });
  },
);

server.tool(
  'wez_set_window_title',
  'Set the title of a window',
  {
    title: z.string().describe('New title'),
    window_id: z.number().optional().describe('Window ID (default: current)'),
  },
  async ({ title, window_id }) => {
    const args = [title];
    if (window_id !== undefined) args.push('--window-id', String(window_id));
    wez('set-window-title', ...args);
    return ok({ title });
  },
);

server.tool(
  'wez_rename_workspace',
  'Rename the current workspace',
  {
    new_name: z.string().describe('New workspace name'),
    current_name: z.string().optional().describe('Current workspace name (default: current)'),
  },
  async ({ new_name, current_name }) => {
    const args = [new_name];
    if (current_name) args.push('--workspace', current_name);
    wez('rename-workspace', ...args);
    return ok({ workspace: new_name });
  },
);

// --- High-level compound tools ---------------------------------------------

server.tool(
  'wez_launch_grid',
  'Create a tab with a grid of panes, each running a command. Returns all pane IDs.',
  {
    rows: z.number().min(1).max(10).describe('Number of rows'),
    cols: z.number().min(1).max(10).describe('Number of columns'),
    command: z.string().optional().describe('Command to run in each pane (e.g. "claude --dangerously-skip-permissions")'),
    cwd: z.string().optional().describe('Working directory'),
    new_window: z.boolean().optional().describe('Create a new window instead of a tab (default: false)'),
    tab_title: z.string().optional().describe('Title for the tab'),
  },
  async ({ rows, cols, command, cwd, new_window, tab_title }) => {
    const wezState = ensureWezRunning();
    if (!wezState.running) {
      return ok({ error: 'Wezterm could not be started. Is it installed?' });
    }

    const dir = resolveCwd(cwd);
    const cmdArgs = command ? command.split(' ') : [];
    const spawnArgs = projectSpawnArgs(dir, new_window);
    if (cmdArgs.length) spawnArgs.push('--', ...cmdArgs);

    // Spawn first pane (in project window or new window)
    const firstPaneId = Number(wez('spawn', ...spawnArgs));
    if (tab_title) {
      wez('set-tab-title', '--pane-id', String(firstPaneId), tab_title);
    }

    const grid: number[][] = [];
    const colPanes: number[] = [firstPaneId];

    // Create columns by splitting right from the first pane
    for (let c = 1; c < cols; c++) {
      const splitArgs = ['--right', '--pane-id', String(colPanes[c - 1])];
      if (dir) splitArgs.push('--cwd', dir);
      if (cmdArgs.length) splitArgs.push('--', ...cmdArgs);
      const newPane = Number(wez('split-pane', ...splitArgs));
      colPanes.push(newPane);
    }

    // Create rows by splitting each column pane downward
    for (let c = 0; c < cols; c++) {
      const column: number[] = [colPanes[c]!];
      let lastPane = colPanes[c]!;
      for (let r = 1; r < rows; r++) {
        const splitArgs = ['--bottom', '--pane-id', String(lastPane)];
        if (dir) splitArgs.push('--cwd', dir);
        if (cmdArgs.length) splitArgs.push('--', ...cmdArgs);
        const newPane = Number(wez('split-pane', ...splitArgs));
        column.push(newPane);
        lastPane = newPane;
      }
      grid.push(column);
    }

    const allPanes = grid.flat();
    return ok({
      tab_title: tab_title ?? null,
      grid: `${cols}x${rows}`,
      total_panes: allPanes.length,
      pane_ids: allPanes,
    });
  },
);

server.tool(
  'wez_launch_agents',
  'Open a project window and optionally launch AI coding agents in it. If count=0 or omitted, just opens a window with a shell. Reuses existing window for the same project unless new_window=true. Auto-sizes grid. Supports claude, gemini, codex, opencode, goose. Permissions auto-skipped.',
  {
    cli: z.enum(['claude', 'gemini', 'codex', 'opencode', 'goose']).default('claude')
      .describe('Which AI CLI to launch (only used if count > 0)'),
    count: z.number().min(0).max(50).default(0).describe('Number of agents to launch. 0 = just open a project window with a shell.'),
    cwd: z.string().optional().describe('Working directory (defaults to project root)'),
    tab_title: z.string().optional().describe('Base title for tabs (numbered if multiple)'),
    project_name: z.string().optional().describe('Project name for window title (defaults to directory name)'),
    new_window: z.boolean().optional().describe('Force a new window even if one exists for this project (default: false)'),
  },
  async ({ cli, count, cwd, tab_title, project_name, new_window }) => {
    // Auto-start wezterm if not running
    const wezState = ensureWezRunning();
    if (!wezState.running) {
      return ok({
        error: 'Wezterm could not be started. Is it installed?',
        installed: isWezInstalled(),
      });
    }

    const dir = resolveCwd(cwd);
    const projName = project_name ?? (basename(dir ?? process.cwd()) || 'project');

    // count=0: just open a project window with a shell
    if (count === 0) {
      const spawnArgs = projectSpawnArgs(dir, new_window);
      const paneId = Number(wez('spawn', ...spawnArgs));

      return ok({
        project_name: projName,
        project_root: dir ?? '(not set)',
        pane_id: paneId,
        note: `Opened window for "${projName}" with a shell. Use wez_launch_agents with count > 0 to add agents.`,
      });
    }

    const cmd = resolveCliCommand(cli, true, dir);

    const grid = calculateGrid(count);
    const allPaneIds: number[] = [];
    const tabInfo: { tab_index: number; pane_ids: number[] }[] = [];

    const preExistingPaneIds = new Set(listPanes().map(p => p.pane_id));
    const targetCwd = (dir ?? '').replace(/\/$/, '');

    let remaining = count;
    let windowPaneId: number | null = null;

    for (let t = 0; t < grid.tabs; t++) {
      const agentsThisTab = Math.min(remaining, grid.perTab);
      remaining -= agentsThisTab;

      const tabCols = Math.min(grid.cols, Math.ceil(Math.sqrt(agentsThisTab)));
      const tabRows = Math.ceil(agentsThisTab / tabCols);

      // First tab: use projectSpawnArgs to find/create the project window
      // Subsequent tabs: anchor to the first pane in the window
      const spawnArgs = t === 0
        ? projectSpawnArgs(dir, new_window)
        : (() => { const a: string[] = []; if (dir) a.push('--cwd', dir); return a; })();
      spawnArgs.push('--', ...cmd.parts);

      const firstPaneId = Number(wez('spawn', ...spawnArgs));
      if (t === 0) windowPaneId = firstPaneId;

      const tabTitle = grid.tabs === 1
        ? (tab_title ?? `${CLI_DEFS[cli]!.label} Agents`)
        : `${tab_title ?? 'Agents'} ${t + 1}/${grid.tabs}`;
      wez('set-tab-title', '--pane-id', String(firstPaneId), tabTitle);

      const tabPanes: number[] = [firstPaneId];

      // Create columns
      const colPanes: number[] = [firstPaneId];
      for (let c = 1; c < tabCols; c++) {
        const splitArgs = ['--right', '--pane-id', String(colPanes[c - 1])];
        if (dir) splitArgs.push('--cwd', dir);
        splitArgs.push('--', ...cmd.parts);
        const newPane = Number(wez('split-pane', ...splitArgs));
        colPanes.push(newPane);
        tabPanes.push(newPane);
      }

      // Create rows in each column
      for (let c = 0; c < tabCols; c++) {
        let lastPane = colPanes[c]!;
        for (let r = 1; r < tabRows; r++) {
          if (tabPanes.length >= agentsThisTab) break;
          const splitArgs = ['--bottom', '--pane-id', String(lastPane)];
          if (dir) splitArgs.push('--cwd', dir);
          splitArgs.push('--', ...cmd.parts);
          const newPane = Number(wez('split-pane', ...splitArgs));
          tabPanes.push(newPane);
          lastPane = newPane;
        }
      }

      allPaneIds.push(...tabPanes);
      tabInfo.push({ tab_index: t, pane_ids: tabPanes });
    }

    // Set window titles — if multiple windows for same project, show "Project N/M"
    if (windowPaneId !== null) {
      try {
        const currentPanes = listPanes();
        const ourPane = currentPanes.find(p => p.pane_id === windowPaneId);
        if (ourPane) {
          // Find all windows for this project
          const projWindows = new Set<number>();
          for (const p of currentPanes) {
            const cwd = normalizeCwd(p.cwd);
            if (cwd === targetCwd) {
              projWindows.add(p.window_id);
            }
          }

          if (projWindows.size > 1) {
            // Multiple windows — number them all
            const sortedWindowIds = [...projWindows].sort();
            for (let i = 0; i < sortedWindowIds.length; i++) {
              try {
                wez('set-window-title', '--window-id', String(sortedWindowIds[i]!), `${projName} ${i + 1}/${sortedWindowIds.length}`);
              } catch { /* best effort */ }
            }
          } else {
            wez('set-window-title', '--window-id', String(ourPane.window_id), projName);
          }
        }
      } catch { /* best effort */ }
    }

    // Clean up: only kill the default startup pane if WE just started wezterm
    // in this call (wezState.started === true). Never kill user's existing panes.
    if (wezState.started && windowPaneId !== null) {
      try {
        const currentPanes = listPanes();
        const ourWindowId = currentPanes.find(p => allPaneIds.includes(p.pane_id))?.window_id;
        if (ourWindowId !== undefined) {
          for (const p of currentPanes) {
            if (p.window_id === ourWindowId
              && preExistingPaneIds.has(p.pane_id)
              && !allPaneIds.includes(p.pane_id)) {
              try { wez('kill-pane', '--pane-id', String(p.pane_id)); } catch { /* ignore */ }
            }
          }
        }
      } catch { /* ignore */ }
    }

    return ok({
      cli,
      cli_label: CLI_DEFS[cli]!.label,
      command: cmd.shellCommand,
      project_name: projName,
      project_root: dir ?? '(not set)',
      git_mode: GIT_MODE,
      count: allPaneIds.length,
      screen_size: getTerminalSize(),
      auto_layout: `${grid.cols}x${grid.rows} per tab, ${grid.tabs} tab(s)`,
      tabs: tabInfo,
      pane_ids: allPaneIds,
      note: `${allPaneIds.length} ${CLI_DEFS[cli]!.label} agents launched in window "${projName}". All share same branch in ${dir ?? 'cwd'} — MACP coordinates via file claims.`,
    });
  },
);

server.tool(
  'wez_launch_mixed',
  'Launch agents with different CLIs in one tab. Each agent can be a different CLI. Use new_window=true to create a separate window.',
  {
    agents: z.array(z.object({
      cli: z.enum(['claude', 'gemini', 'codex', 'opencode', 'goose']).describe('CLI to use'),
      label: z.string().optional().describe('Optional label for this agent'),
    })).describe('List of agents to launch'),
    cwd: z.string().optional().describe('Working directory'),
    new_window: z.boolean().optional().describe('Create a new window instead of a tab (default: false)'),
    tab_title: z.string().optional().describe('Title for the tab'),
  },
  async ({ agents, cwd, new_window, tab_title }) => {
    if (agents.length === 0) throw new Error('Must specify at least one agent');

    const wezState = ensureWezRunning();
    if (!wezState.running) {
      return ok({ error: 'Wezterm could not be started. Is it installed?' });
    }

    const dir = resolveCwd(cwd);
    const firstCmd = resolveCliCommand(agents[0]!.cli, true, dir);
    const spawnArgs = projectSpawnArgs(dir, new_window);
    spawnArgs.push('--', ...firstCmd.parts);

    const firstPaneId = Number(wez('spawn', ...spawnArgs));
    if (tab_title) {
      wez('set-tab-title', '--pane-id', String(firstPaneId), tab_title);
    }

    const paneIds: number[] = [firstPaneId];
    let lastPane = firstPaneId;

    for (let i = 1; i < agents.length; i++) {
      const cmd = resolveCliCommand(agents[i]!.cli, true, dir);
      const splitDir = i % 2 === 1 ? '--right' : '--bottom';
      const splitFrom = i % 2 === 1 ? lastPane : paneIds[Math.max(0, i - 2)]!;
      const splitArgs = [splitDir, '--pane-id', String(splitFrom)];
      if (dir) splitArgs.push('--cwd', dir);
      splitArgs.push('--', ...cmd.parts);
      const newPane = Number(wez('split-pane', ...splitArgs));
      paneIds.push(newPane);
      lastPane = newPane;
    }

    const results = agents.map((a, i) => ({
      pane_id: paneIds[i]!,
      cli: a.cli,
      label: a.label ?? `Agent ${i}`,
    }));

    return ok({
      count: paneIds.length,
      tab_title: tab_title ?? null,
      agents: results,
    });
  },
);

server.tool(
  'wez_fullscreen',
  'Toggle fullscreen mode. Sends the F11 key to the active window.',
  {},
  async () => {
    try {
      OS.toggleFullscreen();
      return ok({ toggled: true });
    } catch {
      return ok({ toggled: false, note: OS.fullscreenErrorMsg });
    }
  },
);

// --- Special keys & control ------------------------------------------------

server.tool(
  'wez_send_key',
  'Send a special key or key combination to a pane. Supports ctrl+c, ctrl+d, escape, tab, enter, etc.',
  {
    pane_id: z.number().describe('Target pane'),
    key: z.string().describe('Key to send: ctrl+c, ctrl+d, ctrl+z, ctrl+l, escape, tab, enter, up, down, left, right'),
  },
  async ({ pane_id, key }) => {
    const keyMap: Record<string, string> = {
      'ctrl+c': '\x03',
      'ctrl+d': '\x04',
      'ctrl+z': '\x1a',
      'ctrl+l': '\x0c',
      'ctrl+u': '\x15',
      'ctrl+a': '\x01',
      'ctrl+e': '\x05',
      'ctrl+w': '\x17',
      'escape': '\x1b',
      'tab': '\x09',
      'enter': '\x0d',
      'up': '\x1b[A',
      'down': '\x1b[B',
      'right': '\x1b[C',
      'left': '\x1b[D',
    };
    const sequence = keyMap[key.toLowerCase()];
    if (!sequence) {
      return ok({ error: `Unknown key "${key}". Supported: ${Object.keys(keyMap).join(', ')}` });
    }
    wez('send-text', '--pane-id', String(pane_id), '--no-paste', sequence);
    return ok({ sent: key, pane_id });
  },
);

server.tool(
  'wez_send_key_all',
  'Send a special key to ALL panes in a tab. Useful for ctrl+c to cancel all agents.',
  {
    tab_id: z.number().describe('Tab containing the panes'),
    key: z.string().describe('Key to send (e.g. ctrl+c)'),
  },
  async ({ tab_id, key }) => {
    const keyMap: Record<string, string> = {
      'ctrl+c': '\x03', 'ctrl+d': '\x04', 'ctrl+z': '\x1a',
      'ctrl+l': '\x0c', 'escape': '\x1b', 'enter': '\x0d',
    };
    const sequence = keyMap[key.toLowerCase()];
    if (!sequence) {
      return ok({ error: `Unknown key "${key}".` });
    }
    const panes = panesInTab(tab_id);
    for (const p of panes) {
      wez('send-text', '--pane-id', String(p.pane_id), '--no-paste', sequence);
    }
    return ok({ sent: key, pane_count: panes.length });
  },
);

// --- Bulk operations -------------------------------------------------------

server.tool(
  'wez_kill_tab',
  'Kill ALL panes in a tab, closing the entire tab.',
  { tab_id: z.number().describe('Tab to kill') },
  async ({ tab_id }) => {
    const panes = panesInTab(tab_id);
    for (const p of panes) {
      try { wez('kill-pane', '--pane-id', String(p.pane_id)); } catch { /* pane may already be dead */ }
    }
    return ok({ killed_tab: tab_id, panes_killed: panes.length });
  },
);

/** Kill wezterm-gui process(es). */
function killGuiProcess(): boolean {
  try { OS.killProcess('wezterm-gui'); return true; } catch { return false; }
}

/** Kill wezterm-mux-server process(es). */
function killMuxProcess(): boolean {
  try { OS.killProcess('wezterm-mux-server'); return true; } catch { return false; }
}

/** Remove stale socket files from the socket directory. */
function cleanSockets(): number {
  let cleaned = 0;
  try {
    const dir = OS.socketDir();
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('gui-sock-') || entry === 'sock') {
        try { unlinkSync(join(dir, entry)); cleaned++; } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return cleaned;
}

server.tool(
  'wez_kill_all',
  'Kill ALL panes in ALL tabs, then kill GUI and mux-server processes, and clean sockets. Full shutdown.',
  {},
  async () => {
    let count = 0;
    try {
      const panes = listPanes();
      count = panes.length;
      for (const p of panes) {
        try { wez('kill-pane', '--pane-id', String(p.pane_id)); } catch { /* ignore — last pane kill closes wezterm */ }
      }
    } catch { /* ignore — wezterm may close mid-loop */ }
    killGuiProcess();
    killMuxProcess();
    const sockets = cleanSockets();
    return ok({ panes_killed: count, sockets_cleaned: sockets });
  },
);

server.tool(
  'wez_kill_gui',
  'Force-kill the WezTerm GUI process. Does not touch mux-server or sockets.',
  {},
  async () => {
    const killed = killGuiProcess();
    return ok({ killed, note: killed ? 'GUI process killed.' : 'No GUI process found.' });
  },
);

server.tool(
  'wez_kill_mux',
  'Force-kill the WezTerm mux-server process. Does not touch GUI or sockets.',
  {},
  async () => {
    const killed = killMuxProcess();
    return ok({ killed, note: killed ? 'Mux-server process killed.' : 'No mux-server process found.' });
  },
);

server.tool(
  'wez_clean_sockets',
  'Remove stale WezTerm socket files. Use after crashes or orphaned processes.',
  {},
  async () => {
    const cleaned = cleanSockets();
    return ok({ sockets_cleaned: cleaned });
  },
);

server.tool(
  'wez_restart_pane',
  'Kill a pane and relaunch the same CLI in the same position. Useful for recovering a stuck agent.',
  {
    pane_id: z.number().describe('Pane to restart'),
    cli: z.enum(['claude', 'gemini', 'codex', 'opencode', 'goose']).optional()
      .describe('CLI to launch (auto-detected from current pane if omitted)'),
    resume: z.boolean().default(false).describe('Resume the previous session instead of starting fresh'),
  },
  async ({ pane_id, cli, resume }) => {
    // Detect current CLI if not specified
    const panes = listPanes();
    const target = panes.find(p => p.pane_id === pane_id);
    if (!target) {
      return ok({ error: `Pane ${pane_id} not found.` });
    }

    const detectedCli = cli ?? detectPaneState(target).cli;
    if (!detectedCli) {
      return ok({ error: 'Could not detect CLI. Specify cli parameter.' });
    }

    // Get session ID before killing if resume requested
    let sessionId: string | null = null;
    if (resume) {
      const allPanes = listPanes();
      const contexts = new Map<number, PaneContext>();
      for (const p of allPanes) {
        const s = detectPaneState(p);
        contexts.set(p.pane_id, { cli: s.cli, cwd: normalizeCwd(p.cwd), ttyName: p.tty_name });
      }
      sessionId = getSessionId(pane_id, detectedCli, contexts);
    }

    const cwd = normalizeCwd(target.cwd);
    const tabId = target.tab_id;

    // Kill the pane
    try { wez('kill-pane', '--pane-id', String(pane_id)); } catch { /* ignore */ }

    // Find a surviving pane in the same tab to split from
    const siblings = listPanes().filter(p => p.tab_id === tabId);
    const cmd = resume ? buildResumeCommand(detectedCli, sessionId, cwd) : resolveCliCommand(detectedCli, true, cwd);

    let newPaneId: number;
    if (siblings.length > 0) {
      const splitArgs = ['--right', '--pane-id', String(siblings[0]!.pane_id)];
      if (cwd) splitArgs.push('--cwd', cwd);
      splitArgs.push('--', ...cmd.parts);
      newPaneId = Number(wez('split-pane', ...splitArgs));
    } else {
      // Tab is empty, spawn new tab
      const spawnArgs: string[] = [];
      if (cwd) spawnArgs.push('--cwd', cwd);
      spawnArgs.push('--', ...cmd.parts);
      newPaneId = Number(wez('spawn', ...spawnArgs));
    }

    return ok({
      old_pane_id: pane_id,
      new_pane_id: newPaneId,
      cli: detectedCli,
      resumed: resume,
      session_id: sessionId,
    });
  },
);

server.tool(
  'wez_send_text_submit_some',
  'Send text and submit to specific panes (not all). Target by pane IDs.',
  {
    pane_ids: z.array(z.number()).describe('List of pane IDs to target'),
    text: z.string().describe('Text to send and submit'),
  },
  async ({ pane_ids, text }) => {
    const sent: number[] = [];
    const failed: number[] = [];
    for (const id of pane_ids) {
      try {
        sendTextAndSubmit(id, text);
        sent.push(id);
      } catch {
        failed.push(id);
      }
    }
    return ok({ sent: sent.length, failed: failed.length, sent_panes: sent, failed_panes: failed });
  },
);

// --- Scrollback ------------------------------------------------------------

server.tool(
  'wez_get_text',
  'Read text from a pane. Supports scrollback with negative start_line.',
  {
    pane_id: z.number().describe('Pane to read from'),
    start_line: z.number().optional().describe('Start line (negative for scrollback, e.g. -100). Default: visible area only.'),
    end_line: z.number().optional().describe('End line. Default: bottom of visible area.'),
  },
  async ({ pane_id, start_line, end_line }) => {
    const args = ['--pane-id', String(pane_id)];
    if (start_line !== undefined) args.push('--start-line', String(start_line));
    if (end_line !== undefined) args.push('--end-line', String(end_line));
    const raw = wez('get-text', ...args);
    return ok({ pane_id, output: raw });
  },
);

// --- Start wezterm ---------------------------------------------------------

server.tool(
  'wez_start',
  'Explicitly start Wezterm if not running. Returns whether it was already running or freshly started.',
  {
    cwd: z.string().optional().describe('Working directory (defaults to project root)'),
  },
  async ({ cwd }) => {
    if (isWezRunning()) {
      return ok({ running: true, started: false, note: 'Wezterm was already running.' });
    }
    if (!isWezInstalled()) {
      return ok({ running: false, started: false, error: 'Wezterm is not installed.' });
    }
    const dir = resolveCwd(cwd) ?? process.cwd();
    try {
      if (!launchWeztermDetached(dir)) {
        return ok({ running: false, started: false, error: 'Failed to launch Wezterm process.' });
      }
      for (let i = 0; i < 20; i++) {
        sleepMs(500);
        if (isWezRunning()) {
          return ok({ running: true, started: true, cwd: dir });
        }
      }
    } catch { /* ignore */ }
    return ok({ running: false, started: false, error: 'Failed to start Wezterm.' });
  },
);

// --- Reconciliation --------------------------------------------------------

server.tool(
  'wez_reconcile',
  'Compare saved session manifest against what is actually running in Wezterm. Reports mismatches: panes that disappeared, new panes that appeared, CLI state changes, and session ID changes. Use this to detect drift.',
  {},
  async () => {
    if (!isWezRunning()) {
      return ok({ error: 'Wezterm is not running.' });
    }

    const manifest = loadManifest();
    const livePanes = listPanes();

    // Pre-compute contexts once, then build live state map
    const contexts = new Map<number, PaneContext>();
    for (const p of livePanes) {
      const state = detectPaneState(p);
      contexts.set(p.pane_id, { cli: state.cli, cwd: normalizeCwd(p.cwd), ttyName: p.tty_name });
    }
    const liveMap = new Map<number, { cli: string | null; state: string; session_id: string | null }>();
    for (const p of livePanes) {
      const ctx = contexts.get(p.pane_id)!;
      const state = detectPaneState(p);
      const sessionId = ctx.cli ? getSessionId(p.pane_id, ctx.cli, contexts) : null;
      liveMap.set(p.pane_id, { cli: ctx.cli, state: state.state, session_id: sessionId });
    }

    if (!manifest) {
      return ok({
        has_manifest: false,
        live_panes: livePanes.length,
        note: 'No saved manifest. Call wez_session_save to create one.',
        live: livePanes.map(p => {
          const s = liveMap.get(p.pane_id)!;
          return { pane_id: p.pane_id, cli: s.cli, state: s.state, session_id: s.session_id };
        }),
      });
    }

    // Compare manifest vs live
    // Support both old and new manifest formats
    const manifestWindows: WindowManifest[] = manifest.windows ??
      [{ window_id: 0, workspace: 'default', tabs: (manifest as any).tabs ?? [] }];

    const manifestPaneIds = new Set(manifestWindows.flatMap(w => w.tabs.flatMap(t => t.panes.map(p => p.pane_id))));
    const livePaneIds = new Set(livePanes.map(p => p.pane_id));

    const disappeared: PaneManifest[] = [];
    const changed: { pane_id: number; field: string; expected: string | null; actual: string | null }[] = [];

    for (const mw of manifestWindows) {
      for (const tab of mw.tabs) {
        for (const mp of tab.panes) {
        if (!livePaneIds.has(mp.pane_id)) {
          disappeared.push(mp);
        } else {
          const live = liveMap.get(mp.pane_id)!;
          if (mp.cli !== 'shell' && mp.cli !== live.cli) {
            changed.push({ pane_id: mp.pane_id, field: 'cli', expected: mp.cli, actual: live.cli });
          }
          if (mp.session_id && live.session_id && mp.session_id !== live.session_id) {
            changed.push({ pane_id: mp.pane_id, field: 'session_id', expected: mp.session_id, actual: live.session_id });
          }
        }
      }
      }
    }

    const appeared = livePanes
      .filter(p => !manifestPaneIds.has(p.pane_id))
      .map(p => {
        const s = liveMap.get(p.pane_id)!;
        return { pane_id: p.pane_id, cli: s.cli, state: s.state };
      });

    const inSync = disappeared.length === 0 && appeared.length === 0 && changed.length === 0;

    return ok({
      has_manifest: true,
      manifest_saved_at: manifest.saved_at,
      in_sync: inSync,
      manifest_panes: manifestPaneIds.size,
      live_panes: livePaneIds.size,
      disappeared: disappeared.length > 0 ? disappeared : undefined,
      appeared: appeared.length > 0 ? appeared : undefined,
      changed: changed.length > 0 ? changed : undefined,
      note: inSync
        ? 'Everything matches. Manifest and live state are in sync.'
        : `Drift detected: ${disappeared.length} disappeared, ${appeared.length} new, ${changed.length} changed.`,
    });
  },
);

// --- Session recovery ------------------------------------------------------

server.tool(
  'wez_session_save',
  'Save current Wezterm state (tabs, panes, CLIs, session IDs) to a manifest for crash recovery. Call this after launching agents and periodically during work.',
  {},
  async () => {
    if (!isWezRunning()) {
      return ok({ error: 'Wezterm is not running. Nothing to save.' });
    }

    const manifest = captureManifest();
    saveManifest(manifest);

    const totalTabs = manifest.windows.reduce((sum, w) => sum + w.tabs.length, 0);
    const totalPanes = manifest.windows.reduce((sum, w) => w.tabs.reduce((s, t) => s + t.panes.length, sum), 0);
    const withSession = manifest.windows.reduce((sum, w) => w.tabs.reduce((s, t) => s + t.panes.filter(p => p.session_id !== null).length, sum), 0);

    return ok({
      saved: true,
      path: MANIFEST_PATH,
      windows: manifest.windows.length,
      tabs: totalTabs,
      panes: totalPanes,
      sessions_captured: withSession,
      sessions_missing: totalPanes - withSession,
      note: withSession < totalPanes
        ? `${totalPanes - withSession} pane(s) have no session ID yet. Save again in a few seconds.`
        : 'All session IDs captured. Full recovery is possible.',
    });
  },
);

server.tool(
  'wez_session_recover',
  'Recover a crashed Wezterm session from the saved manifest. Recreates all tabs, panes, and resumes each CLI session.',
  {
    manifest_path: z.string().optional().describe('Path to manifest file (default: ~/.macp/wez-session.json)'),
  },
  async ({ manifest_path }) => {
    const path = manifest_path ?? MANIFEST_PATH;
    const manifest = (() => {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as SessionManifest;
      } catch {
        return null;
      }
    })();

    if (!manifest) {
      return ok({
        error: 'No session manifest found.',
        path,
        note: 'Use wez_save_session to create one while agents are running.',
      });
    }

    // Start wezterm if needed
    const wezState = ensureWezRunning();
    if (!wezState.running) {
      return ok({ error: 'Wezterm could not be started.' });
    }

    // Kill the startup default pane — we'll recreate everything from the manifest
    const startupPanes = listPanes();
    const startupPaneIds = startupPanes.map(p => p.pane_id);

    type RecoveredPane = { cli: string; session_id: string | null; pane_id: number };
    type RecoveredTab = { tab: string; panes: RecoveredPane[] };
    type RecoveredWindow = { window: number; workspace: string; tabs: RecoveredTab[] };
    const recoveredWindows: RecoveredWindow[] = [];

    // Support both old (tabs-only) and new (windows) manifest formats
    const manifestWindows: WindowManifest[] = manifest.windows ??
      [{ window_id: 0, workspace: 'default', tabs: (manifest as any).tabs ?? [] }];

    for (let wi = 0; wi < manifestWindows.length; wi++) {
      const mw = manifestWindows[wi]!;
      const recoveredTabs: RecoveredTab[] = [];
      let windowFirstPaneId: number | null = null;

      for (const tab of mw.tabs) {
        if (tab.panes.length === 0) continue;

        const tabPanes: RecoveredPane[] = [];

        const firstPane = tab.panes[0]!;
        // Resolve cwd — fall back to manifest project_root if empty/invalid
        const paneCwd = (firstPane.cwd || '').replace(/\/$/, '');
        const resolvedCwd = paneCwd && paneCwd.length > 1 ? paneCwd : manifest.project_root;
        const firstCmd = buildResumeCommand(firstPane.cli, firstPane.session_id, resolvedCwd);

        const spawnArgs: string[] = [];

        if (recoveredTabs.length === 0) {
          // First tab of this window — create a new window
          spawnArgs.push('--new-window');
        } else if (windowFirstPaneId !== null) {
          // Subsequent tab in the same window — anchor to the first pane
          spawnArgs.push('--pane-id', String(windowFirstPaneId));
        }

        spawnArgs.push('--cwd', resolvedCwd);
        spawnArgs.push('--', ...firstCmd.parts);
        const firstPaneId = Number(wez('spawn', ...spawnArgs));
        if (windowFirstPaneId === null) windowFirstPaneId = firstPaneId;
        if (tab.title) {
          wez('set-tab-title', '--pane-id', String(firstPaneId), tab.title);
        }
        tabPanes.push({ cli: firstPane.cli, session_id: firstPane.session_id, pane_id: firstPaneId });

        // Remaining panes — split from first
        // Small delay between spawns prevents wezterm from being overwhelmed
        let lastRight = firstPaneId;
        for (let i = 1; i < tab.panes.length; i++) {
          sleepMs(300);
          const pane = tab.panes[i]!;
          const dir = i % 2 === 1 ? '--right' : '--bottom';
          const splitFrom = i % 2 === 1 ? lastRight : firstPaneId;
          const splitArgs = [dir, '--pane-id', String(splitFrom)];
          const splitCwd = (pane.cwd || '').replace(/\/$/, '');
          const resolvedSplitCwd = splitCwd && splitCwd.length > 1 ? splitCwd : manifest.project_root;
          const cmd = buildResumeCommand(pane.cli, pane.session_id, resolvedSplitCwd);
          splitArgs.push('--cwd', resolvedSplitCwd);
          splitArgs.push('--', ...cmd.parts);
          const newPaneId = Number(wez('split-pane', ...splitArgs));
          tabPanes.push({ cli: pane.cli, session_id: pane.session_id, pane_id: newPaneId });
          if (i % 2 === 1) lastRight = newPaneId;
        }

        recoveredTabs.push({ tab: tab.title || `Tab ${tab.tab_id}`, panes: tabPanes });
      }

      recoveredWindows.push({ window: wi, workspace: mw.workspace, tabs: recoveredTabs });
    }

    // Kill the startup default pane(s) that existed before recovery
    for (const pid of startupPaneIds) {
      try { wez('kill-pane', '--pane-id', String(pid)); } catch { /* ignore — might already be gone */ }
    }

    // Auto-save manifest with new pane IDs so reconcile works immediately
    try { saveManifest(captureManifest()); } catch { /* best effort */ }

    const allRecoveredPanes = recoveredWindows.flatMap(w => w.tabs.flatMap(t => t.panes));
    const totalPanes = allRecoveredPanes.length;
    const totalTabs = recoveredWindows.reduce((sum, w) => sum + w.tabs.length, 0);
    const withSession = allRecoveredPanes.filter(p => p.session_id !== null).length;

    return ok({
      recovered: true,
      from_manifest: manifest.saved_at,
      windows: recoveredWindows.length,
      tabs: totalTabs,
      panes: totalPanes,
      resumed_with_session: withSession,
      resumed_latest: totalPanes - withSession,
      details: recoveredWindows,
      note: `Recovered ${totalPanes} pane(s) across ${recoveredWindows.length} window(s), ${totalTabs} tab(s). ${withSession} resumed specific sessions, ${totalPanes - withSession} resumed latest.`,
    });
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('wezterm-mcp failed:', err);
  process.exit(1);
});
