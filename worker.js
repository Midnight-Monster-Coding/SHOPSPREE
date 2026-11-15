/* worker.js: PIXELCART / SHOPSPREE edge API.
   Serves the static site (via the ASSETS binding) and two private endpoints that hold the API keys:

     GET  /api/pixabay?...   Pixabay search proxy (key added here, never sent to the browser)
     GET  /api/search?q=tv   "live listing": Pixabay photos + believable INR prices for ANY search term
     POST /api/assistant     Gemini shopping assistant

   Secrets (Workers dashboard > Settings > Variables and Secrets, type = Secret; or `wrangler secret put`):
     PIXABAY_KEY      your Pixabay API key
     GEMINI_API_KEY   your Google AI Studio key
   Optional plain variable: GEMINI_MODEL (default gemini-2.5-flash), ALLOWED_ORIGINS (comma list of extra origins). */

const DEFAULT_MODEL = 'gemini-flash-latest';       // alias that always points at the current Flash model; unknown names fall through the list in gemini()
const FALLBACK_MODEL = 'gemini-3.8-flash';
const ADJ = ['Aura', 'Nova', 'Zenith', 'Lumen', 'Ember', 'Onyx', 'Solace', 'Vertex', 'Haven', 'Pulse', 'Echo', 'Drift'];
const CATS = ['Fashion', 'Electronics', 'Home', 'Beauty', 'Crafts'];
const PEOPLE = ['man', 'woman', 'girl', 'boy', 'people', 'child', 'children', 'baby', 'portrait', 'model', 'face', 'couple', 'family'];

/* Known products: [pattern, display name, category, min INR, max INR]. Anything else is classified by Gemini. */
const PRICES = [
  [/\b(tv|tvs|television|televisions|smart tv|led tv|oled)\b/, 'Smart TV', 'Electronics', 12999, 64999, { pq: 'television set', ban: 'tower antenna broadcast berlin architecture skyline city building clock vintage retro old antique crt static noise show movie cinema film news studio' }],
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

function pixabayImageOk(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && (x.hostname === 'pixabay.com' || x.hostname === 'cdn.pixabay.com'); } catch (_) { return false; }
}

