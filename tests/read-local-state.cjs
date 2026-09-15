// Read a copy of Chromium storage; never launch against the user's live profile.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = fs.mkdtempSync(path.join(root, 'cache', 'state-review-'));
const source = path.join(process.env.APPDATA, 'ai-stock-assistant', 'Local Storage');
fs.cpSync(source, path.join(target, 'Local Storage'), { recursive: true });
app.setPath('userData', target);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  win.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    callback({ cancel: request.resourceType !== 'mainFrame' });
  });
  await win.loadFile(path.join(root, 'index.html'));
  const state = await win.webContents.executeJavaScript("JSON.parse(localStorage.getItem('ai-stock-assistant-state-v1') || '{}')");
  fs.writeFileSync(path.join(root, 'cache', 'local-state-review.json'), JSON.stringify(state), 'utf8');
  console.log(JSON.stringify({ labels: (state.labels || []).map(label => ({ name: label.name, count: label.stocks?.length })), positions: state.portfolio?.length, trades: state.simulatedTrades?.length }));
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
