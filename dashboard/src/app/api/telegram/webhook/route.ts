import { NextResponse } from 'next/server';
import { tg, tgSend, btn, tgConfigured, adminChatIds, isAdmin } from '../../../lib/telegram';
import {
  approveTelegramUser, regenerateCodeForUser, recordAccessRequest, isActiveTelegramUser, clearAccessRequest,
} from '../../../lib/auth';

// The owner's public Telegram for direct questions (shown to users).
const OWNER_CONTACT = '@uniway_admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/telegram/webhook  — Telegram calls this. Set the webhook once with:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain>/api/telegram/webhook&secret_token=<SECRET>
// and set TELEGRAM_WEBHOOK_SECRET to the same <SECRET>.
export async function POST(request: Request) {
  if (!tgConfigured()) return NextResponse.json({ ok: true }); // bot disabled

  // Verify the request really came from Telegram.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: TgUpdate = {};
  try { update = await request.json(); } catch { /* ignore */ }

  try {
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
  } catch (e) {
    console.error('telegram webhook error:', e);
  }
  // Always 200 so Telegram doesn't retry-storm.
  return NextResponse.json({ ok: true });
}

const REQUEST_KB = { inline_keyboard: [[btn('🔑 Request access', 'req')]] };

async function sendWelcome(chatId: number) {
  await tgSend(chatId,
    '👋 <b>Welcome to CIMEA Helper Pro</b>\n\n' +
    'This helps you reach the CIMEA DiploMe payment page when request slots open.\n\n' +
    'Access is <b>free</b>, but granted individually — the owner reviews each request personally to make sure it goes to people who genuinely need their credentials verified.\n\n' +
    '<b>To get access:</b> tap <b>Request access</b> below, then reply with one message telling me why you need it (your situation / deadline). If approved, I’ll send you a one-time code for the extension.\n\n' +
    `💬 Questions? Message the owner: ${OWNER_CONTACT}`,
    { reply_markup: REQUEST_KB },
  );
}

async function onMessage(m: TgMessage) {
  const chatId = m.chat?.id;
  const fromId = m.from?.id;
  if (!chatId) return;
  const text = (m.text || '').trim();
  const uname = m.from?.username || m.from?.first_name || '';

  // Commands / greetings -> welcome.
  if (text === '' || /^\/?(start|help|menu)\b/i.test(text)) {
    await sendWelcome(chatId);
    return;
  }

  // Already have access -> point them at Request access for a fresh code.
  if (fromId && await isActiveTelegramUser(fromId)) {
    await tgSend(chatId, '✅ You already have access. Tap <b>Request access</b> if you need a fresh code.', { reply_markup: REQUEST_KB });
    return;
  }

  // Otherwise treat the message as the "why I need it" reason and pass it on.
  if (!fromId) return;
  if (text.length < 3) {
    await tgSend(chatId, 'Please tell me in one message <b>why you need CIMEA access</b> (your situation), and I’ll pass it to the owner.', { reply_markup: REQUEST_KB });
    return;
  }
  await recordAccessRequest(fromId, uname, text);
  await tgSend(chatId, '🙏 Thanks — your request was sent to the owner for review. You’ll get your code here if it’s approved.');
  await notifyAdmins(fromId, uname, text);
}

// Send the Approve/Deny prompt (with the person's reason) to every owner.
async function notifyAdmins(fromId: number, uname: string, reason: string) {
  const label = uname ? '@' + uname : '(no username)';
  const body =
    '🔔 <b>Access request</b>\n' +
    `From: <b>${escapeHtml(label)}</b> (id <code>${fromId}</code>)\n\n` +
    `<b>Reason:</b> ${escapeHtml(reason.slice(0, 600))}`;
  const kb = { inline_keyboard: [[
    btn('✅ Approve', `a:${fromId}:${(uname || '').slice(0, 20)}`),
    btn('❌ Deny', `d:${fromId}`),
  ]] };
  for (const admin of adminChatIds()) {
    await tgSend(admin, body, { reply_markup: kb });
  }
}

async function onCallback(cb: TgCallback) {
  const data = cb.data || '';
  const fromId = cb.from?.id;
  const msg = cb.message;

  // "Request access" button: an existing active user gets a fresh code instantly;
  // a new requester is asked to explain their need (their reply is forwarded).
  if (data === 'req' && fromId) {
    const regen = await regenerateCodeForUser(fromId);
    if (regen) {
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'New access code sent.' });
      await tgSend(fromId,
        `🔑 Your new access code:\n\n<code>${regen}</code>\n\nPaste it in the CIMEA Helper Pro extension and press Activate — it works on your existing device.`
      );
      return;
    }
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Tell me why you need it 🙏' });
    await tgSend(fromId,
      'To request access, reply here with <b>one message</b> explaining why you need CIMEA slot access — your situation (e.g. deadline, why manual booking keeps failing). The owner reviews each request personally.'
    );
    return;
  }

  // Owner-only actions.
  if ((data.startsWith('a:') || data.startsWith('d:'))) {
    if (!isAdmin(fromId)) {
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not authorized.' });
      return;
    }
    const parts = data.split(':');
    const targetId = Number(parts[1]);
    if (!Number.isFinite(targetId)) return;

    if (data.startsWith('a:')) {
      const username = parts[2] || null;
      const res = await approveTelegramUser(targetId, username);
      if ('error' in res) {
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Failed: ' + res.error });
        return;
      }
      await tgSend(targetId,
        `✅ Approved! Your access code:\n\n<code>${res.code}</code>\n\nOpen the CIMEA Helper Pro extension, paste this code, and press Activate. It works on one device — ask the owner to reset it if you switch devices.`
      );
      await editAdmin(msg, `✅ Approved <code>${targetId}</code>. Code delivered.`);
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Approved & code sent.' });
    } else {
      await clearAccessRequest(targetId); // drop it from the pending queue
      await tgSend(targetId, '❌ Your access request was declined.');
      await editAdmin(msg, `❌ Denied <code>${targetId}</code>.`);
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Denied.' });
    }
  }
}

async function editAdmin(msg: TgMessage | undefined, text: string) {
  if (!msg?.chat?.id || !msg.message_id) return;
  await tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text, parse_mode: 'HTML' });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

// ---- minimal Telegram update types ----
interface TgUpdate { message?: TgMessage; callback_query?: TgCallback }
interface TgChat { id: number }
interface TgUser { id: number; username?: string; first_name?: string }
interface TgMessage { chat?: TgChat; message_id?: number; text?: string; from?: TgUser }
interface TgCallback { id: string; data?: string; from?: TgUser; message?: TgMessage }
