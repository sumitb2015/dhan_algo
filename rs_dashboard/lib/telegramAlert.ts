import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

interface Creds { botToken: string; chatId: string }
let credsCache: Creds | null = null;

function readCreds(): Creds {
  if (credsCache) return credsCache;
  let botToken = '';
  let chatId = '';
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    const tokenMatch = content.match(/^TELEGRAM_BOT_TOKEN\s*=\s*["']?([^"'\r\n]+)["']?/m);
    const chatMatch = content.match(/^TELEGRAM_CHAT_ID\s*=\s*["']?([^"'\r\n]+)["']?/m);
    botToken = tokenMatch?.[1]?.trim() ?? '';
    chatId = chatMatch?.[1]?.trim() ?? '';
  } catch { /* .env missing — treat as unconfigured */ }
  credsCache = { botToken, chatId };
  return credsCache;
}

/**
 * Fire-and-forget Telegram alert. No-ops when TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID
 * aren't set in the shared root .env. Never throws — callers should not await
 * this if it would delay a response; the promise resolves to false on any failure.
 */
export async function sendTelegramAlert(message: string): Promise<boolean> {
  const { botToken, chatId } = readCreds();
  if (!botToken || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
