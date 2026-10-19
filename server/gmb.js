// Google Business Profile (GMB) link checking.
//
// The same profile can be linked many ways: maps.app.goo.gl/<code>, g.page/<name>,
// share.google/<code>, google.com/maps/place/<name>/@...!1s0x..:0x<cid>, maps?cid=<cid>,
// embedded map iframes... so links are compared by the profile's IDs (CID, /g/ id,
// place id), resolving short links by following their redirects.

import { fetch } from 'undici';

const SHORT_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|g\.page|share\.google|g\.co)$/i;
const GOOGLE_HOST = /(^|\.)google\.[a-z.]+$/i;

// links that point at a business profile (not directions or a bare map pin)
export function isGmbLink(raw) {
  let u;
  try {
    u = new URL(raw.replace(/&amp;/g, '&'));
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (SHORT_HOSTS.test(host)) return host !== 'goo.gl' || u.pathname.startsWith('/maps');
  if (host === 'business.google.com' || host === 'search.google.com') return /placeid=|\/local\//i.test(u.href);
  if (!GOOGLE_HOST.test(host) && !/^maps\.google\./i.test(host)) return false;
  const s = decodeURIComponent(u.href);
  if (/[?&](daddr|saddr)=|\/maps\/dir\//i.test(s)) return false;
  return /\/maps\/place\/|[?&](cid|ludocid)=\d|0x[0-9a-f]+:0x[0-9a-f]+|\/g\/[a-z0-9_]{6,}|place_?id[=:]|\/maps\/embed\?pb=.*!1s/i.test(s);
}

// every ID that identifies the profile, from a (resolved) Google Maps URL
export function profileIds(raw) {
  const s = decodeURIComponent(raw.replace(/&amp;/g, '&'));
  const ids = new Set();
  for (const m of s.matchAll(/0x[0-9a-f]+:0x([0-9a-f]+)/gi)) ids.add(`cid:${BigInt('0x' + m[1]).toString()}`);
  for (const m of s.matchAll(/[?&](?:cid|ludocid)=(\d+)/gi)) ids.add(`cid:${m[1]}`);
  for (const m of s.matchAll(/\/g\/([a-z0-9_]{6,})/gi)) ids.add(`kg:${m[1].toLowerCase()}`);
  for (const m of s.matchAll(/place_?id[=:](ChI[a-zA-Z0-9_-]+)/gi)) ids.add(`pid:${m[1]}`);
  const name = (s.match(/\/maps\/place\/([^/@?]+)/i) || [])[1];
  return { ids, name: name ? name.replace(/\+/g, ' ').trim().toLowerCase() : null };
}

const cache = new Map();

// follow redirects of short links (maps.app.goo.gl -> google.com/maps/place/...)
async function resolve(raw) {
  let url = raw.replace(/&amp;/g, '&');
  if (!/^https?:/i.test(url)) url = 'https:' + (url.startsWith('//') ? url : '//' + url);
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    let cur = url;
    for (let i = 0; i < 6; i++) {
      const host = new URL(cur).hostname.replace(/^www\./, '');
      if (!SHORT_HOSTS.test(host) && profileIds(cur).ids.size) return cur;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(cur, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36' } });
        const next = res.headers.get('location');
        if (!next) {
          // some short links answer 200 with the target in the page
          const body = await res.text().catch(() => '');
          const inPage = body.match(/https:\/\/www\.google\.[a-z.]+\/maps\/place\/[^"'\s<>]+/i);
          return inPage ? inPage[0] : cur;
        }
        cur = new URL(next, cur).href;
      } catch {
        return cur;
      } finally {
        clearTimeout(timer);
      }
    }
    return cur;
  })();
  cache.set(url, p);
  return p;
}

const sameProfile = (a, b) => {
  for (const id of a.ids) if (b.ids.has(id)) return true;
  // no IDs to compare (rare): fall back to the place name in the URL
  return !a.ids.size && !b.ids.size && a.name && a.name === b.name;
};

const short = (u) => (u.length > 70 ? u.slice(0, 67) + '…' : u);

export async function checkGmb(expected, links) {
  if (!expected?.trim()) return null;
  const found = [...new Set(links.filter(isGmbLink).map((l) => l.replace(/&amp;/g, '&')))].slice(0, 8);
  if (!found.length) return { status: 'absent', note: 'No Google Business Profile link on this page' };

  const norm = (u) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  if (found.some((f) => norm(f) === norm(expected.trim()))) return { status: 'match', found };

  const want = profileIds(await resolve(expected.trim()));
  if (!want.ids.size && !want.name) return { status: 'partial', found, note: "Couldn't read your GMB link; page has: " + short(found[0]) };

  for (const f of found) {
    if (sameProfile(want, profileIds(await resolve(f)))) return { status: 'match', found };
  }
  return { status: 'mismatch', found, note: `Page links a different profile: ${short(found[0])}` };
}

// GMB-looking links in a page: anchors, embedded map iframes, and URLs in the text
export function gmbLinksFrom($, text) {
  const out = [];
  $('a[href], iframe[src], area[href]').each((_, el) => out.push($(el).attr('href') || $(el).attr('src')));
  for (const m of text.matchAll(/(?:https?:)?\/\/(?:www\.)?(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.page|share\.google|g\.co\/kgs|maps\.google\.[a-z.]+|google\.[a-z.]+\/maps)[^\s"'<>)]*/gi)) out.push(m[0]);
  return out.filter(Boolean).map((l) => (l.startsWith('//') ? 'https:' + l : l));
}
