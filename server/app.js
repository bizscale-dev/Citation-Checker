import express from 'express';
import * as cheerio from 'cheerio';
import { Agent, ProxyAgent, fetch } from 'undici';
import { findPublicListing } from './findPublic.js';

// The hidden-Chrome fallback only exists when running locally; on Vercel there is no Chrome
// (and puppeteer is heavy), so it's loaded on demand and never on Vercel.
let browserMod;
const loadBrowser = async () => {
  if (process.env.VERCEL) return null;
  return (browserMod ??= await import('./browser.js').catch(() => null));
};
const getChromePath = async () => (await loadBrowser())?.chromePath || null;
const browserFetch = async (...args) => (await loadBrowser()).browserFetch(...args);

const app = express();
app.use(express.json({ limit: '25mb' }));

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// many small directory sites have expired or self-signed certificates; we only read them
// set PROXY_URL (e.g. a US proxy) to get past sites that block your country
const lenientTls = process.env.PROXY_URL
  ? new ProxyAgent({ uri: process.env.PROXY_URL, requestTls: { rejectUnauthorized: false } })
  : new Agent({ connect: { rejectUnauthorized: false } });

const isEditUrl = (u) => /[?&]action=edit|\/(edit|dashboard|my-?account|wp-admin|login)\b|add-listing/i.test(u);

// ---------- normalizers ----------

const BUSINESS_SUFFIXES = ['llc', 'l l c', 'inc', 'incorporated', 'co', 'corp', 'corporation', 'ltd', 'llp', 'pllc', 'company'];

const ADDRESS_ABBR = {
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd', lane: 'ln',
  court: 'ct', place: 'pl', parkway: 'pkwy', highway: 'hwy', circle: 'cir', terrace: 'ter',
  suite: 'ste', apartment: 'apt', north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw', square: 'sq', trail: 'trl',
};

const STATES = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
  connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id',
  illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
  'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or',
  pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd',
  tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa',
  'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy',
};

const basic = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9@.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normName = (s) => {
  let n = basic(s).replace(/\./g, ' ').replace(/\s+/g, ' ');
  for (const suf of BUSINESS_SUFFIXES) n = n.replace(new RegExp(`\\b${suf}$`), '').trim();
  return n;
};

const normAddress = (s) => {
  let n = ` ${basic(s).replace(/\./g, ' ')} `;
  for (const [full, abbr] of Object.entries(STATES)) n = n.replace(new RegExp(` ${full} `, 'g'), ` ${abbr} `);
  n = n
    .split(' ')
    .map((w) => ADDRESS_ABBR[w] || w)
    .join(' ');
  return n.replace(/\s+/g, ' ').trim();
};

const digits = (s) => (s || '').replace(/\D/g, '');
const last10 = (s) => digits(s).slice(-10);

const formatPhone = (d) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);

// ---------- page extraction ----------

function extractPage(html) {
  const $ = cheerio.load(html);
  const extra = [];

  // values hidden inside forms / links / meta (edit pages, tel:, mailto:)
  $('input').each((_, el) => {
    const t = ($(el).attr('type') || 'text').toLowerCase();
    if (!['hidden', 'password', 'submit', 'button', 'checkbox', 'radio'].includes(t)) extra.push($(el).attr('value') || '');
  });
  $('textarea').each((_, el) => extra.push($(el).text()));
  $('select option[selected]').each((_, el) => extra.push($(el).text()));
  $('a[href^="tel:"], a[href^="mailto:"]').each((_, el) => extra.push(decodeURIComponent($(el).attr('href').replace(/^(tel|mailto):/i, '').split('?')[0])));
  $('meta[content]').each((_, el) => extra.push($(el).attr('content')));
  $('script[type="application/ld+json"]').each((_, el) => extra.push($(el).text()));
  // Cloudflare-protected emails
  $('[data-cfemail]').each((_, el) => extra.push(decodeCfEmail($(el).attr('data-cfemail'))));

  const title = $('title').first().text().trim();
  $('script, style, noscript, svg').remove();
  const bodyText = $('body').length ? $('body').text() : $.root().text();

  return { title, text: `${title}\n${bodyText}\n${extra.join('\n')}`.replace(/[ \t]+/g, ' ') };
}

function decodeCfEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch {
    return '';
  }
}

// ---------- field checks ----------

function checkName(expected, text) {
  if (!expected) return null;
  const n = normName(expected);
  const page = ` ${normName(text.replace(/\n/g, ' '))} `;
  if (page.includes(` ${n} `) || page.includes(n)) return { status: 'match' };
  const tokens = n.split(' ').filter((t) => t.length > 1);
  const hits = tokens.filter((t) => page.includes(` ${t} `));
  if (tokens.length && hits.length / tokens.length >= 0.6)
    return { status: 'partial', note: `Missing words: ${tokens.filter((t) => !hits.includes(t)).join(', ')}` };
  return { status: 'mismatch', note: 'Business name not found on page' };
}

function checkPhone(expected, text) {
  if (!expected) return null;
  const want = last10(expected);
  const found = new Set();
  const re = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/g;
  for (const m of text.match(re) || []) {
    const d = last10(m);
    if (d.length === 10) found.add(d);
  }
  const list = [...found].map(formatPhone);
  if (found.has(want)) return { status: 'match', found: list };
  if (!list.length) return { status: 'absent', found: list, note: 'No phone number shown on this page' };
  return { status: 'mismatch', found: list, note: `Page shows: ${list.slice(0, 3).join(', ')}` };
}

function checkEmail(expected, text, siteHost = '') {
  if (!expected) return null;
  const want = expected.trim().toLowerCase();
  const brand = siteHost.split('.')[0]; // "retreatpool" from retreatpool.com
  const found = [...new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map((e) => e.toLowerCase()))].filter(
    (e) =>
      e === want ||
      (!/\.(png|jpe?g|gif|webp|svg)$/.test(e) &&
        !/sentry|wixpress|example\.com/.test(e) &&
        // skip the directory's own contact emails (info@site.com, sitename@gmail.com)
        !(siteHost && e.split('@')[1].endsWith(siteHost)) &&
        !(brand.length > 3 && e.split('@')[0].includes(brand))),
  );
  if (found.includes(want)) return { status: 'match', found };
  if (!found.length) return { status: 'absent', found, note: 'No email shown on this listing (many directories hide it)' };
  return { status: 'mismatch', found, note: `Page shows: ${found.slice(0, 3).join(', ')}` };
}

function checkAddress(expected, text) {
  if (!expected) return null;
  const want = normAddress(expected);
  const page = ` ${normAddress(text.replace(/\n/g, ' '))} `;
  if (page.includes(` ${want} `)) return { status: 'match' };

  // compare the important parts: street number, street words, zip
  const zip = (expected.match(/\b\d{5}(?:-\d{4})?\b/) || [])[0];
  const parts = want.split(' ').filter((t) => t.length > 1 || /\d/.test(t));
  const missing = parts.filter((t) => !page.includes(` ${t} `) && !(t === zip && page.includes(zip.slice(0, 5))));
  if (!missing.length) return { status: 'match', note: 'All address parts found (formatting differs)' };
  const streetNum = (want.match(/^\d+/) || [])[0];
  const critical = missing.filter((t) => t === streetNum || t === zip || /^\d/.test(t));
  if (missing.length / parts.length <= 0.25 && !critical.length)
    return { status: 'partial', note: `Missing: ${missing.join(', ')}` };
  return { status: 'mismatch', note: `Missing: ${missing.join(', ')}` };
}

function runChecks(info, text, siteHost) {
  return {
    name: checkName(info.name, text),
    phone: checkPhone(info.phone, text),
    email: checkEmail(info.email, text, siteHost),
    address: checkAddress(info.address, text),
  };
}

// ---------- fetching ----------

async function fetchHtml(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      dispatcher: lenientTls,
      headers: BROWSER_HEADERS,
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, finalUrl: res.url, html, via: 'http' };
  } finally {
    clearTimeout(timer);
  }
}

const BLOCK_STATUS = new Set([401, 403, 406, 429, 503, 520, 521, 522, 523, 524, 525, 526, 530]);
const CHALLENGE_TEXT = /just a moment|checking your browser|verify you are human|attention required|cf-chl|captcha-delivery|ddos-guard|are you a robot|enable javascript/i;
const browserHosts = new Set(); // hosts that only worked in real Chrome this session