function cleanQuery(raw) {
  return String(raw || '').normalize('NFKC').replace(/[^\p{L}\p{N} \-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/* ---------------- Pixabay ---------------- */
/* Per-isolate memory cache: the Cache API does nothing on *.workers.dev, so this is what keeps repeat queries
   from burning Pixabay's 100-requests-per-minute limit. On a 429 the last answer (even an old one) is served instead. */
const PX_MEM = new Map();
async function pixabay(env, params) {
  if (!env.PIXABAY_KEY) throw Object.assign(new Error('PIXABAY_KEY is not set'), { status: 500 });
  const u = new URL('https://pixabay.com/api/');
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const mk = u.searchParams.toString(), now = Date.now(), c = PX_MEM.get(mk);
  if (c && now - c.t < 3600e3) return c.d;
  u.searchParams.set('key', env.PIXABAY_KEY);
  const res = await fetch(u.toString(), { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (res.status === 429 && c) return c.d;
  if (!res.ok) throw Object.assign(new Error('Pixabay HTTP ' + res.status + (res.status === 429 ? ' (rate limit: 100 requests/minute per key)' : '')), { status: res.status === 429 ? 429 : 502, retry: res.headers.get('X-RateLimit-Reset') });
  const d = await res.json();
  if (PX_MEM.size > 300) PX_MEM.delete(PX_MEM.keys().next().value);
  PX_MEM.set(mk, { t: now, d });
  return d;
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
async function geminiCall(env, model, body) {
  return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(body)
  });
}
async function gemini(env, body) {
  if (!env.GEMINI_API_KEY) throw Object.assign(new Error('GEMINI_API_KEY is not set'), { status: 500 });
  const models = [...new Set([env.GEMINI_MODEL, DEFAULT_MODEL, FALLBACK_MODEL, 'gemini-2.5-flash'].filter(Boolean))];
  let lastErr = 'no model tried';
  for (const model of models) {
    /* Gemini "thinking" tokens count against maxOutputTokens, so a small budget can leave an EMPTY reply.
       Turn thinking off first; if the model rejects that (HTTP 400) retry without it, with more room. */
    const gc = body.generationConfig || {};
    const tries = [
      { ...body, generationConfig: { ...gc, thinkingConfig: { thinkingBudget: 0 } } },
      { ...body, generationConfig: { ...gc, maxOutputTokens: Math.max(gc.maxOutputTokens || 0, 4096) } }
    ];
    for (const b of tries) {
      let res;
      try { res = await geminiCall(env, model, b); } catch (e) { lastErr = model + ': ' + e.message; break; }
      if (res.status === 400 && b === tries[0]) { lastErr = model + ': HTTP 400 (retrying without thinking config)'; continue; }
      if (!res.ok) {
        let msg = ''; try { msg = ((await res.json()).error || {}).message || ''; } catch (_) {}
        lastErr = model + ': HTTP ' + res.status + (msg ? ' ' + msg.slice(0, 220) : '');
        if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Gemini rejected the key. ' + lastErr), { status: 502 });   // bad / leaked / restricted key: other models will not help
        break;                                               // 404 unknown model, 429, 5xx: next model
      }
      const data = await res.json();
      const text = (((data.candidates || [])[0] || {}).content || {}).parts?.map(x => x.text || '').join('') || '';
      if (text.trim()) return text;
      lastErr = model + ': empty reply (' + ((data.candidates || [])[0] || {}).finishReason + ')';
      break;
    }
  }
  throw Object.assign(new Error('Gemini failed. ' + lastErr), { status: 502 });
}
/* Models sometimes wrap JSON in prose or code fences: take the outermost {...}. */
function parseJson(txt) {
  const s = String(txt || '').replace(/```json|```/g, '').trim(), a = s.indexOf('{'), b = s.lastIndexOf('}');
  return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
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
    generationConfig: { temperature: 0.4, maxOutputTokens: 1500, responseMimeType: 'application/json' }
  });
  return json({ text });
}

/* ---------------- Live listing for any search term ---------------- */
async function profileFor(env, q) {
  const low = q.toLowerCase();
  for (const [re, name, cat, min, max, extra] of PRICES) {
    if (!re.test(low)) continue;
    const alts = ((re.source.match(/\(([^)]*)\)/) || [, ''])[1]).split('|').join(' ');     // synonyms: "tv|television|..." all count as the same product
    return { name, cat, min, max, pq: (extra && extra.pq) || q, alts, ban: (extra && extra.ban) || '' };
  }
  if (env.GEMINI_API_KEY) {                       // unknown word: let Gemini classify it, and also translate non-English words
    try {
      const txt = await gemini(env, {
        systemInstruction: { parts: [{ text: 'You classify a shopper\'s search for an Indian online store. Reply ONLY as JSON: {"product": true|false, "name": "singular product name in English, Title Case, max 3 words", "category": "Fashion|Electronics|Home|Beauty|Crafts", "minInr": number, "maxInr": number, "photoQuery": "2-3 English words for a stock-photo search", "avoid": "up to 8 lowercase words that appear in tags of WRONG photos for this search, e.g. landmarks, places, people"}. "product" is false for anything that is not a normal physical retail product (people, places, adult, weapons, drugs, abstract words). Prices are realistic Indian retail prices in rupees.' }] },
        contents: [{ role: 'user', parts: [{ text: q }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 600, responseMimeType: 'application/json' }
      });
      const o = parseJson(txt);
      if (o.product === false) return null;
      let min = Math.max(49, Math.round(+o.minInr) || 0), max = Math.min(500000, Math.round(+o.maxInr) || 0);
      if (!(min > 0 && max > min)) { min = 499; max = 2999; }
      return { name: titleCase(String(o.name || q).slice(0, 40)), cat: CATS.includes(o.category) ? o.category : 'Home', min, max, pq: cleanQuery(o.photoQuery) || q, ban: String(o.avoid || '').toLowerCase().replace(/[^a-z ,]/g, ' ').replace(/,/g, ' ') };
    } catch (_) { /* fall through to the default */ }
  }
  return { name: titleCase(q), cat: 'Home', min: 499, max: 2999, pq: q };
}

/* level 0 = strict (head noun + banned words), 1 = drop the banned words, 2 = only people/URL checks. handleSearch relaxes until something is found. */
function buildProducts(prof, q, hits, level = 0) {
  const words = new Set((prof.pq + ' ' + q + ' ' + (prof.alts || '')).toLowerCase().split(/\s+/).filter(w => w.length > 1).map(stem));
  const bans = new Set(String(prof.ban || '').split(/\s+/).filter(Boolean));
  const seen = new Set(), out = [];
  for (const h of hits) {
    const tags = String(h.tags || '').toLowerCase().split(/,\s*/);
    const headNoun = tags.some(t => { const parts = t.trim().split(/\s+/); return words.has(stem(parts[parts.length - 1])); });
    if (level < 2 && !headNoun) continue;                                   // some tag must name the product itself ("tv tower" does not)
    if (level < 1 && bans.size && tags.join(' ').split(/\s+/).some(w => bans.has(w))) continue;
    if (tags.some(t => PEOPLE.includes(t))) continue;                       // product shots only
    if (!pixabayImageOk(h.webformatURL)) continue;
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
      img: '/api/img?u=' + encodeURIComponent(h.webformatURL), credit: { user: h.user, page: h.pageURL },
      rating: +(3.8 + (k % 12) / 10).toFixed(1), rcount: 30 + (k >>> 3) % 1800, stock: k % 13 === 0 ? 3 : 25,
      tags: q + ' ' + prof.name.toLowerCase()
    });
    if (out.length >= 24) break;
  }
  return out;
}

/* Ask Gemini which candidate photos (judged by their tags) really show the product. Falls back to all candidates. */
async function vetWithGemini(env, prof, q, products, hitsById) {
  if (!env.GEMINI_API_KEY || products.length < 2) return products;
  try {
    const list = products.map(p => p.id.slice(5) + ': ' + (hitsById.get(p.id.slice(5)) || '')).join('\n');
    const txt = await gemini(env, {
      systemInstruction: { parts: [{ text: 'You check stock photos for an online store. Given a product and photo tag lists, keep only photos that very likely show the product itself as the main subject. Reject landmarks, buildings, cities, people, screenshots, vintage/retro items, and anything where the product is only incidental. Reply ONLY as JSON: {"ids": ["<id>", ...]} (best first, at most 8; empty if none qualify).' }] },
      contents: [{ role: 'user', parts: [{ text: 'Product: ' + prof.name + ' (shopper searched "' + q + '")\nPhotos (id: tags):\n' + list }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 600, responseMimeType: 'application/json' }
    });
    const ids = new Set((parseJson(txt).ids || []).map(String));
    const kept = products.filter(p => ids.has(p.id.slice(5))).slice(0, 8);
    return kept.length ? kept : products.slice(0, 8);       // an over-strict vet must never leave the shopper with nothing
  } catch (_) { return products.slice(0, 8); }
}

async function handleImage(request, env) {
  const ref = request.headers.get('Referer');
  if (ref) { try { if (new URL(ref).host !== new URL(request.url).host && !/^(localhost|127\.0\.0\.1)$/.test(new URL(ref).hostname)) return new Response('forbidden', { status: 403 }); } catch (_) {} }
  const target = new URL(request.url).searchParams.get('u') || '';
  if (!pixabayImageOk(target)) return new Response('bad image url', { status: 400 });
  let up;
  for (let i = 0; i < 3; i++) {                        // Pixabay answers 429 when it is hit too fast: wait and retry
    up = await fetch(target, { cf: { cacheEverything: true, cacheTtl: 2592000 }, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PixelcartImageProxy/1.0)' } });
    if (up.status !== 429) break;
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  const type = up.headers.get('Content-Type') || '';
  if (!up.ok || !type.startsWith('image/')) return new Response('image unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  return new Response(up.body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=2592000, immutable' } });
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
  const data = await pixabay(env, { q: prof.pq, lang: 'en', image_type: 'photo', safesearch: 'true', order: 'popular', per_page: '60', min_width: '600', min_height: '400' });
  const hitsById = new Map((data.hits || []).map(h => [String(h.id), h.tags]));
  let cands = [];
  for (let level = 0; level <= (env.GEMINI_API_KEY ? 2 : 1) && cands.length < 4; level++) cands = buildProducts(prof, q, data.hits || [], level);
  const products = await vetWithGemini(env, prof, q, cands, hitsById);
  const res = json({ products, query: q }, 200, { 'Cache-Control': 'public, max-age=3600' });
  if (products.length) ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify({ products, query: q }), { headers: { 'Cache-Control': 'public, max-age=86400' } })));
  return res;
}

