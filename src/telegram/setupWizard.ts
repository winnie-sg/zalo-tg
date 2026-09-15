/**
 * Interactive /setup wizard — configure bridge env vars straight from Telegram.
 *
 * Bool flags are answered with inline buttons; free-form values (URLs, thread
 * lists) are typed as a normal message in the bridge group. Changes are written
 * back to .env and take effect after /restart.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../utils/paths.js';

export interface SetupStep {
  key: string;
  title: string;
  description: string;
  kind: 'bool' | 'text';
  current: (env: NodeJS.ProcessEnv) => string;
  condition?: (answers: Record<string, string>, env: NodeJS.ProcessEnv) => boolean;
}

export interface SetupSession {
  userId: number;
  threadId?: number;
  steps: SetupStep[];
  idx: number;
  answers: Record<string, string>;
  awaitingText: boolean;
  expiresAt: number;
}

const SESSION_TTL_MS = 10 * 60_000;
const _sessions = new Map<number, SetupSession>();

function currentBool(key: string, fallback: string): (env: NodeJS.ProcessEnv) => string {
  return (env) => env[key]?.trim() || fallback;
}

export const SETUP_STEPS: SetupStep[] = [
  {
    key: 'LOCAL_BOT_API',
    title: 'LOCAL_BOT_API',
    description: 'Dùng Telegram Local Bot API để gửi file lớn (tối đa 2 GB thay vì 20 MB)?',
    kind: 'bool',
    current: currentBool('LOCAL_BOT_API', '0'),
  },
  {
    key: 'TG_LOCAL_SERVER',
    title: 'TG_LOCAL_SERVER',
    description: 'URL của server Local Bot API (ví dụ http://127.0.0.1:8081 hoặc https://...).',
    kind: 'text',
    current: (env) => env.TG_LOCAL_SERVER?.trim() || '(trống)',
    condition: (answers, env) =>
      ((answers.LOCAL_BOT_API ?? env.LOCAL_BOT_API?.trim()) || '0') === '1',
  },
  {
    key: 'ZALO_SKIP_MUTED_GROUPS',
    title: 'ZALO_SKIP_MUTED_GROUPS',
    description: 'Bỏ qua hoàn toàn các nhóm Zalo đang mute (không mirror lên Telegram)?',
    kind: 'bool',
    current: currentBool('ZALO_SKIP_MUTED_GROUPS', '0'),
  },
  {
    key: 'ZALO_MUTE_SILENT',
    title: 'ZALO_MUTE_SILENT',
    description: 'Mirror thread Zalo đang mute thành tin Telegram silent (không ping)?',
    kind: 'bool',
    current: currentBool('ZALO_MUTE_SILENT', '1'),
  },
  {
    key: 'ZALO_DM_NATIVE_REACTION',
    title: 'ZALO_DM_NATIVE_REACTION',
    description: 'Hiển thị cảm xúc Zalo ở DM dạng native reaction trên tin nhắn?\nChọn Không nếu muốn dùng reply tổng hợp kèm số lượng (❤️ ×3 Tên).',
    kind: 'bool',
    current: currentBool('ZALO_DM_NATIVE_REACTION', '1'),
  },
  {
    key: 'ZALO_EXCLUDE_THREADS',
    title: 'ZALO_EXCLUDE_THREADS',
    description: 'Các thread Zalo KHÔNG mirror (ngăn cách bằng dấu phẩy): "type:id", type 0=DM, 1=nhóm.\nVí dụ: 0:123456789,1:987654321 — để trống nếu không cần.',
    kind: 'text',
    current: (env) => env.ZALO_EXCLUDE_THREADS?.trim() || '(trống)',
  },
  {
    key: 'MAGIKA_BLOCK_DISGUISED',
    title: 'MAGIKA_BLOCK_DISGUISED',
    description: 'Bật kiểm tra AI Magika để tự động chặn tệp tin giả mạo (disguised payload) 2 chiều Zalo ↔ Telegram?',
    kind: 'bool',
    current: currentBool('MAGIKA_BLOCK_DISGUISED', '1'),
  },
  {
    key: 'MAGIKA_CONFIDENCE_THRESHOLD',
    title: 'MAGIKA_CONFIDENCE_THRESHOLD',
    description: 'Ngưỡng tin cậy tối thiểu của Magika để phát hiện tệp giả mạo (từ 0.50 đến 1.00, mặc định 0.80). Nhập giá trị ví dụ 0.80.',
    kind: 'text',
    current: (env) => env.MAGIKA_CONFIDENCE_THRESHOLD?.trim() || '0.80',
    condition: (answers, env) =>
      ((answers.MAGIKA_BLOCK_DISGUISED ?? env.MAGIKA_BLOCK_DISGUISED?.trim()) || '1') === '1',
  },
];

function getSession(userId: number): SetupSession | undefined {
  const session = _sessions.get(userId);
  if (session && session.expiresAt < Date.now()) {
    _sessions.delete(userId);
    return undefined;
  }
  return session;
}

function formatEnvLine(key: string, value: string): string {
  const needsQuote = /[\s#"']/.test(value);
  return `${key}=${needsQuote ? JSON.stringify(value) : value}`;
}

/** Upsert keys into .env preserving comments, order and unrelated lines. */
export function writeEnvUpdates(updates: Record<string, string>, envPath?: string): string[] {
  const resolved = envPath ?? path.join(PROJECT_ROOT, '.env');
  const lines = existsSync(resolved) ? readFileSync(resolved, 'utf8').split('\n') : [];
  const pending = new Map(Object.entries(updates));
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && pending.has(m[1]!)) {
      out.push(formatEnvLine(m[1]!, pending.get(m[1]!)!));
      pending.delete(m[1]!);
    } else {
      out.push(line);
    }
  }
  for (const [key, value] of pending) out.push(formatEnvLine(key, value));
  writeFileSync(resolved, out.join('\n').replace(/\n+$/, '') + '\n', 'utf8');
  return Object.keys(updates);
}

