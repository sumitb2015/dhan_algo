import fs from 'fs';
import path from 'path';

// Read-modify-write of a JSON state file shared by API routes and a server tick loop (they can run as separate module
// instances, so an in-memory mutex is not enough). An O_EXCL `.lock` file serialises writers; a lock older than
// `staleMs` is taken to belong to a dead writer and removed. Writes go to a per-process tmp file then rename, so a
// reader never sees a half-written file. Used by lib/guardServerCore.ts and lib/priceLadderServer.ts.

export async function withFileLock<T>(lockFile: string, staleMs: number, label: string, fn: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + staleMs;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.closeSync(fs.openSync(lockFile, 'wx'));
      break;
    } catch {
      try { if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) fs.unlinkSync(lockFile); } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error(`${label} is locked`);
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try { return await fn(); } finally { try { fs.unlinkSync(lockFile); } catch { /* already gone */ } }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}
