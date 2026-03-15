/**
 * Platform abstraction layer for Wezterm MCP Server.
 *
 * Centralises all OS-specific behaviour so the main code never
 * branches on IS_WIN / IS_MAC.  Three concrete implementations
 * share a Unix base; Linux and macOS override where they differ.
 */

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Shared helpers (not exported)
// ---------------------------------------------------------------------------

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Platform {
  readonly name: 'linux' | 'macos' | 'windows';

  // --- Wezterm binaries ---------------------------------------------------
  weztermBin(): string;
  weztermGuiBin(): string;
  isWezInstalled(): boolean;

  // --- Process management -------------------------------------------------
  isProcessRunning(name: string): boolean;
  killProcess(name: string): void;

  // --- Socket / pipe discovery --------------------------------------------
  socketDir(): string;

  // --- Shell execution ----------------------------------------------------
  /** Value for execSync's `shell` option. */
  readonly shell: string | true;
  /** Wrap a command string for shell execution → [shell, flag, cmd]. */
  shellExec(cmd: string): string[];
  /** Syntax for setting an env var inline: 'KEY=val' (unix) / 'set KEY=val' (win). */
  setEnvCmd(key: string, val: string): string;
  /** Cross-platform synchronous sleep. */
  sleep(seconds: number): void;

  // --- Path handling ------------------------------------------------------
  /** Normalise a file:// URI (as returned by wezterm list) to a local path. */
  normalizeCwd(raw: string): string;
  /** Encode a cwd for Claude's trust directory name. */
  encodeTrustPath(cwd: string): string;
  /** Strip trailing path separator(s). */
  stripTrailingSep(p: string): string;

  // --- CLI wrapping (Windows npm shim workaround) -------------------------
  /**
   * On Windows npm-installed CLIs use .cmd wrappers that wezterm cannot exec
   * directly — wrap them in cmd.exe.  On Unix this is a no-op pass-through.
   * Returns { parts, shellCommand, needsShell }.
   */
  wrapCliForSpawn(cli: string, parts: string[]): {
    parts: string[];
    shellCommand: string;
    needsShell: boolean;
  };

  // --- Screenshots --------------------------------------------------------
  screenshotCmds(filePath: string): string[];
  readonly screenshotErrorMsg: string;

  // --- Fullscreen ---------------------------------------------------------
  toggleFullscreen(): void;
  readonly fullscreenErrorMsg: string;
}

// ---------------------------------------------------------------------------
// Unix base (shared by Linux and macOS)
// ---------------------------------------------------------------------------

