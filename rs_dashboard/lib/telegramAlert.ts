import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

interface Creds { botToken: string; chatId: string; fileMtimeMs: number }
let credsCache: Creds | null = null;

/**
 * Cached like lib/dhanToken.ts's getDhanCredentials() — invalidated on the
 * .env file's mtime changing, not just held forever. The documented setup
 * flow is "add these two keys to .env" while the dashboard may already be
 * running; without mtime invalidation, the first no-op lookup before the
 * keys exist would cache empty credentials for the life of the process.
 */
function readCreds(): Creds {
  let fileMtimeMs = 0;
  try { fileMtimeMs = fs.statSync(ENV_FILE).mtimeMs; } catch { /* .env missing */ }

  if (credsCache && credsCache.fileMtimeMs === fileMtimeMs) return credsCache;

  let botToken = '';
  let chatId = '';
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    const tokenMatch = content.match(/^TELEGRAM_BOT_TOKEN\s*=\s*["']?([^"'\r\n]+)["']?/m);
    const chatMatch = content.match(/^TELEGRAM_CHAT_ID\s*=\s*["']?([^"'\r\n]+)["']?/m);
    botToken = tokenMatch?.[1]?.trim() ?? '';
    chatId = chatMatch?.[1]?.trim() ?? '';
  } catch { /* .env missing — treat as unconfigured */ }
  credsCache = { botToken, chatId, fileMtimeMs };
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
