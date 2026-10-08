const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Parser = require('rss-parser');
const { db } = require('./db');

const USER_AGENT = 'Mozilla/5.0 (compatible; NewsReader/1.0; RSS)';
const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': USER_AGENT } });

db.exec(`
  CREATE TABLE IF NOT EXISTS feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    last_fetched TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS feed_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    summary TEXT DEFAULT '',
    image TEXT DEFAULT '',
    pub_date TEXT,
    post_id INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_feed_items_pub ON feed_items (pub_date DESC);
`);
db.pragma('foreign_keys = ON');

// Seed default sources on first run
if (db.prepare('SELECT COUNT(*) c FROM feeds').get().c === 0) {
  const add = db.prepare('INSERT INTO feeds (name, url) VALUES (?, ?)');
  add.run('VnExpress - Tin mới nhất', 'https://vnexpress.net/rss/tin-moi-nhat.rss');
  add.run('VnExpress - Giải trí', 'https://vnexpress.net/rss/giai-tri.rss');
  add.run('Kenh14 - Trang chủ', 'https://kenh14.vn/rss/home.rss');
  add.run('Kenh14 - Star', 'https://kenh14.vn/rss/star.rss');
}

function decodeEntities(str) {
  return String(str)
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripHtml(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractImage(item) {
  if (item.enclosure && item.enclosure.url && /image/.test(item.enclosure.type || 'image')) return item.enclosure.url;
  const m = String(item.content || item.description || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : '';
}

async function fetchFeed(feed) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO feed_items (feed_id, guid, title, link, summary, image, pub_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  try {
    const data = await parser.parseURL(feed.url);
    let added = 0;
    for (const item of data.items || []) {
      const link = (item.link || '').trim();
      const title = stripHtml(item.title);
      if (!link || !title) continue;
      const pub = item.isoDate || (item.pubDate && !isNaN(Date.parse(item.pubDate)) ? new Date(item.pubDate).toISOString() : null);
      const r = insert.run(
        feed.id,
        item.guid || link,
        title,
        link,
        stripHtml(item.content || item.description || item.contentSnippet).slice(0, 500),
        extractImage(item),
        pub || new Date().toISOString()
      );
      added += r.changes;
    }
    db.prepare("UPDATE feeds SET last_fetched = datetime('now','localtime'), last_error = NULL WHERE id = ?").run(feed.id);
    return { added };
  } catch (err) {
    db.prepare("UPDATE feeds SET last_fetched = datetime('now','localtime'), last_error = ? WHERE id = ?").run(String(err.message).slice(0, 300), feed.id);
    return { added: 0, error: err.message };
  }
}

async function fetchAll() {
  const feeds = db.prepare('SELECT * FROM feeds').all();
  let added = 0;
  const errors = [];
  for (const feed of feeds) {
    const r = await fetchFeed(feed);
    added += r.added;
    if (r.error) errors.push(`${feed.name}: ${r.error}`);
  }
  // Keep the table small: drop old items that were never imported
  db.prepare("DELETE FROM feed_items WHERE post_id IS NULL AND pub_date < ?").run(new Date(Date.now() - 1 * 86400e3).toISOString());
  return { added, errors };
}

// Download a remote image into public/uploads so the post doesn't hotlink the source CDN.
// Falls back to the remote URL on failure.
async function downloadImage(url, uploadDir) {
  if (!url) return '';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) return url;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return url;
    const ext = { 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[type.split(';')[0]] || '.jpg';
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(uploadDir, name), buf);
    return `/uploads/${name}`;
  } catch {
    return url;
  }
}

module.exports = { fetchFeed, fetchAll, downloadImage };