/* ---------------- router ---------------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname !== '/api/img' && !originAllowed(request, env)) return json({ error: 'forbidden origin' }, 403);
    try {
      if (url.pathname === '/api/pixabay') return await handlePixabay(request, env);
      if (url.pathname === '/api/img') return await handleImage(request, env);
      if (url.pathname === '/api/search') return await handleSearch(request, env, ctx);
      if (url.pathname === '/api/assistant') return await handleAssistant(request, env);
      if (url.pathname === '/api/health') {
        const out = { ok: true, pixabay: !!env.PIXABAY_KEY, gemini: !!env.GEMINI_API_KEY };
        if (url.searchParams.has('deep')) {                    // /api/health?deep=1 : really calls both services and reports what they said
          try { const d = await pixabay(env, { q: 'television', per_page: '3' }); out.pixabayTest = 'ok, ' + d.total + ' results'; } catch (e) { out.ok = false; out.pixabayTest = 'FAILED: ' + e.message; }
          try { out.geminiTest = 'ok: ' + (await gemini(env, { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK' }] }], generationConfig: { maxOutputTokens: 20 } })).trim().slice(0, 40); } catch (e) { out.ok = false; out.geminiTest = 'FAILED: ' + e.message; }
        }
        return json(out);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      const status = e.status || 502;
      return json({ error: status === 429 ? 'rate_limited' : 'upstream_error', detail: e.message }, status, e.retry ? { 'X-RateLimit-Reset': e.retry } : {});
    }
  }
};