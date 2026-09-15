import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const interactive = Boolean(
  process.stdout.isTTY
  && !process.env.NO_COLOR
  && process.env.TERM !== 'dumb',
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[38;5;44m',
  blue: '\x1b[38;5;75m',
  magenta: '\x1b[38;5;213m',
  green: '\x1b[38;5;84m',
  yellow: '\x1b[38;5;220m',
  red: '\x1b[38;5;203m',
  white: '\x1b[38;5;255m',
  gray: '\x1b[38;5;245m',
  dark: '\x1b[38;5;238m',
  clear: '\x1b[2J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  altScreen: '\x1b[?1049h',
  mainScreen: '\x1b[?1049l',
  mouseOn: '\x1b[?1000h\x1b[?1006h',
  mouseOff: '\x1b[?1000l\x1b[?1006l\x1b[?1007l',
} as const;

type Tone = 'success' | 'info' | 'warn' | 'error' | 'muted';
type ConsoleMethod = 'log' | 'warn' | 'error';

interface ActivityEvent {
  time: string;
  label: string;
  message: string;
  tone: Tone;
}

interface ServiceState {
  bridge: 'starting' | 'online' | 'stopping' | 'error';
  telegram: 'waiting' | 'online' | 'error';
  zalo: 'waiting' | 'online' | 'error';
  users: number;
  topics: number;
  version: string;
  phase: string;
  events: ActivityEvent[];
}

const state: ServiceState = {
  bridge: 'starting',
  telegram: 'waiting',
  zalo: 'waiting',
  users: 0,
  topics: 0,
  version: '1.0.0',
  phase: 'STARTUP',
  events: [],
};

const nativeConsole: Record<ConsoleMethod, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const toneStyle: Record<Tone, { symbol: string; color: string }> = {
  success: { symbol: '●', color: ansi.green },
  info: { symbol: '◆', color: ansi.cyan },
  warn: { symbol: '▲', color: ansi.yellow },
  error: { symbol: '×', color: ansi.red },
  muted: { symbol: '·', color: ansi.gray },
};

const tagAliases: Record<string, string> = {
  boot: 'SYSTEM',
  usercache: 'CACHE',
  zalo: 'ZALO',
  zalohandler: 'ZALO RX',
  telegram: 'TELEGRAM',
  telegramhandler: 'TELEGRAM',
  'tg→zalo': 'TG → ZALO',
  'zalo→tg': 'ZALO → TG',
};

let consoleThemeInstalled = false;
let dashboardActive = false;
let renderQueued = false;
let dashboardTimer: ReturnType<typeof setInterval> | null = null;
let loadingActive = false;
let inputActive = false;
let scrollOffset = 0;
let lastActivityHeight = 5;
let selectionMode = false;
let charmTuiProcess: ChildProcess | null = null;
let charmTuiStream: Writable | null = null;
let charmTuiActive = false;

function paint(text: string, color: string, bold = false): string {
  if (!interactive) return text;
  return `${bold ? ansi.bold : ''}${color}${text}${ansi.reset}`;
}

function rgb(red: number, green: number, blue: number): string {
  return `\x1b[38;2;${Math.round(red)};${Math.round(green)};${Math.round(blue)}m`;
}

function gradient(text: string, phase = 0): string {
  if (!interactive) return text;
  const stops = [
    [255, 79, 190],
    [166, 91, 255],
    [52, 211, 255],
  ] as const;
  return Array.from(text).map((character, index, chars) => {
    const wave = ((index / Math.max(1, chars.length - 1)) + phase) % 1;
    const scaled = wave * (stops.length - 1);
    const stop = Math.min(stops.length - 2, Math.floor(scaled));
    const mix = scaled - stop;
    const from = stops[stop]!;
    const to = stops[stop + 1]!;
    return `${rgb(
      from[0] + (to[0] - from[0]) * mix,
      from[1] + (to[1] - from[1]) * mix,
      from[2] + (to[2] - from[2]) * mix,
    )}${character}`;
  }).join('') + ansi.reset;
}

function clock(): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
}

function uptime(): string {
  const total = Math.floor(process.uptime());
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
}

function canUseDashboard(): boolean {
  return interactive
    && process.env.ZALO_TG_TUI !== '0';
}

function canUseCharmTui(): boolean {
  return canUseDashboard()
    && process.env.ZALO_TG_TUI_ENGINE !== 'ansi';
}

function tuiMouseCaptureEnabled(): boolean {
  const value = process.env.ZALO_TG_TUI_MOUSE?.trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'native'].includes(value ?? '');
}

