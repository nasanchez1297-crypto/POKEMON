const cheerio = require('cheerio');

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9'
    }
  });

  return {
    ok: res.ok,
    status: res.status,
    text: await res.text()
  };
}

function normalizeWhitespace(str = '') {
  return str.replace(/\s+/g, ' ').trim();
}

function moneyFrom(text = '') {
  const m = text.match(/\$\s?\d+(?:\.\d{2})?/);
  return m ? m[0].replace(/\s+/g, '') : null;
}

function statusFromText(text = '') {
  const t = text.toLowerCase();

  if (
    t.includes('sold out') ||
    t.includes('unavailable') ||
    t.includes('out of stock')
  ) return 'out';

  if (
    t.includes('add to cart') ||
    t.includes('in stock') ||
    t.includes('available')
  ) return 'in';

  return 'unknown';
}

function scoreMatch(name, query) {
  const n = name.toLowerCase();
  const q = query.toLowerCase().trim();

  if (!q) return 0;
  if (n === q) return 100;
  if (n.includes(q)) return 80;

  const qWords = q.split(/\s+/).filter(Boolean);
  let hits = 0;
  for (const word of qWords) {
    if (n.includes(word)) hits++;
  }

  if (!qWords.length) return 0;
  return Math.round((hits / qWords.length) * 60);
}

function extractFromAnchors(html, query) {
  const $ = cheerio.load(html);
  const items = [];

  $('a[href*="/product/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const textSelf = normalizeWhitespace($(el).text() || '');
    const root = $(el).closest('article, li, div');
    const textRoot = normalizeWhitespace(root.text() || '');
    const combinedText = normalizeWhitespace(`${textSelf} ${textRoot}`);

    let title =
      normalizeWhitespace($(el).attr('aria-label') || '') ||
      textSelf ||
      combinedText.split('$')[0] ||
      '';

    if (!title || title.length < 5) return;

    const price = moneyFrom(combinedText);
    const status = statusFromText(combinedText);
    const url = href.startsWith('http') ? href : `https://www.pokemoncenter.com${href}`;

    const score = scoreMatch(title, query);

    items.push({
      key: url,
      name: title,
      url,
      price,
      status,
      note: price ? 'Precio detectado' : 'Resultado encontrado',
      score,
      rawText: combinedText
    });
  });

  return items;
}

function extractFromRawHtml(html, query) {
  const items = [];
  const matches = [];

  // product URLs
  const urlRegex = /https:\/\/www\.pokemoncenter\.com\/product\/[A-Za-z0-9\-\/._?=&%]+/g;
  const foundUrls = html.match(urlRegex) || [];
  for (const u of foundUrls) matches.push({ url: u });

  // rough product name chunks
  const nameRegex = /Pokémon TCG:[^<\n]{5,180}/gi;
  const foundNames = html.match(nameRegex) || [];
  for (const n of foundNames) matches.push({ name: normalizeWhitespace(n) });

  const queryLower = query.toLowerCase();

  const merged = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    if (current.name && current.name.toLowerCase().includes(queryLower)) {
      merged.push({
        key: current.name,
        name: current.name,
        url: `https://www.pokemoncenter.com/search/${encodeURIComponent(query)}`,
        price: moneyFrom(current.name),
        status: statusFromText(current.name),
        note: 'Extraído del HTML bruto',
        score: scoreMatch(current.name, query),
        rawText: current.name
      });
    }
  }

  return merged;
}

function dedupeItems(items) {
  const map = new Map();

  for (const item of items) {
    const key = item.key || item.url || item.name;
    const prev = map.get(key);

    if (!prev) {
      map.set(key, item);
      continue;
    }

    const prevScore = prev.score || 0;
    const nextScore = item.score || 0;

    if (nextScore > prevScore) {
      map.set(key, item);
      continue;
    }

    if (!prev.price && item.price) {
      map.set(key, item);
    }
  }

  return Array.from(map.values());
}

function buildStoreData(item) {
  const now = new Date().toISOString();

  return {
    pokemoncenter: {
      status: item.status || 'unknown',
      price: item.price || null,
      note: item.note || '',
      lastUpdated: now
    }
  };
}

exports.handler = async function (event) {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const query = String(body.query || '').trim();

    if (!query) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Missing query' })
      };
    }

    const urls = [
      `https://www.pokemoncenter.com/search/${encodeURIComponent(query)}`,
      'https://www.pokemoncenter.com/category/tcg-cards'
    ];

    let allItems = [];
    const sources = [];

    for (const url of urls) {
      try {
        const page = await fetchText(url);
        sources.push({ url, ok: page.ok, status: page.status });

        if (page.ok && page.text) {
          const anchorItems = extractFromAnchors(page.text, query);
          const rawItems = extractFromRawHtml(page.text, query);
          allItems.push(...anchorItems, ...rawItems);
        }
      } catch (err) {
        sources.push({ url, ok: false, status: 0, error: err.message });
      }
    }

    allItems = dedupeItems(allItems)
      .filter(item => (item.score || 0) >= 20)
      .sort((a, b) => {
        const aPrice = a.price ? 1 : 0;
        const bPrice = b.price ? 1 : 0;
        return (b.score || 0) - (a.score || 0) || bPrice - aPrice;
      })
      .slice(0, 30);

    if (!allItems.length) {
      allItems = [{
        key: `fallback-${query}`,
        name: query,
        url: `https://www.pokemoncenter.com/search/${encodeURIComponent(query)}`,
        price: null,
        status: 'unknown',
        note: 'No se pudo extraer resultado exacto; usa el enlace directo'
      }];
    }

    const results = allItems.map(item => ({
      key: item.key,
      name: item.name,
      sku: null,
      storeData: buildStoreData(item)
    }));

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        checkedAt: new Date().toISOString(),
        sources,
        results
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};
