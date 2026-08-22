import {createSign} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const MID = process.env.MERCHANT_ID || '';
const EMAIL = process.env.GOOGLE_SA_EMAIL || '';
const KEY = (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n').trim();
const INCLUDE = (process.env.PRODUCTS_INCLUDE || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 200);
const OUT = fileURLToPath(new URL('../products.json', import.meta.url));

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

if (!MID || !EMAIL || !KEY.includes('PRIVATE KEY')) {
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

async function fetchAllProducts(token) {
  let all = [], pageToken = '', pages = 0;
  while (pages < 20) {
    const url = 'https://merchantapi.googleapis.com/products/v1/accounts/' + MID +
      '/products?pageSize=250' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, {headers: {authorization: 'Bearer ' + token}});
    if (!res.ok) fail('Merchant API failed (' + res.status + '): ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    all = all.concat(data.products || []);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
    pages++;
  }
  return all;
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
