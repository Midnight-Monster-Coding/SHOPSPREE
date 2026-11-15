/* worker.js: PIXELCART / SHOPSPREE edge API.
   Serves the static site (via the ASSETS binding) and two private endpoints that hold the API keys:

     GET  /api/pixabay?...   Pixabay search proxy (key added here, never sent to the browser)
     GET  /api/search?q=tv   "live listing": Pixabay photos + believable INR prices for ANY search term
     POST /api/assistant     Gemini shopping assistant

   Secrets (Workers dashboard > Settings > Variables and Secrets, type = Secret; or `wrangler secret put`):
     PIXABAY_KEY      your Pixabay API key
     GEMINI_API_KEY   your Google AI Studio key
   Optional plain variable: GEMINI_MODEL (default gemini-2.5-flash), ALLOWED_ORIGINS (comma list of extra origins). */

const DEFAULT_MODEL = 'gemini-2.5-flash';
const ADJ = ['Aura', 'Nova', 'Zenith', 'Lumen', 'Ember', 'Onyx', 'Solace', 'Vertex', 'Haven', 'Pulse', 'Echo', 'Drift'];
const CATS = ['Fashion', 'Electronics', 'Home', 'Beauty', 'Crafts'];
const PEOPLE = ['man', 'woman', 'girl', 'boy', 'people', 'child', 'children', 'baby', 'portrait', 'model', 'face', 'couple', 'family'];

/* Known products: [pattern, display name, category, min INR, max INR]. Anything else is classified by Gemini. */
const PRICES = [
  [/\b(tv|tvs|television|televisions|smart tv|led tv|oled)\b/, 'Smart TV', 'Electronics', 12999, 64999],
  [/\b(fridge|refrigerator)s?\b/, 'Refrigerator', 'Electronics', 13999, 54999],
  [/\bwashing machines?\b/, 'Washing Machine', 'Electronics', 11999, 42999],
  [/\b(ac|air conditioner)s?\b/, 'Air Conditioner', 'Electronics', 28999, 59999],
  [/\bmicrowaves?\b/, 'Microwave Oven', 'Electronics', 5999, 19999],
  [/\b(mixer|grinder|blender)s?\b/, 'Mixer Grinder', 'Electronics', 1999, 6999],
  [/\b(fan|fans)\b/, 'Ceiling Fan', 'Home', 1499, 4999],
  [/\b(iron|steam iron)s?\b/, 'Steam Iron', 'Electronics', 799, 3499],
  [/\bprinters?\b/, 'Printer', 'Electronics', 4999, 24999],
  [/\brouters?\b/, 'Wi-Fi Router', 'Electronics', 999, 6999],
  [/\b(drone|drones)\b/, 'Camera Drone', 'Electronics', 7999, 79999],
  [/\b(tripod|tripods)\b/, 'Camera Tripod', 'Electronics', 599, 4999],
  [/\b(earphone|earphones|earbud|earbuds)\b/, 'Wireless Earbuds', 'Electronics', 799, 5999],
  [/\b(console|playstation|xbox)\b/, 'Gaming Console', 'Electronics', 24999, 54999],
  [/\b(bicycle|bicycles|bike|cycle|cycles)\b/, 'Bicycle', 'Fashion', 5999, 24999],
  [/\b(guitar|guitars)\b/, 'Acoustic Guitar', 'Home', 3499, 19999],
  [/\b(book|books|novel|novels)\b/, 'Paperback Book', 'Home', 199, 799],
  [/\b(toy|toys)\b/, 'Toy Set', 'Home', 299, 1999],
  [/\b(chair|chairs)\b/, 'Office Chair', 'Home', 2499, 12999],
  [/\b(sofa|sofas|couch)\b/, 'Sofa', 'Home', 12999, 49999],
  [/\b(table|tables|desk|desks)\b/, 'Study Table', 'Home', 2999, 14999],
  [/\b(bed|beds|mattress|mattresses)\b/, 'Mattress', 'Home', 5999, 29999],
  [/\b(saree|sarees|sari|saris)\b/, 'Silk Saree', 'Fashion', 1499, 14999],
  [/\b(kurta|kurtas|kurti|kurtis)\b/, 'Cotton Kurta', 'Fashion', 599, 2999],
  [/\b(jeans|denim)\b/, 'Denim Jeans', 'Fashion', 899, 3499],
  [/\b(shirt|shirts|tshirt|t-shirt|tee)\b/, 'Cotton Shirt', 'Fashion', 399, 1999],
  [/\b(jacket|jackets|hoodie|hoodies)\b/, 'Winter Jacket', 'Fashion', 1299, 5999],
  [/\b(dress|dresses)\b/, 'Summer Dress', 'Fashion', 699, 3499],
  [/\b(umbrella|umbrellas)\b/, 'Travel Umbrella', 'Fashion', 249, 999],
  [/\b(suitcase|suitcases|luggage|trolley)\b/, 'Cabin Suitcase', 'Fashion', 1999, 8999],
  [/\b(helmet|helmets)\b/, 'Riding Helmet', 'Fashion', 799, 4999],
  [/\b(towel|towels)\b/, 'Cotton Towel Set', 'Home', 299, 1499],
  [/\b(curtain|curtains)\b/, 'Window Curtains', 'Home', 499, 2999],
  [/\b(carpet|rug|rugs)\b/, 'Floor Rug', 'Home', 999, 7999],
  [/\b(cookware|pan|pans|kadai)\b/, 'Non-stick Cookware', 'Home', 699, 3999],
  [/\b(razor|trimmer|trimmers)\b/, 'Beard Trimmer', 'Beauty', 599, 2499],
  [/\b(hair dryer|dryer)\b/, 'Hair Dryer', 'Beauty', 599, 2999]
];

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }
});

