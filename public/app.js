/* app.js: PIXELCART, every module in one file (load with <script src="app.js" defer>).

   Sections, in boot order:
     (13b plus: coupons, wishlist, quick view, checkout, theme; 13c: compare, assistant, regions, recommendations)
     1 config   2 log   3 utils + bus   4 store   5 net   6 catalog   7 relevance
     8 pixabay  9 dummyjson  10 images  11 ui  12 grid (+ filter)  13 cart (+ drawer)  14 hero  15 fx  16 main

   Photo pipeline per product: Pixabay (needs a key) -> DummyJSON -> curated Unsplash fallback -> placeholder.
   A broken image becomes a placeholder. It is never swapped for another URL and never requested again.

   Debug: open the page with ?debug, then run  SS.debug()  in the console.
*/
(function (w) {
  'use strict';
  const SS = (w.SS = w.SS || {});

  /* ======================================================================== 1. config */
  const config = {
    /* No API keys live in the browser. Pixabay and Gemini are called through the Cloudflare Worker (worker.js),
       which holds PIXABAY_KEY and GEMINI_API_KEY as secrets. */
    PIXABAY_ENDPOINT: '/api/pixabay',         // Pixabay proxy
    SEARCH_ENDPOINT: '/api/search',           // live listing for searches the catalogue cannot answer (e.g. "tv")
    AI_ENDPOINT: '/api/assistant',            // Gemini shopping assistant
    GEMINI_TIMEOUT_MS: 20000,
    LIVE_TIMEOUT_MS: 15000,

    DUMMYJSON_BASE: 'https://dummyjson.com',
    CACHE_TTL_MS: 24 * 60 * 60 * 1000,      // Pixabay requires API responses to be cached for 24 hours
    REQUEST_TIMEOUT_MS: 4500,
    MAX_PARALLEL_REQUESTS: 3,
    HERO_INTERVAL_MS: 4800,
    MAX_QTY: 20,
    CART_KEY: 'shopspree.cart.v1',

    // Only these hosts may ever be used as an <img> source.
    ALLOWED_IMAGE_HOSTS: ['pixabay.com', 'cdn.pixabay.com', 'cdn.dummyjson.com', 'images.unsplash.com']
  };

  /* ======================================================================== 2. log */
  let verbose = false;
  try { verbose = new URLSearchParams(w.location.search).has('debug') || w.localStorage.getItem('ss.debug') === '1'; } catch (_) {}
  const history = [];
  const fmt = a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })());

  function scope(name) {
    const tag = '%c[' + name + ']', style = 'color:#9fb6ff';
    const make = (level, method, always) => (...args) => {
      history.push({ t: Date.now(), level: level, scope: name, msg: args.map(fmt).join(' ') });
      if (history.length > 400) history.shift();
      if (always || verbose) console[method](tag, style, ...args);
    };
    return { debug: make('debug', 'log', false), info: make('info', 'info', true), warn: make('warn', 'warn', true), error: make('error', 'error', true) };
  }
  SS.log = { scope: scope, history: history, setVerbose(on) { verbose = !!on; try { w.localStorage.setItem('ss.debug', on ? '1' : '0'); } catch (_) {} } };

  /* ======================================================================== 3. utils + bus */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);
  const nf = new Intl.NumberFormat('en-IN');
  const money = n => '₹' + nf.format(n);
  const escapeRegExp = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const initial = s => (String(s).trim().charAt(0) || '·').toUpperCase();
  const reduceMotion = () => w.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = () => w.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* Run async task factories with at most `limit` in flight. A failing task yields undefined. */
  async function pool(limit, tasks) {
    const out = new Array(tasks.length);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const i = next++;
        try { out[i] = await tasks[i](); } catch (_) { out[i] = undefined; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return out;
  }

  /* An image URL is usable only if it is https and on the allowlist. */
  function isAllowedImageUrl(url) {
    try {
      const u = new URL(url, w.location.origin);
      if (u.origin === w.location.origin && u.pathname === '/api/img') return true;       // photos served through our Worker
      return u.protocol === 'https:' && config.ALLOWED_IMAGE_HOSTS.indexOf(u.hostname) !== -1;
    } catch (_) { return false; }
  }

  const handlers = new Map();
  const bus = {
    on(evt, fn) { (handlers.get(evt) || handlers.set(evt, []).get(evt)).push(fn); },
    emit(evt, data) { (handlers.get(evt) || []).forEach(fn => { try { fn(data); } catch (e) { console.error('[bus]', evt, e); } }); }
  };

  /* ======================================================================== 4. store */
  const storeLog = scope('store');
  const mem = new Map();                    // used when localStorage is unavailable
  const CACHE_PREFIX = 'ss.c.';
  const store = {
    get(key) { try { return w.localStorage.getItem(key); } catch (_) { return mem.has(key) ? mem.get(key) : null; } },
    set(key, value) { try { w.localStorage.setItem(key, value); return true; } catch (_) { mem.set(key, value); return false; } },
    remove(key) { try { w.localStorage.removeItem(key); } catch (_) { mem.delete(key); } }
  };
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function purgeExpired() {
    try {
      const now = Date.now();
      for (let i = w.localStorage.length - 1; i >= 0; i--) {
        const k = w.localStorage.key(i);
        if (!k || k.indexOf(CACHE_PREFIX) !== 0) continue;
        try { if (JSON.parse(w.localStorage.getItem(k)).e < now) w.localStorage.removeItem(k); }
        catch (_) { w.localStorage.removeItem(k); }
      }
    } catch (_) {}
  }
  store.cache = {
    get(key) {
      const k = CACHE_PREFIX + hash(key), raw = store.get(k);
      if (!raw) return undefined;
      try { const e = JSON.parse(raw); if (e.e > Date.now() && e.k === key) return e.v; } catch (_) {}
      store.remove(k);
      return undefined;
    },
    set(key, value, ttlMs) {
      const k = CACHE_PREFIX + hash(key);
      const payload = JSON.stringify({ k: key, e: Date.now() + ttlMs, v: value });
      if (!store.set(k, payload)) { purgeExpired(); store.set(k, payload); storeLog.debug('cache write retried', key); }
    }
  };

  /* ======================================================================== 5. net */
  async function getJSON(url, opts) {
    const timeout = (opts && opts.timeout) || config.REQUEST_TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) { const err = new Error('HTTP ' + res.status); err.status = res.status; err.headers = res.headers; throw err; }
      return { data: await res.json(), headers: res.headers };
    } catch (e) {
      if (e && e.name === 'AbortError') { const t = new Error('timeout after ' + timeout + 'ms'); t.timeout = true; throw t; }
      throw e;
    } finally { clearTimeout(timer); }
  }

  /* ======================================================================== 6. catalog
     search.qs       Pixabay queries, tried in order until one yields a relevant photo.
     search.must     a photo's tags must contain at least one of these.
     search.context  (optional) tags must also contain at least one of these.
     search.ban      tags containing any of these are rejected.
     search.prefer   (optional) small score bonus, never a requirement.
     search.banPeople reject photos tagged with people words (keeps shots product-only).
     dummy           DummyJSON: allowed categories + title/tag terms ('*' = any item in the category).
     fallback        last-resort curated photo, used only if both APIs give nothing relevant. */
  const CAT_LABEL = { Fashion: 'Fashion', Electronics: 'Tech', Home: 'Home', Beauty: 'Beauty', Crafts: 'India Finds' };
  const unsplash = id => 'https://images.unsplash.com/photo-' + id + '?w=500&q=80';

  const PRODUCTS = [
    { id: 'sneakers', cat: 'Fashion', name: 'Classic Sneakers', title: 'Classic Sneakers — Red',
      desc: 'Comfortable shoes for every day and every occasion.', price: 1499, was: 2999, featured: true,
      alt: 'Red sneakers', fallback: unsplash('1542291026-7eec264c27ff'),
      search: { qs: ['red sneakers', 'sneakers shoes'], must: ['sneaker', 'sneakers', 'shoe', 'shoes', 'footwear', 'trainer', 'trainers'], prefer: ['red'], ban: ['boot', 'boots', 'sandal', 'sandals', 'heel', 'heels'], banPeople: true },
      dummy: { categories: ['mens-shoes', 'womens-shoes'], terms: ['sneaker', 'trainers', 'jordan', 'shoe'], prefer: ['red'], ban: ['cleat', 'boot', 'sandal', 'slipper', 'heel', 'flat'] } },
    { id: 'headphones', cat: 'Electronics', name: 'Wireless Headphones', title: 'Wireless Headphones',
      desc: 'Listen to music anywhere, anytime.', price: 2299, featured: true,
      alt: 'Wireless headphones', fallback: unsplash('1505740420928-5e560c06d30e'),
      search: { qs: ['wireless headphones', 'headphones'], must: ['headphone', 'headphones', 'headset', 'earphone', 'earphones'], prefer: ['wireless'], ban: [], banPeople: true },
      dummy: { categories: ['mobile-accessories'], terms: ['headphone', 'airpods max', 'headset', 'earphone', 'airpod'], prefer: ['wireless'], ban: ['watch', 'speaker', 'charger', 'case'] } },
    { id: 'backpack', cat: 'Fashion', name: 'Everyday Backpack', title: 'Everyday Backpack',
      desc: 'A bag for work, travel, college and more.', price: 999, was: 1499,
      alt: 'Backpack', fallback: unsplash('1553062407-98eeb64c6a62'),
      search: { qs: ['backpack', 'travel backpack'], must: ['backpack', 'backpacks', 'rucksack', 'daypack', 'knapsack'], ban: ['hiking', 'trekking', 'camping', 'mountain', 'tent'], banPeople: true },
      dummy: { categories: ['womens-bags'], terms: ['backpack', 'rucksack'], ban: [] } },
    { id: 'watch', cat: 'Electronics', name: 'Smart Watch', title: 'Smart Watch Series X',
      desc: 'Stay connected and keep moving.', price: 3499, featured: true,
      alt: 'Smart watch', fallback: unsplash('1523275335684-37898b6baf30'),
      search: { qs: ['smart watch', 'smartwatch'], must: ['smartwatch', 'smartwatches', 'wearable', 'fitnesstracker'], ban: [], banPeople: true },
      dummy: { categories: ['mobile-accessories', 'mens-watches'], terms: ['apple watch', 'smartwatch', 'smart watch'], ban: [] } },
    { id: 'mug', cat: 'Home', name: 'Ceramic Coffee Mug', title: 'Ceramic Coffee Mug',
      desc: 'Your new favourite morning companion.', price: 399,
      alt: 'Coffee mug', fallback: unsplash('1514228742587-6b1558fcca3d'),
      search: { qs: ['coffee mug', 'ceramic mug'], must: ['mug', 'mugs', 'cup', 'cups', 'coffeemug'], prefer: ['ceramic', 'coffee'], ban: ['beer', 'wine', 'cocktail', 'trophy'], banPeople: true },
      dummy: { categories: ['kitchen-accessories'], terms: ['mug', 'cup'], ban: ['stand', 'tree', 'holder'] } },
    { id: 'skincare', cat: 'Beauty', name: 'Skincare Set', title: 'Daily Skincare Set',
      desc: 'A simple set for your daily routine.', price: 1199,
      alt: 'Skincare products', fallback: unsplash('1601049541289-9b1b7bbbfe19'),
      search: { qs: ['skincare products', 'skin care cream'], must: ['skincare', 'cream', 'moisturizer', 'serum', 'cosmetic', 'cosmetics', 'lotion'], ban: [], banPeople: true },
      dummy: { categories: ['skin-care'], terms: ['*'], ban: [] } },
    { id: 'sunglasses', cat: 'Fashion', name: 'Sunglasses', title: 'Weekend Sunglasses',
      desc: 'A little extra style for sunny days.', price: 799,
      alt: 'Sunglasses', fallback: unsplash('1517841905240-472988babdf9'),
      search: { qs: ['sunglasses', 'sunglasses product'], must: ['sunglasses', 'sunglass', 'shades', 'eyewear'], ban: [], banPeople: true },
      dummy: { categories: ['sunglasses'], terms: ['*'], ban: [] } },
    { id: 'lamp', cat: 'Home', name: 'Table Lamp', title: 'Modern Table Lamp',
      desc: 'Brighten up your favourite corner.', price: 1599,
      alt: 'Table lamp', fallback: unsplash('1507473885765-e6ed057f782c'),
      search: { qs: ['table lamp', 'desk lamp'], must: ['lamp', 'lamps'], prefer: ['table', 'desk', 'bedside'], ban: ['floor', 'street', 'streetlight', 'lantern', 'neon'], banPeople: true },
      dummy: { categories: ['home-decoration'], terms: ['lamp'], ban: [] } },
    { id: 'speaker', cat: 'Electronics', name: 'Bluetooth Speaker', title: 'Mini Bluetooth Speaker',
      desc: 'Small speaker, big sound.', price: 1899,
      alt: 'Bluetooth speaker', fallback: unsplash('1608043152269-423dbba4e7e1'),
      search: { qs: ['bluetooth speaker', 'portable speaker'], must: ['speaker', 'speakers', 'soundbar', 'loudspeaker'], prefer: ['bluetooth', 'portable'], ban: ['conference', 'microphone', 'stage', 'concert'], banPeople: true },
      dummy: { categories: ['mobile-accessories'], terms: ['speaker', 'homepod', 'echo'], ban: ['watch', 'earphone', 'headphone'] } }
  ];
  PRODUCTS.forEach(p => { p.keep = true; });                       // originals keep their previous (curated) photo links
  ['sunglasses', 'lamp', 'speaker'].forEach(id => { PRODUCTS.find(p => p.id === id).featured = true; });

  /* Generated listing: cat | name | Pixabay queries | extra must-words ('!' = exact list) | min | max | banned words.
     Every variant of a type shares one search profile, so photos come from the same strict relevance rules. */
  const TYPES = [
    ['Fashion','Running Shoes','running shoes,sports shoes','shoe,sneaker,sneakers,runner,footwear',899,3999,'boot,sandal,heel,heels'],
    ['Fashion','Formal Shoes','leather shoes,formal shoes','!shoe,shoes,oxford,loafers,footwear',1299,5999,'sneaker,sneakers,running,sport,boot,sandal'],
    ['Fashion','Leather Wallet','leather wallet,wallet','billfold',349,1499,''],
    ['Fashion','Handbag','handbag,leather handbag','purse,tote',999,4999,''],
    ['Fashion','Baseball Cap','baseball cap,cap hat','!cap,caps,hat,hats,baseballcap',299,899,''],
    ['Fashion','Analog Watch','wrist watch,analog watch','!watch,watches,wristwatch',1299,7999,'smartwatch,smart,fitness,wearable'],
    ['Fashion','Silver Necklace','silver necklace,necklace jewelry','!necklace,necklaces,pendant',499,2999,''],
    ['Fashion','Bracelet','bracelet,bracelet jewelry','bangle',399,1999,''],
    ['Fashion','Leather Belt','leather belt,belt','',399,1499,''],
    ['Fashion','Travel Backpack','backpack,travel backpack','rucksack,daypack',799,2999,'hiking,trekking,camping,mountain,tent'],
    ['Fashion','Sunglasses','sunglasses,sunglasses fashion','shades,eyewear',499,2499,''],
    ['Fashion','Silk Scarf','silk scarf,scarf','shawl',399,1499,''],
    ['Electronics','Wireless Headphones','wireless headphones,headphones','!headphone,headphones,headset',1299,9999,''],
    ['Electronics','Wireless Earbuds','wireless earbuds,earbuds','!earbud,earbuds,airpods',799,5999,'headphone,headphones,headset'],
    ['Electronics','Bluetooth Speaker','bluetooth speaker,portable speaker','!speaker,speakers,loudspeaker,soundbar',999,7999,'conference,microphone,stage,concert'],
    ['Electronics','Laptop','laptop,laptop computer','notebook',24999,79999,'phone,tablet'],
    ['Electronics','Smartphone','smartphone,mobile phone','!smartphone,smartphones,mobile,cellphone',8999,59999,'laptop,tablet,headphone'],
    ['Electronics','Tablet','tablet,tablet computer','!tablet,tablets,ipad',9999,49999,'laptop,smartphone,phone,pill,pills,medicine,drug'],
    ['Electronics','Wireless Mouse','computer mouse,wireless mouse','!mouse,mice',399,2999,'animal,rat,pet,cute'],
    ['Electronics','Mechanical Keyboard','mechanical keyboard,keyboard','',1299,8999,'piano,music'],
    ['Electronics','Power Bank','power bank,portable charger','!powerbank,charger',699,3499,'solar'],
    ['Electronics','Digital Camera','digital camera,camera','!camera,cameras,dslr',14999,89999,'video,film,security,drone'],
    ['Electronics','Game Controller','game controller,gamepad','!controller,gamepad,joystick',1499,5999,'console'],
    ['Electronics','Monitor','computer monitor,monitor display','!monitor,monitors',6999,34999,''],
    ['Home','Coffee Mug','coffee mug,ceramic mug','!mug,mugs,cup,cups,coffeemug',299,899,'beer,wine,cocktail,trophy'],
    ['Home','Table Lamp','table lamp,desk lamp','!lamp,lamps',899,3999,'floor,street,streetlight,lantern,neon'],
    ['Home','Throw Pillow','throw pillow,cushion','!pillow,pillows,cushion,cushions',399,1499,'bed,sleep,hotel'],
    ['Home','Scented Candle','scented candle,candle','!candle,candles',299,1299,'birthday,cake,church'],
    ['Home','Wall Clock','wall clock,clock','!clock,clocks',699,2999,'alarm,tower'],
    ['Home','Plant Pot','plant pot,flower pot','!pot,pots,planter,planters,flowerpot',299,1499,'coffee,tea,cooking,kitchen'],
    ['Home','Ceramic Vase','vase,flower vase','!vase,vases',499,2499,''],
    ['Home','Dinner Plate Set','dinner plate,ceramic plate','!plate,plates,dinnerware',799,3499,'food,meal,pizza,cake'],
    ['Home','Photo Frame','photo frame,picture frame','!frame,frames,photoframe',299,1599,'glasses,bike'],
    ['Home','Cutting Board','cutting board,wooden board','!cuttingboard,chopping,choppingboard',499,1999,'food,vegetable,knife'],
    ['Home','Water Bottle','water bottle,steel bottle','!waterbottle,thermos,flask',399,1999,'plastic,gym'],
    ['Home','Storage Basket','storage basket,wicker basket','!basket,baskets,wicker',499,1999,'fruit,picnic,easter,food'],
    ['Beauty','Face Cream','face cream,moisturizer cream','!cream,facecream,moisturizer',399,2499,'body,hand,sunscreen,lotion'],
    ['Beauty','Perfume','perfume bottle,perfume','!perfume,perfumes,fragrance',799,5999,''],
    ['Beauty','Lipstick','lipstick,red lipstick','!lipstick,lipsticks',299,1999,'nail,lipgloss'],
    ['Beauty','Nail Polish','nail polish,nail polish bottles','!nailpolish,manicure,nailvarnish',199,999,''],
    ['Beauty','Face Serum','face serum,serum dropper bottle','!serum,serums,dropper',599,2999,''],
    ['Beauty','Shampoo','shampoo bottle,shampoo','conditioner',249,999,'dog,pet'],
    ['Beauty','Soap Bar','soap bar,handmade soap','',99,599,'dish,liquid'],
    ['Beauty','Body Lotion','body lotion,lotion bottle','!lotion,bodylotion',299,1499,'face'],
    ['Beauty','Makeup Brush Set','makeup brushes,makeup brush','!makeupbrush,makeupbrushes,brushes',399,2499,'paint,painting,art,hair'],
    ['Beauty','Eyeshadow Palette','eyeshadow palette,makeup palette','!eyeshadow,palette',499,2999,'paint,art'],
    ['Beauty','Sunscreen','sunscreen,sunscreen lotion','!sunscreen,sunblock',299,1499,'beach'],
    ['Beauty','Lip Balm','lip balm,lip care','!lipbalm,balm',99,499,'']
  ];
  const ADJ = ['Aura', 'Nova', 'Zenith', 'Lumen', 'Ember', 'Onyx', 'Solace', 'Vertex', 'Haven', 'Pulse', 'Echo', 'Drift'];
  const BLURB = { Fashion: 'Everyday style, made to last.', Electronics: 'Smart performance for daily life.', Home: 'Small touches that warm up a room.', Beauty: 'Gentle care, simply made.' };
  const VARIANTS = 8, generated = [];
  TYPES.forEach((t, ti) => {
    const words = t[1].toLowerCase().split(' '), last = words[words.length - 1];
    const must = t[3].charAt(0) === '!' ? t[3].slice(1).split(',') : [last, last.replace(/s$/, '')].concat(t[3] ? t[3].split(',') : []);
    const search = { qs: t[2].split(','), must: must, ban: t[6] ? t[6].split(',') : [], banPeople: true };
    for (let v = 0; v < VARIANTS; v++) {
      const raw = t[4] + (t[5] - t[4]) * (((ti * 7 + v * 5) % 10) / 9);
      const price = Math.max(9, Math.round(raw / 10) * 10 - 1);
      const name = ADJ[(ti * 3 + v) % ADJ.length] + ' ' + t[1];
      (generated[v] = generated[v] || []).push({
        id: 'g' + ti + '-' + v, cat: t[0], name: name, title: name, desc: BLURB[t[0]], price: price,
        was: v % 3 === 0 ? Math.round(price * 1.35 / 10) * 10 - 1 : undefined, alt: name, gen: true, search: search
      });
    }
  });
  generated.forEach(round => round.forEach(p => PRODUCTS.push(p)));       // interleaved, so "Everything" stays varied

  const CRAFTS = [
    ['diya', 'Brass Diya Set of 6', 'Moradabad', 649, 899, 'brass diya,oil lamp', 'diya,lamp,lamps,brass,candle', 'Hand-finished brass lamps for festivals and quiet evenings.'],
    ['vase', 'Blue Pottery Vase', 'Jaipur', 899, 1299, 'blue pottery vase,ceramic vase', 'vase,vases,pottery,ceramic', 'Glazed by hand in the Jaipur blue pottery tradition.'],
    ['stole', 'Handloom Cotton Stole', 'Varanasi', 799, 1199, 'handloom scarf,cotton scarf', 'scarf,stole,shawl,textile,fabric', 'Light, soft and woven on a handloom.'],
    ['toys', 'Channapatna Wooden Toys', 'Karnataka', 549, 0, 'wooden toys,wooden toy', 'toy,toys,wooden,wood', 'Lacquered wooden toys from the toy town of Karnataka.'],
    ['madhubani', 'Madhubani Art Print', 'Bihar', 1199, 1699, 'madhubani painting,folk art painting', 'painting,art,madhubani,folk', 'Folk art from Mithila, ready for your wall.'],
    ['jute', 'Jute Market Tote', 'West Bengal', 449, 599, 'jute bag,jute tote', 'jute,bag,tote,bags', 'A sturdy everyday tote woven from natural jute.']
  ];
  CRAFTS.forEach(c => PRODUCTS.push({ id: 'in-' + c[0], cat: 'Crafts', name: c[1], title: c[1], region: c[2], brand: c[2] + ' Artisans', desc: c[7], price: c[3], was: c[4] || undefined, alt: c[1], search: { qs: c[5].split(','), must: c[6].split(','), ban: [], banPeople: true }, dummy: { categories: [], terms: [], ban: [] } }));
  const BRANDS = { Fashion: ['Urbane', 'Kaveri Co.', 'Nirvaan', 'Studio Mehr'], Electronics: ['Voltix', 'Sonara', 'Pulse Labs', 'Nexa'], Home: ['Gharana', 'Casa Nila', 'Hearth & Co', 'Terra'], Beauty: ['Ayu Naturals', 'Veda Glow', 'Rasa', 'Soham'] };
  PRODUCTS.forEach((p, i) => {            // sample data: stable per product, so ratings and stock never jump around
    let h = 7; for (let k = 0; k < p.id.length; k++) h = (h * 31 + p.id.charCodeAt(k)) >>> 0;
    p.order = i; p.brand = p.brand || BRANDS[p.cat][h % 4];
    p.rating = +(3.6 + (h % 14) / 10).toFixed(1); p.rcount = 40 + (h >> 3) % 2400;
    p.stock = h % 17 === 0 ? 0 : (h % 11 === 0 ? 3 : 25);
  });
  const GEN_SEARCH = PRODUCTS.filter(p => p.gen).map(p => p.search);
  const FOREIGN = new Map();
  const foreignOf = prof => { if (!FOREIGN.has(prof)) FOREIGN.set(prof, foreignFor(prof, GEN_SEARCH)); return FOREIGN.get(prof); };
  const BY_ID = new Map(PRODUCTS.map(p => [p.id, p]));
  const BANNER = { url: unsplash('1607082349566-187342175e2f'), alt: 'Sale tags and a red gift box with 50% off' };
  SS.catalog = { products: PRODUCTS, byId: BY_ID, CAT_LABEL: CAT_LABEL, BANNER: BANNER };

  /* Live listing: products created from a search the built-in catalogue cannot answer (see worker.js /api/search).
     They join PRODUCTS/BY_ID, so cart, wishlist, quick view and compare work on them like on any other item. */
  const DYN_KEY = 'ss.live.v2';                     // v2: older saved results had off-topic photos
  function addLive(rows) {
    let added = 0;
    (Array.isArray(rows) ? rows : []).forEach(r => {
      if (!r || BY_ID.has(r.id) || !CAT_LABEL[r.cat] || !/^\/api\/img\?u=/.test(r.img || '')) return;
      let h = 7; for (let k = 0; k < r.id.length; k++) h = (h * 31 + r.id.charCodeAt(k)) >>> 0;
      const p = Object.assign({}, r, { alt: r.name, brand: (BRANDS[r.cat] || BRANDS.Home)[h % 4], order: PRODUCTS.length, live: true });
      PRODUCTS.push(p); BY_ID.set(p.id, p); added++;
    });
    return added;
  }
  function saveLive() {
    const rows = PRODUCTS.filter(p => p.live).slice(-48).map(p => ({ id: p.id, cat: p.cat, name: p.name, title: p.title, price: p.price, was: p.was, desc: p.desc, img: p.img, credit: p.credit, rating: p.rating, rcount: p.rcount, stock: p.stock, tags: p.tags }));
    try { store.set(DYN_KEY, JSON.stringify(rows)); } catch (_) {}
  }
  try { addLive(JSON.parse(store.get(DYN_KEY) || '[]')); } catch (_) {}

  /* ======================================================================== 7. relevance
     Pure functions: decide whether a photo may represent a product.
     A Pixabay photo is rejected when ANY of these is true:
       - it is not a photo
       - its tags (or URL slug) contain a banned word, or a people word when the product asks for product-only shots
       - its tags mention another product's keywords (a "headphones" photo tagged "watch" never lands on the watch)
       - its tags contain none of the product's required keywords
       - the product has context words and none of them appear
     Survivors are ranked: earlier tag position, more keyword hits, preferred words, then popularity. */
  const PEOPLE = ['woman', 'women', 'man', 'men', 'girl', 'boy', 'people', 'person', 'child', 'children', 'kid', 'kids', 'model', 'portrait',
    'face', 'lady', 'male', 'female', 'couple', 'family', 'baby', 'student', 'teenager', 'selfie', 'fashionable'];
  const MIN_SCORE = 10;

  const tokens = str => String(str || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  /* Adds each word, a naive singular, and adjacent words glued together ("smart watch" -> "smartwatch"). */
  function addPhrase(set, str) {
    const t = tokens(str);
    for (let i = 0; i < t.length; i++) {
      set.add(t[i]);
      if (t[i].length > 3 && t[i].charAt(t[i].length - 1) === 's') set.add(t[i].slice(0, -1));
      if (i < t.length - 1) set.add(t[i] + t[i + 1]);
    }
  }
  function wordsOf(hit) {
    const set = new Set();
    String(hit.tags || '').split(',').forEach(tag => addPhrase(set, tag));
    try {
      const slug = new URL(hit.pageURL).pathname.split('/').filter(Boolean).pop() || '';
      addPhrase(set, slug.replace(/-\d+$/, ''));
    } catch (_) {}
    return set;
  }
  function tagIndexOfFirst(hit, mustSet) {
    const tags = String(hit.tags || '').split(',');
    for (let i = 0; i < tags.length; i++) {
      if (tokens(tags[i]).some(x => mustSet.has(x) || (x.length > 3 && x.charAt(x.length - 1) === 's' && mustSet.has(x.slice(0, -1))))) return i;
    }
    return -1;
  }
  /* Keywords that belong to OTHER products, minus anything this product legitimately uses itself. */
  function foreignFor(own, allProfiles) {
    const mine = new Set([].concat(own.must, own.context || [], own.prefer || []));
    const out = new Set();
    allProfiles.forEach(p => { if (p !== own) p.must.forEach(m => { if (!mine.has(m)) out.add(m); }); });
    return Array.from(out);
  }

  function scorePixabay(hit, profile, foreign) {
    if (!hit || !hit.webformatURL) return { score: -1, reason: 'no-url' };
    if (hit.type && hit.type !== 'photo') return { score: -1, reason: 'not-photo' };

    const words = wordsOf(hit);
    const banned = (profile.ban || []).concat(profile.banPeople ? PEOPLE : []);
    for (let i = 0; i < banned.length; i++) if (words.has(banned[i])) return { score: -1, reason: 'ban:' + banned[i] };
    for (let i = 0; i < foreign.length; i++) if (words.has(foreign[i])) return { score: -1, reason: 'other-product:' + foreign[i] };

    const mustSet = new Set(profile.must);
    const hits = profile.must.filter(m => words.has(m)).length;
    if (!hits) return { score: -1, reason: 'no-keyword' };
    if (profile.context && profile.context.length && !profile.context.some(c => words.has(c))) return { score: -1, reason: 'no-context' };

    let idx = tagIndexOfFirst(hit, mustSet);
    if (idx < 0) idx = 6;                                  // matched only via the URL slug
    const pref = (profile.prefer || []).filter(p => words.has(p)).length;
    const pop = Math.log10((hit.likes || 0) + (hit.downloads || 0) + 1);
    const iw = hit.imageWidth || 0, ih = hit.imageHeight || 0;
    const shape = iw && ih ? Math.max(0, 1 - Math.abs(iw / ih - 0.95)) * 8 : 0;      // closest to square/portrait
    const res = iw && ih ? Math.min(Math.sqrt(iw * ih) / 1000, 2) * 3 : 0;            // bigger source = sharper
    const score = 60 - Math.min(idx, 8) * 5 + hits * 4 + pref * 6 + pop * 2 + shape + res;
    return score < MIN_SCORE ? { score: -1, reason: 'low-score' } : { score: score, reason: 'ok' };
  }

  /* Best acceptable Pixabay hit, or null. Also returns a count of why the others were rejected. */
  function pickPixabay(hits, profile, foreign, used, accept) {
    let best = null;
    const rejected = {};
    const note = r => { const k = r.split(':')[0]; rejected[k] = (rejected[k] || 0) + 1; };
    (hits || []).forEach(hit => {
      if (!hit || used.has(hit.id)) { note('already-used'); return; }
      if (!accept(hit.largeImageURL || hit.webformatURL)) { note('url-not-usable'); return; }
      const s = scorePixabay(hit, profile, foreign);
      if (s.score < 0) { note(s.reason); return; }
      if (!best || s.score > best.score) best = { hit: hit, score: s.score };
    });
    return { pick: best, rejected: rejected };
  }

  const hasWord = (text, term) => new RegExp('(^|[^a-z0-9])' + escapeRegExp(term)).test(text);

  /* Best DummyJSON item for a profile {categories, terms, prefer, ban}, or null. */
  function pickDummy(items, prof, used, accept) {
    const allowed = new Set(prof.categories);
    const any = prof.terms.indexOf('*') !== -1;
    let best = null;
    items.forEach(it => {
      if (!it || used.has(it.id) || !allowed.has(it.category)) return;
      const url = it.thumbnail || (it.images && it.images[0]);
      if (!url || !accept(url)) return;
      const title = String(it.title || '').toLowerCase();
      const text = [title].concat((it.tags || []).map(String)).join(' ').toLowerCase();
      if ((prof.ban || []).some(b => hasWord(text, b))) return;
      let score = 0;
      if (any) score = 1;
      else {
        const ti = prof.terms.findIndex(t => hasWord(title, t));
        const gi = ti >= 0 ? ti : prof.terms.findIndex(t => hasWord(text, t));
        if (gi < 0) return;
        score = (ti >= 0 ? 50 : 20) + (prof.terms.length - gi);
      }
      score += (prof.prefer || []).filter(p => hasWord(text, p)).length * 10 + (Number(it.rating) || 0);
      if (!best || score > best.score) best = { item: it, url: url, score: score };
    });
    return best;
  }
  SS.relevance = { scorePixabay: scorePixabay, pickPixabay: pickPixabay, pickDummy: pickDummy, foreignFor: foreignFor, PEOPLE: PEOPLE };

  /* ======================================================================== 8. pixabay
     - Responses are cached for 24 hours (API terms). The key is never part of a cache key.
     - 429 pauses Pixabay until the rate-limit window resets; a rejected key pauses it for an hour.
     - Two consecutive network failures pause it for a minute. Nothing here ever retries a request. */
  const pxLog = scope('pixabay');
  const px = { pausedUntil: 0, reason: '', failures: 0, requests: 0, cacheHits: 0 };
  const pxInflight = new Map();
  const PX_KEEP = ['id', 'pageURL', 'type', 'tags', 'webformatURL', 'largeImageURL', 'imageWidth', 'imageHeight', 'user', 'likes', 'downloads'];

  const pxAvailable = () => Date.now() >= px.pausedUntil && w.navigator.onLine !== false;
  function pxWhy() {
    if (w.navigator.onLine === false) return 'offline';
    if (Date.now() < px.pausedUntil) return 'paused: ' + px.reason;
    return 'available';
  }
  function pxPause(reason, ms) {
    px.reason = reason; px.pausedUntil = Date.now() + ms;
    pxLog.warn('Pixabay paused (' + reason + ') for ' + Math.round(ms / 1000) + 's. DummyJSON will be used instead.');
  }

  function pxSearch(q) {
    q = String(q).trim().slice(0, 100);
    const params = new URLSearchParams({ q: q, lang: 'en', image_type: 'photo', safesearch: 'true', order: 'popular', min_width: '900', min_height: '800', per_page: '60' });
    const cacheKey = 'px|' + params.toString();            // no key in here
    const cached = store.cache.get(cacheKey);
    if (cached) { px.cacheHits++; pxLog.debug('cache hit', q, cached.length + ' hits'); return Promise.resolve(cached); }
    if (pxInflight.has(cacheKey)) return pxInflight.get(cacheKey);

    const p = (async () => {
      px.requests++;
      try {
        const { data } = await getJSON(config.PIXABAY_ENDPOINT + '?' + params.toString());
        px.failures = 0;
        const hits = (data.hits || []).map(h => { const o = {}; PX_KEEP.forEach(k => { o[k] = h[k]; }); return o; });
        store.cache.set(cacheKey, hits, config.CACHE_TTL_MS);
        pxLog.debug('fetched', q, hits.length + ' hits');
        return hits;
      } catch (e) {
        if (e.status === 429) {
          const reset = e.headers && Number(e.headers.get('X-RateLimit-Reset'));
          pxPause('rate limit', (reset > 0 ? reset : 60) * 1000);
        } else if (e.status === 400 || e.status === 401 || e.status === 403) {
          pxPause('API proxy refused the request (HTTP ' + e.status + ')', 10 * 60 * 1000);
        } else if (++px.failures >= 2) {
          pxPause(e.message, 60 * 1000);
        }
        throw e;
      } finally { pxInflight.delete(cacheKey); }
    })();
    pxInflight.set(cacheKey, p);
    return p;
  }

  /* Pixabay answers direct image links with HTTP 429 under load, so photos are fetched by the Worker (cached) instead. */
  const viaWorker = u => '/api/img?u=' + encodeURIComponent(u);

  async function pxBest(product, used, accept) {
    const prof = product.search;
    const foreign = foreignOf(prof);
    const trace = [];
    for (const q of prof.qs) {
      if (!pxAvailable()) { trace.push('stopped: ' + pxWhy()); break; }
      let hits;
      try { hits = await pxSearch(q); }
      catch (e) { trace.push('"' + q + '": failed (' + e.message + ')'); continue; }
      const r = pickPixabay(hits, prof, foreign, used, accept);
      if (!r.pick) { trace.push('"' + q + '": ' + hits.length + ' hits, none relevant ' + JSON.stringify(r.rejected)); continue; }
      used.add(r.pick.hit.id);
      trace.push('"' + q + '": picked #' + r.pick.hit.id + ' (score ' + r.pick.score.toFixed(1) + ', tags: ' + r.pick.hit.tags + ')');
      return {
        source: 'pixabay', url: viaWorker(r.pick.hit.webformatURL || r.pick.hit.largeImageURL), fit: 'cover', alt: product.alt,
        credit: { user: r.pick.hit.user, page: r.pick.hit.pageURL },
        meta: { id: r.pick.hit.id, tags: r.pick.hit.tags, query: q }, trace: trace
      };
    }
    if (product.gen && pxAvailable()) {      // every relevant photo is taken: reuse the best one rather than show nothing
      for (const q of prof.qs) {
        let hits; try { hits = await pxSearch(q); } catch (_) { break; }
        const r = pickPixabay(hits, prof, foreign, new Set(), accept);
        if (!r.pick) continue;
        trace.push('"' + q + '": reused #' + r.pick.hit.id);
        return { source: 'pixabay', url: viaWorker(r.pick.hit.webformatURL || r.pick.hit.largeImageURL), fit: 'cover', alt: product.alt,
          credit: { user: r.pick.hit.user, page: r.pick.hit.pageURL }, meta: { id: r.pick.hit.id, tags: r.pick.hit.tags, query: q }, trace: trace };
      }
    }
    return { source: null, trace: trace };
  }
  SS.pixabay = { available: pxAvailable, whyUnavailable: pxWhy, best: pxBest, state: px };

  /* ======================================================================== 9. dummyjson
     Each product lists the DummyJSON categories it may draw from, so a result can never come from another
     product's category. Category lists are cached for 24 hours. Never retries. */
  const djLog = scope('dummyjson');
  const dj = { pausedUntil: 0, failures: 0, requests: 0 };
  const djLists = new Map();                // category slug -> Promise<items[]>
  const DJ_FIELDS = 'title,tags,category,rating,thumbnail,images';

  const djAvailable = () => Date.now() >= dj.pausedUntil && w.navigator.onLine !== false;
  function djWhy() {
    if (w.navigator.onLine === false) return 'offline';
    if (Date.now() < dj.pausedUntil) return 'paused after repeated failures';
    return 'available';
  }

  function djCategory(slug) {
    if (djLists.has(slug)) return djLists.get(slug);
    const key = 'dj|' + slug;
    const cached = store.cache.get(key);
    if (cached) { djLog.debug('cache hit', slug); const p = Promise.resolve(cached); djLists.set(slug, p); return p; }
    const p = (async () => {
      dj.requests++;
      try {
        const url = config.DUMMYJSON_BASE + '/products/category/' + encodeURIComponent(slug) + '?limit=0&select=' + DJ_FIELDS;
        const { data } = await getJSON(url);
        dj.failures = 0;
        const items = (data.products || []).map(x => ({ id: x.id, title: x.title, tags: x.tags, category: x.category, rating: x.rating, thumbnail: x.thumbnail, images: x.images }));
        store.cache.set(key, items, config.CACHE_TTL_MS);
        djLog.debug('fetched', slug, items.length + ' items');
        return items;
      } catch (e) {
        djLists.delete(slug);               // a later page load may try again, never within this load
        if (++dj.failures >= 3) { dj.pausedUntil = Date.now() + 60 * 1000; djLog.warn('DummyJSON paused after repeated failures'); }
        throw e;
      }
    })();
    djLists.set(slug, p);
    return p;
  }

  async function djBest(product, used, accept) {
    const prof = product.dummy;
    const trace = [];
    let items = [];
    for (const slug of prof.categories) {
      if (!djAvailable()) { trace.push('stopped: ' + djWhy()); break; }
      try { const got = await djCategory(slug); trace.push(slug + ': ' + got.length + ' items'); items = items.concat(got); }
      catch (e) { trace.push(slug + ': failed (' + e.message + ')'); }
    }
    const pick = pickDummy(items, prof, used, accept);
    if (!pick) { trace.push('no item passed the relevance rules'); return { source: null, trace: trace }; }
    used.add(pick.item.id);
    return {
      source: 'dummyjson', url: pick.url, fit: 'contain', alt: product.alt,
      meta: { id: pick.item.id, title: pick.item.title, category: pick.item.category }, trace: trace
    };
  }
  SS.dummyjson = { available: djAvailable, whyUnavailable: djWhy, best: djBest, state: dj };

  /* ======================================================================== 10. images
     One photo per product: Pixabay, then DummyJSON, then the curated fallback.
     Broken-link policy: every candidate is checked against the host allowlist; an <img> that fails to load is
     shown as a placeholder, NEVER swapped for another URL and NEVER re-requested. */
  const imgLog = scope('images');
  const failed = new Set();
  const results = new Map();
  const usedIds = { pixabay: new Set(), dummyjson: new Set() };
  const usable = url => isAllowedImageUrl(url) && !failed.has(url);

  function markFailed(url) {
    if (!url || failed.has(url)) return;
    failed.add(url);
    imgLog.warn('image failed to load, will not be requested again:', url);
  }
  /* Capture phase: <img> error events do not bubble. */
  function watchBroken(root, onBroken) {
    root.addEventListener('error', e => {
      const t = e.target;
      if (!t || t.tagName !== 'IMG') return;
      markFailed(t.currentSrc || t.src);
      if (onBroken) onBroken(t);
    }, true);
  }

  async function resolveOne(product) {
    const trace = [];
    if (product.img && usable(product.img)) return { source: 'pixabay', url: product.img, fit: 'cover', alt: product.alt || product.name, credit: product.credit, trace: ['live listing photo'] };
    if (product.keep && usable(product.fallback)) return { source: 'static', url: product.fallback, fit: 'cover', alt: product.alt, trace: ['original photo link kept'] };
    if (!product.keep && px.reason === 'rate limit' && Date.now() < px.pausedUntil) await new Promise(r => setTimeout(r, Math.min(px.pausedUntil - Date.now(), 65000) + 250));   // wait out the limit instead of giving up on this photo
    if (pxAvailable()) {
      try {
        const r = await pxBest(product, usedIds.pixabay, usable);
        r.trace.forEach(x => trace.push('pixabay ' + x));
        if (r.source) return Object.assign(r, { trace: trace });
      } catch (e) { trace.push('pixabay error: ' + e.message); }
    } else trace.push('pixabay skipped (' + pxWhy() + ')');

    if (product.dummy && djAvailable()) {
      try {
        const r = await djBest(product, usedIds.dummyjson, usable);
        r.trace.forEach(x => trace.push('dummyjson ' + x));
        if (r.source) return Object.assign(r, { trace: trace });
      } catch (e) { trace.push('dummyjson error: ' + e.message); }
    } else trace.push('dummyjson skipped (' + djWhy() + ')');

    if (usable(product.fallback)) {
      trace.push('using curated fallback');
      return { source: 'static', url: product.fallback, fit: 'cover', alt: product.alt, trace: trace };
    }
    trace.push('no usable image: showing placeholder');
    return { source: 'none', url: null, fit: 'cover', alt: product.alt, trace: trace };
  }

  async function resolveAll(products, onEach) {
    const tasks = products.map(p => async () => {
      const res = await resolveOne(p);
      results.set(p.id, res);
      imgLog.debug(p.id + ' -> ' + res.source, res.url || '', res.trace);
      onEach(p, res);
      return res;
    });
    await pool(config.MAX_PARALLEL_REQUESTS, tasks);
    const set = new Set();
    results.forEach(r => { if (r.source && r.source !== 'none') set.add(r.source); });
    bus.emit('images:done', { sources: Array.from(set) });
  }
  /* Photos are fetched lazily: a card asks for its photo only when it is drawn (3 at a time). */
  const srcs = () => { const set = new Set(); results.forEach(r => { if (r.source && r.source !== 'none') set.add(r.source); }); return Array.from(set); };
  const pending = new Set(), waiting = [];
  let active = 0;
  function queueImage(p) {
    if (results.has(p.id) || pending.has(p.id)) return;
    pending.add(p.id); waiting.push(p); pump();
  }
  function pump() {
    while (active < config.MAX_PARALLEL_REQUESTS && waiting.length) {
      const p = waiting.shift();
      active++;
      resolveOne(p).then(res => {
        results.set(p.id, res);
        imgLog.debug(p.id + ' -> ' + res.source, res.url || '', res.trace);
        gridSetImage(p.id, res);
        bus.emit('image:resolved', { id: p.id });
      }).catch(e => imgLog.warn('resolve failed', p.id, e.message)).finally(() => {
        active--; pending.delete(p.id);
        if (!active && !waiting.length) bus.emit('images:done', { sources: srcs() });
        pump();
      });
    }
  }
  SS.images = { queue: queueImage, resolve: resolveOne, resolveAll: resolveAll, get: id => results.get(id), all: results, failed: failed, usable: usable, markFailed: markFailed, watchBroken: watchBroken };

  /* ======================================================================== 11. ui */
  let toastEl, toastTimer = 0;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }
  function renderCredits(sources) {
    const el = $('#credits');
    if (!el) return;
    const link = (href, label) => '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    const parts = [];
    if (sources.indexOf('pixabay') !== -1) parts.push(link('https://pixabay.com', 'Pixabay'));
    if (sources.indexOf('dummyjson') !== -1) parts.push(link('https://dummyjson.com', 'DummyJSON'));
    if (sources.indexOf('static') !== -1) parts.push(link('https://unsplash.com', 'Unsplash'));
    el.innerHTML = parts.length ? 'Product photos from ' + parts.join(', ') + '.' : '';
    el.hidden = !parts.length;
  }
  function uiInit() {
    toastEl = $('#toast');
    const nav = $('#nav');
    if ('IntersectionObserver' in w) new IntersectionObserver(([en]) => { nav.dataset.stuck = String(!en.isIntersecting); }).observe($('#sentinel'));

    const dlg = $('#auth');
    $('#authBtn').addEventListener('click', () => { if (dlg.showModal) dlg.showModal(); });
    $('#authClose').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    $('#authForm').addEventListener('submit', e => {
      e.preventDefault();
      const first = String(new FormData(e.target).get('name') || '').trim().split(/\s+/)[0] || 'there';
      e.target.reset(); dlg.close();
      toast('Thanks, ' + first + '. This is a demo, so nothing was saved.');
    });
    $$('[data-copy]').forEach(b => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText('SPREE10'); toast('SPREE10 copied. Apply it in your cart.'); }
      catch (_) { toast('Your code is SPREE10. Enter it in your cart.'); }
    }));
    document.addEventListener('keydown', e => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = document.activeElement && document.activeElement.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || dlg.open || isCartOpen()) return;
      e.preventDefault(); $('#q').focus();
    });
    bus.on('images:done', d => renderCredits(d.sources.concat(['static'])));   // the banner is always from Unsplash
  }
  SS.ui = { toast: toast };

  /* ======================================================================== 12. grid + filter */
  const gridLog = scope('grid');
  const gstate = { cat: 'All', q: '' };
  const F = { sort: 'featured', max: null, rate: 0, stock: false, wish: false };
  const disc = p => (p.was ? 1 - p.price / p.was : 0);
  const SORTS = { popular: (a, b) => b.rcount - a.rcount, low: (a, b) => a.price - b.price, high: (a, b) => b.price - a.price, rating: (a, b) => b.rating - a.rating || b.rcount - a.rcount, newest: (a, b) => b.order - a.order, deals: (a, b) => disc(b) - disc(a) };
  const wish = new Set(); try { JSON.parse(store.get('ss.wish') || '[]').forEach(id => { if (BY_ID.has(id)) wish.add(id); }); } catch (_) {}
  const entries = new Map();
  let grid, countEl, emptyEl, emptyMsg, search;

  const HEART = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5.5 6.2 5.5c2 0 3.2 1.1 3.8 2 .6-.9 1.8-2 3.8-2 3.2 0 5 3.1 3.7 6.3C19.5 16.4 12 21 12 21Z"/></svg>';
  const rateHTML = p => '<span class="rate" aria-label="Rated ' + p.rating + ' out of 5, ' + p.rcount + ' ratings"><b>★</b> ' + p.rating.toFixed(1) + ' <small>(' + nf.format(p.rcount) + ')</small></span>';
  function cardHTML(p) {
    const off = p.was ? Math.round(disc(p) * 100) : 0, out = p.stock <= 0;
    return '<article class="card tilt" data-id="' + p.id + '"><div class="card-in">' +
      '<div class="media skel" data-ph="' + esc(initial(p.name)) + '" data-qv="' + p.id + '">' + (off ? '<span class="off">−' + off + '%</span>' : '') +
      (out ? '<span class="stk">Sold out</span>' : (p.stock <= 5 ? '<span class="stk">Only ' + p.stock + ' left</span>' : '')) +
      '<button class="heart" type="button" data-wish="' + p.id + '" aria-pressed="' + wish.has(p.id) + '" aria-label="Save ' + esc(p.title) + ' to wishlist">' + HEART + '</button>' +
      '<button class="qvb" type="button" data-qv="' + p.id + '">Quick view</button></div>' +
      '<div class="body">' +
        '<p class="cat">' + esc(p.brand) + ' · ' + CAT_LABEL[p.cat] + '</p>' +
        '<h3>' + esc(p.title) + '</h3>' + rateHTML(p) +
        '<label class="cmp"><input type="checkbox" data-cmp="' + p.id + '"' + (cmp.indexOf(p.id) !== -1 ? ' checked' : '') + '>Compare</label>' +
        '<p class="desc">' + esc(p.desc) + '</p>' +
        '<div class="row">' +
          '<p class="price">' + money(p.price) + (p.was ? '<s>' + money(p.was) + '</s>' : '') + '</p>' +
          '<button class="add" type="button" data-add="' + p.id + '"' + (out ? ' disabled' : '') + ' aria-label="Add ' + esc(p.title) + ' to bag">' +
            '<span class="qty" hidden>0</span><span class="lbl">' + (out ? 'Sold out' : 'Add') + '</span></button>' +
        '</div></div></div></article>';
  }

  const BATCH = 24; let BATCH_ALL = false;
  let list = [], shownN = 0, moreEl, moreIO;
  const hayOf = p => p.hay || (p.hay = (p.name + ' ' + p.title + ' ' + p.cat + ' ' + CAT_LABEL[p.cat] + ' ' + p.brand + ' ' + (p.region || '') + ' ' + (p.tags || '')).toLowerCase());

  /* Draw the next batch of cards. Photos already resolved are applied instantly; the rest are queued. */
  function gridMore() {
    const batch = list.slice(shownN, BATCH_ALL ? list.length : shownN + BATCH);
    if (!batch.length) { moreEl.hidden = true; return; }
    shownN += batch.length;
    const tmp = document.createElement('div');
    tmp.innerHTML = batch.map(cardHTML).join('');
    Array.from(tmp.children).forEach((node, i) => {
      const p = batch[i];
      entries.set(p.id, { p: p, el: node, media: $('.media', node), btn: $('.add', node), qty: $('.qty', node) });
      grid.appendChild(node);
      gridSetQty(p.id, cartQty(p.id));
      const r = results.get(p.id);
      if (r) gridSetImage(p.id, r); else queueImage(p);
    });
    moreEl.hidden = shownN >= list.length;
    if (!moreEl.hidden && moreIO) { moreIO.unobserve(moreEl); moreIO.observe(moreEl); }   // re-check: still in view?
  }

  /* Called once per product when its photo has been chosen. A broken link only ever becomes a placeholder. */
  function gridSetImage(id, res) {
    const e = entries.get(id);
    if (!e) return;
    e.media.classList.remove('skel');
    if (!res.url) { e.media.classList.add('no-img'); return; }
    const img = new Image();
    img.alt = res.alt; img.width = 500; img.height = 550; img.decoding = 'async';
    if (res.fit === 'contain') img.className = 'contain';
    img.addEventListener('load', () => img.classList.add('ready'), { once: true });
    e.media.prepend(img);
    img.src = res.url;
    if (res.credit) e.media.title = 'Photo by ' + res.credit.user + ' on Pixabay';
  }

  /* The Add button shows how many of this item are in the cart: 1, then 2, ... */
  function gridSetQty(id, n) {
    const e = entries.get(id);
    if (!e) return;
    e.qty.textContent = n;
    e.qty.hidden = n === 0;
    e.btn.classList.toggle('has', n > 0);
    e.btn.setAttribute('aria-label', n > 0 ? 'Add another ' + e.p.title + ', ' + n + ' in cart' : 'Add ' + e.p.title + ' to cart');
    if (n > 0 && !reduceMotion() && e.qty.animate) e.qty.animate([{ transform: 'scale(1.45)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  const gridSyncAll = () => entries.forEach((e, id) => gridSetQty(id, cartQty(id)));

  function applyFilter() {
    list = PRODUCTS.filter(p => (!p.live || gstate.q || F.wish) && (gstate.cat === 'All' || p.cat === gstate.cat) && (!gstate.q || gstate.q.split(/\s+/).every(t => hayOf(p).indexOf(t) !== -1)) && (F.max == null || p.price <= F.max) && p.rating >= F.rate && (!F.stock || p.stock > 0) && (!F.wish || wish.has(p.id)));
    if (SORTS[F.sort]) list.sort(SORTS[F.sort]);
    grid.innerHTML = ''; entries.clear(); shownN = 0;
    gridMore();
    countEl.textContent = list.length === 1 ? '1 piece' : list.length + ' pieces';
    emptyEl.hidden = list.length > 0;
    if (!list.length) emptyMsg.textContent = F.wish ? 'Your wishlist is empty. Tap the heart on any product to save it.' : gstate.q ? 'No products match “' + search.value.trim() + '”.' : 'No products match these filters.';
  }
  /* Nothing in the catalogue matches (for example "tv"): ask the Worker for Pixabay photos with believable INR prices. */
  const liveTried = new Set(); let liveSeq = 0, liveT = 0;
  async function liveSearch(q) {
    if (!q || q.length < 2 || liveTried.has(q)) return;
    liveTried.add(q);
    const seq = ++liveSeq;
    emptyMsg.textContent = 'Searching for “' + q + '”…';
    try {
      const ck = 'live2|' + q;
      let rows = store.cache.get(ck);
      if (!rows) {
        const { data } = await getJSON(config.SEARCH_ENDPOINT + '?q=' + encodeURIComponent(q), { timeout: config.LIVE_TIMEOUT_MS });
        rows = data.products || [];
        if (rows.length) store.cache.set(ck, rows, config.CACHE_TTL_MS);
      }
      if (addLive(rows)) saveLive();
      if (seq === liveSeq && gstate.q === q) applyFilter();     // shows the new items, or the normal "no match" message
    } catch (e) {
      liveTried.delete(q);                                       // allow a retry
      gridLog.warn('live search failed', e.message);
      if (seq === liveSeq && gstate.q === q && !list.length) emptyMsg.textContent = 'No products match “' + q + '”. Live search is not reachable right now.';
    }
  }
  function setCat(cat) {
    gstate.cat = cat;
    $$('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === cat)));
    $$('[data-cat]').forEach(a => { if (a.dataset.cat === cat) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
    applyFilter();
  }

  function gridInit() {
    grid = $('#grid'); countEl = $('#count'); emptyEl = $('#empty'); emptyMsg = $('#emptyMsg'); search = $('#q');
    moreEl = $('#more');
    if ('IntersectionObserver' in w) { moreIO = new IntersectionObserver(es => { if (es[0].isIntersecting) gridMore(); }, { rootMargin: '700px 0px' }); moreIO.observe(moreEl); }
    else BATCH_ALL = true;

    $$('[data-filter]').forEach(b => b.addEventListener('click', () => setCat(b.dataset.filter)));
    $$('[data-cat]').forEach(a => a.addEventListener('click', () => setCat(a.dataset.cat)));
    $('#clear').addEventListener('click', () => { search.value = ''; gstate.q = ''; resetPlus(); setCat('All'); });

    let t = 0;
    const commit = now => {
      gstate.q = search.value.trim().toLowerCase();
      if (gstate.q && F.wish) { F.wish = false; syncWish(); }
      if (gstate.q && gstate.cat !== 'All') setCat('All'); else applyFilter();      // a search looks through everything, not just the chip that is on
      clearTimeout(liveT);
      if (gstate.q && !list.length && !F.wish) liveT = setTimeout(() => liveSearch(gstate.q), now === true ? 0 : 700);
      if (gstate.q) { const r = $('#products').getBoundingClientRect(); if (r.top > w.innerHeight * 0.5 || r.bottom < 80) $('#products').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' }); }
    };
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(commit, 120); });
    search.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      clearTimeout(t); commit(true);
    });

    grid.addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) cartAdd(b.dataset.add); });
    bus.on('cart:change', d => gridSetQty(d.id, d.qty));
    bus.on('cart:reset', gridSyncAll);
    setCat('All');
    gridLog.debug('listing ready', PRODUCTS.length + ' products');
  }
  SS.grid = { setImage: gridSetImage, setQty: gridSetQty, entries: entries };

  /* ======================================================================== 13. cart + drawer
     Map id -> qty (O(1) updates), SPREE10 coupon, persistence, slide-in drawer.
     Emits 'cart:change' {id, qty} for one item and 'cart:reset' when everything changes at once. */
  const cartLog = scope('cart');
  const items = new Map();
  let coupon = '', lastFocus = null;
  const el = {};

  const cartQty = id => items.get(id) || 0;
  const isCartOpen = () => !!(el.drawer && el.drawer.classList.contains('open'));

  function cartLoad() {
    try {
      const saved = JSON.parse(store.get(config.CART_KEY) || 'null');
      if (!saved) return;
      (saved.items || []).forEach(([id, q]) => { if (!BY_ID.has(id) || !(q > 0)) return; const m = Math.min(q | 0, config.MAX_QTY, BY_ID.get(id).stock); if (m > 0) items.set(id, m); });
      coupon = saved.coupon === true ? 'SPREE10' : (typeof saved.coupon === 'string' ? saved.coupon : '');
    } catch (e) { cartLog.warn('could not read saved cart', e.message); }
  }
  const cartPersist = () => store.set(config.CART_KEY, JSON.stringify({ items: Array.from(items), coupon: coupon }));

  function cartChange(id, next) {
    if (next <= 0) items.delete(id); else items.set(id, next);
    cartPersist();
    renderCart();
    bus.emit('cart:change', { id: id, qty: cartQty(id) });
  }
  function bump() {
    if (reduceMotion() || !el.count.animate) return;
    el.count.animate([{ transform: 'scale(1.5)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  function cartAdd(id) {
    const p = BY_ID.get(id);
    if (!p) return;
    const q = cartQty(id);
    if (p.stock <= 0) { toast('This item is out of stock.'); return; }
    if (q >= cap(id)) { toast(capMsg(id)); return; }
    cartChange(id, q + 1);
    bump();
    toast(p.title + ' added to cart');
  }

  function thumb(p) {
    const r = results.get(p.id);
    const ok = r && r.url && usable(r.url);
    return '<div class="thumb' + (ok ? '' : ' no-img') + '" data-ph="' + esc(initial(p.name)) + '">' +
      (ok ? '<img src="' + esc(r.url) + '" alt="" width="60" height="60" decoding="async"' + (r.fit === 'contain' ? ' class="contain"' : '') + '>' : '') + '</div>';
  }

  function renderCart() {
    if (!el.lines) return;
    let n = 0, sub = 0, craft = 0, html = '';
    items.forEach((q, id) => {
      const p = BY_ID.get(id);
      n += q; sub += p.price * q; if (p.cat === 'Crafts') craft += p.price * q;
      if (!results.has(id)) queueImage(p);
      html += '<li class="line">' + thumb(p) +
        '<div><p class="line-name">' + esc(p.title) + '</p>' +
        '<p class="line-price">' + money(p.price) + ' each</p>' +
        '<button class="rm" type="button" data-act="rm" data-id="' + id + '" aria-label="Remove ' + esc(p.title) + '">Remove</button></div>' +
        '<div class="stepper" role="group" aria-label="Quantity of ' + esc(p.title) + '">' +
          '<button type="button" data-act="dec" data-id="' + id + '" aria-label="Decrease quantity">−</button>' +
          '<span>' + q + '</span>' +
          '<button type="button" data-act="inc" data-id="' + id + '" aria-label="Increase quantity">+</button>' +
        '</div></li>';
    });
    const T = totalsOf(sub, craft), disc = T.disc;
    el.lines.innerHTML = html;
    el.empty.hidden = n > 0;
    el.count.hidden = n === 0;
    el.count.textContent = n;
    el.btn.setAttribute('aria-label', n ? 'Open cart, ' + n + (n === 1 ? ' item' : ' items') : 'Open cart');
    el.drawerCount.textContent = '(' + n + ')';
    el.sub.textContent = money(sub);
    el.discRow.hidden = !disc;
    el.disc.textContent = '−' + money(disc);
    el.total.textContent = money(T.total); $('#discLbl').textContent = T.label || 'Coupon'; $('#ship').textContent = n ? (T.ship ? money(T.ship) : 'Free') : '₹0';
    $('#shipBar').innerHTML = n ? (T.left > 0 ? 'Add <b>' + money(T.left) + '</b> more for free delivery' : 'You have unlocked free delivery') + '<div class="track"><i style="width:' + Math.max(4, Math.min(100, (FREE_AT - T.left) / FREE_AT * 100)) + '%"></i></div>' : '';
    el.checkout.disabled = n === 0;
    el.coupon.value = coupon; el.coupon.readOnly = !!coupon; el.couponBtn.textContent = coupon ? 'Remove' : 'Apply';
    el.couponMsg.dataset.state = coupon ? T.state : ''; el.couponMsg.textContent = coupon ? T.msg : '';
  }

  function openCart() {
    if (isCartOpen()) return;
    lastFocus = document.activeElement;
    el.drawer.inert = false;
    el.drawer.classList.add('open'); el.scrim.classList.add('open');
    document.body.classList.add('lock');
    el.bg.forEach(n => { n.inert = true; });
    el.btn.setAttribute('aria-expanded', 'true');
    $('#drawerClose').focus();
  }
  function closeCart() {
    if (!isCartOpen()) return;
    el.drawer.classList.remove('open'); el.scrim.classList.remove('open');
    document.body.classList.remove('lock');
    el.bg.forEach(n => { n.inert = false; });
    el.drawer.inert = true;
    el.btn.setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function cartInit() {
    Object.assign(el, {
      drawer: $('#drawer'), scrim: $('#scrim'), btn: $('#cartBtn'), count: $('#cartCount'), drawerCount: $('#drawerCount'),
      lines: $('#lines'), empty: $('#cartEmpty'), sub: $('#sub'), discRow: $('#discRow'), disc: $('#disc'), total: $('#total'),
      checkout: $('#checkout'), coupon: $('#coupon'), couponBtn: $('#couponBtn'), couponMsg: $('#couponMsg'),
      bg: [$('#nav'), $('#main'), $('#footer')]
    });
    cartLoad();

    el.lines.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const id = b.dataset.id, q = cartQty(id), act = b.dataset.act;
      if (act === 'rm' || (act === 'dec' && q <= 1)) cartChange(id, 0);
      else if (act === 'dec') cartChange(id, q - 1);
      else if (act === 'inc') { if (q >= cap(id)) { toast(capMsg(id)); return; } cartChange(id, q + 1); }
      // The list was re-rendered, so put keyboard focus back on the matching control.
      const again = items.has(id) && $('[data-act="' + act + '"][data-id="' + id + '"]', el.lines);
      (again || $('[data-act="inc"]', el.lines) || $('#drawerClose')).focus();
    });
    $('#couponForm').addEventListener('submit', e => {
      e.preventDefault();
      if (coupon) { coupon = ''; cartPersist(); renderCart(); toast('Coupon removed'); return; }
      const v = el.coupon.value.trim().toUpperCase();
      if (!COUPONS[v]) { el.couponMsg.dataset.state = 'error'; el.couponMsg.textContent = v ? 'That code is not valid. Try SPREE10, FLAT200 or INDIA15.' : 'Enter a discount code.'; return; }
      coupon = v; cartPersist(); renderCart(); toast(v + ' applied');
    });
    el.checkout.addEventListener('click', openCheckout);
    el.btn.addEventListener('click', openCart);
    $('#drawerClose').addEventListener('click', closeCart);
    el.scrim.addEventListener('click', closeCart);
    el.drawer.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeCart(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCart(); });

    // A saved cart renders before photos resolve; refresh its thumbnails as each photo arrives.
    bus.on('image:resolved', d => { if (items.has(d.id)) renderCart(); });

    renderCart();
    bus.emit('cart:reset');
  }
  SS.cart = { add: cartAdd, qty: cartQty, items: items, open: openCart, close: closeCart };


  /* ======================================================================== 13b. plus
     Coupons + delivery, wishlist, recently viewed, quick view with PIN check, demo checkout, theme, offers bar. */
  const FREE_AT = 999, SHIP_FEE = 49;
  const COUPONS = {
    SPREE10: { n: 'SPREE10 (10% off)', note: '10% off your first order is applied.', f: s => Math.round(s.sub * 0.1) },
    FLAT200: { n: 'FLAT200 (₹200 off)', note: '₹200 off orders above ₹1,999.', f: () => 200, ok: s => s.sub >= 1999, err: 'FLAT200 needs a subtotal of ₹1,999 or more.' },
    INDIA15: { n: 'INDIA15 (15% off India Finds)', note: '15% off India Finds, up to ₹750.', f: s => Math.min(Math.round(s.craft * 0.15), 750), ok: s => s.craft > 0, err: 'Add an India Finds product to use INDIA15.' }
  };
  function totalsOf(sub, craft) {
    const t = { disc: 0, label: '', msg: '', state: '' }, c = COUPONS[coupon];
    if (coupon && !c) { t.msg = 'That code is no longer valid.'; t.state = 'error'; }
    else if (c) { const s = { sub: sub, craft: craft }; if (c.ok && !c.ok(s)) { t.msg = c.err; t.state = 'error'; } else { t.disc = Math.min(c.f(s), sub); t.label = c.n; t.msg = c.note; t.state = 'ok'; } }
    const after = sub - t.disc; t.ship = sub ? (after >= FREE_AT ? 0 : SHIP_FEE) : 0; t.total = after + t.ship; t.left = FREE_AT - after; t.sub = sub;
    return t;
  }
  const cap = id => Math.min(config.MAX_QTY, BY_ID.get(id).stock);
  const capMsg = id => (BY_ID.get(id).stock < config.MAX_QTY ? 'Only ' + BY_ID.get(id).stock + ' left in stock.' : 'You can add up to ' + config.MAX_QTY + ' of each item.');
  const fmtDay = d => d.toLocaleDateString({ kn: 'kn-IN', hi: 'hi-IN' }[document.documentElement.lang] || 'en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  function eta(pin) {
    if (!/^[1-9]\d{5}$/.test(pin) || pin[0] === '9') return null;
    const days = { 5: 2, 4: 3, 1: 3, 6: 3 }[pin[0]] || (pin[0] > 6 ? 6 : 4), d = new Date(); d.setDate(d.getDate() + days);
    return { days: days, date: d };
  }
  const X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';

  function resetPlus() {
    F.sort = 'featured'; F.max = null; F.rate = 0; F.stock = false; F.wish = false;
    $('#sortSel').value = 'featured'; $('#fPrice').value = ''; $('#fRate').value = '0'; $('#fStock').checked = false; syncWish();
  }
  function syncWish() {
    const n = wish.size, c = $('#wishCount'); c.hidden = !n; c.textContent = n;
    $$('[data-wish]').forEach(b => b.setAttribute('aria-pressed', String(wish.has(b.dataset.wish))));
    $('#wishBtn').setAttribute('aria-pressed', String(F.wish));
  }
  function toggleWish(id) {
    if (wish.has(id)) { wish.delete(id); toast('Removed from wishlist'); } else { wish.add(id); toast('Saved to wishlist'); }
    store.set('ss.wish', JSON.stringify(Array.from(wish))); syncWish(); if (F.wish) applyFilter();
  }

  let recent = [], qv = null;
  try { recent = JSON.parse(store.get('ss.recent') || '[]').filter(id => BY_ID.has(id)); } catch (_) {}
  function renderRecent() {
    const ids = recent.slice(0, 6); $('#recent').hidden = !ids.length; renderReco(ids);
    $('#recentRow').innerHTML = ids.map(id => { const p = BY_ID.get(id); if (!results.has(id)) queueImage(p); return '<button class="rc" type="button" data-qv="' + id + '">' + thumb(p) + '<span><b>' + esc(p.title) + '</b>' + money(p.price) + '</span></button>'; }).join('');
  }
  function openQV(id) {
    const p = BY_ID.get(id), d = $('#qvDlg'); if (!p) return;
    qv = { p: p, qty: 1 };
    const off = p.was ? Math.round(disc(p) * 100) : 0, out = p.stock <= 0;
    const stock = out ? '<b class="bad">Out of stock</b>' : (p.stock <= 5 ? '<b class="warn">Only ' + p.stock + ' left</b>' : '<b class="good">In stock</b>');
    d.innerHTML = '<div class="qv-in"><div class="qv-img skel" id="qvImg" data-ph="' + esc(initial(p.name)) + '"></div><div class="qv-info">' +
      '<div class="dlg-top"><div><p class="cat">' + esc(p.brand) + (p.region ? ' · ' + esc(p.region) : '') + '</p><h2 id="qvT">' + esc(p.title) + '</h2></div><button class="icon-btn" type="button" data-qvx aria-label="Close">' + X + '</button></div>' +
      '<div class="meta">' + rateHTML(p) + stock + '</div>' +
      '<p class="price big">' + money(p.price) + (p.was ? '<s>' + money(p.was) + '</s><em>' + off + '% off</em>' : '') + '</p>' +
      '<p class="fine2">Inclusive of all taxes. Free delivery above ' + money(FREE_AT) + '. Ratings and stock are sample data.</p>' +
      '<p class="pdesc">' + esc(p.desc) + '</p>' +
      '<dl class="spec"><div><dt>Brand</dt><dd>' + esc(p.brand) + '</dd></div><div><dt>Category</dt><dd>' + CAT_LABEL[p.cat] + '</dd></div><div><dt>Returns</dt><dd>7 days (sample)</dd></div></dl>' +
      '<div class="buy"><div class="stepper" role="group" aria-label="Quantity"><button type="button" data-qd="-1" aria-label="Decrease quantity">−</button><span id="qvQty" aria-live="polite">1</span><button type="button" data-qd="1" aria-label="Increase quantity">+</button></div>' +
      '<button class="btn primary glow" type="button" data-qadd' + (out ? ' disabled' : '') + '>Add to bag</button><button class="btn ghost glow" type="button" data-qbuy' + (out ? ' disabled' : '') + '>Buy now</button>' +
      '<button class="heart static" type="button" data-wish="' + p.id + '" aria-pressed="' + wish.has(id) + '" aria-label="Save to wishlist">' + HEART + '</button></div>' +
      '<form class="pin" id="pinForm" novalidate><label for="pinIn">Check delivery to your PIN code</label><div><input id="pinIn" inputmode="numeric" maxlength="6" placeholder="6-digit PIN code" autocomplete="postal-code"><button class="btn ghost" type="submit">Check</button></div><p id="pinRes" role="status"></p></form>' +
      '</div></div>';
    if (!d.open) d.showModal();
    recent = [id].concat(recent.filter(x => x !== id)).slice(0, 12); store.set('ss.recent', JSON.stringify(recent)); renderRecent();
    fillQV();
  }
  function fillQV() {
    if (!qv) return;
    const p = qv.p, r = results.get(p.id), box = $('#qvImg'); if (!box) return;
    if (!r) { queueImage(p); return; }
    box.classList.remove('skel');
    if (!r.url || !usable(r.url)) { box.classList.add('no-img'); return; }
    if ($('img', box)) return;
    const im = new Image(); im.alt = r.alt || p.title; if (r.fit === 'contain') im.className = 'contain'; im.src = r.url; box.prepend(im);
  }

  const STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];
  const PAY = { upi: ['UPI', 'Pay with any UPI app (demo)'], card: ['Credit or debit card', 'Visa, Mastercard, RuPay (demo)'], netbanking: ['Net banking', 'All major banks (demo)'], cod: ['Cash on delivery', 'Pay when your order arrives'] };
  const fld = (id, label, input) => '<label class="field"><span>' + label + '</span>' + input + '<span class="err" id="e-' + id + '" role="alert"></span></label>';
  function bagLines() {
    const rows = []; items.forEach((q, id) => { const p = BY_ID.get(id); if (p) rows.push({ p: p, q: q }); }); return rows;
  }
  function sumHTML(rows, t) {
    return '<ul class="sum-l">' + rows.map(r => '<li><span>' + esc(r.p.title) + ' <small>× ' + r.q + '</small></span><b>' + money(r.p.price * r.q) + '</b></li>').join('') + '</ul>' +
      '<dl class="totals"><div><dt>Subtotal</dt><dd>' + money(t.sub) + '</dd></div>' + (t.disc ? '<div><dt>' + esc(t.label) + '</dt><dd>−' + money(t.disc) + '</dd></div>' : '') +
      '<div><dt>Delivery</dt><dd>' + (t.ship ? money(t.ship) : 'Free') + '</dd></div><div class="grand"><dt>Total payable</dt><dd>' + money(t.total) + '</dd></div></dl>';
  }
  function bagTotals() { let sub = 0, craft = 0; items.forEach((q, id) => { const p = BY_ID.get(id); sub += p.price * q; if (p.cat === 'Crafts') craft += p.price * q; }); return totalsOf(sub, craft); }
  function openCheckout() {
    if (!items.size) return;
    closeCart(); const d = $('#coDlg'), t = bagTotals();
    d.innerHTML = '<div class="co"><form id="coForm" novalidate><div class="dlg-top"><h2>Checkout</h2><button class="icon-btn" type="button" data-dclose aria-label="Close">' + X + '</button></div>' +
      '<p class="demo-note">This is a demo checkout. No payment is taken and nothing is shipped. Please do not enter real card, bank or UPI details.</p>' +
      '<h3>Contact</h3><div class="fgrid">' + fld('name', 'Full name', '<input name="name" autocomplete="name">') + fld('mobile', 'Mobile number', '<input name="mobile" inputmode="tel" autocomplete="tel" placeholder="10-digit number">') + '</div>' +
      fld('email', 'Email address', '<input name="email" type="email" autocomplete="email">') +
      '<h3>Delivery address</h3>' + fld('address', 'Address (house number, street, area)', '<textarea name="address" rows="2" autocomplete="street-address"></textarea>') +
      '<div class="fgrid">' + fld('state', 'State or UT', '<select name="state" autocomplete="address-level1"><option value="">Select state</option>' + STATES.map(s => '<option>' + s + '</option>').join('') + '</select>') + fld('city', 'City', '<input name="city" autocomplete="address-level2">') + '</div>' +
      fld('pin', 'PIN code', '<input name="pin" inputmode="numeric" maxlength="6" autocomplete="postal-code" placeholder="6-digit PIN code">') +
      '<h3>Payment method</h3>' + Object.keys(PAY).map((k, i) => '<label class="pay"><input type="radio" name="pay" value="' + k + '"' + (i ? '' : ' checked') + '><div><b>' + PAY[k][0] + '</b><span>' + PAY[k][1] + '</span></div></label>').join('') +
      '<button class="btn primary block" type="submit" style="margin-top:14px">Place demo order, ' + money(t.total) + '</button></form>' +
      '<aside class="sum"><h3>Order summary</h3>' + sumHTML(bagLines(), t) + '</aside></div>';
    d.showModal(); const f = $('input[name="name"]', d); if (f) f.focus();
  }
  function validateCo(d) {
    const e = {}; let m = String(d.mobile || '').replace(/\D/g, '');
    if (m.length === 12 && m.slice(0, 2) === '91') m = m.slice(2);
    if (String(d.name || '').trim().length < 2) e.name = 'Enter your full name.';
    if (!/^[6-9]\d{9}$/.test(m)) e.mobile = 'Enter a valid 10-digit mobile number.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(d.email || '').trim())) e.email = 'Enter a valid email address.';
    if (String(d.address || '').trim().length < 8) e.address = 'Enter your full delivery address.';
    if (!d.state) e.state = 'Choose your state or UT.';
    if (String(d.city || '').trim().length < 2) e.city = 'Enter your city.';
    if (!/^[1-9]\d{5}$/.test(String(d.pin || '').trim())) e.pin = 'Enter a valid 6-digit PIN code.';
    return e;
  }
  function submitOrder(form) {
    const d = {}; new FormData(form).forEach((v, k) => { d[k] = v; });
    const errs = validateCo(d), keys = Object.keys(errs);
    $$('.err', form).forEach(x => { x.textContent = ''; }); $$('[aria-invalid]', form).forEach(x => x.removeAttribute('aria-invalid'));
    if (keys.length) {
      keys.forEach(k => { $('#e-' + k, form).textContent = errs[k]; $('[name="' + k + '"]', form).setAttribute('aria-invalid', 'true'); });
      $('[name="' + keys[0] + '"]', form).focus(); toast('Please fix the highlighted fields.'); return;
    }
    const t = bagTotals(), rows = bagLines(), id = 'SS-' + (100000 + Math.floor(Math.random() * 899999)), r = eta(d.pin.trim());
    items.clear(); coupon = ''; cartPersist(); renderCart(); bus.emit('cart:reset');
    $('#coDlg').innerHTML = '<div class="done"><div class="tick">✓</div><h2>Thank you, ' + esc(d.name.trim().split(/\s+/)[0]) + '</h2>' +
      '<p>Your demo order is confirmed. No payment was taken and nothing will be shipped.</p><span class="oid">' + id + '</span>' +
      '<p>' + (r ? 'Estimated delivery by <b>' + fmtDay(r.date) + '</b> to ' : 'Delivery to ') + esc(d.city.trim()) + ', ' + esc(d.state) + '. Payment: ' + PAY[d.pay][0] + '.</p>' +
      '<div class="sumbox">' + sumHTML(rows, t) + '</div><button class="btn primary" type="button" data-dclose>Continue shopping</button></div>';
    toast('Demo order placed');
  }

  const OFFERS = ['Free delivery on orders above ₹999', 'Use SPREE10 for 10% off your first order', 'INDIA15: 15% off India Finds, up to ₹750', 'UPI, cards, net banking and cash on delivery'];
  function plusInit() {
    const root = document.documentElement, tb = $('#themeBtn');
    const setTheme = t => { root.dataset.theme = t; store.set('ss.theme', t); $('meta[name="theme-color"]').content = t === 'light' ? '#fbf7ef' : '#060709'; tb.setAttribute('aria-label', t === 'light' ? 'Switch to dark theme' : 'Switch to light theme'); };
    tb.addEventListener('click', () => setTheme(root.dataset.theme === 'light' ? 'dark' : 'light')); setTheme(root.dataset.theme || 'dark');
    let oi = 0; const ot = $('#annTxt'); ot.textContent = OFFERS[0]; setInterval(() => { oi = (oi + 1) % OFFERS.length; ot.textContent = OFFERS[oi]; }, 4000);

    $('#sortSel').addEventListener('change', e => { F.sort = e.target.value; applyFilter(); });
    $('#fPrice').addEventListener('change', e => { F.max = e.target.value ? Number(e.target.value) : null; applyFilter(); });
    $('#fRate').addEventListener('change', e => { F.rate = Number(e.target.value); applyFilter(); });
    $('#fStock').addEventListener('change', e => { F.stock = e.target.checked; applyFilter(); });
    $('#wishBtn').addEventListener('click', () => { F.wish = !F.wish; syncWish(); applyFilter(); $('#products').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' }); });
    $$('[data-filter],[data-cat]').forEach(b => b.addEventListener('click', () => { if (F.wish) { F.wish = false; syncWish(); applyFilter(); } }));

    const onClick = e => {
      const w2 = e.target.closest('[data-wish]'); if (w2) { e.stopPropagation(); toggleWish(w2.dataset.wish); return; }
      const q = e.target.closest('[data-qv]'); if (q) openQV(q.dataset.qv);
    };
    $('#grid').addEventListener('click', onClick);

    const d = $('#qvDlg');
    d.addEventListener('click', e => {
      if (e.target === d || e.target.closest('[data-qvx]')) { d.close(); return; }
      const w2 = e.target.closest('[data-wish]'); if (w2) { toggleWish(w2.dataset.wish); return; }
      const b = e.target.closest('[data-qd]');
      if (b) { qv.qty = Math.max(1, Math.min(10, qv.p.stock, qv.qty + Number(b.dataset.qd))); $('#qvQty').textContent = qv.qty; return; }
      const add = () => { for (let i = 0; i < qv.qty && cartQty(qv.p.id) < cap(qv.p.id); i++) cartAdd(qv.p.id); if (cartQty(qv.p.id) >= cap(qv.p.id)) toast(capMsg(qv.p.id)); };
      if (e.target.closest('[data-qadd]')) add();
      else if (e.target.closest('[data-qbuy]')) { add(); d.close(); openCheckout(); }
    });
    d.addEventListener('submit', e => {
      e.preventDefault(); const v = $('#pinIn', d).value.trim(), res = $('#pinRes', d), r = eta(v);
      if (!/^\d{6}$/.test(v)) { res.className = 'bad'; res.textContent = 'Enter a valid 6-digit PIN code.'; return; }
      if (!r) { res.className = 'bad'; res.textContent = 'Sorry, we cannot deliver to this PIN code.'; return; }
      res.className = 'good'; res.textContent = 'Delivery by ' + fmtDay(r.date) + '. Cash on delivery is available.';
    });
    const c = $('#coDlg');
    c.addEventListener('click', e => { if (e.target === c || e.target.closest('[data-dclose]')) c.close(); });
    c.addEventListener('submit', e => { e.preventDefault(); if (e.target.id === 'coForm') submitOrder(e.target); });
    bus.on('image:resolved', x => { if (qv && qv.p.id === x.id) fillQV(); swapThumbs(x.id); });
    renderRecent(); syncWish();
  }

  /* ======================================================================== 13c. compare, assistant, regions, recommendations */
  const cmp = [];
  const mini = p => '<button class="rc" type="button" data-qv="' + p.id + '">' + thumb(p) + '<span><b>' + esc(p.title) + '</b>' + money(p.price) + '</span></button>';
  let recoIds = [];
  const BRAND_RE = /^(Aura|Lumen|Solace|Pulse|Nova|Ember|Vertex|Echo|Zenith|Onyx|Haven|Drift)\s+/;
  const typeKey = p => p.name.replace(BRAND_RE, '').toLowerCase();      // "Aura Sunglasses" and "Echo Sunglasses" are the same kind of product
  const THUMB_SEL = id => '#recentRow .rc[data-qv="' + id + '"] .thumb, #recoRow .rc[data-qv="' + id + '"] .thumb, #asstLog .ar[data-id="' + id + '"] .thumb';
  function swapThumbs(id) { const p = BY_ID.get(id); if (p) $$(THUMB_SEL(id)).forEach(t => { t.outerHTML = thumb(p); }); }
  /* "You may also like": built from what was viewed, newest views count most. Every viewed category gets a turn
     (round-robin), a kind of product appears once, and items already viewed or in the bag are left out. */
  function renderReco(seen) {
    const hist = seen.map(id => BY_ID.get(id)).filter(Boolean), used = new Set(recent.concat(Array.from(items.keys())));
    const weight = new Map(), ref = new Map(), kinds = new Set(hist.map(typeKey));
    hist.forEach((p, i) => { weight.set(p.cat, (weight.get(p.cat) || 0) + 1 / (i + 1)); if (!ref.has(p.cat)) ref.set(p.cat, p); });
    const byCat = new Map();
    PRODUCTS.forEach(p => {
      if (p.stock <= 0 || !weight.has(p.cat) || used.has(p.id)) return;
      const near = 1 - Math.min(1, Math.abs(Math.log(p.price / ref.get(p.cat).price)) / Math.log(4));   // 1 = same price, 0 = 4x apart
      const sc = near * 0.8 + (p.rating - 3) * 0.3 + (kinds.has(typeKey(p)) ? 0.4 : 0);
      if (!byCat.has(p.cat)) byCat.set(p.cat, []); byCat.get(p.cat).push({ p: p, sc: sc });
    });
    const order = Array.from(byCat.keys()).sort((a, b) => weight.get(b) - weight.get(a)), seenKinds = new Set(), queues = new Map();
    order.forEach(c => queues.set(c, byCat.get(c).sort((a, b) => b.sc - a.sc || b.p.rcount - a.p.rcount)));
    const out = [];
    for (let guard = 0; out.length < 6 && guard < 60; guard++) {
      let progressed = false;
      order.forEach(c => {
        if (out.length >= 6) return;
        const q = queues.get(c);
        while (q.length) { const x = q.shift(); const k = typeKey(x.p); if (seenKinds.has(k)) continue; seenKinds.add(k); out.push(x.p.id); progressed = true; break; }
      });
      if (!progressed) break;
    }
    recoIds = out;
    recoIds.forEach(id => { if (!results.has(id)) queueImage(BY_ID.get(id)); });
    $('#recoRow').innerHTML = recoIds.map(id => mini(BY_ID.get(id))).join('');
    $('#recoBox').hidden = !recoIds.length;
  }
  function renderTray() {
    const n = cmp.length; $('#cmpTray').hidden = !n;
    $('#cmpMsg').textContent = n < 2 ? 'Pick one more product to compare' : n + ' products selected';
    $('#cmpGo').disabled = n < 2;
  }
  function toggleCmp(id, on) {
    const i = cmp.indexOf(id);
    if (on && i === -1) { if (cmp.length >= 3) { toast('You can compare up to 3 products.'); $$('[data-cmp="' + id + '"]').forEach(c => { c.checked = false; }); return; } cmp.push(id); }
    else if (!on && i !== -1) cmp.splice(i, 1);
    $$('[data-cmp="' + id + '"]').forEach(c => { c.checked = cmp.indexOf(id) !== -1; }); renderTray();
  }
  function openCompare() {
    const ps = cmp.map(id => BY_ID.get(id)), d = $('#cmpDlg'); if (ps.length < 2) return;
    ps.forEach(p => { if (!results.has(p.id)) queueImage(p); });
    const best = (fn, min) => { const v = ps.map(fn), b = min ? Math.min.apply(null, v) : Math.max.apply(null, v); return v.map(x => x === b && v.some(y => y !== b)); };
    const bp = best(p => p.price, true), br = best(p => p.rating), bd = best(p => Math.round(disc(p) * 100));
    const row = (l, cells) => '<tr><th scope="row">' + l + '</th>' + cells.map(c => '<td>' + c + '</td>').join('') + '</tr>';
    d.innerHTML = '<div class="dlg"><div class="dlg-top"><h2>Compare products</h2><button class="icon-btn" type="button" data-cx aria-label="Close">' + X + '</button></div><p class="fine2" style="margin:0 0 14px">Best values are highlighted. Ratings and details are sample data.</p><div class="ct"><table><thead><tr><th></th>' +
      ps.map(p => '<th scope="col">' + thumb(p) + '<button class="lk" type="button" data-qv="' + p.id + '">' + esc(p.title) + '</button></th>').join('') + '</tr></thead><tbody>' +
      row('Price', ps.map((p, i) => '<span class="' + (bp[i] ? 'best' : '') + '">' + money(p.price) + '</span>' + (p.was ? ' <s>' + money(p.was) + '</s>' : ''))) +
      row('Discount', ps.map((p, i) => '<span class="' + (bd[i] ? 'best' : '') + '">' + (p.was ? Math.round(disc(p) * 100) + '% off' : 'None') + '</span>')) +
      row('Rating', ps.map((p, i) => '<span class="' + (br[i] ? 'best' : '') + '">' + p.rating.toFixed(1) + ' of 5</span> <small>(' + nf.format(p.rcount) + ')</small>')) +
      row('Brand', ps.map(p => esc(p.brand))) + row('Category', ps.map(p => CAT_LABEL[p.cat])) + row('Made in', ps.map(p => esc(p.region || 'Not listed'))) +
      row('Availability', ps.map(p => p.stock <= 0 ? 'Out of stock' : (p.stock <= 5 ? 'Only ' + p.stock + ' left' : 'In stock'))) +
      row('', ps.map(p => '<button class="btn primary" type="button" data-cadd="' + p.id + '"' + (p.stock <= 0 ? ' disabled' : '') + '>Add to bag</button>')) + '</tbody></table></div></div>';
    if (!d.open) d.showModal();
  }

  /* Catalogue assistant: parses price, rating and keywords from plain English and ranks real catalogue items. No external AI. */
  const STOP = new Set('find me show a an the for with and or some please i want need looking to buy get best good cheap cheapest top rated rating star stars stock available gift gifts something any of in on my is are can you'.split(' '));
  const CATWORDS = { handmade: 'Crafts', craft: 'Crafts', crafts: 'Crafts', india: 'Crafts', indian: 'Crafts', artisan: 'Crafts', tech: 'Electronics', gadget: 'Electronics', gadgets: 'Electronics' };
  const asstStem = t => (t.length > 3 && t.slice(-1) === 's' && t.slice(-2) !== 'ss') ? t.slice(0, -1) : t;
  const asstHit = (h, t) => t.length < 3 ? (' ' + h + ' ').indexOf(' ' + t + ' ') !== -1 : (h.indexOf(t) !== -1 || h.indexOf(asstStem(t)) !== -1);
  function asstFind(q) {
    let s = q.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1'), max = null, min = null, cat = '', m;
    const num = (v, k) => +v * (!k ? 1 : k === 'k' ? 1000 : /^cr/.test(k) ? 1e7 : /^la/.test(k) ? 1e5 : 1), CUR = '(?:rs\\.?|inr|₹)?\\s*';
    if ((m = s.match(new RegExp('\\bbetween\\s*' + CUR + '(\\d+(?:\\.\\d+)?)\\s*(k|lakhs?|lacs?|crores?)?\\s*(?:and|to|-)\\s*' + CUR + '(\\d+(?:\\.\\d+)?)\\s*(k|lakhs?|lacs?|crores?)?')))) { min = num(m[1], m[2]); max = num(m[3], m[4]); if (min > max) { const t = min; min = max; max = t; } s = s.replace(m[0], ' '); }
    if (max == null && (m = s.match(new RegExp('\\b(?:under|below|less than|upto|up to|within|maximum|max)\\s*' + CUR + '(\\d+(?:\\.\\d+)?)\\s*(k|lakhs?|lacs?|crores?)?\\b')))) { max = num(m[1], m[2]); s = s.replace(m[0], ' '); }
    if (min == null && (m = s.match(new RegExp('\\b(?:above|over|more than|minimum|min)\\s*' + CUR + '(\\d+(?:\\.\\d+)?)\\s*(k|lakhs?|lacs?|crores?)?\\b')))) { min = num(m[1], m[2]); s = s.replace(m[0], ' '); }
    const rate = /top rated|best rated|highly rated|4\s*\+|4 stars?/.test(s) ? 4 : 0, cheap = /cheap|lowest|budget/.test(s), deals = /deal|discount|offer|sale/.test(s);
    const toks = s.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !/^\d+$/.test(w) && !STOP.has(w) && !/^(deal|deals|discount|offer|sale|budget|lowest)$/.test(w) && !(CATWORDS[w] && (cat = CATWORDS[w])));
    const pool = PRODUCTS.filter(p => p.stock > 0 && (max == null || p.price <= max) && (min == null || p.price >= min) && p.rating >= rate && (!cat || p.cat === cat))
      .map(p => { const h = hayOf(p); return { p: p, sc: toks.filter(t => asstHit(h, t)).length }; });
    // every word must match when something does; otherwise fall back to the closest partial matches
    let rows = pool, partial = false;
    if (toks.length) { const full = pool.filter(r => r.sc === toks.length); if (full.length) rows = full; else { rows = pool.filter(r => r.sc > 0); partial = toks.length > 1 && rows.length > 0; } }
    rows.sort((a, b) => b.sc - a.sc || (cheap ? a.p.price - b.p.price || b.p.rating - a.p.rating : deals ? disc(b.p) - disc(a.p) || b.p.rating - a.p.rating : b.p.rating - a.p.rating || b.p.rcount - a.p.rcount));
    return { all: rows.map(r => r.p), rows: rows.slice(0, 4), total: rows.length, max: max, min: min, toks: toks, partial: partial };
  }
  /* ---- Gemini-powered replies. The model only ever sees a short catalogue list and may only pick ids from it. ---- */
  const asstHist = [];
  const ASST_SYS = 'You are the shopping assistant of PIXELCART, an Indian online store (prices are in Indian rupees, ₹). ' +
    'Reply in the same language the customer writes in, in one to three short, friendly sentences. ' +
    'Recommend only products from the CATALOGUE list the customer message includes, by their id. Never invent products, prices, ratings or stock. ' +
    'If nothing fits, say so and suggest a broader search or budget. Answer general shopping questions briefly. ' +
    'Reply ONLY as JSON: {"reply": "<text>", "ids": ["<product id>", ...]} with at most 4 ids (an empty list when no product is needed).';
  function asstCandidates(local) {
    const seen = new Set(), out = [];
    const add = p => { if (p && p.stock > 0 && !seen.has(p.id) && out.length < 16) { seen.add(p.id); out.push(p); } };
    local.all.slice(0, 12).forEach(add);
    if (out.length < 8) PRODUCTS.slice().sort((a, b) => b.rating - a.rating || b.rcount - a.rcount).forEach(add);   // thin match: add popular items so it can still help
    return out;
  }
  async function askGemini(q, cands) {
    const lines = cands.map(p => p.id + ' | ' + p.title + ' | ' + CAT_LABEL[p.cat] + ' | ₹' + p.price + ' | ' + p.rating.toFixed(1) + '★' + (p.region ? ' | ' + p.region : '')).join('\n');
    const body = { contents: asstHist.slice(-6).concat([{ role: 'user', parts: [{ text: 'CATALOGUE (id | title | category | price | rating):\n' + lines + '\n\nCustomer: ' + q }] }]) };   // the system prompt lives in worker.js
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), config.GEMINI_TIMEOUT_MS);
    try {
      const res = await fetch(config.AI_ENDPOINT, {
        method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (!res.ok) { let m = ''; try { m = (await res.json()).detail || ''; } catch (_) {} throw new Error('Assistant ' + res.status + (m ? ': ' + m : '')); }
      const data = await res.json();
      const txt = String(data.text || '').replace(/```json|```/g, '').trim();
      let out; try { out = JSON.parse(txt); } catch (_) { out = { reply: txt, ids: [] }; }
      const ids = (Array.isArray(out.ids) ? out.ids : []).filter(id => BY_ID.has(id)).slice(0, 4);
      const reply = String(out.reply || '').trim();
      if (!reply) throw new Error('empty reply');
      asstHist.push({ role: 'user', parts: [{ text: q }] }, { role: 'model', parts: [{ text: reply }] }); if (asstHist.length > 12) asstHist.splice(0, 2);
      return { reply: reply, ids: ids };
    } finally { clearTimeout(timer); }
  }
  const asstRow = p => '<div class="ar" data-id="' + p.id + '"><button type="button" class="rc" data-qv="' + p.id + '">' + thumb(p) + '<span><b>' + esc(p.title) + '</b>' + money(p.price) + ' · ★ ' + p.rating.toFixed(1) + '</span></button><button class="btn ghost sm" type="button" data-aadd="' + p.id + '" aria-label="Add ' + esc(p.title) + ' to bag"' + (p.stock <= 0 ? ' disabled' : '') + '>Add</button></div>';
  async function asstAsk(q) {
    q = q.trim(); if (!q) return;
    const log = $('#asstLog');
    const say = (c, h) => { log.insertAdjacentHTML('beforeend', '<div class="am ' + c + '">' + h + '</div>'); log.scrollTop = log.scrollHeight; return log.lastElementChild; };
    say('u', esc(q));
    const local = asstFind(q);
    const localReply = () => {
      if (!local.rows.length) { say('b', 'I could not find a match' + (local.max ? ' under ' + money(local.max) : '') + '. Try a broader word like “headphones”, “bag” or “handmade”, or a higher budget.'); return; }
      local.rows.forEach(x => { if (!results.has(x.p.id)) queueImage(x.p); });
      say('b', (local.partial ? '<p class="note">No product matches every word you typed, so these are the closest matches.</p>' : '') + 'Found ' + local.total + (local.total === 1 ? ' match' : ' matches') + (local.max ? ' under ' + money(local.max) : '') + (local.min ? ' above ' + money(local.min) : '') + '. Top picks from the catalogue:' + local.rows.map(x => asstRow(x.p)).join(''));
    };
    const wait = say('b', '<span class="think">Thinking…</span>'), form = $('#asstForm');
    form.setAttribute('aria-busy', 'true');
    try {
      const r = await askGemini(q, asstCandidates(local));
      r.ids.forEach(id => { if (!results.has(id)) queueImage(BY_ID.get(id)); });
      wait.innerHTML = esc(r.reply).replace(/\n/g, '<br>') + r.ids.map(id => asstRow(BY_ID.get(id))).join('');
    } catch (e) {
      mainLogWarn('assistant AI failed, using catalogue search: ' + e.message);
      wait.remove(); localReply();
    } finally { form.removeAttribute('aria-busy'); log.scrollTop = log.scrollHeight; }
  }
  const mainLogWarn = m => { try { console.warn('[assistant] ' + m); } catch (_) {} };
  function goRegion(q) {
    $('#q').value = q; gstate.q = q; resetPlus(); setCat('Crafts'); $('#products').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' });
  }
  function plus2Init() {
    $('#grid').addEventListener('change', e => { const c = e.target.closest('[data-cmp]'); if (c) toggleCmp(c.dataset.cmp, c.checked); });
    $('#cmpGo').addEventListener('click', openCompare);
    $('#cmpClear').addEventListener('click', () => { cmp.slice().forEach(id => toggleCmp(id, false)); });
    const cd = $('#cmpDlg');
    cd.addEventListener('click', e => {
      if (e.target === cd || e.target.closest('[data-cx]')) { cd.close(); return; }
      const q = e.target.closest('[data-qv]'); if (q) { cd.close(); openQV(q.dataset.qv); return; }
      const a = e.target.closest('[data-cadd]'); if (a) cartAdd(a.dataset.cadd);
    });
    $('#recent').addEventListener('click', e => { const q = e.target.closest('[data-qv]'); if (q) openQV(q.dataset.qv); });
    $$('[data-region]').forEach(b => b.addEventListener('click', () => goRegion(b.dataset.region)));

    const panel = $('#asst'), fab = $('#asstBtn'); let greeted = false;
    const toggle = open => {
      panel.hidden = !open; fab.setAttribute('aria-expanded', String(open));
      if (open) { if (!greeted) { greeted = true; $('#asstLog').insertAdjacentHTML('beforeend', '<div class="am b">Hi! This is the PIXELCART assistant. Tell me what you need and your budget.<div class="sg2">' +
        ['Wireless headphones under ₹2,500', 'Handmade gifts under ₹1,000', 'Best rated beauty', 'Cheapest sunglasses'].map(t => '<button type="button" data-ask="' + esc(t) + '">' + esc(t) + '</button>').join('') + '</div></div>'); } $('#asstIn').focus(); } else fab.focus();
    };
    fab.addEventListener('click', () => toggle(panel.hidden)); $('#asstClose').addEventListener('click', () => toggle(false));
    panel.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false); });
    $('#asstForm').addEventListener('submit', e => { e.preventDefault(); const i = $('#asstIn'), v = i.value; i.value = ''; asstAsk(v); });
    panel.addEventListener('click', e => {
      const a = e.target.closest('[data-ask]'); if (a) { asstAsk(a.dataset.ask); return; }
      const b = e.target.closest('[data-aadd]'); if (b) { cartAdd(b.dataset.aadd); return; }
      const q = e.target.closest('[data-qv]'); if (q) openQV(q.dataset.qv);
    });
    bus.on('image:resolved', d => {
      swapThumbs(d.id);
      if (cmp.indexOf(d.id) !== -1 && $('#cmpDlg').open) openCompare();
    });
    if ('IntersectionObserver' in w && !reduceMotion()) {
      const io = new IntersectionObserver(es => es.forEach(x => { if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); } }), { threshold: 0.1 });
      $$('.reveal').forEach(n => { n.classList.add('pre'); io.observe(n); });
    }
    renderTray(); renderRecent(); deptsInit();
  }

  /* ---- Shop by Category: six department cards, each with a 2x2 mosaic of real catalogue products ---- */
  const DEPTS = [
    { cat: 'Electronics', go: 'Electronics', blurb: 'Audio and wearables', test: p => /Headphone|Earbud|Speaker|Smart Watch/i.test(p.name) },
    { cat: 'Fashion', go: 'Fashion', blurb: 'Footwear for every day', test: p => /Shoe|Sneaker/i.test(p.name) },
    { cat: 'Crafts', go: 'Crafts', blurb: 'Handmade crafts from across India', test: () => true },
    { cat: 'Beauty', go: 'Beauty', blurb: 'Skincare and beauty essentials', test: () => true },
    { cat: 'Home', go: 'Home', blurb: 'Lamps, mugs and home decor', test: p => /Lamp|Mug|Vase|Candle|Clock|Frame|Pillow|Plant Pot/i.test(p.name) },
    { cat: 'Fashion', go: 'Fashion', blurb: 'Bags, watches and jewellery', test: p => /Handbag|Backpack|Watch|Necklace|Bracelet/i.test(p.name) }
  ];
  const CHEV = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  let deptIds = [];
  function renderDepts() {
    const box = $('#deptGrid'); if (!box) return;
    deptIds = [];
    box.innerHTML = DEPTS.map(d => {
      const pool = PRODUCTS.filter(p => p.cat === d.cat && p.stock > 0 && d.test(p)); if (!pool.length) return '';
      const seen = new Set(), pick = pool.slice().sort((a, b) => b.rating - a.rating || b.rcount - a.rcount).filter(p => { const k = typeKey(p); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
      if (pick.length < 4) pool.slice().sort((a, b) => b.rating - a.rating).forEach(p => { if (pick.length < 4 && pick.indexOf(p) === -1) pick.push(p); });   // few product types: fill with more of the same
      const from = Math.min.apply(null, pool.map(p => p.price));
      return '<article class="dp-card"><button class="dp-h" type="button" data-dcat="' + d.go + '"><span class="dp-t"><b>Starting ' + money(from) + '</b> | <em>' + d.blurb + '</em></span>' + CHEV + '</button><div class="dp-tiles">' +
        pick.map(p => { deptIds.push(p.id); return '<button class="dp-tile" type="button" data-qv="' + p.id + '" aria-label="' + esc(p.title) + ', ' + money(p.price) + '"><div class="dp-img skel" data-id="' + p.id + '" data-ph="' + esc(initial(p.name)) + '"><span class="dp-p">' + money(p.price) + '</span></div><b>' + esc(p.title) + '</b><small>' + esc(p.brand) + ' • ' + p.rating.toFixed(1) + '★</small></button>'; }).join('') + '</div></article>';
    }).join('');
  }
  function deptImg(id) {
    const r = results.get(id); if (!r) return;
    $$('.dp-img[data-id="' + id + '"]').forEach(b => {
      b.classList.remove('skel');
      if (!r.url || !usable(r.url)) { b.classList.add('no-img'); return; }
      if ($('img', b)) return;
      const im = new Image(); im.alt = r.alt || ''; im.decoding = 'async'; if (r.fit === 'contain') im.className = 'contain';
      im.addEventListener('load', () => im.classList.add('ready'), { once: true }); im.src = r.url; b.prepend(im);
    });
  }
  function loadDepts() { deptIds.forEach(id => { if (results.has(id)) deptImg(id); else queueImage(BY_ID.get(id)); }); }
  function deptsInit() {
    const sec = $('#depts'); if (!sec) return;
    renderDepts();
    sec.addEventListener('click', e => {
      const q = e.target.closest('[data-qv]'); if (q) { openQV(q.dataset.qv); return; }
      const c = e.target.closest('[data-dcat]');
      if (c) { $('#q').value = ''; gstate.q = ''; resetPlus(); setCat(c.dataset.dcat); $('#products').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' }); }
    });
    bus.on('image:resolved', d => { if (deptIds.indexOf(d.id) !== -1) deptImg(d.id); });
    if ('IntersectionObserver' in w) { const io = new IntersectionObserver(es => { if (es[0].isIntersecting) { io.disconnect(); loadDepts(); } }, { rootMargin: '500px 0px' }); io.observe(sec); } else loadDepts();
  }
  /* ======================================================================== 14. hero
     Auto-changing banner (no buttons). Slide 1 is the sale banner already in the HTML; featured product photos
     join as they resolve, so every product slide uses the same relevance-checked photo as its card.
     Pauses while hovered, the tab is hidden, or the banner is off-screen.
     A slide whose image fails to load is dropped for the rest of the visit and never re-requested. */
  const heroLog = scope('hero');
  const slides = [];                         // { order, el, img, cap: {b, s} }
  let current = null, heroAcc = 0, host, ticksEl, capB, capS, chip, stage;
  const paused = { hover: false, hidden: false, offscreen: false };

  function mark() {
    const i = slides.indexOf(current);
    Array.from(ticksEl.children).forEach((t, k) => { t.className = k < i ? 'done' : (k === i ? 'now' : ''); });
  }
  function rebuildTicks() { ticksEl.innerHTML = slides.map(() => '<i></i>').join(''); mark(); }

  function show(s) {
    if (!s || s === current) return;
    if (current) current.el.classList.remove('on');
    current = s; heroAcc = 0;
    s.el.classList.add('on');
    if (!reduceMotion() && chip.animate) chip.animate([{ opacity: 0, transform: 'translateZ(76px) translateY(6px)' }, { opacity: 1, transform: 'translateZ(76px)' }], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
    capB.textContent = s.cap.b; capS.textContent = s.cap.s;
    mark();
  }
  const heroPaused = () => paused.hover || paused.hidden || paused.offscreen;
  function schedule() { stage.classList.toggle('paused', heroPaused()); }   // freezes the progress tick in step with the timer
  function next() {
    if (slides.length < 2) return;
    show(slides[(slides.indexOf(current) + 1) % slides.length]);
  }
  function insertSlide(slide) {
    slides.push(slide);
    slides.sort((a, b) => a.order - b.order);
    host.appendChild(slide.el);
    rebuildTicks();
    schedule();
  }
  function heroOnImage(p, res) {
    if (!p.featured || !res.url) return;
    const slideEl = document.createElement('div');
    slideEl.className = 'slide' + (res.fit === 'contain' ? ' contain' : '');
    slideEl.dataset.ph = initial(p.name);
    const img = new Image();
    img.alt = res.alt; img.width = 500; img.height = 575; img.decoding = 'async';
    slideEl.appendChild(img);
    img.src = res.url;
    insertSlide({ order: 10 + PRODUCTS.indexOf(p), el: slideEl, img: img, cap: { b: p.title, s: money(p.price) + (p.was ? ' (was ' + money(p.was) + ')' : '') } });
  }
  function heroDrop(img) {
    const s = slides.find(x => x.img === img);
    if (!s) return;
    if (slides.length < 2) { s.el.classList.add('no-img'); return; }     // never leave the stage empty
    const i = slides.indexOf(s), wasCurrent = s === current;
    slides.splice(i, 1);
    s.el.remove();
    heroLog.warn('slide dropped (image failed):', img.currentSrc || img.src);
    if (wasCurrent) { current = null; show(slides[Math.min(i, slides.length - 1)]); }
    rebuildTicks();
    schedule();
  }
  function heroInit() {
    stage = $('#stage'); host = $('.stage-media', stage); ticksEl = $('#ticks'); capB = $('#capB'); capS = $('#capS'); chip = $('.chip-a', stage);
    const first = $('.slide', host), firstImg = $('img', first);
    first.classList.add('on');
    current = { order: 0, el: first, img: firstImg, cap: { b: capB.textContent, s: capS.textContent } };
    slides.push(current);
    rebuildTicks();
    // The banner may have failed before this script ran (the error event is already gone).
    if (firstImg.complete && !firstImg.naturalWidth) { failed.add(firstImg.src); first.classList.add('no-img'); }

    const visual = stage.parentElement;
    visual.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { paused.hover = true; schedule(); } });
    visual.addEventListener('pointerleave', () => { paused.hover = false; schedule(); });
    document.addEventListener('visibilitychange', () => { paused.hidden = document.hidden; schedule(); });
    if ('IntersectionObserver' in w) new IntersectionObserver(([en]) => { paused.offscreen = !en.isIntersecting; schedule(); }).observe(stage);
    // Slides come from the original photo links, so rotation never waits on an API.
    PRODUCTS.filter(p => p.featured).forEach(p => heroOnImage(p, { url: p.fallback, fit: 'cover', alt: p.alt }));
    stage.style.setProperty('--hero-ms', config.HERO_INTERVAL_MS + 'ms');
    setInterval(() => {                       // one steady clock: pausing freezes it, it is never restarted
      if (slides.length < 2 || heroPaused()) return;
      heroAcc += 250;
      if (heroAcc >= config.HERO_INTERVAL_MS) next();
    }, 250);
    schedule();
  }
  SS.hero = { onImage: heroOnImage, drop: heroDrop, slides: slides };

  /* ======================================================================== 15. fx
     3D tilt on cards and the hero stage, cursor glow on buttons. One delegated listener per region, one rAF
     per frame. Off on touch and with reduced motion. */
  function tilt(root, amp) {
    let raf = 0, cur = null, x = 0, y = 0;
    const clear = () => {
      if (!cur) return;
      cur.classList.remove('tilting');
      ['--rx', '--ry', '--mx', '--my'].forEach(k => cur.style.removeProperty(k));
      cur = null;
    };
    const frame = () => {
      raf = 0;
      if (!cur) return;
      const r = cur.getBoundingClientRect();
      const u = (x - r.left) / r.width, v = (y - r.top) / r.height;
      cur.style.setProperty('--rx', ((0.5 - v) * amp).toFixed(2) + 'deg');
      cur.style.setProperty('--ry', ((u - 0.5) * amp * 1.2).toFixed(2) + 'deg');
      cur.style.setProperty('--mx', (u * 100).toFixed(1) + '%');
      cur.style.setProperty('--my', (v * 100).toFixed(1) + '%');
    };
    root.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      const t = e.target.closest('.tilt');
      if (t !== cur) { clear(); cur = t; if (t) t.classList.add('tilting'); }
      if (!cur) return;
      x = e.clientX; y = e.clientY;
      if (!raf) raf = requestAnimationFrame(frame);
    }, { passive: true });
    root.addEventListener('pointerleave', () => { cancelAnimationFrame(raf); raf = 0; clear(); });
  }
  function fxInit() {
    if (!finePointer() || reduceMotion()) return;
    tilt($('#grid'), 11);
    tilt($('.hero-visual'), 16);
    document.addEventListener('pointermove', e => {
      const b = e.target.closest && e.target.closest('.glow');
      if (!b) return;
      const r = b.getBoundingClientRect();
      b.style.setProperty('--bx', (e.clientX - r.left) + 'px');
      b.style.setProperty('--by', (e.clientY - r.top) + 'px');
    }, { passive: true });
  }

  /* ======================================================================== 16. main */
  const mainLog = scope('main');

  function boot() {
    // A failed image becomes a placeholder (cards, cart) or a dropped slide (hero). Never replaced, never retried.
    watchBroken(document, img => {
      const hostEl = img.closest('[data-ph]');
      if (hostEl) hostEl.classList.add('no-img');
      heroDrop(img);
      bus.emit('image:broken', { el: img });
    });

    uiInit();
    gridInit();
    cartInit();
    plusInit();
    plus2Init();
    heroInit();
    fxInit();

    mainLog.info('Photos, live search and the AI assistant go through the /api Cloudflare Worker (no keys in the browser).');

    bus.emit('images:done', { sources: [] });                          // credits line (the banner is Unsplash)
  }

  SS.debug = function () {
    const rows = [];
    results.forEach((r, id) => rows.push({ product: id, source: r.source, url: r.url, detail: JSON.stringify(r.meta || {}) }));
    console.table(rows);
    results.forEach((r, id) => console.log('%c' + id, 'font-weight:bold', r.trace));
    console.log('failed image URLs:', Array.from(failed));
    console.log('pixabay:', pxWhy(), px, '| dummyjson:', djWhy(), dj);
    return rows;
  };
  SS.config = config; SS.bus = bus; SS.store = store; SS.utils = { isAllowedImageUrl: isAllowedImageUrl, money: money };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window);


