import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';

/** Synthetic snapshots on real Canvas 2D/WebGL2. This does not replace native guest-sidebar acceptance. */
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  ...(process.env.RA2_BROWSER_EXECUTABLE ? { executablePath: process.env.RA2_BROWSER_EXECUTABLE } : {}),
});
const evidence = process.env.HD_UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
try {
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1000, height: 800 },
    deviceScaleFactor: 2,
  });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  const pictures = (await page.evaluate(`(() => {
    const png = (width, height, color, title) => {
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      const ctx = c.getContext('2d');
      if (width===336) {
        for (let tab=0;tab<4;tab++) for (let state=0;state<3;state++) {
          ctx.fillStyle=['#3355aa','#33cc66','#aa3344'][state]; ctx.fillRect(state*112,tab*100,112,100);
        }
        return c.toDataURL('image/png').split(',')[1];
      }
      if (width===16) { ctx.fillStyle='#f544ff'; ctx.fillRect(0,0,width,height); return c.toDataURL('image/png').split(',')[1]; }
      const g = ctx.createLinearGradient(0,0,width,height);
      g.addColorStop(0,color); g.addColorStop(1,'#0d1016'); ctx.fillStyle=g; ctx.fillRect(0,0,width,height);
      ctx.strokeStyle='#d4a548'; ctx.strokeRect(2,2,width-4,height-4);
      ctx.fillStyle='#dae1eb'; ctx.font='bold 12px sans-serif'; ctx.fillText(title,8,18);
      if (width===120) { ctx.fillStyle='#4a9dff'; ctx.fillRect(30,30,60,30); ctx.fillStyle='#eee'; ctx.fillRect(50,20,10,15); }
      return c.toDataURL('image/png').split(',')[1];
    };
    return { cameo: png(120,96,'#345677','Synthetic'), sidebar: png(168,600,'#262c38','SOVIET'), bar: png(632,32,'#333945','COMMAND'), cursor: png(16,16,'#f544ff',''), tabs: png(336,400,'','') };
  })()`)) as { cameo: string; sidebar: string; bar: string; cursor: string; tabs: string };
  const requests: string[] = [];
  let chromeOn = false;
  await page.route('**/hd-cache/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path.endsWith('/cursor/cursor.json'))
      return route.fulfill({ json: { version: 1, frames: [{ x: 0, y: 0, width: 16, height: 16 }] } });
    if (path.endsWith('/cameos/index.json'))
      return route.fulfill({
        json: {
          version: 1,
          byId: {},
          images: { powricon: { hd: 'cameo.png' }, giicon: { hd: 'cameo.png' }, tnkicon: { hd: 'cameo.png' } },
        },
      });
    if (chromeOn && path.endsWith('/chrome/1/chrome.json'))
      return route.fulfill({
        json: {
          frame: { width: 800, height: 600 },
          pieces: [
            { file: 'sidebar.png', rect: { x: 0, y: 0, width: 168, height: 600 }, anchor: 'sidebar' },
            { file: 'bar.png', rect: { x: 0, y: 0, width: 632, height: 32 }, anchor: 'commandBar' },
          ],
          tabs: {
            file: 'tabs.png',
            scale: 4,
            frames: Array.from({ length: 4 }, (_, tab) =>
              ['normal', 'active', 'pressed'].map((state, column) => ({
                tab,
                state,
                rect: { x: column * 112, y: tab * 100, width: 112, height: 100 },
              })),
            ).flat(),
          },
        },
      });
    const key = path.endsWith('/tabs.png')
      ? 'tabs'
      : path.endsWith('/cursor.png')
        ? 'cursor'
        : path.endsWith('/cameo.png')
          ? 'cameo'
          : path.endsWith('/sidebar.png')
            ? 'sidebar'
            : path.endsWith('/bar.png')
              ? 'bar'
              : null;
    if (key) return route.fulfill({ body: Buffer.from(pictures[key], 'base64'), contentType: 'image/png' });
    return route.fulfill({ status: 404, body: 'Optional cache absent' });
  });
  const initialize = `(async () => {
    const { createVmFrameRenderer } = await import('/src/ui/pages/game/vmFrameRenderer.ts');
    const { startHdBridge } = await import('/src/ui/pages/game/hdBridge.ts');
    const { hdSidebar } = await import('/tests/helpers/hdSidebar.ts');
    document.body.innerHTML = '<div id="stage" style="position:relative;width:800px;height:600px;margin:32px;background:#080b10"><canvas id="screen" width="800" height="600" style="width:800px;height:600px"></canvas></div><button id="ui-toggle">UI A/B</button><button id="all-toggle">Full A/B</button><p id="result">Synthetic snapshot / real canvas</p>';
    document.body.style.background='#14181f'; document.body.style.color='#f4f1e8';
    const screen = document.getElementById('screen');
    const renderer = createVmFrameRenderer(screen,true,false,null,false,false,'gan',true);
    if (renderer.backend !== 'WebGL2') throw new Error('WebGL2 required');
    const gl = screen.getContext('webgl2');
    const rgba = new Uint8Array(800*600*4);
    for (let y=0;y<600;y++) for (let x=0;x<800;x++) {
      const radar=x>=644&&x<788&&y>=20&&y<150;
      rgba.set(radar ? [20,95,90,255] : x>=632 ? [100,24,20,255] : y>=568 ? [25,35,75,255] : [20,28,40,255], (y*800+x)*4);
    }
    const frame={width:800,height:600,pixels:new Uint8Array(0),palette:new Uint8Array(0),rgba,
      cursor:{handle:1,x:690,y:250,hotspotX:0,hotspotY:0,width:6,height:6,rgba:new Uint8Array(6*6*4).fill(255)}};
    const sidebar=hdSidebar();
    sidebar.pointer={x:660,y:400,frame:0,hotspot:{x:2,y:3}};
    sidebar.tooltip={rect:{x:590,y:300,width:100,height:40},text:'Native tooltip\\n$600'};
    for (let y=397;y<413;y++) for (let x=658;x<674;x++) rgba.set([245,68,255,255],(y*800+x)*4);
    const state={frame:1,map:{fileName:null},view:null,houses:[],objects:[],sidebar};
    let polls=0, clicks=0, stopped=false, request;
    const draw=()=>renderer.draw(frame,800,600);
    const stop=startHdBridge({screen,frameRenderer:renderer,invalidate:draw,frameSize:()=>({width:800,height:600}),
      vm:{getRenderState:async()=>{polls++;return state},setTacticalPassthrough:async()=>true}});
    // Synthetic selection only: verify real pointer passthrough and resulting canvas state without guest memory.
    screen.addEventListener('click',(event)=>{
      const bounds=screen.getBoundingClientRect(), x=event.clientX-bounds.left, y=event.clientY-bounds.top;
      const tab=sidebar.layout.tabs.findIndex(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height);
      if(tab>=0&&sidebar.tabs[tab].count>0) sidebar.activeTab=tab;
      clicks++;document.getElementById('result').textContent='Input reached #screen: '+clicks
    });
    document.getElementById('ui-toggle').onclick=()=>window.__hdBridge.ui.toggle();
    document.getElementById('all-toggle').onclick=()=>window.__hdBridge.toggle();
    const tick=()=>{if(stopped)return;draw();request=requestAnimationFrame(tick)};tick();
    window.__uiAcceptance={
      pixel(x,y){draw();const p=new Uint8Array(4);gl.readPixels(x,599-y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return Array.from(p)},
      uiPixel(x,y){const c=document.getElementById('hd-ui');return Array.from(c.getContext('2d').getImageData(Math.floor(x*c.width/800),Math.floor(y*c.height/600),1,1).data)},
      tooltip(on){sidebar.tooltip=on?{rect:{x:590,y:300,width:100,height:40},text:'Native tooltip\\n$600'}:null},
      info(){return {polls,clicks,canvas:!!document.getElementById('hd-ui'),enabled:window.__hdBridge.ui.enabled,
        width:document.getElementById('hd-ui')?.width,height:document.getElementById('hd-ui')?.height}},
      mode(mode){renderer.setUpscaleMode(mode)},
      keyed(){renderer.setTransparentKey({rect:{x:0,y:0,width:632,height:568},rgb565:0xf81f});rgba.set([255,0,255,255],0);frame.rgba=rgba.slice()},
      stop(){stopped=true;cancelAnimationFrame(request);stop();renderer.destroy()},
    };
  })()`;
  const results: unknown[] = [];
  for (const chrome of [false, true]) {
    chromeOn = chrome;
    await page.goto((process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/') + '?hd=1&hd-ui=1');
    await page.evaluate(initialize);
    await page.waitForFunction('window.__uiAcceptance?.info().polls >= 5');
    await page.waitForTimeout(100);
    const pixels =
      (await page.evaluate(`(() => ({strip:__uiAcceptance.pixel(670,400),radar:__uiAcceptance.pixel(660,40),
      cursor:__uiAcceptance.pixel(690,250),command:__uiAcceptance.pixel(10,580), info:__uiAcceptance.info()}))()`)) as {
        strip: number[];
        radar: number[];
        cursor: number[];
        command: number[];
        info: { width: number; height: number };
      };
    assert.equal(pixels.strip[3], 0);
    assert.deepEqual(pixels.radar, [20, 95, 90, 255]);
    assert.deepEqual(pixels.cursor, [255, 255, 255, 255]);
    assert.equal(pixels.command[3], chrome ? 0 : 255);
    assert.equal(pixels.info.width, 1600);
    assert.equal(pixels.info.height, 1200);
    assert.deepEqual(await page.evaluate('__uiAcceptance.pixel(660,400)'), [245, 68, 255, 255]);
    assert.equal(await page.evaluate('__uiAcceptance.uiPixel(660,400)[3]'), chrome ? 255 : 0);
    assert.deepEqual(await page.evaluate('__uiAcceptance.uiPixel(666,400)'), [245, 68, 255, 255]);
    assert.equal(await page.evaluate('__uiAcceptance.pixel(600,310)[3]'), 0);
    assert.equal(await page.evaluate('__uiAcceptance.uiPixel(600,310)[3]'), 255);
    assert.equal(await page.evaluate('window.__hdBridge.ui.state.tooltip.text'), 'Native tooltip\n$600');
    await page.evaluate('__uiAcceptance.tooltip(false)');
    await page.waitForFunction('__uiAcceptance.pixel(600,310)[3]===255');
    await page.evaluate('__uiAcceptance.tooltip(true)');
    await page.waitForFunction('__uiAcceptance.pixel(600,310)[3]===0');
    if (evidence) await page.screenshot({ path: `${evidence}/${chrome ? 'chrome' : 'fallback'}.png` });
    await page.locator('#screen').click({ position: { x: 670, y: 400 } });
    assert.match(await page.locator('#result').innerText(), /Input reached #screen: 1/);
    if (chrome) {
      await page.waitForFunction('__uiAcceptance.uiPixel(760,210).slice(0,3).join(",")==="51,85,170"');
      await page.locator('#screen').click({ position: { x: 760, y: 210 } });
      await page.waitForFunction('__uiAcceptance.uiPixel(760,210).slice(0,3).join(",")==="51,204,102"');
      await page.locator('#screen').click({ position: { x: 730, y: 210 } });
      assert.equal(await page.evaluate('window.__hdBridge.ui.state.activeTab'), 3);
      assert.deepEqual(await page.evaluate('__uiAcceptance.uiPixel(760,210).slice(0,3)'), [51, 204, 102]);
      assert.notDeepEqual(await page.evaluate('__uiAcceptance.uiPixel(730,210).slice(0,3)'), [51, 85, 170]);
      if (evidence) await page.screenshot({ path: `${evidence}/tabs-selected-disabled.png` });
    }
    await page.locator('#ui-toggle').click();
    await page.waitForFunction('document.getElementById("hd-ui").style.display === "none"');
    assert.equal(await page.evaluate('__uiAcceptance.pixel(670,400)[3]'), 255);
    await page.locator('#ui-toggle').click();
    await page.waitForFunction('document.getElementById("hd-ui").style.display === "block"');
    await page.locator('#all-toggle').click();
    await page.waitForFunction('document.getElementById("hd-ui").style.display === "none"');
    await page.locator('#all-toggle').click();
    await page.waitForFunction('document.getElementById("hd-ui").style.display === "block"');
    await page.evaluate('__uiAcceptance.mode("bicubic")');
    assert.equal(await page.evaluate('__uiAcceptance.pixel(670,400)[3]'), 0);
    await page.evaluate('__uiAcceptance.keyed()');
    assert.equal(await page.evaluate('__uiAcceptance.pixel(0,0)[3]'), 0);
    assert.equal(await page.evaluate('__uiAcceptance.pixel(670,400)[3]'), 0);
    assert.deepEqual(await page.evaluate('__uiAcceptance.pixel(690,250)'), [255, 255, 255, 255]);
    await page.evaluate('__uiAcceptance.stop()');
    assert.equal(await page.locator('#hd-ui').count(), 0);
    assert.equal(await page.locator('#hd-screen').count(), 0);
    results.push({
      chrome,
      pixels,
      input: 'screen',
      switches: 'UI and full A/B',
      pipelines: 'plain, bicubic, keyed',
      cleanup: true,
      softwareCursor: 'atlas clipped at covered boundary',
      tooltip: 'native rect shown/hidden',
      tabs: chrome ? 'normal/active art after screen click; disabled sibling retains selection' : 'procedural fallback',
    });
  }
  assert.equal(requests.filter((path) => path.endsWith('/chrome/1/chrome.json')).length, 2);
  if (evidence) writeFileSync(`${evidence}/results.json`, JSON.stringify({ results, requests }, null, 2));
  console.log(JSON.stringify({ results, requests }));
} finally {
  await browser.close();
}
