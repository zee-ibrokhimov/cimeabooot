import { NextResponse } from 'next/server';
import { tg, tgSend, btn, tgConfigured, adminChatId } from '../../../lib/telegram';
import { approveTelegramUser, regenerateCodeForUser } from '../../../lib/auth';

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

async function onMessage(m: TgMessage) {
  const chatId = m.chat?.id;
  if (!chatId) return;
  const text = (m.text || '').trim();
  if (text.startsWith('/start') || /access|start/i.test(text)) {
    await tgSend(chatId,
      'Welcome to <b>CIMEA Helper Pro</b>.\nTap the button to request an access code. The owner will approve it.',
      { reply_markup: { inline_keyboard: [[btn('🔑 Request access', 'req')]] } }
    );
  } else {
    await tgSend(chatId, 'Tap /start to request access.');
  }
}

async function onCallback(cb: TgCallback) {
  const data = cb.data || '';
  const fromId = cb.from?.id;
  const fromUser = cb.from?.username || cb.from?.first_name || '';
  const msg = cb.message;
  const admin = adminChatId();

  // Requester asks for access -> notify the owner with Approve/Deny.
  if (data === 'req' && fromId) {
    // Already-approved, still-active user re-requesting: auto-issue a fresh
    // OTP-style code bound to their existing device — no new owner approval.
    const regen = await regenerateCodeForUser(fromId);
    if (regen) {
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'New access code sent.' });
      await tgSend(fromId,
        `🔑 Your new access code:\n\n<code>${regen}</code>\n\nPaste it in the CIMEA Helper Pro extension and press Activate — it works on your existing device.`
      );
      return;
    }
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Request sent — awaiting approval.' });
    if (admin) {
      const uname = fromUser ? '@' + fromUser : '(no username)';
      await tgSend(admin,
        `🔔 Access request from <b>${escapeHtml(uname)}</b> (id <code>${fromId}</code>).`,
        { reply_markup: { inline_keyboard: [[
          btn('✅ Approve', `a:${fromId}:${(fromUser || '').slice(0, 20)}`),
          btn('❌ Deny', `d:${fromId}`),
        ]] } }
      );
    }
    return;
  }

  // Owner-only actions.
  if ((data.startsWith('a:') || data.startsWith('d:'))) {
    if (!admin || String(fromId) !== admin) {
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