const hostOf = (u) => new URL(u).hostname.replace(/^www\./, '');

function looksBlocked(page) {
  if (BLOCK_STATUS.has(page.status)) return true;
  if (page.status === 404 || page.status === 410) return false;
  const head = page.html.slice(0, 8000);
  if (CHALLENGE_TEXT.test(head)) return true;
  // empty shell that builds itself with JavaScript
  return extractPage(page.html).text.split(/\s+/).filter(Boolean).length < 25;
}

// Plain request first (fast); real Chrome when the site blocks bots or needs JavaScript.
async function smartFetch(url, timeoutMs = 20000, { allowBrowser = true } = {}) {
  const host = hostOf(url);
  const useBrowser = allowBrowser && (await getChromePath());
  if (useBrowser && browserHosts.has(host)) return browserFetch(url, Math.max(timeoutMs, 30000));

  let plain, plainErr;
  try {
    plain = await fetchHtml(url, timeoutMs);
    if (!looksBlocked(plain)) return plain;
  } catch (err) {
    plainErr = err;
  }
  if (!useBrowser) {
    if (plain) return plain;
    throw plainErr;
  }

  try {
    const viaBrowser = await browserFetch(url, 45000);
    if (!viaBrowser.challenged && !BLOCK_STATUS.has(viaBrowser.status)) browserHosts.add(host);
    return viaBrowser;
  } catch (err) {
    if (plain) return plain;
    throw plainErr || err;
  }
}

// classify a fetched page and run the field checks on it
function analyzePage(page, pageUrl, info) {
  const { title, text } = extractPage(page.html);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const alertMsg = (page.html.match(/alert\(['"]([^'"]+)['"]\)/) || [])[1];
  const reason = alertMsg || `HTTP ${page.status}`;
  const base = { httpStatus: page.status, finalUrl: page.finalUrl, title, fetchedWith: page.via, challenged: page.challenged };

  const notFound =
    page.status === 404 || page.status === 410 || /profile not found|page does not exist|listing not found/i.test(alertMsg || text.slice(0, 2000));
  if (notFound) return { ...base, kind: 'missing', reason };
  if (!page.ok || wordCount < 25) return { ...base, kind: 'unreadable', reason };

  const checks = runChecks(info, text, new URL(pageUrl).hostname.replace(/^www\./, ''));
  const looksLikeLogin = /log ?in|sign ?in/i.test(title) && Object.values(checks).every((c) => !c || c.status !== 'match');
  return { ...base, kind: looksLikeLogin ? 'login' : 'ok', reason, checks };
}

const okResponse = (a, extra = {}) => ({
  readable: true,
  httpStatus: a.httpStatus,
  finalUrl: a.finalUrl,
  title: a.title,
  fetchedWith: a.fetchedWith,
  checks: a.checks,
  ...extra,
});

app.get('/api/browser', async (_, res) => res.json((await loadBrowser())?.browserInfo() || { available: false }));