function hash(str) { let h = 7; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; }
const titleCase = s => s.replace(/\b\w/g, c => c.toUpperCase());
const stem = t => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) ? t.slice(0, -1) : t;

/* Browsers call this from our own pages only. Not a hard security boundary: add a Cloudflare rate-limit rule too. */
function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  const self = new URL(request.url);
  let o; try { o = new URL(origin); } catch (_) { return false; }
  if (o.host === self.host || o.hostname === 'localhost' || o.hostname === '127.0.0.1') return true;
  return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).includes(origin);
}

function cleanQuery(raw) {
  return String(raw || '').normalize('NFKC').replace(/[^\p{L}\p{N} \-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/* ---------------- Pixabay ---------------- */
async function pixabay(env, params) {
  if (!env.PIXABAY_KEY) throw Object.assign(new Error('PIXABAY_KEY is not set'), { status: 500 });
  const u = new URL('https://pixabay.com/api/');
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  u.searchParams.set('key', env.PIXABAY_KEY);
  const res = await fetch(u.toString(), { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) throw Object.assign(new Error('Pixabay HTTP ' + res.status), { status: res.status === 429 ? 429 : 502, retry: res.headers.get('X-RateLimit-Reset') });
  return res.json();
}

/* Pass-through used by the existing photo pipeline: only whitelisted parameters, key added here. */
async function handlePixabay(request, env) {
  const inUrl = new URL(request.url), p = {};
  const q = cleanQuery(inUrl.searchParams.get('q'));
  if (!q) return json({ error: 'missing q' }, 400);
  p.q = q; p.lang = 'en'; p.image_type = 'photo'; p.safesearch = 'true';
  p.order = inUrl.searchParams.get('order') === 'latest' ? 'latest' : 'popular';
  p.min_width = String(Math.min(+inUrl.searchParams.get('min_width') || 600, 2000));
  p.min_height = String(Math.min(+inUrl.searchParams.get('min_height') || 500, 2000));
  p.per_page = String(Math.min(Math.max(+inUrl.searchParams.get('per_page') || 30, 3), 60));
  const data = await pixabay(env, p);
  return json({ total: data.total, hits: data.hits }, 200, { 'Cache-Control': 'public, max-age=3600' });
}

/* ---------------- Gemini ---------------- */
async function gemini(env, body) {
  if (!env.GEMINI_API_KEY) throw Object.assign(new Error('GEMINI_API_KEY is not set'), { status: 500 });
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(body)
  });
  if (!res.ok) throw Object.assign(new Error('Gemini HTTP ' + res.status), { status: 502 });
  const data = await res.json();
  return (((data.candidates || [])[0] || {}).content || {}).parts?.map(x => x.text || '').join('') || '';
}

const ASSISTANT_SYSTEM =
  'You are the shopping assistant of PIXELCART, an Indian online store (prices are in Indian rupees, ₹). ' +
  'Reply in the same language the customer writes in, in one to three short, friendly sentences. ' +
  'Recommend only products from the CATALOGUE list the customer message includes, by their id. Never invent products, prices, ratings or stock. ' +
  'If nothing fits, say so and suggest a broader search or budget. Answer general shopping questions briefly. ' +
  'Reply ONLY as JSON: {"reply": "<text>", "ids": ["<product id>", ...]} with at most 4 ids (an empty list when no product is needed).';

async function handleAssistant(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  const raw = await request.text();
  if (raw.length > 24000) return json({ error: 'too large' }, 413);
  let body; try { body = JSON.parse(raw); } catch (_) { return json({ error: 'bad json' }, 400); }
  const contents = (Array.isArray(body.contents) ? body.contents : []).slice(-7).map(c => ({
    role: c && c.role === 'model' ? 'model' : 'user',
    parts: [{ text: String((c && c.parts && c.parts[0] && c.parts[0].text) || '').slice(0, 5000) }]
  })).filter(c => c.parts[0].text);
  if (!contents.length || contents[contents.length - 1].role !== 'user') return json({ error: 'no user message' }, 400);
  const text = await gemini(env, {
    systemInstruction: { parts: [{ text: ASSISTANT_SYSTEM }] },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 700, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } }
  });
  return json({ text });
}

