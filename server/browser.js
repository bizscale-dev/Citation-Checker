// Real-Chrome fallback for sites that block plain HTTP requests (bot walls, Cloudflare
// challenges, JavaScript-rendered listings).
//
// One normal (non-headless) Chrome runs with its window parked off-screen, using a
// dedicated profile folder. Headless Chrome is easy for bot walls to spot, and running a
// single real browser means a captcha you solve or a directory you log into via
// openVisible() leaves cookies that the background checks reuse straight away.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

// Kept outside the project: Chrome locks files in its profile, which crashes Vite's file watcher.
const PROFILE_DIR =
  process.env.BROWSER_PROFILE_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'citation-checker', 'browser-profile');

const CANDIDATES = [
  process.env.CHROME_PATH,
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

export const chromePath = CANDIDATES.find((p) => fs.existsSync(p)) || null;

// optional proxy, e.g. PROXY_URL=http://user:pass@us-proxy.example.com:8080
const proxy = process.env.PROXY_URL ? new URL(process.env.PROXY_URL) : null;

const OFFSCREEN = { left: -32000, top: -32000, width: 1366, height: 900 };
const MAX_TABS = 3;

let browserPromise = null;
let active = 0;
const waiters = [];

async function getBrowser() {
  const existing = await browserPromise?.catch(() => null);
  if (existing?.connected) return existing;
  if (!chromePath) throw new Error('Chrome not found. Set CHROME_PATH to your chrome.exe');

  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US',
    `--window-position=${OFFSCREEN.left},${OFFSCREEN.top}`,
    `--window-size=${OFFSCREEN.width},${OFFSCREEN.height}`,
  ];
  if (proxy) args.push(`--proxy-server=${proxy.protocol}//${proxy.host}`);

  browserPromise = puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    userDataDir: PROFILE_DIR,
    defaultViewport: null,
    ignoreHTTPSErrors: true,
    args,
  });
  const b = await browserPromise.catch((e) => {
    browserPromise = null;
    throw e;
  });
  b.on('disconnected', () => {
    browserPromise = null;
  });
  return b;
}

async function preparePage(page, { blockAssets }) {
  // alert()/confirm() popups freeze the tab until answered (findmetop does this on missing listings)
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  if (proxy?.username) await page.authenticate({ username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  if (blockAssets) {
    // we only need the text; skipping images/fonts makes checks much faster
    await page.setRequestInterception(true);
    page.on('request', (req) => (['image', 'media', 'font'].includes(req.resourceType()) ? req.abort() : req.continue()));
  }
}

async function withTab(fn) {
  if (active >= MAX_TABS) await new Promise((r) => waiters.push(r));
  active++;
  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await preparePage(page, { blockAssets: true });
    return await fn(page);
  } finally {
    await page?.close().catch(() => {});
    active--;
    waiters.shift()?.();
  }
}

const CHALLENGE = /just a moment|checking your browser|verify you are human|attention required|cf-chl|challenge-platform|captcha-delivery|ddos-guard|are you a robot|you have been blocked|access denied/i;

const withDeadline = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms))]);

// Load a page like a person would and return its rendered HTML.
export async function browserFetch(url, timeoutMs = 45000) {
  // hard cap so one stuck page can never hold up the whole check
  return withDeadline(loadInTab(url, timeoutMs), timeoutMs + 15000, 'Chrome page load');
}

async function loadInTab(url, timeoutMs) {
  return withTab(async (page) => {
    const started = Date.now();
    let res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch((e) => {
      if (/timeout/i.test(e.message)) return null;
      throw e;
    });
    // give JS-rendered listings and bot challenges a moment to settle
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {});

    // Cloudflare-style interstitials often clear themselves within ~10s in a real browser
    for (let i = 0; i < 5 && Date.now() - started < timeoutMs; i++) {
      const title = await page.title().catch(() => '');
      const head = (await page.content().catch(() => '')).slice(0, 5000);
      if (!CHALLENGE.test(title) && !CHALLENGE.test(head)) break;
      const nav = await page.waitForNavigation({ timeout: 3000 }).catch(() => null);
      if (nav) res = nav;
    }

    const html = await page.content();
    const title = await page.title();
    const status = res?.status() ?? 200;
    const challenged = CHALLENGE.test(title) || CHALLENGE.test(html.slice(0, 5000));
    return { ok: status < 400 && !challenged, status, finalUrl: page.url(), html, challenged, via: 'browser' };
  });
}

// Open the page in its own visible window of the checker's Chrome, so the user can solve
// a captcha or log in. The cookies land in the same browser the background checks use.
export async function openVisible(url) {
  const b = await getBrowser();
  const cdp = await b.target().createCDPSession();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const target = await b.waitForTarget((t) => t._targetId === targetId || t._targetInfo?.targetId === targetId);
  const page = await target.page();
  await preparePage(page, { blockAssets: false });

  const session = await page.createCDPSession();
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await session.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 40, width: 1280, height: 860 } });
  await page.bringToFront();
  page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
}

export const browserInfo = () => ({ available: Boolean(chromePath), chromePath, proxy: proxy ? `${proxy.protocol}//${proxy.host}` : null });