// open a visible Chrome window so the user can pass a captcha / log in; cookies are kept
app.post('/api/browser/open', async (req, res) => {
  try {
    const b = await loadBrowser();
    if (!b) throw new Error('Hidden Chrome is only available when running locally');
    await b.openVisible(req.body.url);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/check', async (req, res) => {
  // `page` = HTML already loaded in the user's own Chrome by the helper extension
  // serverChrome: opt-in to the checker's own hidden Chrome (separate profile: no VPN, no logins)
  const { url, info, pastedText, page, findPublic = true, serverChrome = false } = req.body || {};
  if (!info) return res.status(400).json({ error: 'Missing business info' });

  // manual mode: user pasted the page content themselves
  if (pastedText) {
    return res.json({ readable: true, source: 'pasted', checks: runChecks(info, pastedText) });
  }

  let target;
  try {
    target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) throw new Error();
  } catch {
    return res.json({ readable: false, error: 'Invalid URL' });
  }

  let a;
  try {
    a = page?.html
      ? analyzePage({ ok: page.ok, status: page.status, finalUrl: page.finalUrl, html: page.html, challenged: page.challenged, via: 'your-chrome' }, target.href, info)
      : analyzePage(await smartFetch(target.href, 20000, { allowBrowser: serverChrome }), target.href, info);
  } catch (err) {
    return res.json({ readable: false, error: err.name === 'AbortError' ? 'Timed out after 20s' : `Fetch failed: ${err.cause?.code || err.message}` });
  }

  const ownerLink = isEditUrl(target.href);

  // owner links work in Chrome once you've logged in there via "Open in Chrome"
  if (serverChrome && ownerLink && a.kind !== 'ok' && a.fetchedWith === 'http' && (await getChromePath())) {
    try {
      const b = analyzePage(await browserFetch(target.href), target.href, info);
      if (b.kind === 'ok' && b.checks.name?.status === 'match') a = b;
    } catch {}
  }

  const nameMissing = a.checks?.name && a.checks.name.status !== 'match';
  const needsPublic = a.kind === 'missing' || (ownerLink && (a.kind !== 'ok' || nameMissing));

  // owner/edit link or dead link: look for the public listing on the same site
  if (needsPublic && findPublic && info.name?.trim()) {
    const slow = serverChrome && browserHosts.has(hostOf(target.href));
    const hit = await findPublicListing({
      url: target.href,
      name: info.name,
      // real Chrome is slow, so on bot-protected sites the finder makes fewer, browser-backed requests
      fetchHtml: (u, ms) => smartFetch(u, ms, { allowBrowser: slow }),
      checkName,
      slow,
      budgetMs: slow ? 90000 : 45000,
    }).catch(() => null);
    if (hit?.found) {
      const pub = analyzePage({ ok: true, status: hit.status, finalUrl: hit.publicUrl, html: hit.html }, hit.publicUrl, info);
      if (pub.kind === 'ok') {
        return res.json(
          okResponse(pub, {
            publicUrl: hit.publicUrl,
            foundVia: hit.via,
            originalProblem: !ownerLink
              ? `Original link is dead (${a.reason})`
              : a.kind === 'ok' || a.kind === 'login'
                ? 'Owner link (shows a login/edit page)'
                : `Owner link (${a.reason})`,
          }),
        );
      }
    }
  }

  const searchedNote = needsPublic && findPublic && info.name?.trim() ? ' Searched the site for the public listing but could not find it.' : '';

  if (ownerLink && a.kind !== 'ok') {
    return res.json({
      readable: false,
      ownerLink: true,
      ...a,
      error: `This is an owner edit/login link (${a.reason}), so it only works when you're signed in.${searchedNote}`,
    });
  }
  if (a.kind === 'missing') {
    return res.json({
      readable: false,
      missing: true,
      ...a,
      error: `Listing not found (${a.reason}). The citation may have been deleted or the URL changed.${searchedNote}`,
    });
  }
  if (a.kind === 'unreadable') {
    return res.json({
      readable: false,
      ...a,
      error:
        a.fetchedWith === 'your-chrome'
          ? a.challenged
            ? 'The site shows a captcha in your Chrome. Open the link, solve it once, then Recheck'
            : BLOCK_STATUS.has(a.httpStatus)
              ? `Blocked in your Chrome too (HTTP ${a.httpStatus}). Check that your VPN is on and set to the US, then Recheck`
              : `Page had no readable content (HTTP ${a.httpStatus})`
          : a.challenged
            ? 'The site shows a captcha / bot check. Click "Open in Chrome", solve it, close the window, then Recheck'
            : BLOCK_STATUS.has(a.httpStatus)
              ? a.fetchedWith === 'browser'
                ? `Blocked even in real Chrome (HTTP ${a.httpStatus}). The site likely blocks your country/IP. Use a US VPN or set PROXY_URL`
                : `Site blocked the server (HTTP ${a.httpStatus}). Click Open in my Chrome (VPN on) and use the Send to Checker bookmark`
              : `Page had no readable content (HTTP ${a.httpStatus})`,
    });
  }
  res.json(okResponse(a, a.kind === 'login' ? { warning: 'Looks like a login page. Use a public listing URL or paste the page text.' } : {}));
});

export default app;