/* ---------------- Live listing for any search term ---------------- */
async function profileFor(env, q) {
  const low = q.toLowerCase();
  for (const [re, name, cat, min, max] of PRICES) {
    if (!re.test(low)) continue;
    const alts = ((re.source.match(/\(([^)]*)\)/) || [, ''])[1]).split('|').join(' ');     // synonyms: "tv|television|..." all count as the same product
    return { name, cat, min, max, pq: q, alts };
  }
  if (env.GEMINI_API_KEY) {                       // unknown word: let Gemini classify it, and also translate non-English words
    try {
      const txt = await gemini(env, {
        systemInstruction: { parts: [{ text: 'You classify a shopper\'s search for an Indian online store. Reply ONLY as JSON: {"product": true|false, "name": "singular product name in English, Title Case, max 3 words", "category": "Fashion|Electronics|Home|Beauty|Crafts", "minInr": number, "maxInr": number, "photoQuery": "2-3 English words for a stock-photo search"}. "product" is false for anything that is not a normal physical retail product (people, places, adult, weapons, drugs, abstract words). Prices are realistic Indian retail prices in rupees.' }] },
        contents: [{ role: 'user', parts: [{ text: q }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 200, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } }
      });
      const o = JSON.parse(txt.replace(/```json|```/g, '').trim());
      if (o.product === false) return null;
      let min = Math.max(49, Math.round(+o.minInr) || 0), max = Math.min(500000, Math.round(+o.maxInr) || 0);
      if (!(min > 0 && max > min)) { min = 499; max = 2999; }
      return { name: titleCase(String(o.name || q).slice(0, 40)), cat: CATS.includes(o.category) ? o.category : 'Home', min, max, pq: cleanQuery(o.photoQuery) || q };
    } catch (_) { /* fall through to the default */ }
  }
  return { name: titleCase(q), cat: 'Home', min: 499, max: 2999, pq: q };
}

function buildProducts(prof, q, hits) {
  const words = new Set((prof.pq + ' ' + q + ' ' + (prof.alts || '')).toLowerCase().split(/\s+/).filter(w => w.length > 1).map(stem));
  const seen = new Set(), out = [];
  for (const h of hits) {
    const tags = String(h.tags || '').toLowerCase().split(/,\s*/);
    const tagWords = tags.join(' ').split(/\s+/).map(stem);
    if (!tagWords.some(w => words.has(w))) continue;                        // photo must actually be about the search
    if (tags.some(t => PEOPLE.includes(t))) continue;                       // product shots only
    if (!/^https:\/\/(cdn\.)?pixabay\.com\//.test(h.webformatURL || '')) continue;
    if (seen.has(h.id)) continue; seen.add(h.id);
    const k = hash(String(h.id));
    const raw = prof.min + (prof.max - prof.min) * ((k % 100) / 99);
    const step = raw >= 10000 ? 500 : raw >= 1000 ? 100 : 10;
    const price = Math.max(9, Math.round(raw / step) * step - 1);
    const name = ADJ[k % ADJ.length] + ' ' + prof.name;
    out.push({
      id: 'live-' + h.id, cat: prof.cat, name, title: name, price,
      was: k % 3 === 0 ? Math.round(price * 1.3 / 10) * 10 - 1 : undefined,
      desc: 'Popular pick for "' + q + '". Photo from Pixabay; sample listing.',
      img: h.webformatURL, credit: { user: h.user, page: h.pageURL },
      rating: +(3.8 + (k % 12) / 10).toFixed(1), rcount: 30 + (k >> 3) % 1800, stock: k % 13 === 0 ? 3 : 25,
      tags: q + ' ' + prof.name.toLowerCase()
    });
    if (out.length >= 8) break;
  }
  return out;
}

async function handleSearch(request, env, ctx) {
  const q = cleanQuery(new URL(request.url).searchParams.get('q'));
  if (q.length < 2) return json({ products: [] });
  const cacheKey = new Request('https://cache.pixelcart.internal/search?q=' + encodeURIComponent(q.toLowerCase()));
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });

  const prof = await profileFor(env, q);
  if (!prof) return json({ products: [], note: 'not a shoppable product' });
  const data = await pixabay(env, { q: prof.pq, lang: 'en', image_type: 'photo', safesearch: 'true', order: 'popular', per_page: '40', min_width: '600', min_height: '450' });
  const products = buildProducts(prof, q, data.hits || []);
  const res = json({ products, query: q }, 200, { 'Cache-Control': 'public, max-age=3600' });
  if (products.length) ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify({ products, query: q }), { headers: { 'Cache-Control': 'public, max-age=86400' } })));
  return res;
}

/* ---------------- router ---------------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!originAllowed(request, env)) return json({ error: 'forbidden origin' }, 403);
    try {
      if (url.pathname === '/api/pixabay') return await handlePixabay(request, env);
      if (url.pathname === '/api/search') return await handleSearch(request, env, ctx);
      if (url.pathname === '/api/assistant') return await handleAssistant(request, env);
      if (url.pathname === '/api/health') return json({ ok: true, pixabay: !!env.PIXABAY_KEY, gemini: !!env.GEMINI_API_KEY });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      const status = e.status || 502;
      return json({ error: status === 429 ? 'rate_limited' : 'upstream_error', detail: e.message }, status, e.retry ? { 'X-RateLimit-Reset': e.retry } : {});
    }
  }
};