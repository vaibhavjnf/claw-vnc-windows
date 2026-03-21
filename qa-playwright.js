const fs = require('fs');
const path = require('path');
const { chromium, request } = require('playwright');

const BASE_URL = 'http://localhost:8080/?token=vaibhavclaw';
const API_URL = 'http://localhost:8080/api/windows?token=vaibhavclaw';
const DOCS_DIR = path.join(__dirname, 'docs');

fs.mkdirSync(DOCS_DIR, { recursive: true });

const allResults = [];
const allScreenshots = [];
const allBugs = [];
const timingNotes = [];

function nowIso() {
  return new Date().toISOString();
}

function msSince(start) {
  return Date.now() - start;
}

function addTiming(label, valueMs) {
  timingNotes.push({ label, valueMs });
}

function addBug(testId, message) {
  allBugs.push({ testId, message });
}

function createCase(id, title) {
  return {
    id,
    title,
    status: 'PASS',
    checks: [],
    screenshots: [],
    details: [],
  };
}

function recordCheck(testCase, ok, message, { bugOnFail = true } = {}) {
  testCase.checks.push({ ok, message });
  if (!ok) {
    testCase.status = 'FAIL';
    if (bugOnFail) addBug(testCase.id, message);
  }
}

function addDetail(testCase, message) {
  testCase.details.push(message);
}

async function takeShot(page, testCase, shotName, fullPage = false) {
  const filePath = path.join(DOCS_DIR, `test-${shotName}.png`);
  await page.screenshot({ path: filePath, fullPage });
  const rel = path.relative(__dirname, filePath).replace(/\\/g, '/');
  testCase.screenshots.push(rel);
  allScreenshots.push(rel);
  return rel;
}

async function takeFailureShot(page, testCase, shotName) {
  try {
    await takeShot(page, testCase, `${shotName}-failure`);
  } catch (_) {}
}

function pushCase(testCase) {
  allResults.push(testCase);
}

function textEqualsAny(str, patterns) {
  const value = (str || '').trim();
  return patterns.some((p) => p.test(value));
}

async function getMonitorState(page) {
  return page.evaluate(() => {
    const ids = ['mon-1', 'mon-all', 'mon-2'];
    const activeIds = ids.filter((id) => document.getElementById(id)?.classList.contains('active'));
    const wrap = document.getElementById('vnc-wrap');
    const canvas = document.querySelector('#vnc-wrap canvas');
    return {
      activeIds,
      activeCount: activeIds.length,
      inlineTransform: wrap?.style.transform || '',
      inlineOrigin: wrap?.style.transformOrigin || '',
      computedTransform: wrap ? getComputedStyle(wrap).transform : '',
      canvasPresent: !!canvas,
    };
  });
}

function reportMarkdown() {
  const lines = [];
  const overallPass = allResults.every((r) => r.status === 'PASS');
  lines.push('# Playwright QA Report: claw-vnc portal');
  lines.push('');
  lines.push(`- Run Timestamp: ${nowIso()}`);
  lines.push(`- Target: ${BASE_URL}`);
  lines.push(`- Overall: ${overallPass ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('## Test Cases');
  lines.push('');

  for (const result of allResults) {
    lines.push(`### ${result.id}. ${result.title} — ${result.status}`);
    for (const check of result.checks) {
      lines.push(`- ${check.ok ? 'PASS' : 'FAIL'}: ${check.message}`);
    }
    for (const d of result.details) {
      lines.push(`- Note: ${d}`);
    }
    if (result.screenshots.length) {
      lines.push('- Screenshots:');
      for (const shot of result.screenshots) lines.push(`- ${shot}`);
    }
    lines.push('');
  }

  lines.push('## Bugs Found');
  if (!allBugs.length) {
    lines.push('- None observed during this run.');
  } else {
    for (const bug of allBugs) lines.push(`- [${bug.testId}] ${bug.message}`);
  }
  lines.push('');

  lines.push('## Screenshots Taken');
  if (!allScreenshots.length) {
    lines.push('- None');
  } else {
    for (const shot of allScreenshots) lines.push(`- ${shot}`);
  }
  lines.push('');

  lines.push('## Timing Observations');
  if (!timingNotes.length) {
    lines.push('- No timing metrics recorded.');
  } else {
    for (const t of timingNotes) lines.push(`- ${t.label}: ${t.valueMs} ms`);
  }
  lines.push('');

  return lines.join('\n');
}

