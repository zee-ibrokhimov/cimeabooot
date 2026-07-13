// =============================================================================
// Telegram Bot API helper. The bot token lives only in TELEGRAM_BOT_TOKEN
// (server env) and never reaches the client.
// =============================================================================
const TG_API = 'https://api.telegram.org';

export function tgConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

export function adminChatId(): string {
  return process.env.TELEGRAM_ADMIN_CHAT_ID || '';
}

// TELEGRAM_ADMIN_CHAT_ID may be a comma-separated list of owner chat ids; all of
// them receive requests and can approve/deny.
export function adminChatIds(): string[] {
  return (process.env.TELEGRAM_ADMIN_CHAT_ID || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

export function isAdmin(id: number | string | undefined | null): boolean {
  if (id == null) return false;
  return adminChatIds().includes(String(id));
}

export async function tg(method: string, params: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN not set' };
  try {
    const res = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, description: e instanceof Error ? e.message : 'network error' };
  }
}

export function tgSend(chatId: number | string, text: string, extra?: Record<string, unknown>) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

// Inline keyboard button helper.
export function btn(text: string, data: string) {
  return { text, callback_data: data };
}
