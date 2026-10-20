// Turns one free-form "business details" blob into { name, phone, email, address, gmb }.
// Accepts any order, one line or many, with or without labels ("Phone: ..."), e.g.
//   MacLock Locksmith Services LLC (417) 425-3167 jamcneely27@gmail.com
//   Name: R&D Junk Removal | 2209 S Harlem Ave, Joplin, MO 64804 | https://maps.app.goo.gl/...

const STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|' +
  'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming';

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.page|share\.google|g\.co\/kgs)\/[^\s<>"']+/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+?1[\s.-]*)?\(?\b\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/g;
const SOCIAL_RE =
  /\b(facebook|fb|instagram|twitter|x|linkedin|youtube|youtu|tiktok|pinterest|yelp|reddit|tumblr|nextdoor|bbb|threads|medium|wa|whatsapp|t)\.(com|me|be|org|net)\b/i;
const GMB_RE =/maps\.app\.goo\.gl|goo\.gl\/maps|g\.page|share\.google|g\.co\/kgs|google\.[a-z.]+\/maps|maps\.google\.|[?&]cid=\d/i;

// "123 Main St, Suite 4, Springfield, MO 65802" (street optional, zip optional when there is a street)
const ADDRESS_RE = new RegExp(
  String.raw`(?:\b\d{1,6}[A-Za-z]?\s+[^,\n|•;]{2,60}?,\s*(?:[^,\n|•;]{1,30},\s*)?)?` + // street (+ unit)
    String.raw`[A-Za-z][A-Za-z .'-]{1,40}?,?\s+(?:${STATES})\.?(?:\s+\d{5}(?:-\d{4})?\b|(?=\s*$|\s*[\n|•;]))` + // city, ST zip
    String.raw`(?:,?\s*(?:USA|United States))?`,
  'gi',
);

const LABEL_RE =
  /^\s*(business\s*name|company|name|phone|tel(?:ephone)?|mobile|cell|ph|email|e-mail|mail|address|addr|location|gmb(?:\s*link)?|google(?:\s*(?:maps|business|profile))*(?:\s*link)?|maps?|website|web|url|site)\s*[:\-–=]\s*/i;

const FIELD_OF_LABEL = (l) => {
  l = l.toLowerCase();
  if (/name|company/.test(l)) return 'name';
  if (/phone|tel|mobile|cell|^ph$/.test(l)) return 'phone';
  if (/mail/.test(l)) return 'email';
  if (/addr|location/.test(l)) return 'address';
  if (/gmb|google|map/.test(l)) return 'gmb';
  return 'website';
};

const tidy = (s) => s.replace(/\s+/g, ' ').replace(/^[\s,;|•:\-–]+|[\s,;|•:\-–]+$/g, '').trim();

export function parseDetails(raw) {
  const out = { name: '', phone: '', email: '', address: '', gmb: '', website: '' };
  if (!raw?.trim()) return out;

  // 1. labelled lines win ("Phone: ...")
  const unlabelled = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(LABEL_RE);
    if (m) {
      const field = FIELD_OF_LABEL(m[1]);
      const value = tidy(line.slice(m[0].length));
      if (value && !out[field]) out[field] = value;
    } else unlabelled.push(line);
  }
  let text = unlabelled.join('\n');

  // 2. pull out the unambiguous bits; each becomes a separator so what's around them stays apart
  const take = (re, pick) => {
    text = text.replace(re, (m) => {
      pick(m);
      return '\n';
    });
  };
  take(URL_RE, (u) => {
    const full = /^https?:/i.test(u) ? u : `https://${u}`;
    if (GMB_RE.test(u)) out.gmb ||= full;
    // the business's own site: the first link that isn't Google Maps or a social / directory profile
    else if (!SOCIAL_RE.test(u)) out.website ||= full.replace(/[.,;)]+$/, '');
  });
  take(EMAIL_RE, (e) => (out.email ||= e));
  // a bare domain ("colorstarspaintingllc.com"), once emails are out of the way
  take(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|co|us|biz|info|io|pro|services|llc|site|online)\b(?:\/[^\s<>"']*)?/gi, (d) => {
    if (!out.website && !SOCIAL_RE.test(d) && !GMB_RE.test(d)) out.website = `https://${d.replace(/[.,;)]+$/, '')}`;
  });
  take(PHONE_RE, (p) => (out.phone ||= tidy(p)));

  // 3. address: city + state (+ zip), with a street in front if there is one
  if (!out.address) {
    const m = [...text.matchAll(ADDRESS_RE)].sort((a, b) => b[0].length - a[0].length)[0];
    if (m) {
      const start = addressStart(m[0]);
      out.address = tidy(m[0].slice(start));
      // whatever the match swallowed before the real start (business name words) goes back
      text = text.slice(0, m.index) + m[0].slice(0, start) + '\n' + text.slice(m.index + m[0].length);
    }
  }

  // 4. name: the first leftover chunk that looks like words
  if (!out.name) {
    const chunks = text
      .split(/\n|\s[|•;]\s|\s{2,}|\t/)
      .map((c) => tidy(c.replace(INLINE_LABEL_EDGES, ' ')))
      .filter((c) => /[A-Za-z]{2}/.test(c));
    out.name = chunks[0] || '';
  }
  return out;
}

// label words left behind next to a value we pulled out ("Call (417)...", "Email: x@y")
const INLINE_LABEL_EDGES = /(?:^|\s)(?:phone|tel|telephone|call(?: us)?|ph|mobile|cell|email|e-mail|mail|address|addr|gmb|website|web|url)\s*[:\-–]?\s*$|^\s*(?:phone|tel|email|e-mail|address|gmb|website)\s*[:\-–]\s*/gi;

// Words that start multi-word city names ("New York", "San Antonio", "Fort Worth"...)
const CITY_PREFIX = /^(new|san|santa|los|las|el|la|le|st\.?|saint|ft\.?|fort|port|mount|mt\.?|lake|palm|grand|north|south|east|west|little|big|salt|glen|cedar|bowling|baton|corpus|des|coral|daly|elk|fall|high|long|overland|round|sioux|sugar|thousand|walnut|white|winston|kansas|oklahoma|jersey|virginia|iowa|ocean|rock|royal|park|bay|beverly|boca|bonita|castle|cherry|college|eden|fair|falls|forest|garden|green|holly|hot|huntington|junction|lees|maple|myrtle|oak|orange|pacific|pine|pleasant|plant|red|rancho|redondo|rio|silver|spring|sun|union|university|valley|west)$/i;

// Where the address really starts inside an ADDRESS_RE match.
function addressStart(s) {
  const firstComma = s.indexOf(',');
  const head = firstComma === -1 ? s : s.slice(0, firstComma);
  // a street: start at the LAST house number before the first comma ("24/7 Pros 1500 Elm St" -> "1500 Elm St")
  const nums = [...head.matchAll(/(?:^|[\s,])(\d{1,6}[A-Za-z]?\s+(?=[A-Za-z]))/g)];
  if (nums.length) {
    const last = nums[nums.length - 1];
    return last.index + last[0].indexOf(last[1]);
  }
  // no street: the city is the last word before the comma, plus city-name prefixes ("New York")
  const words = [...head.matchAll(/\S+/g)];
  let i = words.length - 1;
  while (i > 0 && CITY_PREFIX.test(words[i - 1][0])) i--;
  return words.length ? words[i].index : 0;
}
