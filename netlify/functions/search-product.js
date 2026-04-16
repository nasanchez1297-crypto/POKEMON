const cheerio = require('cheerio');

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      'accept': 'text/html,application/xhtml+xml'
    }
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

function normalizeWhitespace(s='') {
  return s.replace(/\s+/g, ' ').trim();
}

function moneyFrom(text) {
  const m = text.match(/\$\s?\d+(?:\.\d{2})?/);
  return m ? m[0].replace(/\s+/g, '') : null;
}

function extractProductBlocks(html) {
  const $ = cheerio.load(html);
  const out = [];

  $('a[href*="/product/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const root = $(el).closest('article, li, div');
    const text = normalizeWhitespace(root.text() || $(el).text() || '');
    const title = normalizeWhitespace($(el).attr('aria-label') || $(el).text() || '');
    if (!title || title.length < 6) return;
    const sold = /sold out|unavailable|out of stock/i.test(text);
    const available = /add to cart|in stock|available/i.test(text);
    out.push({
      name: title,
      url: href.startsWith('http') ? href : `https://www.pokemoncenter.com${href}`,
      price: moneyFrom(text),
      status: sold ? 'out' : (available ? 'in' : 'unknown'),
      note: sold ? 'Marcado como sold out/unavailable' : (moneyFrom(text) ? 'Precio detectado' : 'Resultado encontrado'),
      rawText: text
    });
  });

  const dedup = new Map();
  for (const item of out) if (!dedup.has(item.url)) dedup.set(item.url, item);
  return Array.from(dedup.values());
}

function buildStoreData(pcData) {
  const now = new Date().toISOString();
  return {
    pokemoncenter: {
      status: pcData.status || 'unknown',
      price: pcData.price || null,
      note: pcData.note || '',
      lastUpdated: now
    }
  };
}

exports.handler = async function (event) {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const query = String(body.query || '').trim();
    if (!query) {
      return { statusCode: 400, headers:{'content-type':'application/json'}, body: JSON.stringify({ error: 'Missing query' }) };
    }

    const urls = [
      `https://www.pokemoncenter.com/search/${encodeURIComponent(query)}`,
      `https://www.pokemoncenter.com/category/tcg-cards`
    ];

    let items = [];
    const sources = [];

    for (const url of urls) {
      try {
        const page = await fetchText(url);
        sources.push({ url, ok: page.ok, status: page.status });
        if (page.ok && page.text) items.push(...extractProductBlocks(page.text));
      } catch (e) {
        sources.push({ url, ok: false, status: 0, error: e.message });
      }
    }

    const q = query.toLowerCase();
    items = items.filter(x => x.name.toLowerCase().includes(q) || (x.rawText || '').toLowerCase().includes(q));

    const dedup = new Map();
    for (const item of items) if (!dedup.has(item.url)) dedup.set(item.url, item);
    let results = Array.from(dedup.values()).slice(0, 40);

    if (!results.length) {
      results = [{
        name: query,
        url: `https://www.pokemoncenter.com/search/${encodeURIComponent(query)}`,
        price: null,
        status: 'unknown',
        note: 'No se pudo confirmar coincidencia exacta; usa búsqueda rápida'
      }];
    }

    const payload = results.map((item, idx) => ({
      key: item.url || `${query}-${idx}`,
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
        results: payload
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
