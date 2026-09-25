import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';

const secret = 'dhan-dashboard-local-secret-v1';
const uuid = crypto.randomUUID();
const sig = crypto.createHmac('sha256', secret).update(uuid).digest('hex');
const cookieVal = `${uuid}.${sig}`;

// Launch Chrome
const chrome = spawn('google-chrome', [
  '--headless=new',
  '--remote-debugging-port=9222',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--window-size=1600,1050',
]);

await new Promise(r => setTimeout(r, 1500));

try {
  const versionRes = await fetch('http://127.0.0.1:9222/json/version');
  const versionData = await versionRes.json();

  const newRes = await fetch('http://127.0.0.1:9222/json/new?http://localhost:3000/focus-tool', { method: 'PUT' });
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

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
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

  await send('Page.navigate', { url: 'http://localhost:3000/focus-tool' });
  await new Promise(r => setTimeout(r, 4000));

  fs.mkdirSync('debug/screenshots', { recursive: true });

  // 1. Dark Mode screenshot
  const darkShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('debug/screenshots/focus_tool_dark.png', Buffer.from(darkShot.data, 'base64'));
  console.log('Saved dark mode screenshot to debug/screenshots/focus_tool_dark.png');

  // 2. Switch to Light Mode
  await send('Runtime.evaluate', {
    expression: `
      localStorage.setItem('dhan-theme', 'light');
      document.documentElement.classList.remove('dark');
      document.documentElement.setAttribute('data-theme', 'light');
      document.documentElement.style.colorScheme = 'light';
    `,
  });
  await new Promise(r => setTimeout(r, 1000));

  const lightShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('debug/screenshots/focus_tool_light.png', Buffer.from(lightShot.data, 'base64'));
  console.log('Saved light mode screenshot to debug/screenshots/focus_tool_light.png');

  ws.close();
} catch (e) {
  console.error('Error during capture:', e);
} finally {
  chrome.kill();
}