function tuiBinaryName(): string {
  return process.platform === 'win32' ? 'zalo-tg-tui.exe' : 'zalo-tg-tui';
}

function resolveCharmTuiBinary(): string | null {
  const explicit = process.env.ZALO_TG_TUI_BIN?.trim();
  const candidates = [
    explicit || undefined,
    path.resolve(process.cwd(), 'bin', tuiBinaryName()),
    path.resolve(PROJECT_ROOT, 'bin', tuiBinaryName()),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function tuiState(): ServiceState {
  return {
    ...state,
    events: state.events.slice(-200),
  };
}

function sendCharmTui(payload: Record<string, unknown>): boolean {
  if (!charmTuiActive || !charmTuiStream || charmTuiStream.destroyed || !charmTuiStream.writable) {
    return false;
  }
  try {
    charmTuiStream.write(`${JSON.stringify(payload)}\n`);
    return true;
  } catch {
    charmTuiActive = false;
    return false;
  }
}

function stopCharmTui(): void {
  if (!charmTuiActive && !charmTuiProcess) return;
  sendCharmTui({ type: 'quit', state: tuiState() });
  try { charmTuiStream?.end(); } catch { /* ignore */ }
  charmTuiActive = false;
  charmTuiStream = null;
  charmTuiProcess = null;
}

function shouldDumpCharmTuiExit(): boolean {
  if (process.env.ZALO_TG_TUI_DUMP_ON_EXIT === '0') return false;
  if (process.uptime() < 20) return true;
  return state.events.slice(-8).some(event => event.tone === 'error');
}

function dumpCharmTuiExit(reason: string): void {
  if (!shouldDumpCharmTuiExit()) return;
  nativeConsole.warn('');
  nativeConsole.warn(`${paint('▲', ansi.yellow, true)} ${paint('Bridge stopped', ansi.yellow, true)} ${paint(reason, ansi.gray)}`);
  for (const event of state.events.slice(-8)) {
    streamEvent(event, event.tone === 'error' ? 'error' : event.tone === 'warn' ? 'warn' : 'log');
  }
}

function startCharmTui(): boolean {
  if (!canUseCharmTui()) return false;
  const binary = resolveCharmTuiBinary();
  if (!binary) return false;
  try {
    const child = spawn(binary, [], {
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
      env: {
        ...process.env,
        ZALO_TG_TUI_SIDECAR: '1',
      },
    });
    const eventStream = child.stdio[3] as Writable | undefined;
    if (!eventStream) {
      child.kill();
      return false;
    }
    charmTuiProcess = child;
    charmTuiStream = eventStream;
    charmTuiActive = true;
    child.once('exit', () => {
      charmTuiActive = false;
      charmTuiStream = null;
      charmTuiProcess = null;
    });
    child.once('error', () => {
      charmTuiActive = false;
      charmTuiStream = null;
      charmTuiProcess = null;
    });
    sendCharmTui({ type: 'snapshot', state: tuiState() });
    return true;
  } catch {
    charmTuiActive = false;
    charmTuiStream = null;
    charmTuiProcess = null;
    return false;
  }
}

function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

function divide(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

function labelColor(label: string): string {
  const value = label.toLowerCase();
  if (value.includes('zalo')) return ansi.magenta;
  if (value.includes('telegram') || value.includes('tg')) return ansi.cyan;
  if (value.includes('bridge')) return ansi.green;
  if (value.includes('system') || value.includes('runtime')) return ansi.blue;
  if (value.includes('cache') || value.includes('topic')) return ansi.yellow;
  return ansi.white;
}

function serviceValue(value: 'starting' | 'online' | 'stopping' | 'waiting' | 'error'): { text: string; color: string } {
  if (value === 'online') return { text: '●  CONNECTED', color: ansi.green };
  if (value === 'error') return { text: '×  ERROR', color: ansi.red };
  if (value === 'stopping') return { text: '◌  STOPPING', color: ansi.yellow };
  return { text: '◌  CONNECTING', color: ansi.cyan };
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function centered(text: string, width: number): string {
  return `${' '.repeat(Math.max(0, Math.floor((width - text.length) / 2)))}${text}`;
}

async function playLoadingAnimation(): Promise<void> {
  if (!dashboardActive || process.env.ZALO_TG_NO_ANIMATION === '1') return;
  if ((process.stdout.columns ?? 0) < 56 || (process.stdout.rows ?? 0) < 16) return;
  loadingActive = true;
  const frameCount = 36;
  for (let frame = 0; frame <= frameCount; frame++) {
    const columns = process.stdout.columns ?? 100;
    const rows = process.stdout.rows ?? 30;
    const progress = frame / frameCount;
    const eased = 1 - Math.pow(1 - progress, 3);
    const boxWidth = Math.max(42, Math.min(72, columns - 6));
    const inner = boxWidth - 2;
    const barWidth = Math.max(20, Math.min(46, inner - 12));
    const filled = Math.min(barWidth, Math.round(barWidth * eased));
    const bar = `${'━'.repeat(Math.max(0, filled - 1))}${filled > 0 ? '╸' : ''}${'─'.repeat(barWidth - filled)}`;
    const trackWidth = Math.max(13, Math.min(31, inner - 16));
    const head = Math.min(trackWidth - 1, Math.floor(progress * trackWidth));
    const track = Array.from({ length: trackWidth }, (_, index) => {
      const distance = Math.abs(index - head);
      if (distance === 0) return '◆';
      if (distance === 1) return '●';
      if (distance === 2) return '•';
      return '·';
    }).join('');
    const percent = `${String(Math.round(progress * 100)).padStart(3)}%`;
    const logo = 'Z A L O   ⇄   T E L E G R A M';
    const centerStyled = (plain: string, styled: string): string => {
      const left = Math.max(0, Math.floor((inner - plain.length) / 2));
      const right = Math.max(0, inner - plain.length - left);
      return `${' '.repeat(left)}${styled}${' '.repeat(right)}`;
    };
    const content: string[] = [
      gradient(`╭${'─'.repeat(inner)}╮`, frame / 90),
      `${gradient('│', frame / 90)}${' '.repeat(inner)}${gradient('│', frame / 90 + 0.2)}`,
      `${gradient('│', frame / 90)}${centerStyled(logo, gradient(logo, frame / 55))}${gradient('│', frame / 90 + 0.2)}`,
      `${gradient('│', frame / 90)}${centerStyled(track, gradient(track, frame / 45))}${gradient('│', frame / 90 + 0.2)}`,
      `${gradient('│', frame / 90)}${' '.repeat(inner)}${gradient('│', frame / 90 + 0.2)}`,
      gradient(`╰${'─'.repeat(inner)}╯`, frame / 90 + 0.1),
      '',
      centered(`${bar}  ${percent}`, columns),
      centered(frame === frameCount ? 'BRIDGE READY' : 'INITIALIZING REALTIME BRIDGE', columns),
    ];
    const top = '\n'.repeat(Math.max(0, Math.floor((rows - content.length) / 2)));
    const left = ' '.repeat(Math.max(0, Math.floor((columns - boxWidth) / 2)));
    const rendered = content.map((line, index) => {
      if (index >= 7) return index === 7 ? gradient(line, frame / 80) : paint(line, frame === frameCount ? ansi.green : ansi.gray, index === 8);
      return line ? `${left}${line}` : '';
    }).join('\n');
    process.stdout.write(`${ansi.hideCursor}${ansi.clear}${top}${rendered}`);
    await wait(frame === frameCount ? 110 : 26);
  }
  loadingActive = false;
}

async function playShutdownAnimation(reason: string): Promise<void> {
  if (!dashboardActive) {
    await wait(150);
    return;
  }
  selectionMode = false;
  loadingActive = true;
  process.stdout.write(ansi.mouseOff);
  const frameCount = 52;
  for (let frame = 0; frame <= frameCount; frame++) {
    const columns = process.stdout.columns ?? 100;
    const rows = process.stdout.rows ?? 30;
    if (columns < 50 || rows < 14) {
      process.stdout.write(`${ansi.clear}${centered('Closing bridge safely…', columns)}`);
      await wait(600);
      return;
    }
    const progress = frame / frameCount;
    const ease = progress * progress * (3 - 2 * progress);
    const boxWidth = Math.min(78, columns - 6);
    const inner = boxWidth - 2;
    const trackWidth = Math.max(25, Math.min(47, inner - 12));
    const center = Math.floor(trackWidth / 2);
    const distance = Math.max(0, Math.round(center * (1 - ease)));
    const leftHead = center - distance;
    const rightHead = center + distance;
    const particleChars = Array.from({ length: trackWidth }, (_, index) => {
      if (index === leftHead || index === rightHead) return distance === 0 ? '◇' : '◆';
      if (index > leftHead && index < rightHead) return (index + frame) % 3 === 0 ? '━' : '─';
      const flicker = (index * 7 + frame * 3) % 19;
      return flicker === 0 ? '✦' : flicker < 4 ? '·' : ' ';
    }).join('');
    const logo = progress < 0.88 ? 'Z A L O   ⇄   T E L E G R A M' : '◇';
    const status = progress < 0.32
      ? 'DRAINING MESSAGE PIPELINE'
      : progress < 0.68
        ? 'FLUSHING BRIDGE STATE'
        : progress < 0.96
          ? 'CLOSING CONNECTIONS'
          : 'BRIDGE OFFLINE · STATE SAFE';
    const centerStyled = (plain: string, styled: string): string => {
      const left = Math.max(0, Math.floor((inner - plain.length) / 2));
      const right = Math.max(0, inner - plain.length - left);
      return `${' '.repeat(left)}${styled}${' '.repeat(right)}`;
    };
    const reasonText = fit(reason, Math.max(12, inner - 8)).trimEnd();
    const content = [
      gradient(`╭${'─'.repeat(inner)}╮`, 0.55 + frame / 100),
      `${gradient('│', frame / 80)}${' '.repeat(inner)}${gradient('│', 0.7 + frame / 80)}`,
      `${gradient('│', frame / 80)}${centerStyled(logo, gradient(logo, 0.4 + frame / 45))}${gradient('│', 0.7 + frame / 80)}`,
      `${gradient('│', frame / 80)}${centerStyled(particleChars, gradient(particleChars, 0.6 + frame / 35))}${gradient('│', 0.7 + frame / 80)}`,
      `${gradient('│', frame / 80)}${centerStyled(status, paint(status, progress > 0.95 ? ansi.green : ansi.white, true))}${gradient('│', 0.7 + frame / 80)}`,
      `${gradient('│', frame / 80)}${centerStyled(reasonText, paint(reasonText, ansi.gray))}${gradient('│', 0.7 + frame / 80)}`,
      `${gradient('│', frame / 80)}${' '.repeat(inner)}${gradient('│', 0.7 + frame / 80)}`,
      gradient(`╰${'─'.repeat(inner)}╯`, 0.65 + frame / 100),
    ];
    const top = '\n'.repeat(Math.max(0, Math.floor((rows - content.length) / 2)));
    const left = ' '.repeat(Math.max(0, Math.floor((columns - boxWidth) / 2)));
    process.stdout.write(`${ansi.hideCursor}${ansi.clear}${top}${content.map(line => `${left}${line}`).join('\n')}`);
    await wait(frame === frameCount ? 260 : 24);
  }
  // Keep loadingActive set until process exit so late shutdown logs cannot
  // overwrite the final outro frame.
}

function maxScrollOffset(): number {
  return Math.max(0, state.events.length - lastActivityHeight);
}

function scrollActivity(delta: number): void {
  scrollOffset = Math.max(0, Math.min(maxScrollOffset(), scrollOffset + delta));
  scheduleRender();
}

function setSelectionMode(enabled: boolean): void {
  selectionMode = enabled;
  if (enabled) {
    if (tuiMouseCaptureEnabled()) process.stdout.write(ansi.mouseOff);
    // Render the SELECT indicator once, then freeze the screen so incoming
    // events cannot invalidate Terminal.app's native text selection.
    renderDashboard(true);
  } else {
    if (tuiMouseCaptureEnabled()) process.stdout.write(ansi.mouseOn);
    renderDashboard(true);
  }
}

function handleInput(data: Buffer | string): void {
  const input = data.toString();
  if (input.includes('\x03')) {
    // Raw mode turns Ctrl+C into a byte instead of a terminal signal. Signal
    // the whole foreground process group so npm/tsx/run.sh stop with the bot.
    process.kill(0, 'SIGINT');
    return;
  }
  if (input === 's' || input === 'S') {
    setSelectionMode(!selectionMode);
    return;
  }
  if (selectionMode) return;
  // SGR mouse packets (Terminal.app, iTerm2, Kitty). Count every packet in a
  // chunk so smooth trackpad gestures do not collapse into a single step.
  const wheelUp = input.match(/\x1b\[<64;\d+;\d+[mM]/g)?.length ?? 0;
  const wheelDown = input.match(/\x1b\[<65;\d+;\d+[mM]/g)?.length ?? 0;
  if (wheelUp > 0) scrollActivity(wheelUp);
  if (wheelDown > 0) scrollActivity(-wheelDown);

  // X10/legacy mouse packets: wheel-up is button byte 96 (`), down is 97 (a).
  const legacyUp = input.match(/\x1b\[M`[\s\S]{2}/g)?.length ?? 0;
  const legacyDown = input.match(/\x1b\[Ma[\s\S]{2}/g)?.length ?? 0;
  if (legacyUp > 0) scrollActivity(legacyUp);
  if (legacyDown > 0) scrollActivity(-legacyDown);
  if (input.includes('\x1b[5~')) scrollActivity(lastActivityHeight);
  else if (input.includes('\x1b[6~')) scrollActivity(-lastActivityHeight);
  else {
    // Alternate-scroll may batch many trackpad ticks into one stdin chunk.
    const arrowUp = input.match(/\x1b\[A/g)?.length ?? 0;
    const arrowDown = input.match(/\x1b\[B/g)?.length ?? 0;
    if (arrowUp > 0) scrollActivity(arrowUp);
    else if (arrowDown > 0) scrollActivity(-arrowDown);
    else if (input === 'k' || input === 'K') scrollActivity(1);
    else if (input === 'j' || input === 'J') scrollActivity(-1);
  }
  if (input.includes('\x1b[H') || input === 'g') {
    scrollOffset = maxScrollOffset();
    scheduleRender();
  } else if (input.includes('\x1b[F') || input === 'G') {
    scrollOffset = 0;
    scheduleRender();
  }
}

function setupInteractiveInput(): void {
  if (inputActive || !dashboardActive || !process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return;
  inputActive = true;
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  process.stdout.write(`${ansi.altScreen}${tuiMouseCaptureEnabled() ? ansi.mouseOn : ''}${ansi.hideCursor}`);
}

function cleanupInteractiveInput(): void {
  if (!inputActive) return;
  inputActive = false;
  process.stdin.off('data', handleInput);
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`${ansi.mouseOff}${ansi.showCursor}${ansi.mainScreen}`);
}

function renderDashboard(force = false): void {
  if (!dashboardActive || !canUseDashboard() || loadingActive || (selectionMode && !force)) return;

  const terminalWidth = process.stdout.columns ?? 100;
  const terminalHeight = process.stdout.rows ?? 30;
  if (terminalWidth < 56 || terminalHeight < 16) {
    const message = 'Resize terminal to at least 56 × 16';
    const title = gradient('◆  ZALO  ⇄  TELEGRAM');
    const top = '\n'.repeat(Math.max(0, Math.floor(terminalHeight / 2) - 2));
    process.stdout.write(`${ansi.hideCursor}${ansi.clear}${top}${centered(title, terminalWidth)}\n${centered(message, terminalWidth)}`);
    return;
  }
  const width = Math.min(136, terminalWidth - 2);
  const inner = width - 2;
  const indent = ' '.repeat(Math.max(0, Math.floor((terminalWidth - width) / 2)));
  const wideLayout = width >= 100;
  const bridge = serviceValue(state.bridge);
  const telegram = serviceValue(state.telegram);
  const zalo = serviceValue(state.zalo);
  const right = width >= 76 ? `v${state.version}  ·  ${clock()}` : `v${state.version}`;
  const brand = '◆  ZALO  ⇄  TELEGRAM';
  const brandGap = ' '.repeat(Math.max(1, inner - brand.length - right.length - 6));
  // Pin the closing border to an absolute terminal column. Unicode glyphs can
  // have font-dependent display widths, so string.length padding alone is not
  // reliable in Terminal.app/iTerm.
  const rightColumn = width + indent.length;
  const closeHeaderRow = (content: string): string => `${indent}${paint('│', ansi.dark)}${content}\x1b[${rightColumn}G${paint('│', ansi.dark)}`;

  const lines: string[] = [];
  const headerRow = (text: string, color: string, bold = false): string => {
    const content = `  ${text}`;
    return closeHeaderRow(paint(fit(content, inner - 2), color, bold));
  };
  lines.push(`${indent}${paint(`╭${'─'.repeat(inner)}╮`, ansi.dark)}`);
  lines.push(closeHeaderRow(`  ${paint('◆', ansi.magenta, true)}  ${paint('ZALO', ansi.magenta, true)}  ${paint('⇄', ansi.gray)}  ${paint('TELEGRAM', ansi.cyan, true)}${brandGap}${paint(right, ansi.gray)}  `));
  if (width >= 72) lines.push(headerRow('REALTIME FORUM BRIDGE  ·  Native media  ·  Reactions  ·  Topics', ansi.gray));

  if (wideLayout) {
    const cardWidths = divide(width - 5, 4);
    lines.push(`${indent}${paint('├', ansi.dark)}${cardWidths.map(w => paint('─'.repeat(w), ansi.dark)).join(paint('┬', ansi.dark))}${paint('┤', ansi.dark)}`);
    const cardRow = (values: Array<{ text: string; color: string; bold?: boolean }>): string => {
      const cells = values.map((value, i) => paint(fit(`  ${value.text}`, cardWidths[i]!), value.color, value.bold));
      return `${indent}${paint('│', ansi.dark)}${cells.join(paint('│', ansi.dark))}${paint('│', ansi.dark)}`;
    };
    lines.push(cardRow([
      { text: 'BRIDGE', color: ansi.gray, bold: true },
      { text: 'TELEGRAM', color: ansi.gray, bold: true },
      { text: 'ZALO', color: ansi.gray, bold: true },
      { text: 'WORKSPACE', color: ansi.gray, bold: true },
    ]));
    lines.push(cardRow([
      { text: bridge.text, color: bridge.color, bold: true },
      { text: telegram.text, color: telegram.color, bold: true },
      { text: zalo.text, color: zalo.color, bold: true },
      { text: `${state.topics} topics  ·  ${state.users} users`, color: ansi.white },
    ]));
    lines.push(`${indent}${paint('╰', ansi.dark)}${cardWidths.map(w => paint('─'.repeat(w), ansi.dark)).join(paint('┴', ansi.dark))}${paint('╯', ansi.dark)}`);
  } else {
    const cardWidths = divide(width - 3, 2);
    const compactCardRow = (values: Array<{ title: string; value: string; color: string }>): string => {
      const cells = values.map((value, i) => {
        const title = `${value.title.padEnd(10)} `;
        const room = Math.max(1, cardWidths[i]! - title.length - 2);
        return `${paint(`  ${title}`, ansi.gray, true)}${paint(fit(value.value, room), value.color, true)}`;
      });
      return `${indent}${paint('│', ansi.dark)}${cells.join(paint('│', ansi.dark))}${paint('│', ansi.dark)}`;
    };
    lines.push(`${indent}${paint('├', ansi.dark)}${paint('─'.repeat(cardWidths[0]!), ansi.dark)}${paint('┬', ansi.dark)}${paint('─'.repeat(cardWidths[1]!), ansi.dark)}${paint('┤', ansi.dark)}`);
    lines.push(compactCardRow([
      { title: 'BRIDGE', value: bridge.text, color: bridge.color },
      { title: 'TELEGRAM', value: telegram.text, color: telegram.color },
    ]));
    lines.push(compactCardRow([
      { title: 'ZALO', value: zalo.text, color: zalo.color },
      { title: 'DATA', value: `${state.topics} topics · ${state.users} users`, color: ansi.white },
    ]));
    lines.push(`${indent}${paint('╰', ansi.dark)}${paint('─'.repeat(cardWidths[0]!), ansi.dark)}${paint('┴', ansi.dark)}${paint('─'.repeat(cardWidths[1]!), ansi.dark)}${paint('╯', ansi.dark)}`);
  }

  lines.push('');
  const activityHeight = Math.max(3, terminalHeight - lines.length - 5);
  lastActivityHeight = activityHeight;
  scrollOffset = Math.min(scrollOffset, maxScrollOffset());
  const historyLabel = scrollOffset > 0 ? `  HISTORY −${scrollOffset}` : '  LIVE';
  const activityTitle = `${state.phase}${historyLabel}`;
  const activityRule = '─'.repeat(Math.max(0, width - activityTitle.length - 5));
  lines.push(`${indent}${paint('╭─ ', ansi.dark)}${paint(state.phase, ansi.blue, true)}${paint(historyLabel, scrollOffset > 0 ? ansi.yellow : ansi.green, true)}${paint(` ${activityRule}╮`, ansi.dark)}`);
  const visibleEnd = Math.max(0, state.events.length - scrollOffset);
  const visibleStart = Math.max(0, visibleEnd - activityHeight);
  const visibleEvents = state.events.slice(visibleStart, visibleEnd);
  const emptyRows = activityHeight - visibleEvents.length;

  for (let i = 0; i < emptyRows; i++) {
    const placeholder = i === emptyRows - 1 && visibleEvents.length === 0 ? 'Waiting for bridge activity…' : '';
    lines.push(`${indent}${paint('│', ansi.dark)} ${paint(fit(placeholder, inner - 2), ansi.dark)} ${paint('│', ansi.dark)}`);
  }

  for (const event of visibleEvents) {
    const style = toneStyle[event.tone];
    const prefix = `${event.time}  ${style.symbol}  ${event.label.padEnd(11)} `;
    const detailWidth = Math.max(8, inner - prefix.length - 2);
    lines.push(
      `${indent}${paint('│', ansi.dark)} ${paint(event.time, ansi.gray)}  ${paint(style.symbol, style.color, true)}  ${paint(event.label.padEnd(11), labelColor(event.label), true)} ${paint(fit(event.message, detailWidth), event.tone === 'muted' ? ansi.gray : ansi.white)} ${paint('│', ansi.dark)}`,
    );
  }
  lines.push(`${indent}${paint(`╰${'─'.repeat(inner)}╯`, ansi.dark)}`);
  const modeLabel = selectionMode
    ? 'SELECT · drag + Cmd+C · S resume'
    : tuiMouseCaptureEnabled()
      ? 'SCROLL · wheel/trackpad · S select'
      : 'NATIVE MOUSE · ↑↓ scroll';
  const controls = width >= 112
    ? `${modeLabel}  ·  PgUp/PgDn  ·  Home/End  ·  Ctrl+C stop  ·  up ${uptime()}`
    : width >= 78
      ? `↑↓ / wheel scroll  ·  PgUp/PgDn  ·  Ctrl+C stop  ·  up ${uptime()}`
      : '↑↓ scroll  ·  PgUp/PgDn  ·  Ctrl+C stop';
  lines.push(`${indent}${paint(fit(controls, width), ansi.gray)}`);

  process.stdout.write(`${ansi.hideCursor}${ansi.clear}${lines.join('\n')}`);
}

function scheduleRender(): void {
  if (!dashboardActive || renderQueued || loadingActive || selectionMode) return;
  renderQueued = true;
  setImmediate(() => {
    renderQueued = false;
    renderDashboard();
  });
}

function updateServiceState(label: string, detail: string, tone: Tone): void {
  const key = label.toLowerCase();
  if (key === 'telegram') state.telegram = tone === 'success' ? 'online' : tone === 'error' ? 'error' : 'waiting';
  if (key === 'zalo') state.zalo = tone === 'success' ? 'online' : tone === 'error' ? 'error' : 'waiting';
  if (key === 'bridge') state.bridge = tone === 'success' ? 'online' : tone === 'error' ? 'error' : 'starting';
  if (key === 'cache') {
    const match = /(\d+) users.*?(\d+) topics/.exec(detail);
    if (match) {
      state.users = Number(match[1]);
      state.topics = Number(match[2]);
    }
  }
}

function streamEvent(event: ActivityEvent, method: ConsoleMethod, rest: unknown[] = []): void {
  const style = toneStyle[event.tone];
  nativeConsole[method](
    `${paint(event.time, ansi.gray)}  ${paint(style.symbol, style.color, true)}  ${paint(event.label.padEnd(11), labelColor(event.label), true)} ${event.message}`,
    ...rest,
  );
}

function formatDashboardValue(value: unknown): string {
  if (value instanceof AggregateError) {
    const causes = value.errors
      .slice(0, 3)
      .map(formatDashboardValue)
      .join(' | ');
    return `${value.name}: ${value.message}${causes ? `; ${causes}` : ''}`;
  }
  if (value instanceof Error) {
    const cause = 'cause' in value && value.cause !== undefined
      ? `; cause=${formatDashboardValue(value.cause)}`
      : '';
    return `${value.name}: ${value.message}${cause}`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const response = record.response;
    if (response && typeof response === 'object') {
      const apiResponse = response as Record<string, unknown>;
      const code = apiResponse.error_code ?? apiResponse.status;
      const description = apiResponse.description ?? apiResponse.statusText;
      if (code !== undefined || description !== undefined) {
        return [code, description].filter(part => part !== undefined).join(' · ');
      }
    }
    if (typeof record.message === 'string') return record.message;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function dashboardLogMessage(message: string, rest: unknown[]): string {
  if (!dashboardActive || !canUseDashboard() || rest.length === 0) return message;
  const details = rest.map(formatDashboardValue).join(' · ').replace(/[\r\n]+/g, ' ↵ ');
  return details ? `${message} ${details}` : message;
}

function addEvent(label: string, message: string, tone: Tone, method: ConsoleMethod = 'log', rest: unknown[] = []): void {
  const event: ActivityEvent = { time: clock(), label: label.slice(0, 11), message, tone };
  if (scrollOffset > 0) scrollOffset++;
  state.events.push(event);
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
  if (charmTuiActive && sendCharmTui({ type: 'event', event, state: tuiState() })) return;
  if (dashboardActive && canUseDashboard()) scheduleRender();
  else streamEvent(event, method, rest);
}

function formatTaggedLog(method: ConsoleMethod, args: unknown[]): void {
  // File logging is a separate sink; this preserves the existing TUI flow.
  logger.fromConsole(method, args);
  const first = args[0];
  if (typeof first !== 'string') {
    if (dashboardActive && canUseDashboard()) {
      addEvent('APP', formatDashboardValue(first), method === 'error' ? 'error' : method === 'warn' ? 'warn' : 'muted');
    } else nativeConsole[method](...args);
    return;
  }
  const match = /^\[([^\]]+)]\s*(.*)$/s.exec(first);
  if (!match) {
    if (dashboardActive && canUseDashboard()) {
      addEvent('APP', first, method === 'error' ? 'error' : method === 'warn' ? 'warn' : 'muted');
    } else nativeConsole[method](...args);
    return;
  }
  const rawTag = match[1] ?? 'LOG';
  const label = tagAliases[rawTag.toLowerCase()] ?? rawTag.toUpperCase();
  const tone: Tone = method === 'error' ? 'error' : method === 'warn' ? 'warn' : 'muted';
  const rest = args.slice(1);
  addEvent(label, dashboardLogMessage(match[2] ?? '', rest), tone, method,
    dashboardActive && canUseDashboard() ? [] : rest);
}

export const terminal = {
  interactive,

  async intro(version: string): Promise<void> {
    state.version = version;
    dashboardActive = canUseDashboard();
    if (dashboardActive && startCharmTui()) {
      return;
    }
    if (dashboardActive) {
      setupInteractiveInput();
      await playLoadingAnimation();
      renderDashboard();
    }
    else nativeConsole.log(`${paint('◆', ansi.magenta)} ${paint('ZALO', ansi.magenta, true)} ${paint('⇄', ansi.gray)} ${paint('TELEGRAM', ansi.cyan, true)} ${paint(`v${version}`, ansi.gray)}`);
  },

  installConsoleTheme(): void {
    if (consoleThemeInstalled) return;
    consoleThemeInstalled = true;
    console.log = (...args: unknown[]) => formatTaggedLog('log', args);
    console.warn = (...args: unknown[]) => formatTaggedLog('warn', args);
    console.error = (...args: unknown[]) => formatTaggedLog('error', args);
  },

  status(label: string, detail: string, tone: Tone = 'info'): void {
    updateServiceState(label, detail, tone);
    addEvent(label.toUpperCase(), detail, tone);
  },

  section(title: string): void {
    state.phase = title.toUpperCase();
    if (charmTuiActive && sendCharmTui({ type: 'section', state: tuiState() })) return;
    scheduleRender();
  },

  qr(path: string): void {
    addEvent('QR LOGIN', `Scan requested · ${path}`, 'warn');
  },

  async shutdown(reason: string): Promise<void> {
    state.bridge = 'stopping';
    state.phase = 'SHUTDOWN';
    addEvent('LIFECYCLE', reason, 'warn');
    if (charmTuiActive) {
      sendCharmTui({ type: 'shutdown', reason, state: tuiState() });
      await wait(1100);
      stopCharmTui();
      await wait(120);
      dumpCharmTuiExit(reason);
      return;
    }
    await playShutdownAnimation(reason);
  },
};

if (interactive) {
  process.stdout.on('resize', scheduleRender);
  process.once('exit', () => {
    if (dashboardTimer) clearInterval(dashboardTimer);
    stopCharmTui();
    cleanupInteractiveInput();
    if (!inputActive) process.stdout.write(ansi.showCursor);
  });
}