const unix: Omit<Platform, 'name' | 'socketDir' | 'weztermGuiBin' | 'screenshotCmds' | 'screenshotErrorMsg' | 'toggleFullscreen' | 'fullscreenErrorMsg'> = {
  shell: '/bin/bash',

  weztermBin(): string {
    return 'wezterm';
  },

  isWezInstalled(): boolean {
    try {
      execFileSync('which', ['wezterm'], { encoding: 'utf8', timeout: 3000, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  },

  isProcessRunning(name: string): boolean {
    try {
      const out = execSync(`pgrep -x ${name}`, { encoding: 'utf8', timeout: 3000 });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  },

  killProcess(name: string): void {
    try {
      execSync(`pkill -x ${name}`, { timeout: 3000 });
    } catch { /* process may not exist */ }
  },

  shellExec(cmd: string): string[] {
    return ['bash', '-c', cmd];
  },

  setEnvCmd(key: string, val: string): string {
    return `${key}=${val}`;
  },

  sleep(seconds: number): void {
    sleepMs(seconds * 1000);
  },

  normalizeCwd(raw: string): string {
    const path = raw.replace(/^file:\/\/[^/]*/, '');
    return path.replace(/\/+$/, '') || '/';
  },

  encodeTrustPath(cwd: string): string {
    return cwd.replace(/\//g, '-');
  },

  stripTrailingSep(p: string): string {
    return p.replace(/\/+$/, '');
  },

  wrapCliForSpawn(_cli: string, parts: string[]): { parts: string[]; shellCommand: string; needsShell: boolean } {
    return { parts, shellCommand: parts.join(' '), needsShell: false };
  },
};

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

const linux: Platform = {
  ...unix,
  name: 'linux',

  weztermGuiBin(): string {
    return 'wezterm-gui';
  },

  socketDir(): string {
    const uid = process.getuid?.();
    return join('/run/user', String(uid ?? 1000), 'wezterm');
  },

  screenshotCmds(filePath: string): string[] {
    return [
      `import -window "$(xdotool getactivewindow 2>/dev/null || xprop -root _NET_ACTIVE_WINDOW | awk '{print $5}')" "${filePath}"`,
      `scrot -u "${filePath}"`,
      `grim -g "$(slurp)" "${filePath}"`,
      `gnome-screenshot -w -f "${filePath}"`,
    ];
  },

  screenshotErrorMsg: 'No screenshot tool available. Install one of: imagemagick (import), scrot, grim, gnome-screenshot',

  toggleFullscreen(): void {
    execSync('xdotool key F11', { timeout: 5000 });
  },

  fullscreenErrorMsg: 'xdotool not available. Press F11 manually.',
};

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

const macos: Platform = {
  ...unix,
  name: 'macos',

  weztermGuiBin(): string {
    const appBin = '/Applications/WezTerm.app/Contents/MacOS/wezterm-gui';
    if (existsSync(appBin)) return appBin;
    return 'wezterm-gui';
  },

  socketDir(): string {
    return join(homedir(), '.local', 'share', 'wezterm');
  },

  screenshotCmds(filePath: string): string[] {
    return [`screencapture -w "${filePath}"`];
  },

  screenshotErrorMsg: 'Screenshot capture failed. Ensure screencapture is available.',

  toggleFullscreen(): void {
    execSync(
      'osascript -e \'tell application "System Events" to keystroke "f" using {control down, command down}\'',
      { timeout: 5000 },
    );
  },

  fullscreenErrorMsg: 'AppleScript failed. Press Ctrl+Cmd+F manually.',
};

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function winProgramFiles(): string {
  return process.env['ProgramFiles'] ?? 'C:\\Program Files';
}

function winWeztermDir(): string {
  return join(winProgramFiles(), 'WezTerm');
}

/** Emit an OSC 1337 SetUserVar to tag a pane with its CLI type. */
function winSetUserVar(cli: string): string {
  const b64 = Buffer.from(cli).toString('base64');
  return `node -e "process.stdout.write('\\x1b]1337;SetUserVar=cli=${b64}\\x07')"`;
}

const windows: Platform = {
  name: 'windows',
  shell: true as const,

  weztermBin(): string {
    const candidate = join(winWeztermDir(), 'wezterm.exe');
    if (existsSync(candidate)) return candidate;
    return 'wezterm';
  },

  weztermGuiBin(): string {
    const candidate = join(winWeztermDir(), 'wezterm-gui.exe');
    if (existsSync(candidate)) return candidate;
    return 'wezterm-gui';
  },

  isWezInstalled(): boolean {
    // Check common install paths first
    if (existsSync(join(winWeztermDir(), 'wezterm.exe'))) return true;
    try {
      execFileSync('where', ['wezterm'], { encoding: 'utf8', timeout: 3000, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  },

  isProcessRunning(name: string): boolean {
    try {
      const exe = name.endsWith('.exe') ? name : `${name}.exe`;
      const out = execSync(`tasklist /FI "IMAGENAME eq ${exe}" /NH`, { encoding: 'utf8', timeout: 5000 });
      return out.includes(name);
    } catch {
      return false;
    }
  },

  killProcess(name: string): void {
    try {
      const exe = name.endsWith('.exe') ? name : `${name}.exe`;
      execSync(`taskkill /F /IM ${exe}`, { timeout: 5000, stdio: 'pipe' });
    } catch { /* process may not exist */ }
  },

  socketDir(): string {
    return join(homedir(), '.local', 'share', 'wezterm');
  },

  shellExec(cmd: string): string[] {
    return ['cmd.exe', '/c', cmd];
  },

  setEnvCmd(key: string, val: string): string {
    return `set ${key}=${val}`;
  },

  sleep(seconds: number): void {
    sleepMs(seconds * 1000);
  },

  normalizeCwd(raw: string): string {
    let path = raw.replace(/^file:\/\/[^/]*/, '');
    // file:///C:/foo → /C:/foo — strip leading slash before drive letter
    if (/^\/[A-Za-z]:/.test(path)) {
      path = path.slice(1);
    }
    return path.replace(/[\\/]+$/, '') || 'C:\\';
  },

  encodeTrustPath(cwd: string): string {
    // Normalise to forward slashes first, then encode
    return cwd.replace(/\\/g, '/').replace(/\//g, '-');
  },

  stripTrailingSep(p: string): string {
    return p.replace(/[\\/]+$/, '');
  },

  wrapCliForSpawn(cli: string, parts: string[]): { parts: string[]; shellCommand: string; needsShell: boolean } {
    const bin = parts[0] ?? '';
    if (bin.endsWith('.exe')) {
      // Native exe — no wrapping needed
      return { parts, shellCommand: parts.join(' '), needsShell: false };
    }
    // npm-installed CLI: wrap in cmd.exe with OSC 1337 SetUserVar
    const shellCommand = parts.join(' ');
    return {
      parts: ['cmd.exe', '/c', `${winSetUserVar(cli)} && ${shellCommand}`],
      shellCommand,
      needsShell: true,
    };
  },

  screenshotCmds(filePath: string): string[] {
    const escaped = filePath.replace(/'/g, "''");
    return [
      `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $bmp = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0,0,0,0,$bmp.Size); $bmp.Save('${escaped}'); $g.Dispose(); $bmp.Dispose()"`,
    ];
  },

  screenshotErrorMsg: 'Screenshot capture failed on Windows.',

  toggleFullscreen(): void {
    execSync(
      'powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'{F11}\')"',
      { timeout: 5000, stdio: 'pipe' },
    );
  },

  fullscreenErrorMsg: 'SendKeys failed. Press F11 manually.',
};

// ---------------------------------------------------------------------------
// Export: pick the right implementation at module load time
// ---------------------------------------------------------------------------

export const OS: Platform =
  process.platform === 'win32' ? windows :
  process.platform === 'darwin' ? macos :
  linux;

// Re-export sleepMs for use in main code (non-platform-specific utility)
export { sleepMs };