/* ============================================================================ 17. i18n: English / ಕನ್ನಡ / हिन्दी
   A self-contained translator. It never touches the code above: it rewrites the text the page shows
   (static HTML and the strings app.js generates) from an English -> Kannada / Hindi table, and keeps the
   English original so switching back and forth is lossless. Product names, descriptions, brands, names
   and addresses are catalogue/user data and stay as they are.
   Add a string:   T('English text', 'ಕನ್ನಡ', 'हिन्दी')      Add a pattern:   R(/^Only (\d+) left$/, 'kn $1', 'hi $1')
   Saved choice: localStorage 'ss.lang'. */
(function (w) {
  'use strict';
  const doc = w.document, root = doc.documentElement;
  const LANGS = { en: 'EN', kn: 'ಕನ್ನಡ', hi: 'हिन्दी' };
  const D = { kn: new Map(), hi: new Map() }, P = [];
  const T = (en, kn, hi) => { D.kn.set(en, kn); D.hi.set(en, hi); };
  const R = (re, kn, hi) => P.push({ re: re, kn: kn, hi: hi });
  const HSEL = '#shipBar, .hero-note, .done > p';          // elements translated as a whole (they mix text and tags)

  /* ---------- translations: exact strings ---------- */
  // page + offers bar
  T('PIXELCART | Online Shopping', 'PIXELCART | ಆನ್‌ಲೈನ್ ಶಾಪಿಂಗ್', 'PIXELCART | ऑनलाइन शॉपिंग');
  T('Free delivery on orders above ₹999', '₹999ಕ್ಕಿಂತ ಹೆಚ್ಚಿನ ಆರ್ಡರ್‌ಗಳಿಗೆ ಉಚಿತ ಡೆಲಿವರಿ', '₹999 से ऊपर के ऑर्डर पर मुफ़्त डिलीवरी');
  T('Use SPREE10 for 10% off your first order', 'ಮೊದಲ ಆರ್ಡರ್‌ನಲ್ಲಿ 10% ರಿಯಾಯಿತಿಗೆ SPREE10 ಬಳಸಿ', 'पहले ऑर्डर पर 10% छूट के लिए SPREE10 इस्तेमाल करें');
  T('INDIA15: 15% off India Finds, up to ₹750', 'INDIA15: ಇಂಡಿಯಾ ಫೈಂಡ್ಸ್‌ನಲ್ಲಿ 15% ರಿಯಾಯಿತಿ, ಗರಿಷ್ಠ ₹750 ವರೆಗೆ', 'INDIA15: इंडिया फाइंड्स पर 15% छूट, ₹750 तक');
  T('UPI, cards, net banking and cash on delivery', 'UPI, ಕಾರ್ಡ್‌ಗಳು, ನೆಟ್ ಬ್ಯಾಂಕಿಂಗ್ ಮತ್ತು ಕ್ಯಾಶ್ ಆನ್ ಡೆಲಿವರಿ', 'UPI, कार्ड, नेट बैंकिंग और कैश ऑन डिलीवरी');
  T('Offers', 'ಆಫರ್‌ಗಳು', 'ऑफ़र');
  // nav + categories
  T('Categories', 'ವರ್ಗಗಳು', 'श्रेणियाँ');
  T('Collection', 'ಸಂಗ್ರಹ', 'कलेक्शन');
  T('Fashion', 'ಫ್ಯಾಷನ್', 'फ़ैशन');
  T('Tech', 'ಟೆಕ್', 'टेक');
  T('Home', 'ಮನೆ', 'होम');
  T('Beauty', 'ಬ್ಯೂಟಿ', 'ब्यूटी');
  T('India Finds', 'ಇಂಡಿಯಾ ಫೈಂಡ್ಸ್', 'इंडिया फाइंड्स');
  T('No product matches every word you typed, so these are the closest matches.', 'ನೀವು ಟೈಪ್ ಮಾಡಿದ ಎಲ್ಲಾ ಪದಗಳಿಗೆ ಹೊಂದುವ ಉತ್ಪನ್ನ ಇಲ್ಲ, ಆದ್ದರಿಂದ ಹತ್ತಿರದ ಹೊಂದಾಣಿಕೆಗಳು ಇಲ್ಲಿವೆ.', 'आपके लिखे सभी शब्दों से मेल खाने वाला कोई उत्पाद नहीं है, इसलिए ये सबसे करीबी विकल्प हैं।');
  T('Curated departments', 'ಆಯ್ದ ವಿಭಾಗಗಳು', 'चुने हुए विभाग');
  T('Shop by Category', 'ವರ್ಗದ ಪ್ರಕಾರ ಶಾಪಿಂಗ್', 'श्रेणी के अनुसार खरीदारी');
  T('Six departments, from everyday essentials to handmade Indian crafts.', 'ದಿನನಿತ್ಯದ ಅಗತ್ಯಗಳಿಂದ ಕೈಯಿಂದ ಮಾಡಿದ ಭಾರತೀಯ ಕರಕುಶಲ ವಸ್ತುಗಳವರೆಗೆ ಆರು ವಿಭಾಗಗಳು.', 'रोज़मर्रा की ज़रूरतों से लेकर हस्तनिर्मित भारतीय शिल्प तक छह विभाग।');
  T('Audio and wearables', 'ಆಡಿಯೊ ಮತ್ತು ವೇರಬಲ್‌ಗಳು', 'ऑडियो और वियरेबल्स');
  T('Footwear for every day', 'ಪ್ರತಿದಿನಕ್ಕೆ ಪಾದರಕ್ಷೆಗಳು', 'रोज़ाना के लिए जूते-चप्पल');
  T('Handmade crafts from across India', 'ಭಾರತದಾದ್ಯಂತದ ಕೈಯಿಂದ ಮಾಡಿದ ಕರಕುಶಲ ವಸ್ತುಗಳು', 'पूरे भारत से हस्तनिर्मित शिल्प');
  T('Skincare and beauty essentials', 'ಚರ್ಮದ ಆರೈಕೆ ಮತ್ತು ಬ್ಯೂಟಿ ಅಗತ್ಯಗಳು', 'स्किनकेयर और ब्यूटी ज़रूरतें');
  T('Lamps, mugs and home decor', 'ದೀಪಗಳು, ಮಗ್‌ಗಳು ಮತ್ತು ಮನೆ ಅಲಂಕಾರ', 'लैंप, मग और होम डेकोर');
  T('Bags, watches and jewellery', 'ಬ್ಯಾಗ್‌ಗಳು, ಗಡಿಯಾರಗಳು ಮತ್ತು ಆಭರಣಗಳು', 'बैग, घड़ियाँ और गहने');
  R(/^Starting (₹[\d,]+)$/, 'ಪ್ರಾರಂಭ $1', 'शुरुआत $1');
  T('Everything', 'ಎಲ್ಲವೂ', 'सब कुछ');
  T('PIXELCART home', 'PIXELCART ಮುಖಪುಟ', 'PIXELCART होम');
  T('Search the collection', 'ಸಂಗ್ರಹದಲ್ಲಿ ಹುಡುಕಿ', 'कलेक्शन में खोजें');
  T('Search products', 'ಉತ್ಪನ್ನಗಳನ್ನು ಹುಡುಕಿ', 'उत्पाद खोजें');
  T('Show wishlist', 'ವಿಶ್‌ಲಿಸ್ಟ್ ತೋರಿಸಿ', 'विशलिस्ट दिखाएँ');
  T('Switch theme', 'ಥೀಮ್ ಬದಲಿಸಿ', 'थीम बदलें');
  T('Switch to dark theme', 'ಡಾರ್ಕ್ ಥೀಮ್‌ಗೆ ಬದಲಿಸಿ', 'डार्क थीम चुनें');
  T('Switch to light theme', 'ಲೈಟ್ ಥೀಮ್‌ಗೆ ಬದಲಿಸಿ', 'लाइट थीम चुनें');
  T('Account', 'ಖಾತೆ', 'खाता');
  T('Open cart', 'ಕಾರ್ಟ್ ತೆರೆಯಿರಿ', 'कार्ट खोलें');
  T('Change language', 'ಭಾಷೆ ಬದಲಿಸಿ', 'भाषा बदलें');
  // hero
  T('Free delivery above ₹999 · Cash on delivery available', '₹999ಕ್ಕಿಂತ ಹೆಚ್ಚಿಗೆ ಉಚಿತ ಡೆಲಿವರಿ · ಕ್ಯಾಶ್ ಆನ್ ಡೆಲಿವರಿ ಲಭ್ಯ', '₹999 से ऊपर मुफ़्त डिलीवरी · कैश ऑन डिलीवरी उपलब्ध');
  T('Everyday finds, from across India.', 'ಭಾರತದ ಎಲ್ಲೆಡೆಯಿಂದ ದಿನನಿತ್ಯದ ಆಯ್ಕೆಗಳು.', 'पूरे भारत से रोज़मर्रा की खास चीज़ें।');
  T('Fashion, tech, home, beauty and handmade crafts from Indian makers, priced plainly. Selected pieces are up to 50% off this week.',
    'ಭಾರತೀಯ ತಯಾರಕರ ಫ್ಯಾಷನ್, ಟೆಕ್, ಮನೆ, ಬ್ಯೂಟಿ ಮತ್ತು ಕೈಯಿಂದ ಮಾಡಿದ ಕರಕುಶಲ ವಸ್ತುಗಳು, ಸರಳ ಬೆಲೆಗಳಲ್ಲಿ. ಆಯ್ದ ವಸ್ತುಗಳ ಮೇಲೆ ಈ ವಾರ 50% ವರೆಗೆ ರಿಯಾಯಿತಿ.',
    'भारतीय कारीगरों के फ़ैशन, टेक, होम, ब्यूटी और हस्तनिर्मित शिल्प, सीधे-सादे दामों पर। चुनिंदा चीज़ों पर इस हफ़्ते 50% तक की छूट।');
  T('Shop the collection', 'ಸಂಗ್ರಹವನ್ನು ನೋಡಿ', 'कलेक्शन देखें');
  T('Copy code SPREE10', 'ಕೋಡ್ SPREE10 ನಕಲಿಸಿ', 'कोड SPREE10 कॉपी करें');
  T('New here? <b>10% off your first order</b> with code SPREE10.', 'ಹೊಸಬರೇ? ಕೋಡ್ SPREE10 ಬಳಸಿ <b>ಮೊದಲ ಆರ್ಡರ್‌ನಲ್ಲಿ 10% ರಿಯಾಯಿತಿ</b> ಪಡೆಯಿರಿ.', 'नए हैं? कोड SPREE10 से पाएँ <b>पहले ऑर्डर पर 10% की छूट</b>।');
  T('Up to 50% off', '50% ವರೆಗೆ ರಿಯಾಯಿತಿ', '50% तक की छूट');
  T('Selected pieces', 'ಆಯ್ದ ವಸ್ತುಗಳು', 'चुनिंदा चीज़ें');
  T('300+ pieces, five categories', '300+ ವಸ್ತುಗಳು, ಐದು ವರ್ಗಗಳು', '300+ चीज़ें, पाँच श्रेणियाँ');
  // collection + filters
  T('The collection', 'ನಮ್ಮ ಸಂಗ್ರಹ', 'हमारा कलेक्शन');
  T('Loading…', 'ಲೋಡ್ ಆಗುತ್ತಿದೆ…', 'लोड हो रहा है…');
  T('Filter by category', 'ವರ್ಗದ ಪ್ರಕಾರ ಫಿಲ್ಟರ್ ಮಾಡಿ', 'श्रेणी के अनुसार फ़िल्टर करें');
  T('Sort and filter', 'ವಿಂಗಡಿಸಿ ಮತ್ತು ಫಿಲ್ಟರ್ ಮಾಡಿ', 'क्रमबद्ध और फ़िल्टर करें');
  T('Sort', 'ವಿಂಗಡಿಸಿ', 'क्रमबद्ध करें');
  T('Featured', 'ವಿಶೇಷ', 'फ़ीचर्ड');
  T('Popularity', 'ಜನಪ್ರಿಯತೆ', 'लोकप्रियता');
  T('Price: low to high', 'ಬೆಲೆ: ಕಡಿಮೆಯಿಂದ ಹೆಚ್ಚು', 'कीमत: कम से ज़्यादा');
  T('Price: high to low', 'ಬೆಲೆ: ಹೆಚ್ಚಿನಿಂದ ಕಡಿಮೆ', 'कीमत: ज़्यादा से कम');
  T('Highest rated', 'ಅತ್ಯಧಿಕ ರೇಟಿಂಗ್', 'सबसे ज़्यादा रेटिंग');
  T('Newest arrivals', 'ಹೊಸ ಆಗಮನ', 'नए आगमन');
  T('Biggest discounts', 'ಅತಿ ಹೆಚ್ಚು ರಿಯಾಯಿತಿ', 'सबसे ज़्यादा छूट');
  T('Price', 'ಬೆಲೆ', 'कीमत');
  T('Any price', 'ಯಾವುದೇ ಬೆಲೆ', 'कोई भी कीमत');
  T('Rating', 'ರೇಟಿಂಗ್', 'रेटिंग');
  T('Any rating', 'ಯಾವುದೇ ರೇಟಿಂಗ್', 'कोई भी रेटिंग');
  T('In stock only', 'ಸ್ಟಾಕ್‌ನಲ್ಲಿರುವುದು ಮಾತ್ರ', 'सिर्फ़ स्टॉक में');
  T('No products found.', 'ಯಾವುದೇ ಉತ್ಪನ್ನ ಸಿಗಲಿಲ್ಲ.', 'कोई उत्पाद नहीं मिला।');
  T('Clear search and filters', 'ಹುಡುಕಾಟ ಮತ್ತು ಫಿಲ್ಟರ್ ತೆರವುಗೊಳಿಸಿ', 'खोज और फ़िल्टर हटाएँ');
  T('Your wishlist is empty. Tap the heart on any product to save it.', 'ನಿಮ್ಮ ವಿಶ್‌ಲಿಸ್ಟ್ ಖಾಲಿಯಾಗಿದೆ. ಉಳಿಸಲು ಯಾವುದೇ ಉತ್ಪನ್ನದ ಹೃದಯ ಚಿಹ್ನೆಯನ್ನು ಒತ್ತಿ.', 'आपकी विशलिस्ट खाली है। सहेजने के लिए किसी भी उत्पाद पर दिल के निशान को दबाएँ।');
  T('No products match these filters.', 'ಈ ಫಿಲ್ಟರ್‌ಗಳಿಗೆ ಹೊಂದುವ ಉತ್ಪನ್ನಗಳಿಲ್ಲ.', 'इन फ़िल्टरों से कोई उत्पाद मेल नहीं खाता।');
  // regions, recent, facts
  T('Shop by region', 'ಪ್ರದೇಶದ ಪ್ರಕಾರ ಖರೀದಿಸಿ', 'क्षेत्र के अनुसार खरीदें');
  T('Sample listings, sellers not verified', 'ಮಾದರಿ ಪಟ್ಟಿಗಳು, ಮಾರಾಟಗಾರರನ್ನು ಪರಿಶೀಲಿಸಿಲ್ಲ', 'नमूना लिस्टिंग, विक्रेता सत्यापित नहीं');
  T('Rajasthan', 'ರಾಜಸ್ಥಾನ', 'राजस्थान');
  T('Uttar Pradesh', 'ಉತ್ತರ ಪ್ರದೇಶ', 'उत्तर प्रदेश');
  T('Karnataka', 'ಕರ್ನಾಟಕ', 'कर्नाटक');
  T('Bihar', 'ಬಿಹಾರ', 'बिहार');
  T('West Bengal', 'ಪಶ್ಚಿಮ ಬಂಗಾಳ', 'पश्चिम बंगाल');
  T('Blue pottery from Jaipur', 'ಜೈಪುರದ ನೀಲಿ ಮಣ್ಣಿನ ಪಾತ್ರೆಗಳು', 'जयपुर की ब्लू पॉटरी');
  T('Brass lamps from Moradabad', 'ಮೊರಾದಾಬಾದ್‌ನ ಹಿತ್ತಾಳೆ ದೀಪಗಳು', 'मुरादाबाद के पीतल के दीये');
  T('Handloom stoles from Varanasi', 'ವಾರಾಣಸಿಯ ಕೈಮಗ್ಗದ ಶಾಲುಗಳು', 'वाराणसी के हथकरघा स्टोल');
  T('Channapatna wooden toys', 'ಚನ್ನಪಟ್ಟಣದ ಮರದ ಆಟಿಕೆಗಳು', 'चन्नपटना के लकड़ी के खिलौने');
  T('Madhubani folk art', 'ಮಧುಬನಿ ಜಾನಪದ ಕಲೆ', 'मधुबनी लोक कला');
  T('Natural jute totes', 'ನೈಸರ್ಗಿಕ ಸೆಣಬಿನ ಟೋಟ್ ಬ್ಯಾಗ್‌ಗಳು', 'प्राकृतिक जूट टोट बैग');
  T('Recently viewed', 'ಇತ್ತೀಚೆಗೆ ನೋಡಿದ್ದು', 'हाल ही में देखे गए');
  T('You may also like', 'ನಿಮಗೆ ಇದೂ ಇಷ್ಟವಾಗಬಹುದು', 'आपको ये भी पसंद आ सकते हैं');
  T('Shopping facts', 'ಶಾಪಿಂಗ್ ಮಾಹಿತಿ', 'शॉपिंग की जानकारी');
  T('Free delivery', 'ಉಚಿತ ಡೆಲಿವರಿ', 'मुफ़्त डिलीवरी');
  T('On orders above ₹999, otherwise just ₹49.', '₹999ಕ್ಕಿಂತ ಹೆಚ್ಚಿನ ಆರ್ಡರ್‌ಗಳಿಗೆ ಉಚಿತ, ಇಲ್ಲದಿದ್ದರೆ ಕೇವಲ ₹49.', '₹999 से ऊपर के ऑर्डर पर मुफ़्त, वरना सिर्फ़ ₹49।');
  T('Coupons', 'ಕೂಪನ್‌ಗಳು', 'कूपन');
  T('in your bag.', 'ಕೋಡ್‌ಗಳನ್ನು ನಿಮ್ಮ ಕಾರ್ಟ್‌ನಲ್ಲಿ ಬಳಸಿ.', 'कोड अपने कार्ट में इस्तेमाल करें।');
  T('Pay your way', 'ನಿಮ್ಮ ರೀತಿಯಲ್ಲಿ ಪಾವತಿಸಿ', 'अपने तरीके से भुगतान करें');
  T('UPI, cards, net banking or cash on delivery.', 'UPI, ಕಾರ್ಡ್‌ಗಳು, ನೆಟ್ ಬ್ಯಾಂಕಿಂಗ್ ಅಥವಾ ಕ್ಯಾಶ್ ಆನ್ ಡೆಲಿವರಿ.', 'UPI, कार्ड, नेट बैंकिंग या कैश ऑन डिलीवरी।');
  // footer
  T('Your online shopping destination.', 'ನಿಮ್ಮ ಆನ್‌ಲೈನ್ ಶಾಪಿಂಗ್ ತಾಣ.', 'आपकी ऑनलाइन शॉपिंग मंज़िल।');
  T('Customer service', 'ಗ್ರಾಹಕ ಸೇವೆ', 'ग्राहक सेवा');
  T('Contact us', 'ನಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸಿ', 'हमसे संपर्क करें');
  T('Returns and refunds', 'ರಿಟರ್ನ್ಸ್ ಮತ್ತು ರೀಫಂಡ್', 'रिटर्न और रिफ़ंड');
  T('Shipping info', 'ಶಿಪ್ಪಿಂಗ್ ಮಾಹಿತಿ', 'शिपिंग जानकारी');
  T('Get in touch', 'ಸಂಪರ್ಕದಲ್ಲಿರಿ', 'संपर्क में रहें');
  T('Mon–Sat, 9 AM to 6 PM', 'ಸೋಮ–ಶನಿ, ಬೆಳಿಗ್ಗೆ 9 ರಿಂದ ಸಂಜೆ 6', 'सोम–शनि, सुबह 9 से शाम 6 बजे');
  T('© 2026 PIXELCART. A demo store: no payment is taken and nothing is shipped.', '© 2026 PIXELCART. ಇದು ಡೆಮೊ ಅಂಗಡಿ: ಯಾವುದೇ ಪಾವತಿ ಪಡೆಯುವುದಿಲ್ಲ ಮತ್ತು ಏನನ್ನೂ ಕಳುಹಿಸುವುದಿಲ್ಲ.', '© 2026 PIXELCART। यह एक डेमो स्टोर है: कोई भुगतान नहीं लिया जाता और कुछ भेजा नहीं जाता।');
  T('Product photos from', 'ಉತ್ಪನ್ನ ಫೋಟೋಗಳ ಮೂಲ:', 'उत्पाद फ़ोटो स्रोत:');
  // cart
  T('Your cart', 'ನಿಮ್ಮ ಕಾರ್ಟ್', 'आपका कार्ट');
  T('Close cart', 'ಕಾರ್ಟ್ ಮುಚ್ಚಿ', 'कार्ट बंद करें');
  T('Your cart is empty.', 'ನಿಮ್ಮ ಕಾರ್ಟ್ ಖಾಲಿಯಾಗಿದೆ.', 'आपका कार्ट खाली है।');
  T('Continue shopping', 'ಶಾಪಿಂಗ್ ಮುಂದುವರಿಸಿ', 'खरीदारी जारी रखें');
  T('Discount code', 'ರಿಯಾಯಿತಿ ಕೋಡ್', 'डिस्काउंट कोड');
  T('Apply', 'ಅನ್ವಯಿಸಿ', 'लागू करें');
  T('Remove', 'ತೆಗೆದುಹಾಕಿ', 'हटाएँ');
  T('Subtotal', 'ಉಪಮೊತ್ತ', 'उप-योग');
  T('Coupon', 'ಕೂಪನ್', 'कूपन');
  T('Delivery', 'ಡೆಲಿವರಿ', 'डिलीवरी');
  T('Total', 'ಒಟ್ಟು', 'कुल');
  T('Free', 'ಉಚಿತ', 'मुफ़्त');
  T('Checkout', 'ಚೆಕ್‌ಔಟ್', 'चेकआउट');
  T('Checkout is a demo. No payment is taken.', 'ಚೆಕ್‌ಔಟ್ ಡೆಮೊ ಮಾತ್ರ. ಯಾವುದೇ ಪಾವತಿ ಪಡೆಯುವುದಿಲ್ಲ.', 'चेकआउट सिर्फ़ डेमो है। कोई भुगतान नहीं लिया जाता।');
  T('Decrease quantity', 'ಪ್ರಮಾಣ ಕಡಿಮೆ ಮಾಡಿ', 'मात्रा घटाएँ');
  T('Increase quantity', 'ಪ್ರಮಾಣ ಹೆಚ್ಚಿಸಿ', 'मात्रा बढ़ाएँ');
  T('Quantity', 'ಪ್ರಮಾಣ', 'मात्रा');
  T('You have unlocked free delivery', 'ನೀವು ಉಚಿತ ಡೆಲಿವರಿ ಪಡೆದಿದ್ದೀರಿ', 'आपको मुफ़्त डिलीवरी मिल गई है');
  T('10% off your first order is applied.', 'ನಿಮ್ಮ ಮೊದಲ ಆರ್ಡರ್‌ನಲ್ಲಿ 10% ರಿಯಾಯಿತಿ ಅನ್ವಯವಾಗಿದೆ.', 'पहले ऑर्डर पर 10% की छूट लागू हो गई।');
  T('₹200 off orders above ₹1,999.', '₹1,999ಕ್ಕಿಂತ ಹೆಚ್ಚಿನ ಆರ್ಡರ್‌ಗಳ ಮೇಲೆ ₹200 ರಿಯಾಯಿತಿ.', '₹1,999 से ऊपर के ऑर्डर पर ₹200 की छूट।');
  T('15% off India Finds, up to ₹750.', 'ಇಂಡಿಯಾ ಫೈಂಡ್ಸ್‌ನಲ್ಲಿ 15% ರಿಯಾಯಿತಿ, ಗರಿಷ್ಠ ₹750 ವರೆಗೆ.', 'इंडिया फाइंड्स पर 15% की छूट, ₹750 तक।');
  T('FLAT200 needs a subtotal of ₹1,999 or more.', 'FLAT200 ಗೆ ಉಪಮೊತ್ತ ₹1,999 ಅಥವಾ ಹೆಚ್ಚು ಇರಬೇಕು.', 'FLAT200 के लिए उप-योग ₹1,999 या उससे अधिक होना चाहिए।');
  T('Add an India Finds product to use INDIA15.', 'INDIA15 ಬಳಸಲು ಇಂಡಿಯಾ ಫೈಂಡ್ಸ್ ಉತ್ಪನ್ನವೊಂದನ್ನು ಸೇರಿಸಿ.', 'INDIA15 इस्तेमाल करने के लिए एक इंडिया फाइंड्स उत्पाद जोड़ें।');
  T('That code is no longer valid.', 'ಈ ಕೋಡ್ ಇನ್ನು ಮಾನ್ಯವಲ್ಲ.', 'यह कोड अब मान्य नहीं है।');
  T('That code is not valid. Try SPREE10, FLAT200 or INDIA15.', 'ಆ ಕೋಡ್ ಮಾನ್ಯವಲ್ಲ. SPREE10, FLAT200 ಅಥವಾ INDIA15 ಪ್ರಯತ್ನಿಸಿ.', 'यह कोड मान्य नहीं है। SPREE10, FLAT200 या INDIA15 आज़माएँ।');
  T('Enter a discount code.', 'ರಿಯಾಯಿತಿ ಕೋಡ್ ನಮೂದಿಸಿ.', 'डिस्काउंट कोड दर्ज करें।');
  T('SPREE10 (10% off)', 'SPREE10 (10% ರಿಯಾಯಿತಿ)', 'SPREE10 (10% छूट)');
  T('FLAT200 (₹200 off)', 'FLAT200 (₹200 ರಿಯಾಯಿತಿ)', 'FLAT200 (₹200 की छूट)');
  T('INDIA15 (15% off India Finds)', 'INDIA15 (ಇಂಡಿಯಾ ಫೈಂಡ್ಸ್‌ನಲ್ಲಿ 15% ರಿಯಾಯಿತಿ)', 'INDIA15 (इंडिया फाइंड्स पर 15% छूट)');
  // sign in
  T('Sign in or join', 'ಸೈನ್ ಇನ್ ಅಥವಾ ಸೇರಿ', 'साइन इन करें या जुड़ें');
  T('Close', 'ಮುಚ್ಚಿ', 'बंद करें');
  T('This is a demo form. Nothing is saved or sent.', 'ಇದು ಡೆಮೊ ಫಾರ್ಮ್. ಏನನ್ನೂ ಉಳಿಸುವುದಿಲ್ಲ ಅಥವಾ ಕಳುಹಿಸುವುದಿಲ್ಲ.', 'यह एक डेमो फ़ॉर्म है। कुछ भी सहेजा या भेजा नहीं जाता।');
  T('Your name', 'ನಿಮ್ಮ ಹೆಸರು', 'आपका नाम');
  T('Email address', 'ಇಮೇಲ್ ವಿಳಾಸ', 'ईमेल पता');
  T('Password', 'ಪಾಸ್‌ವರ್ಡ್', 'पासवर्ड');
  T('Continue', 'ಮುಂದುವರಿಸಿ', 'जारी रखें');
  // toasts
  T('SPREE10 copied. Apply it in your cart.', 'SPREE10 ನಕಲಾಗಿದೆ. ನಿಮ್ಮ ಕಾರ್ಟ್‌ನಲ್ಲಿ ಅನ್ವಯಿಸಿ.', 'SPREE10 कॉपी हो गया। इसे अपने कार्ट में लागू करें।');
  T('Your code is SPREE10. Enter it in your cart.', 'ನಿಮ್ಮ ಕೋಡ್ SPREE10. ಅದನ್ನು ನಿಮ್ಮ ಕಾರ್ಟ್‌ನಲ್ಲಿ ನಮೂದಿಸಿ.', 'आपका कोड SPREE10 है। इसे अपने कार्ट में दर्ज करें।');
  T('This item is out of stock.', 'ಈ ವಸ್ತು ಸ್ಟಾಕ್‌ನಲ್ಲಿ ಇಲ್ಲ.', 'यह चीज़ स्टॉक में नहीं है।');
  T('Coupon removed', 'ಕೂಪನ್ ತೆಗೆದುಹಾಕಲಾಗಿದೆ', 'कूपन हटा दिया गया');
  T('Removed from wishlist', 'ವಿಶ್‌ಲಿಸ್ಟ್‌ನಿಂದ ತೆಗೆದುಹಾಕಲಾಗಿದೆ', 'विशलिस्ट से हटाया गया');
  T('Saved to wishlist', 'ವಿಶ್‌ಲಿಸ್ಟ್‌ಗೆ ಉಳಿಸಲಾಗಿದೆ', 'विशलिस्ट में सहेजा गया');
  T('You can compare up to 3 products.', 'ನೀವು ಗರಿಷ್ಠ 3 ಉತ್ಪನ್ನಗಳನ್ನು ಹೋಲಿಸಬಹುದು.', 'आप ज़्यादा से ज़्यादा 3 उत्पादों की तुलना कर सकते हैं।');
  T('Please fix the highlighted fields.', 'ದಯವಿಟ್ಟು ಗುರುತಿಸಿದ ಕ್ಷೇತ್ರಗಳನ್ನು ಸರಿಪಡಿಸಿ.', 'कृपया हाइलाइट किए गए फ़ील्ड ठीक करें।');
  T('Demo order placed', 'ಡೆಮೊ ಆರ್ಡರ್ ಸಲ್ಲಿಸಲಾಗಿದೆ', 'डेमो ऑर्डर दे दिया गया');
  // product cards + quick view
  T('Quick view', 'ತ್ವರಿತ ನೋಟ', 'क्विक व्यू');
  T('Sold out', 'ಮಾರಾಟವಾಗಿದೆ', 'बिक चुका');
  T('Compare', 'ಹೋಲಿಸಿ', 'तुलना करें');
  T('Add', 'ಸೇರಿಸಿ', 'जोड़ें');
  T('Out of stock', 'ಸ್ಟಾಕ್‌ನಲ್ಲಿ ಇಲ್ಲ', 'स्टॉक में नहीं');
  T('In stock', 'ಸ್ಟಾಕ್‌ನಲ್ಲಿದೆ', 'स्टॉक में है');
  T('Inclusive of all taxes. Free delivery above ₹999. Ratings and stock are sample data.', 'ಎಲ್ಲಾ ತೆರಿಗೆಗಳು ಸೇರಿವೆ. ₹999ಕ್ಕಿಂತ ಹೆಚ್ಚಿಗೆ ಉಚಿತ ಡೆಲಿವರಿ. ರೇಟಿಂಗ್ ಮತ್ತು ಸ್ಟಾಕ್ ಮಾದರಿ ಡೇಟಾ.', 'सभी करों सहित। ₹999 से ऊपर मुफ़्त डिलीवरी। रेटिंग और स्टॉक नमूना डेटा हैं।');
  T('Brand', 'ಬ್ರ್ಯಾಂಡ್', 'ब्रांड');
  T('Category', 'ವರ್ಗ', 'श्रेणी');
  T('Returns', 'ರಿಟರ್ನ್ಸ್', 'रिटर्न');
  T('7 days (sample)', '7 ದಿನಗಳು (ಮಾದರಿ)', '7 दिन (नमूना)');
  T('Add to bag', 'ಕಾರ್ಟ್‌ಗೆ ಸೇರಿಸಿ', 'कार्ट में जोड़ें');
  T('Buy now', 'ಈಗಲೇ ಖರೀದಿಸಿ', 'अभी खरीदें');
  T('Save to wishlist', 'ವಿಶ್‌ಲಿಸ್ಟ್‌ಗೆ ಉಳಿಸಿ', 'विशलिस्ट में सहेजें');
  T('Check delivery to your PIN code', 'ನಿಮ್ಮ ಪಿನ್ ಕೋಡ್‌ಗೆ ಡೆಲಿವರಿ ಪರಿಶೀಲಿಸಿ', 'अपने पिन कोड पर डिलीवरी जाँचें');
  T('6-digit PIN code', '6 ಅಂಕಿಯ ಪಿನ್ ಕೋಡ್', '6 अंकों का पिन कोड');
  T('Check', 'ಪರಿಶೀಲಿಸಿ', 'जाँचें');
  T('Enter a valid 6-digit PIN code.', 'ಮಾನ್ಯವಾದ 6 ಅಂಕಿಯ ಪಿನ್ ಕೋಡ್ ನಮೂದಿಸಿ.', 'सही 6 अंकों का पिन कोड दर्ज करें।');
  T('Sorry, we cannot deliver to this PIN code.', 'ಕ್ಷಮಿಸಿ, ಈ ಪಿನ್ ಕೋಡ್‌ಗೆ ನಾವು ಡೆಲಿವರಿ ಮಾಡಲಾಗುವುದಿಲ್ಲ.', 'क्षमा करें, हम इस पिन कोड पर डिलीवरी नहीं कर सकते।');
  // checkout
  T('Contact', 'ಸಂಪರ್ಕ', 'संपर्क');
  T('Full name', 'ಪೂರ್ಣ ಹೆಸರು', 'पूरा नाम');
  T('Mobile number', 'ಮೊಬೈಲ್ ಸಂಖ್ಯೆ', 'मोबाइल नंबर');
  T('10-digit number', '10 ಅಂಕಿಯ ಸಂಖ್ಯೆ', '10 अंकों का नंबर');
  T('Delivery address', 'ವಿತರಣಾ ವಿಳಾಸ', 'डिलीवरी का पता');
  T('Address (house number, street, area)', 'ವಿಳಾಸ (ಮನೆ ಸಂಖ್ಯೆ, ರಸ್ತೆ, ಪ್ರದೇಶ)', 'पता (मकान नंबर, गली, इलाका)');
  T('State or UT', 'ರಾಜ್ಯ ಅಥವಾ ಕೇಂದ್ರಾಡಳಿತ ಪ್ರದೇಶ', 'राज्य या केंद्र शासित प्रदेश');
  T('Select state', 'ರಾಜ್ಯ ಆಯ್ಕೆಮಾಡಿ', 'राज्य चुनें');
  T('City', 'ನಗರ', 'शहर');
  T('PIN code', 'ಪಿನ್ ಕೋಡ್', 'पिन कोड');
  T('Payment method', 'ಪಾವತಿ ವಿಧಾನ', 'भुगतान का तरीका');
  T('Pay with any UPI app (demo)', 'ಯಾವುದೇ UPI ಆ್ಯಪ್‌ನಿಂದ ಪಾವತಿಸಿ (ಡೆಮೊ)', 'किसी भी UPI ऐप से भुगतान करें (डेमो)');
  T('Credit or debit card', 'ಕ್ರೆಡಿಟ್ ಅಥವಾ ಡೆಬಿಟ್ ಕಾರ್ಡ್', 'क्रेडिट या डेबिट कार्ड');
  T('Visa, Mastercard, RuPay (demo)', 'Visa, Mastercard, RuPay (ಡೆಮೊ)', 'Visa, Mastercard, RuPay (डेमो)');
  T('Net banking', 'ನೆಟ್ ಬ್ಯಾಂಕಿಂಗ್', 'नेट बैंकिंग');
  T('All major banks (demo)', 'ಎಲ್ಲಾ ಪ್ರಮುಖ ಬ್ಯಾಂಕ್‌ಗಳು (ಡೆಮೊ)', 'सभी प्रमुख बैंक (डेमो)');
  T('Cash on delivery', 'ಕ್ಯಾಶ್ ಆನ್ ಡೆಲಿವರಿ', 'कैश ऑन डिलीवरी');
  T('Pay when your order arrives', 'ಆರ್ಡರ್ ಬಂದಾಗ ಪಾವತಿಸಿ', 'ऑर्डर आने पर भुगतान करें');
  T('This is a demo checkout. No payment is taken and nothing is shipped. Please do not enter real card, bank or UPI details.', 'ಇದು ಡೆಮೊ ಚೆಕ್‌ಔಟ್. ಯಾವುದೇ ಪಾವತಿ ಪಡೆಯುವುದಿಲ್ಲ ಮತ್ತು ಏನನ್ನೂ ಕಳುಹಿಸುವುದಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಜವಾದ ಕಾರ್ಡ್, ಬ್ಯಾಂಕ್ ಅಥವಾ UPI ವಿವರಗಳನ್ನು ನಮೂದಿಸಬೇಡಿ.', 'यह एक डेमो चेकआउट है। कोई भुगतान नहीं लिया जाता और कुछ भेजा नहीं जाता। कृपया असली कार्ड, बैंक या UPI विवरण दर्ज न करें।');
  T('Order summary', 'ಆರ್ಡರ್ ಸಾರಾಂಶ', 'ऑर्डर सारांश');
  T('Total payable', 'ಪಾವತಿಸಬೇಕಾದ ಮೊತ್ತ', 'देय कुल राशि');
  T('Enter your full name.', 'ನಿಮ್ಮ ಪೂರ್ಣ ಹೆಸರನ್ನು ನಮೂದಿಸಿ.', 'अपना पूरा नाम दर्ज करें।');
  T('Enter a valid 10-digit mobile number.', 'ಮಾನ್ಯವಾದ 10 ಅಂಕಿಯ ಮೊಬೈಲ್ ಸಂಖ್ಯೆ ನಮೂದಿಸಿ.', 'सही 10 अंकों का मोबाइल नंबर दर्ज करें।');
  T('Enter a valid email address.', 'ಮಾನ್ಯವಾದ ಇಮೇಲ್ ವಿಳಾಸ ನಮೂದಿಸಿ.', 'सही ईमेल पता दर्ज करें।');
  T('Enter your full delivery address.', 'ನಿಮ್ಮ ಪೂರ್ಣ ವಿತರಣಾ ವಿಳಾಸ ನಮೂದಿಸಿ.', 'अपना पूरा डिलीवरी पता दर्ज करें।');
  T('Choose your state or UT.', 'ನಿಮ್ಮ ರಾಜ್ಯ ಅಥವಾ ಕೇಂದ್ರಾಡಳಿತ ಪ್ರದೇಶ ಆಯ್ಕೆಮಾಡಿ.', 'अपना राज्य या केंद्र शासित प्रदेश चुनें।');
  T('Enter your city.', 'ನಿಮ್ಮ ನಗರ ನಮೂದಿಸಿ.', 'अपना शहर दर्ज करें।');
  T('Your demo order is confirmed. No payment was taken and nothing will be shipped.', 'ನಿಮ್ಮ ಡೆಮೊ ಆರ್ಡರ್ ದೃಢಪಟ್ಟಿದೆ. ಯಾವುದೇ ಪಾವತಿ ಪಡೆದಿಲ್ಲ ಮತ್ತು ಏನನ್ನೂ ಕಳುಹಿಸಲಾಗುವುದಿಲ್ಲ.', 'आपका डेमो ऑर्डर पक्का हो गया। कोई भुगतान नहीं लिया गया और कुछ भेजा नहीं जाएगा।');
  // compare
  T('Compare products', 'ಉತ್ಪನ್ನಗಳನ್ನು ಹೋಲಿಸಿ', 'उत्पादों की तुलना');
  T('Best values are highlighted. Ratings and details are sample data.', 'ಉತ್ತಮ ಮೌಲ್ಯಗಳನ್ನು ಹೈಲೈಟ್ ಮಾಡಲಾಗಿದೆ. ರೇಟಿಂಗ್ ಮತ್ತು ವಿವರಗಳು ಮಾದರಿ ಡೇಟಾ.', 'सबसे अच्छे मान हाइलाइट किए गए हैं। रेटिंग और विवरण नमूना डेटा हैं।');
  T('Discount', 'ರಿಯಾಯಿತಿ', 'छूट');
  T('Made in', 'ತಯಾರಿಸಿದ ಸ್ಥಳ', 'निर्माण स्थान');
  T('Availability', 'ಲಭ್ಯತೆ', 'उपलब्धता');
  T('None', 'ಇಲ್ಲ', 'कोई नहीं');
  T('Not listed', 'ಪಟ್ಟಿಯಲ್ಲಿಲ್ಲ', 'सूचीबद्ध नहीं');
  T('Pick one more product to compare', 'ಹೋಲಿಸಲು ಇನ್ನೊಂದು ಉತ್ಪನ್ನ ಆರಿಸಿ', 'तुलना के लिए एक और उत्पाद चुनें');
  T('Clear', 'ತೆರವುಗೊಳಿಸಿ', 'हटाएँ');
  // assistant
  T('Ask PIXELCART', 'PIXELCART ಅನ್ನು ಕೇಳಿ', 'PIXELCART से पूछें');
  T('Shopping assistant', 'ಶಾಪಿಂಗ್ ಸಹಾಯಕ', 'शॉपिंग सहायक');
  T('Searches this catalogue. Not a live AI.', 'ಈ ಕ್ಯಾಟಲಾಗ್‌ನಲ್ಲಿ ಹುಡುಕುತ್ತದೆ. ನೇರ AI ಅಲ್ಲ.', 'इस कैटलॉग में खोजता है। यह लाइव AI नहीं है।');
  T('Close assistant', 'ಸಹಾಯಕ ಮುಚ್ಚಿ', 'सहायक बंद करें');
  T('Ask for a product', 'ಉತ್ಪನ್ನ ಕೇಳಿ', 'कोई उत्पाद पूछें');
  T('Send', 'ಕಳುಹಿಸಿ', 'भेजें');
  T('Hi! I search the PIXELCART catalogue for you. Tell me what you need and your budget.', 'ನಮಸ್ಕಾರ! ನಾನು PIXELCART ಕ್ಯಾಟಲಾಗ್‌ನಲ್ಲಿ ನಿಮಗಾಗಿ ಹುಡುಕುತ್ತೇನೆ. ನಿಮಗೆ ಏನು ಬೇಕು ಮತ್ತು ಬಜೆಟ್ ಎಷ್ಟು ಎಂದು ಇಂಗ್ಲಿಷ್‌ನಲ್ಲಿ ಹೇಳಿ.', 'नमस्ते! मैं आपके लिए PIXELCART कैटलॉग में खोज करता हूँ। अंग्रेज़ी में बताइए कि आपको क्या चाहिए और बजट कितना है।');
  T('Wireless headphones under ₹2,500', '₹2,500ರ ಒಳಗಿನ ವೈರ್‌ಲೆಸ್ ಹೆಡ್‌ಫೋನ್‌ಗಳು', '₹2,500 से कम के वायरलेस हेडफ़ोन');
  T('Handmade gifts under ₹1,000', '₹1,000ರ ಒಳಗಿನ ಕೈಯಿಂದ ಮಾಡಿದ ಉಡುಗೊರೆಗಳು', '₹1,000 से कम के हस्तनिर्मित उपहार');
  T('Best rated beauty', 'ಅತ್ಯುತ್ತಮ ರೇಟಿಂಗ್‌ನ ಬ್ಯೂಟಿ', 'सबसे अच्छी रेटिंग वाले ब्यूटी उत्पाद');
  T('Cheapest sunglasses', 'ಅತ್ಯಂತ ಕಡಿಮೆ ಬೆಲೆಯ ಸನ್‌ಗ್ಲಾಸ್', 'सबसे सस्ते धूप के चश्मे');
  T('I could not find a match. Try a broader word like “headphones”, “bag” or “handmade”, or a higher budget.', 'ಹೊಂದಾಣಿಕೆ ಸಿಗಲಿಲ್ಲ. “headphones”, “bag” ಅಥವಾ “handmade” ಮುಂತಾದ ವಿಶಾಲ ಪದ ಅಥವಾ ಹೆಚ್ಚಿನ ಬಜೆಟ್ ಪ್ರಯತ್ನಿಸಿ.', 'कोई मेल नहीं मिला। “headphones”, “bag” या “handmade” जैसा व्यापक शब्द या ज़्यादा बजट आज़माएँ।');

  /* ---------- translations: patterns (dynamic text) ---------- */
  R(/^(\d+) pieces$/, '$1 ವಸ್ತುಗಳು', '$1 चीज़ें');
  R(/^1 piece$/, '1 ವಸ್ತು', '1 चीज़');
  R(/^Under (₹[\d,]+)$/, '$1ಕ್ಕಿಂತ ಕಡಿಮೆ', '$1 से कम');
  R(/^([\d.]+)★ and up$/, '$1★ ಮತ್ತು ಮೇಲ್ಪಟ್ಟು', '$1★ और उससे ऊपर');
  R(/^No products match “(.+)”\.$/, 'ಯಾವ ಉತ್ಪನ್ನವೂ “$1” ಗೆ ಹೊಂದುತ್ತಿಲ್ಲ.', '“$1” से कोई उत्पाद मेल नहीं खाता।');
  R(/^Only (\d+) left$/, 'ಕೇವಲ $1 ಉಳಿದಿವೆ', 'सिर्फ़ $1 बचे');
  R(/^Only (\d+) left in stock\.$/, 'ಸ್ಟಾಕ್‌ನಲ್ಲಿ ಕೇವಲ $1 ಉಳಿದಿವೆ.', 'स्टॉक में सिर्फ़ $1 बचे हैं।');
  R(/^You can add up to (\d+) of each item\.$/, 'ಪ್ರತಿ ವಸ್ತುವಿನ $1 ವರೆಗೆ ಸೇರಿಸಬಹುದು.', 'हर चीज़ के $1 तक जोड़ सकते हैं।');
  R(/^(−?\d+)% off$/, '$1% ರಿಯಾಯಿತಿ', '$1% छूट');
  R(/^([\d.]+) of 5$/, '5ರಲ್ಲಿ $1', '5 में से $1');
  R(/^(₹[\d,]+) each$/, '$1 ಪ್ರತಿಯೊಂದಕ್ಕೆ', '$1 प्रति');
  R(/^(₹[\d,]+) \(was (₹[\d,]+)\)$/, '$1 (ಮೊದಲು $2)', '$1 (पहले $2)');
  R(/^(\d+) products selected$/, '$1 ಉತ್ಪನ್ನಗಳನ್ನು ಆರಿಸಲಾಗಿದೆ', '$1 उत्पाद चुने गए');
  R(/^Open cart, 1 item$/, 'ಕಾರ್ಟ್ ತೆರೆಯಿರಿ, 1 ವಸ್ತು', 'कार्ट खोलें, 1 आइटम');
  R(/^Open cart, (\d+) items?$/, 'ಕಾರ್ಟ್ ತೆರೆಯಿರಿ, $1 ವಸ್ತುಗಳು', 'कार्ट खोलें, $1 आइटम');
  R(/^Thanks, (.+)\. This is a demo, so nothing was saved\.$/, 'ಧನ್ಯವಾದಗಳು, $1. ಇದು ಡೆಮೊ, ಆದ್ದರಿಂದ ಏನೂ ಉಳಿಸಿಲ್ಲ.', 'धन्यवाद, $1। यह डेमो है, इसलिए कुछ सहेजा नहीं गया।');
  R(/^Thank you, (.+)$/, 'ಧನ್ಯವಾದಗಳು, $1', 'धन्यवाद, $1');
  R(/^(.+) added to cart$/, '$1 ಕಾರ್ಟ್‌ಗೆ ಸೇರಿಸಲಾಗಿದೆ', '$1 कार्ट में जोड़ा गया');
  R(/^([A-Z0-9]+) applied$/, '$1 ಅನ್ವಯವಾಗಿದೆ', '$1 लागू हो गया');
  R(/^Delivery by (.+)\. Cash on delivery is available\.$/, 'ಡೆಲಿವರಿ ದಿನಾಂಕ $1. ಕ್ಯಾಶ್ ಆನ್ ಡೆಲಿವರಿ ಲಭ್ಯ.', '$1 तक डिलीवरी। कैश ऑन डिलीवरी उपलब्ध है।');
  R(/^Place demo order, (.+)$/, 'ಡೆಮೊ ಆರ್ಡರ್ ಮಾಡಿ, $1', 'डेमो ऑर्डर दें, $1');
  R(/^Rated ([\d.]+) out of 5, (\d+) ratings$/, '5ರಲ್ಲಿ $1 ರೇಟಿಂಗ್, $2 ರೇಟಿಂಗ್‌ಗಳು', '5 में से $1 रेटिंग, $2 रेटिंग');
  R(/^Save (.+) to wishlist$/, '$1 ಅನ್ನು ವಿಶ್‌ಲಿಸ್ಟ್‌ಗೆ ಉಳಿಸಿ', '$1 को विशलिस्ट में सहेजें');
  R(/^Add another (.+), (\d+) in cart$/, 'ಇನ್ನೊಂದು $1 ಸೇರಿಸಿ, ಕಾರ್ಟ್‌ನಲ್ಲಿ $2', 'एक और $1 जोड़ें, कार्ट में $2');
  R(/^Add (.+) to (?:cart|bag)$/, '$1 ಅನ್ನು ಕಾರ್ಟ್‌ಗೆ ಸೇರಿಸಿ', '$1 को कार्ट में जोड़ें');
  R(/^Remove (.+)$/, '$1 ತೆಗೆದುಹಾಕಿ', '$1 हटाएँ');
  R(/^Quantity of (.+)$/, '$1 ಪ್ರಮಾಣ', '$1 की मात्रा');
  // assistant reply: "Found 3 matches under ₹2,000 above ₹500. Top picks from the catalogue:"
  R(/^Found (\d+) matches? ?(?:under (₹[\d,]+))? ?(?:above (₹[\d,]+))?\. Top picks from the catalogue:$/,
    (m, n, u, a) => n + ' ಹೊಂದಾಣಿಕೆಗಳು ಸಿಕ್ಕಿವೆ' + (u ? ', ' + u + 'ರ ಒಳಗೆ' : '') + (a ? ', ' + a + 'ಕ್ಕಿಂತ ಮೇಲೆ' : '') + '. ಕ್ಯಾಟಲಾಗ್‌ನ ಅತ್ಯುತ್ತಮ ಆಯ್ಕೆಗಳು:',
    (m, n, u, a) => n + ' मैच मिले' + (u ? ', ' + u + ' से कम' : '') + (a ? ', ' + a + ' से ऊपर' : '') + '। कैटलॉग से शीर्ष चुनाव:');
  R(/^I could not find a match under (₹[\d,]+)\. Try a broader word like “headphones”, “bag” or “handmade”, or a higher budget\.$/,
    'ಹೊಂದಾಣಿಕೆ ಸಿಗಲಿಲ್ಲ ($1ರ ಒಳಗೆ). “headphones”, “bag” ಅಥವಾ “handmade” ಮುಂತಾದ ವಿಶಾಲ ಪದ ಅಥವಾ ಹೆಚ್ಚಿನ ಬಜೆಟ್ ಪ್ರಯತ್ನಿಸಿ.',
    'कोई मेल नहीं मिला ($1 से कम)। “headphones”, “bag” या “handmade” जैसा व्यापक शब्द या ज़्यादा बजट आज़माएँ।');
  // whole-element (mixed text + tags)
  R(/^Add <b>(.+?)<\/b> more for free delivery(<div class="track">[\s\S]*)$/, 'ಉಚಿತ ಡೆಲಿವರಿಗೆ ಇನ್ನೂ <b>$1</b> ಸೇರಿಸಿ$2', 'मुफ़्त डिलीवरी के लिए <b>$1</b> और जोड़ें$2');
  R(/^You have unlocked free delivery(<div class="track">[\s\S]*)$/, 'ನೀವು ಉಚಿತ ಡೆಲಿವರಿ ಪಡೆದಿದ್ದೀರಿ$1', 'आपको मुफ़्त डिलीवरी मिल गई है$1');
  R(/^Estimated delivery by <b>(.+?)<\/b> to ([\s\S]+)\. Payment: ([^.]+)\.$/,
    (m, d, c, p) => 'ಅಂದಾಜು ಡೆಲಿವರಿ <b>' + d + '</b>, ' + c + ' ಗೆ. ಪಾವತಿ: ' + tr(p, 'kn') + '.',
    (m, d, c, p) => 'अनुमानित डिलीवरी <b>' + d + '</b> तक, ' + c + '। भुगतान: ' + tr(p, 'hi') + '।');
  R(/^Delivery to ([\s\S]+)\. Payment: ([^.]+)\.$/,
    (m, c, p) => c + ' ಗೆ ಡೆಲಿವರಿ. ಪಾವತಿ: ' + tr(p, 'kn') + '.',
    (m, c, p) => c + ' में डिलीवरी। भुगतान: ' + tr(p, 'hi') + '।');

  /* ---------- engine ---------- */
  function tr(str, lang) {
    if (lang === 'en' || !str) return str;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(str), core = m[2];
    if (!core) return str;
    let out = D[lang].get(core);
    if (out === undefined) {
      for (let i = 0; i < P.length; i++) {
        if (P[i].re.test(core)) { out = core.replace(P[i].re, P[i][lang]); break; }
      }
    }
    return out === undefined ? str : m[1] + out + m[3];
  }

  let lang = 'en';
  const textRec = new WeakMap(), attrRec = new WeakMap(), htmlRec = new WeakMap();
  const ATTRS = ['placeholder', 'aria-label', 'title'];

  function skipText(n) {
    const p = n.parentElement;
    if (!p) return true;
    const t = p.tagName;
    if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEXTAREA') return true;
    if (t === 'OPTION' && p.parentElement && p.parentElement.matches('select[name="state"]')) return true;   // option text is also its value
    return !!p.closest('.am.u, .lang, ' + HSEL);
  }
  function applyText(n) {
    if (skipText(n)) return;
    let r = textRec.get(n);
    if (!r || n.data !== r.shown) { r = { en: n.data, shown: n.data }; textRec.set(n, r); }
    const out = tr(r.en, lang);
    if (out !== n.data) n.data = out;
    r.shown = out;
  }
  function applyAttr(el, a) {
    if (el.closest && el.closest('.lang')) return;
    const v = el.getAttribute(a);
    if (v == null) return;
    const rec = attrRec.get(el) || {}; attrRec.set(el, rec);
    let r = rec[a];
    if (!r || v !== r.shown) { r = rec[a] = { en: v, shown: v }; }
    const out = tr(r.en, lang);
    if (out !== v) el.setAttribute(a, out);
    r.shown = out;
  }
  function applyHtml(el, force) {
    const cur = el.innerHTML;
    let r = htmlRec.get(el);
    if (!r || cur !== r.shown) r = { en: cur, shown: cur, lang: null };
    else if (!force && r.lang === lang) return;
    htmlRec.set(el, r);
    const out = tr(r.en, lang);
    if (out !== cur) el.innerHTML = out;
    r.shown = el.innerHTML; r.lang = lang;
  }
  function scan(node, force) {
    if (node.nodeType === 3) { applyText(node); return; }
    if (node.nodeType !== 1) return;
    const tw = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = tw.nextNode(); t; t = tw.nextNode()) applyText(t);
    const els = [node].concat(Array.from(node.querySelectorAll('[placeholder],[aria-label],[title]')));
    els.forEach(el => ATTRS.forEach(a => { if (el.hasAttribute && el.hasAttribute(a)) applyAttr(el, a); }));
    const hs = Array.from(node.querySelectorAll(HSEL)); if (node.matches && node.matches(HSEL)) hs.push(node);
    hs.forEach(h => applyHtml(h, force));
  }

  const mo = new MutationObserver(muts => {
    if (lang === 'en') return;
    const hs = new Set();
    muts.forEach(m => {
      const host = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const h = host && host.closest && host.closest(HSEL); if (h) hs.add(h);
      if (m.type === 'childList') m.addedNodes.forEach(n => scan(n, false));
      else if (m.type === 'characterData') applyText(m.target);
      else if (m.type === 'attributes') applyAttr(m.target, m.attributeName);
    });
    hs.forEach(h => applyHtml(h, false));
  });

  function setLang(l, save) {
    if (!LANGS[l]) l = 'en';
    lang = l; root.lang = l;
    if (save !== false) { try { w.localStorage.setItem('ss.lang', l); } catch (_) {} }
    scan(root, true);                                           // full pass; for 'en' this restores every original
    const cur = doc.getElementById('langCur'); if (cur) cur.textContent = LANGS[l];
    Array.from(doc.querySelectorAll('[data-lang]')).forEach(b => b.setAttribute('aria-checked', String(b.dataset.lang === l)));
  }

  function init() {
    const btn = doc.getElementById('langBtn'), menu = doc.getElementById('langMenu');
    mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    if (btn && menu) {
      const open = on => {
        menu.hidden = !on; btn.setAttribute('aria-expanded', String(on));
        if (on) { const c = menu.querySelector('[aria-checked="true"]') || menu.querySelector('button'); c.focus(); }
      };
      btn.addEventListener('click', () => open(menu.hidden));
      menu.addEventListener('click', e => {
        const b = e.target.closest('[data-lang]'); if (!b) return;
        setLang(b.dataset.lang); open(false); btn.focus();
      });
      menu.addEventListener('keydown', e => {
        const items = Array.from(menu.querySelectorAll('button')), i = items.indexOf(doc.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i + items.length - 1) % items.length].focus(); }
      });
      doc.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('.lang')) open(false); });
      doc.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { open(false); btn.focus(); } });
    }
    let saved = 'en'; try { saved = w.localStorage.getItem('ss.lang') || 'en'; } catch (_) {}
    setLang(LANGS[saved] ? saved : 'en', false);
  }
  w.SS = w.SS || {}; w.SS.lang = { set: setLang, get: () => lang, tr: tr };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})(window);