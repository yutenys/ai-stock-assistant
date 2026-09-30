const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(root, 'cache', 'worker-ui-')));
app.disableHardwareAcceleration();
app.on('browser-window-created', (_event, win) => { win.show = () => {}; });
require('../main.js');
const timeout = setTimeout(() => { console.error('Worker UI test timed out'); app.exit(1); }, 190000);
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  const resultPromise = win.webContents.executeJavaScript(`(async () => {
    const progress=[];
    const stop=window.stockApi.onMarketProgress(row=>progress.push({stage:row.stage,time:Date.now()}));
    let ticks=0, lastTick=Date.now(), maxTickGapMs=0;
    const timer=setInterval(()=>{ ticks++; maxTickGapMs=Math.max(maxTickGapMs,Date.now()-lastTick); lastTick=Date.now(); },50);
    const started=Date.now();
    const pending=loadMarketOverview(true,true);
    const input=document.getElementById('commandInput');
    input.focus();
    await new Promise(resolve=>setTimeout(resolve,1500));
    const typedDuringRefresh=marketOverviewRefreshing && document.activeElement===input && input.value==='refresh-responsive';
    const market=await pending;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    clearInterval(timer); stop();
    return {typedDuringRefresh,ticks,maxTickGapMs,elapsedMs:Date.now()-started,progress,
      indices:market?.indices?.length,stable:market?.recommendations?.length,momentum:market?.momentumRecommendations?.length,
      currentFunds:market?.recommendationCoverage?.currentFundFlowDirect,errors:market?.errors, warnings:market?.warnings,
      buttonRestored:!document.getElementById('refreshMarketOverview').disabled};
  })()`);
  await new Promise(resolve=>setTimeout(resolve,500));
  await win.webContents.insertText('refresh-responsive');
  const result = await resultPromise;
  assert.equal(result.typedDuringRefresh,true);
  assert.equal(result.buttonRestored,true);
  assert.ok(result.ticks > 5);
  assert.ok(result.progress.some(row=>row.stage==='history'));
  assert.equal(result.indices,3);
  fs.writeFileSync(path.join(root,'cache','worker-ui-result.json'),JSON.stringify(result,null,2));
  const screenshot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(root,'cache','worker-ui.png'),screenshot.toPNG());
  console.log(JSON.stringify(result));
  clearTimeout(timeout);
  win.destroy();
  app.quit();
}).catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1);});
