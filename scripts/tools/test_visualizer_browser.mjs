import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';

// Never hardcode the signing secret: pass it in (the same value rs_dashboard/lib/auth.ts signs with).
const secret = process.env.DHAN_COOKIE_SECRET;
if (!secret) {
  console.error('Set DHAN_COOKIE_SECRET to the dashboard cookie signing secret.');
  process.exit(1);
}
let uuid;
try {
  const sessionRaw = JSON.parse(fs.readFileSync('debug/session.json', 'utf8'));
  uuid = Object.keys(sessionRaw.sessions ?? {})[0];
} catch {
  uuid = crypto.randomUUID();
}
const sig = crypto.createHmac('sha256', secret).update(uuid).digest('hex');
const cookieVal = `${uuid}.${sig}`;

console.log('Session cookie minted (value not printed).');

// Launch Chrome Headless
const chrome = spawn('google-chrome', [
  '--headless=new',
  '--remote-debugging-port=9223',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--window-size=1600,1050',
]);

await new Promise(r => setTimeout(r, 1500));

try {
  const newRes = await fetch('http://127.0.0.1:9223/json/new?http://localhost:3000/multi-leg-focus/visualization', { method: 'PUT' });
  const target = await newRes.json();
  const targetWsUrl = target.webSocketDebuggerUrl;

  const ws = new WebSocket(targetWsUrl);

  let id = 1;
  const pending = new Map();

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  const consoleLogs = [];
  const errors = [];

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.method === 'Runtime.consoleAPICalled') {
      const text = data.params.args.map(a => a.value || JSON.stringify(a)).join(' ');
      consoleLogs.push(`[${data.params.type}] ${text}`);
      if (data.params.type === 'error') {
        errors.push(text);
      }
    } else if (data.method === 'Runtime.exceptionThrown') {
      const desc = data.params.exceptionDetails?.exception?.description || data.params.exceptionDetails?.text;
      consoleLogs.push(`[EXCEPTION] ${desc}`);
      errors.push(desc);
    }

    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(data.error);
      else resolve(data.result);
    }
  };

  await new Promise(r => ws.onopen = r);

  await send('Network.enable');
  await send('Page.enable');
  await send('Runtime.enable');

  await send('Network.setCookie', {
    name: 'dhan_session',
    value: cookieVal,
    domain: 'localhost',
    path: '/',
  });

  console.log('Navigating to /multi-leg-focus/visualization...');
  await send('Page.navigate', { url: 'http://localhost:3000/multi-leg-focus/visualization' });
  await new Promise(r => setTimeout(r, 4500));

  fs.mkdirSync('debug/screenshots', { recursive: true });

  // 1. Screenshot of the standalone Visualization Page
  const shot1 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('debug/screenshots/visualizer_page.png', Buffer.from(shot1.data, 'base64'));
  console.log('Saved screenshot: debug/screenshots/visualizer_page.png');

  // 2. Click "Calls (↑) / Puts (↓)" view mode
  console.log('Testing "Calls (↑) / Puts (↓)" toggle...');
  await send('Runtime.evaluate', {
    expression: `
      const btns = Array.from(document.querySelectorAll('button'));
      const callPutBtn = btns.find(b => b.textContent.includes('Calls (↑)'));
      if (callPutBtn) callPutBtn.click();
    `,
  });
  await new Promise(r => setTimeout(r, 1000));
  const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('debug/screenshots/visualizer_call_put_mode.png', Buffer.from(shot2.data, 'base64'));
  console.log('Saved screenshot: debug/screenshots/visualizer_call_put_mode.png');

  // 3. Navigate to /multi-leg-focus and test clicking "Position Map" button
  console.log('Navigating to /multi-leg-focus...');
  await send('Page.navigate', { url: 'http://localhost:3000/multi-leg-focus' });
  await new Promise(r => setTimeout(r, 4500));

  // Find and click the Position Map button
  console.log('Looking for "Position Map" button...');
  const clickResult = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const posMapBtn = btns.find(b => b.textContent.includes('Position Map'));
        if (posMapBtn) {
          posMapBtn.click();
          return { clicked: true, text: posMapBtn.textContent.trim() };
        }
        return { clicked: false, allBtns: btns.map(b => b.textContent.trim().slice(0, 30)).slice(0, 20) };
      })()
    `,
    returnByValue: true,
  });

  console.log('Click result:', clickResult.result?.value);
  await new Promise(r => setTimeout(r, 1500));

  const shot3 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('debug/screenshots/multi_leg_focus_modal.png', Buffer.from(shot3.data, 'base64'));
  console.log('Saved screenshot: debug/screenshots/multi_leg_focus_modal.png');

  console.log('Console errors encountered:', errors.length);
  if (errors.length > 0) {
    console.log('Errors:', errors);
  }

  ws.close();
} catch (err) {
  console.error('Error during test:', err);
} finally {
  chrome.kill();
}