async function main() {
  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await page.addInitScript(() => {
      window.__qa = {
        winStreamConnections: 0,
        winBinaryFrames: 0,
        winTextFrames: 0,
        winClosed: 0,
        lastFrameAt: null,
      };
      const NativeWS = window.WebSocket;
      window.WebSocket = new Proxy(NativeWS, {
        construct(target, args) {
          const ws = Reflect.construct(target, args);
          try {
            const url = String(args[0] || '');
            if (url.includes('/window-stream')) {
              window.__qa.winStreamConnections += 1;
              ws.addEventListener('message', (event) => {
                if (typeof event.data === 'string') window.__qa.winTextFrames += 1;
                else window.__qa.winBinaryFrames += 1;
                window.__qa.lastFrameAt = Date.now();
              });
              ws.addEventListener('close', () => {
                window.__qa.winClosed += 1;
              });
            }
          } catch (_) {}
          return ws;
        },
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const test1 = createCase('1', 'D1 / All / D2 monitor selector');
    try {
      await page.locator('.tab', { hasText: 'Desktop' }).click();
      await page.waitForFunction(() => document.querySelector('.tab.active')?.textContent?.trim() === 'Desktop');

      let vncCanvasLoaded = true;
      try {
        await page.waitForFunction(() => !!document.querySelector('#vnc-wrap canvas'), { timeout: 8000 });
      } catch (_) {
        vncCanvasLoaded = false;
      }
      recordCheck(test1, vncCanvasLoaded, 'VNC canvas element appears in Desktop panel');

      const states = [];
      const monitorFlow = [
        { id: 'mon-1', label: 'D1', shot: 'monitor-d1', expectedOrigin: '75% 50%', expectedScale: true },
        { id: 'mon-all', label: 'All', shot: 'monitor-all', expectedOrigin: '', expectedScale: false },
        { id: 'mon-2', label: 'D2', shot: 'monitor-d2', expectedOrigin: '25% 50%', expectedScale: true },
      ];

      for (const step of monitorFlow) {
        await page.click(`#${step.id}`);
        await page.waitForFunction((id) => document.getElementById(id)?.classList.contains('active'), step.id);
        const st = await getMonitorState(page);
        states.push({ step, st });

        recordCheck(test1, st.activeIds.includes(step.id), `${step.label} button gets active class`);
        recordCheck(test1, st.activeCount === 1, `${step.label} click leaves exactly one monitor button active`);
        if (step.expectedScale) {
          recordCheck(test1, st.inlineTransform.includes('scale(2)'), `${step.label} applies zoom transform on VNC viewport`);
        } else {
          recordCheck(test1, st.inlineTransform === '', `${step.label} clears monitor zoom transform`);
        }
        if (step.expectedOrigin) {
          recordCheck(test1, st.inlineOrigin === step.expectedOrigin, `${step.label} sets expected transform origin (${step.expectedOrigin})`);
        } else {
          recordCheck(test1, st.inlineOrigin === '', `${step.label} clears transform origin`);
        }
        await takeShot(page, test1, step.shot);
      }

      for (let i = 1; i < states.length; i += 1) {
        const prev = states[i - 1].st;
        const curr = states[i].st;
        const changed = prev.inlineTransform !== curr.inlineTransform || prev.inlineOrigin !== curr.inlineOrigin;
        recordCheck(test1, changed, `${states[i - 1].step.label} -> ${states[i].step.label} changes viewport transform state`);
      }
    } catch (err) {
      recordCheck(test1, false, `Unexpected error in monitor selector test: ${err.message}`);
      await takeFailureShot(page, test1, 'monitor');
    }
    pushCase(test1);

    const test2 = createCase('2', 'Win tab — window listing');
    try {
      await page.click('.tab:has-text("Win")');
      await page.waitForFunction(() => document.querySelector('.tab.active')?.textContent?.trim() === 'Win');

      const autoLoadStart = Date.now();
      let loadedIn3s = true;
      try {
        await page.waitForFunction(() => document.querySelectorAll('#win-list button').length > 0, { timeout: 3000 });
      } catch (_) {
        loadedIn3s = false;
      }
      const autoLoadMs = msSince(autoLoadStart);
      addTiming('Win list auto-load latency', autoLoadMs);
      recordCheck(test2, loadedIn3s, 'Window list auto-loads with at least one button within 3s');

      const statusBeforeRefresh = (await page.textContent('#win-status'))?.trim() || '';
      addDetail(test2, `Status before refresh: "${statusBeforeRefresh}"`);

      let refreshResponseStatus = null;
      let refreshObserved = false;
      const refreshStart = Date.now();
      try {
        const [resp] = await Promise.all([
          page.waitForResponse((r) => r.url().includes('/api/windows') && r.request().method() === 'GET', { timeout: 5000 }),
          page.click('#win-refresh'),
        ]);
        refreshObserved = true;
        refreshResponseStatus = resp.status();
      } catch (_) {}
      const refreshMs = msSince(refreshStart);
      addTiming('Win list refresh latency', refreshMs);

      recordCheck(test2, refreshObserved, 'Refresh button triggers /api/windows request');
      recordCheck(test2, refreshResponseStatus === 200, 'Refresh request returns HTTP 200');

      const listCount = await page.locator('#win-list button').count();
      recordCheck(test2, listCount > 0, 'Window list contains at least one selectable window after refresh');
      addDetail(test2, `Window count after refresh: ${listCount}`);
      await takeShot(page, test2, 'win-list');
    } catch (err) {
      recordCheck(test2, false, `Unexpected error in window listing test: ${err.message}`);
      await takeFailureShot(page, test2, 'win-listing');
    }
    pushCase(test2);

    const test3 = createCase('3', 'Win tab — live window streaming');
    try {
      const windowCount = await page.locator('#win-list button').count();
      recordCheck(test3, windowCount > 0, 'At least one window exists to start live stream');

      if (windowCount > 0) {
        const pickedTitle = ((await page.locator('#win-list button').first().textContent()) || '').trim();
        addDetail(test3, `Selected window: "${pickedTitle}"`);

        const frameCountBefore = await page.evaluate(() => window.__qa?.winBinaryFrames || 0);
        const streamStart = Date.now();

        await page.locator('#win-list button').first().click();

        let framesArrivedIn5s = true;
        try {
          await page.waitForFunction((before) => (window.__qa?.winBinaryFrames || 0) > before, frameCountBefore, { timeout: 5000 });
        } catch (_) {
          framesArrivedIn5s = false;
        }
        const frameLatencyMs = msSince(streamStart);
        addTiming('First live JPEG frame latency', frameLatencyMs);
        recordCheck(test3, framesArrivedIn5s, 'JPEG frames arrive on window-stream within 5s');

        const canvasMetrics = await page.evaluate(() => {
          const c = document.getElementById('win-canvas');
          return c ? { width: c.width, height: c.height } : { width: 0, height: 0 };
        });
        recordCheck(test3, canvasMetrics.width > 0 && canvasMetrics.height > 0, 'Streaming canvas has non-zero width/height');
        addDetail(test3, `Canvas size while streaming: ${canvasMetrics.width}x${canvasMetrics.height}`);

        const status = (await page.textContent('#win-status'))?.trim() || '';
        recordCheck(test3, status === 'Streaming...', `Status text is "Streaming..." (actual: "${status}")`);

        const frameCountAfter = await page.evaluate(() => window.__qa?.winBinaryFrames || 0);
        addDetail(test3, `Window-stream binary frames observed: ${frameCountAfter}`);

        await takeShot(page, test3, 'win-streaming-canvas');
      } else {
        await takeFailureShot(page, test3, 'win-streaming-no-window');
      }
    } catch (err) {
      recordCheck(test3, false, `Unexpected error in live streaming test: ${err.message}`);
      await takeFailureShot(page, test3, 'win-streaming');
    }
    pushCase(test3);

    const test4 = createCase('4', 'Win tab — WebSocket cleanup');
    try {
      const closedBefore = await page.evaluate(() => window.__qa?.winClosed || 0);

      await page.click('.tab:has-text("Desktop")');
      await page.waitForFunction(() => document.querySelector('.tab.active')?.textContent?.trim() === 'Desktop');
      await page.waitForTimeout(500);

      const statusAfterSwitch = (await page.textContent('#win-status'))?.trim() || '';
      const resetLike = textEqualsAny(statusAfterSwitch, [
        /select a window/i,
        /disconnected/i,
        /loading/i,
        /windows found/i,
        /no windows found/i,
      ]);
      recordCheck(test4, resetLike, `Status resets from streaming after leaving Win tab (actual: "${statusAfterSwitch}")`);

      const closedAfter = await page.evaluate(() => window.__qa?.winClosed || 0);
      recordCheck(test4, closedAfter > closedBefore, 'Window stream WebSocket is closed when switching away from Win tab');
      await takeShot(page, test4, 'win-cleanup-desktop');

      let reloadObserved = false;
      let reloadStatus = null;
      const reloadStart = Date.now();
      try {
        const [resp] = await Promise.all([
          page.waitForResponse((r) => r.url().includes('/api/windows') && r.request().method() === 'GET', { timeout: 5000 }),
          page.click('.tab:has-text("Win")'),
        ]);
        reloadObserved = true;
        reloadStatus = resp.status();
      } catch (_) {}
      const reloadMs = msSince(reloadStart);
      addTiming('Win list reload after tab return', reloadMs);
      recordCheck(test4, reloadObserved, 'Returning to Win tab triggers /api/windows reload');
      recordCheck(test4, reloadStatus === 200, 'Reload request after returning to Win tab returns HTTP 200');

      let reloadedButtons = true;
      try {
        await page.waitForFunction(() => document.querySelectorAll('#win-list button').length > 0, { timeout: 3000 });
      } catch (_) {
        reloadedButtons = false;
      }
      recordCheck(test4, reloadedButtons, 'Window buttons appear again after returning to Win tab');
      await takeShot(page, test4, 'win-cleanup-reload');
    } catch (err) {
      recordCheck(test4, false, `Unexpected error in WebSocket cleanup test: ${err.message}`);
      await takeFailureShot(page, test4, 'win-cleanup');
    }
    pushCase(test4);

    const test5 = createCase('5', 'Tab navigation');
    try {
      const cycle = [
        { tab: 'Desktop', panelId: 'panel-vnc', shot: 'tabs-desktop' },
        { tab: 'Terminal', panelId: 'panel-term', shot: 'tabs-terminal' },
        { tab: 'Files', panelId: 'panel-files', shot: 'tabs-files' },
        { tab: 'Win', panelId: 'panel-windows', shot: 'tabs-win' },
        { tab: 'Desktop', panelId: 'panel-vnc', shot: 'tabs-desktop-final' },
      ];

      for (const step of cycle) {
        await page.click(`.tab:has-text("${step.tab}")`);
        await page.waitForTimeout(250);
        const ok = await page.evaluate(({ tab, panelId }) => {
          const tabEl = [...document.querySelectorAll('.tab')].find((t) => t.textContent.trim() === tab);
          const panel = document.getElementById(panelId);
          return !!tabEl && !!panel && tabEl.classList.contains('active') && panel.classList.contains('active');
        }, step);
        recordCheck(test5, ok, `${step.tab} tab activates ${step.panelId} panel and keeps active tab class`);
        await takeShot(page, test5, step.shot);
      }
    } catch (err) {
      recordCheck(test5, false, `Unexpected error in tab navigation test: ${err.message}`);
      await takeFailureShot(page, test5, 'tabs');
    }
    pushCase(test5);

    const test6 = createCase('6', 'API smoke test');
    try {
      const apiCtx = await request.newContext();
      const apiStart = Date.now();
      const response = await apiCtx.get(API_URL, { timeout: 10000 });
      const apiMs = msSince(apiStart);
      addTiming('API smoke GET /api/windows latency', apiMs);

      recordCheck(test6, response.status() === 200, `API responds with HTTP 200 (actual: ${response.status()})`);

      let body;
      let jsonOk = true;
      try {
        body = await response.json();
      } catch (_) {
        jsonOk = false;
      }
      recordCheck(test6, jsonOk, 'API response parses as JSON');
      recordCheck(test6, Array.isArray(body), 'API response is a JSON array');

      if (Array.isArray(body)) {
        const allHaveFields = body.every(
          (item) =>
            item &&
            typeof item === 'object' &&
            Object.prototype.hasOwnProperty.call(item, 'id') &&
            Object.prototype.hasOwnProperty.call(item, 'title') &&
            Object.prototype.hasOwnProperty.call(item, 'appName')
        );
        recordCheck(test6, allHaveFields, 'Each array item has id, title, appName fields');
        addDetail(test6, `API returned ${body.length} windows`);
      }

      await apiCtx.dispose();
    } catch (err) {
      recordCheck(test6, false, `Unexpected error in API smoke test: ${err.message}`);
      if (page) await takeFailureShot(page, test6, 'api-smoke');
    }
    pushCase(test6);
  } catch (fatal) {
    const fatalCase = createCase('FATAL', 'Test harness setup');
    recordCheck(fatalCase, false, `Harness failed before completion: ${fatal.message}`);
    pushCase(fatalCase);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  const report = reportMarkdown();
  console.log(report);

  const anyFail = allResults.some((r) => r.status === 'FAIL');
  process.exitCode = anyFail ? 1 : 0;
}

main();