function stepText(session: SetupSession, step: SetupStep): string {
  const total = session.steps.length;
  const value = session.answers[step.key];
  const suffix = value !== undefined ? `\nGiá trị mới: <b>${value}</b>` : '';
  return [
    `⚙️ <b>Cấu hình bridge</b> — bước ${Math.min(session.idx + 1, total)}/${total}`,
    '',
    `<b>${step.title}</b> — ${step.description}`,
    `Giá trị hiện tại: <code>${step.current(process.env)}</code>${suffix}`,
  ].join('\n');
}

function boolKeyboard(session: SetupSession) {
  const extra: Array<{ text: string; callback_data: string }> = [
    { text: '⏭ Bỏ qua', callback_data: 'setup:skip' },
    { text: '❌ Huỷ', callback_data: 'setup:cancel' },
  ];
  if (session.awaitingText) {
    return { inline_keyboard: [extra] };
  }
  return {
    inline_keyboard: [[
      { text: '✅ Có', callback_data: 'setup:bool:1' },
      { text: '❌ Không', callback_data: 'setup:bool:0' },
      ...extra,
    ]],
  };
}

async function renderStep(
  session: SetupSession,
  send: (text: string, opts: object) => Promise<unknown>,
): Promise<void> {
  const step = session.steps[session.idx]!;
  if (step.kind === 'bool') {
    await send(stepText(session, step), {
      parse_mode: 'HTML',
      reply_markup: boolKeyboard(session),
    });
    return;
  }
  await send(
    stepText(session, step) + '\n\n✍️ Gửi giá trị vào khung chat bên dưới (tin nhắn này sẽ không được chuyển sang Zalo).',
    {
      parse_mode: 'HTML',
      reply_markup: boolKeyboard(session),
    },
  );
}

function advance(
  session: SetupSession,
  send: (text: string, opts: object) => Promise<unknown>,
): Promise<void> {
  session.idx++;
  while (session.idx < session.steps.length) {
    const step = session.steps[session.idx]!;
    if (!step.condition || step.condition(session.answers, process.env)) break;
    session.idx++;
  }
  if (session.idx >= session.steps.length) {
    _sessions.delete(session.userId);
    return finish(session, send);
  }
  session.awaitingText = session.steps[session.idx]!.kind === 'text';
  return renderStep(session, send);
}

async function finish(
  session: SetupSession,
  send: (text: string, opts: object) => Promise<unknown>,
): Promise<void> {
  const updated = writeEnvUpdates(session.answers);
  const summary = updated.length > 0
    ? 'Các biến đã cập nhật:\n' + updated.map(k => `• <code>${k} = ${session.answers[k]}</code>`).join('\n')
    : 'Không có biến nào thay đổi.';
  await send(
    `✅ <b>Đã lưu cấu hình mới!</b>\n\n${summary}\n\n⚠️ Cần khởi động lại để áp dụng — gửi <b>/restart</b>.\nDùng Docker? Nhớ cập nhật thêm biến tương ứng trong docker-compose nếu cần.`,
    { parse_mode: 'HTML' },
  );
}

export function startSetupWizard(
  userId: number,
  threadId: number | undefined,
  send: (text: string, opts: object) => Promise<unknown>,
): SetupSession {
  const session: SetupSession = {
    userId,
    threadId,
    steps: SETUP_STEPS,
    idx: 0,
    answers: {},
    awaitingText: SETUP_STEPS[0]!.kind === 'text',
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  _sessions.set(userId, session);
  void renderStep(session, send);
  return session;
}

export async function handleSetupCallback(
  ctx: {
    from: { id: number };
    answerCbQuery: (text?: string, opts?: object) => Promise<unknown>;
  },
  data: string,
  adminCheck: (userId: number) => Promise<boolean>,
  send: (text: string, opts?: object) => Promise<unknown>,
): Promise<boolean> {
  const session = getSession(ctx.from.id);
  if (!session) return false;

  void (async () => {
    if (data === 'setup:cancel') {
      _sessions.delete(session.userId);
      await ctx.answerCbQuery('Đã huỷ.');
      await send('❌ Đã huỷ cấu hình.');
      return;
    }
    if (!(await adminCheck(ctx.from.id))) {
      await ctx.answerCbQuery('⛔ Chỉ admin mới có thể cấu hình.', { show_alert: true });
      return;
    }
    if (data === 'setup:skip') {
      session.awaitingText = false;
      await ctx.answerCbQuery('Bỏ qua');
      await advance(session, send);
      return;
    }
    const boolMatch = data.match(/^setup:bool:([01])$/);
    if (boolMatch) {
      const step = session.steps[session.idx]!;
      session.answers[step.key] = boolMatch[1]!;
      session.awaitingText = false;
      await ctx.answerCbQuery('Đã chọn');
      await advance(session, send);
      return;
    }
    await ctx.answerCbQuery();
  })();

  return true;
}

/** Consume a free-form text answer for the wizard. Returns true if consumed. */
export function consumeSetupTextAndAdvance(
  userId: number,
  text: string,
  send: (text: string, opts?: object) => Promise<unknown>,
): boolean {
  const session = getSession(userId);
  if (!session || !session.awaitingText) return false;
  session.answers[session.steps[session.idx]!.key] = text.trim();
  session.awaitingText = false;
  void advance(session, send);
  return true;
}

export function hasActiveSetup(userId: number): boolean {
  return getSession(userId) !== undefined;
}
