import {createSign} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

function normalizePem(raw) {
  let k = (raw || '').replace(/\\r/gi, '').replace(/\\n/g, '\n');
  const m = k.match(/-----BEGIN ([A-Z ]*?)PRIVATE KEY-----([\s\S]*?)-----END [A-Z ]*?PRIVATE KEY-----/);
  const body = (m ? m[2] : k).replace(/[^A-Za-z0-9+/=]/g, '');
  if (!body.length) return '';
  const type = m && m[1].trim() ? m[1].trim() + ' ' : '';
  const wrapped = body.replace(/(.{64})/g, '$1\n');
  return '-----BEGIN ' + type + 'PRIVATE KEY-----\n' + wrapped +
    '\n-----END ' + type + 'PRIVATE KEY-----\n';
}

const MID = (process.env.MERCHANT_ID || '').replace(/[^0-9]/g, '');
const EMAIL = (process.env.GOOGLE_SA_EMAIL || '')
  .trim().replace(/^["']+|["']+$/g, '').replace(/\\n/g, '').toLowerCase();
const KEY = normalizePem(process.env.GOOGLE_SA_KEY);
const INCLUDE = (process.env.PRODUCTS_INCLUDE || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 200);
const OUT = fileURLToPath(new URL('../products.json', import.meta.url));

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

if (!MID || !/^\d{6,20}$/.test(MID)) {
  fail('MERCHANT_ID must be the numeric Merchant Center account ID (digits only). Check the secret value.');
}
if (!EMAIL || !KEY.includes('PRIVATE KEY')) {
  fail('Missing secrets: set MERCHANT_ID, GOOGLE_SA_EMAIL and GOOGLE_SA_KEY (repo Settings > Secrets > Actions).');
}

const b64u = s => Buffer.from(s).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getToken() {
  const iat = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({
    iss: EMAIL,
    scope: 'https://www.googleapis.com/auth/content',
    aud: 'https://oauth2.googleapis.com/token',
    exp: iat + 3600,
    iat
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(head + '.' + claims);
  const sig = b64u(signer.sign(KEY));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: head + '.' + claims + '.' + sig
    })
  });
  if (!res.ok) fail('Google auth failed (' + res.status + '): ' + (await res.text()).slice(0, 300));
  return (await res.json()).access_token;
}

function redact(s) {
  let t = s || '';
  if (EMAIL) t = t.split(EMAIL).join('[SA-EMAIL]');
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
  t = t.replace(/[A-Za-z0-9+/=]{60,}/g, '[BLOB]');
  return t;
}

async function diagnoseToken(token) {
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token));
    const d = await r.json();
    const parts = ['scope=' + (d.scope || '?'),
      'email_present=' + (d.email ? 'yes' : 'no'),
      'email_matches_secret=' + (d.email && EMAIL ? String(d.email.toLowerCase() === EMAIL.toLowerCase()) : '?'),
      'issued_to_matches_project_email_domain=' + (d.email_verified === 'true' ? 'verified' : d.email_verified || '?')];
    try {
      const probe = await fetch('https://merchantapi.googleapis.com/accounts/v1/accounts/' + MID,
        {headers: {authorization: 'Bearer ' + token}});
      parts.push('account_access=' + probe.status);
    } catch (e) {
      parts.push('account_access=?');
    }
    return parts.join(' | ');
  } catch (e) {
    return 'tokeninfo unreachable';
  }
}

async function fetchAllProducts(token) {
  const versions = ['v1', 'v1beta'];
  let lastErr = 'no attempt';
  for (const ver of versions) {
    let all = [], pageToken = '', pages = 0, routeMiss = false;
    while (pages < 20) {
      const url = 'https://merchantapi.googleapis.com/products/' + ver +
        '/accounts/' + MID + '/products?pageSize=250' +
        (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      const res = await fetch(url, {headers: {authorization: 'Bearer ' + token}});
      if (!res.ok) {
        const body = await res.text();
        lastErr = ver + ' (' + res.status + ') at /products/' + ver + '/accounts/...: ' + body.slice(0, 200);
        if (/^\s*<(!DOCTYPE|html)/i.test(body)) { routeMiss = true; break; }
        if (res.status === 401) {
          let msg = body;
          try { msg = JSON.parse(body).error.message; } catch (e) {}
          fail('Google rejected the credential (401). DIAGNOSTICS[' + await diagnoseToken(token) + '] ' +
            'GOOGLE SAID: ' + redact(msg));
        }
        fail('Merchant API failed (' + res.status + ') via ' + ver + ': ' + body.slice(0, 300));
      }
      const data = await res.json();
      all = all.concat(data.products || []);
      if (!data.nextPageToken) return all;
      pageToken = data.nextPageToken;
      pages++;
    }
    if (!routeMiss && all.length) return all;
  }
  fail('All Merchant API routes failed. Last error: ' + lastErr);
}

function money(price) {
  if (!price || price.amountMicros === undefined) return null;
  const v = Number(price.amountMicros) / 1e6;
  if (!isFinite(v)) return null;
  return price.currencyCode === 'USD'
    ? '$' + v.toFixed(2)
    : v.toFixed(2) + ' ' + (price.currencyCode || '');
}

const AVAILABILITY = {
  'IN_STOCK': 'in stock',
  'OUT_OF_STOCK': 'out of stock',
  'PREORDER': 'preorder',
  'BACKORDER': 'backorder'
};

const token = await getToken();
const raw = await fetchAllProducts(token);
console.log('Fetched ' + raw.length + ' products from Merchant Center.');

const match = p => {
  if (!INCLUDE.length) return true;
  const hay = ((p.productTypes || []).join(' ') + ' ' + (p.title || '') + ' ' +
    (p.googleProductCategory || '')).toLowerCase();
  return INCLUDE.some(k => hay.includes(k));
};

const items = raw.filter(match).slice(0, MAX_ITEMS).map(p => ({
  sku: p.offerId || p.id || '',
  title: (p.title || '').trim(),
  price: money(p.price),
  salePrice: money(p.salePrice),
  availability: AVAILABILITY[String(p.availability || '').toUpperCase()] ||
    String(p.availability || 'unknown').toLowerCase(),
  link: p.link || null,
  image: p.imageLink || null,
  brand: p.brand || null,
  type: (p.productTypes && p.productTypes[0]) || null,
  category: p.googleProductCategory || null
})).filter(p => p.title);

items.sort((a, b) => a.title.localeCompare(b.title));

if (!items.length) {
  console.error('No products matched PRODUCTS_INCLUDE="' + INCLUDE.join(',') +
    '" - keeping existing products.json.');
  process.exit(0);
}

writeFileSync(OUT, JSON.stringify({
  updated: new Date().toISOString(),
  count: items.length,
  source: 'google-merchant-api-v1',
  items
}, null, 2));

console.log('Wrote products.json with ' + items.length + ' items.');
