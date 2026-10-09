const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    summary TEXT DEFAULT '',
    thumbnail TEXT DEFAULT '',
    content TEXT DEFAULT '',
    redirect_url TEXT DEFAULT '',
    published INTEGER DEFAULT 1,
    views INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Password hashing with built-in scrypt: "salt:hash"
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return orig.length === test.length && crypto.timingSafeEqual(orig, test);
}

const DEFAULT_SETTINGS = {
  site_name: 'Tin Tức 24h',
  site_description: 'Cập nhật tin tức nhanh nhất',
  redirect_url: 'https://example.com',
  redirect_mode: 'same_tab', // same_tab | new_tab
  popup_enabled: '1',
  popup_title: 'Tai nghe Bluetooth Pro 5.3 - Chống ồn chủ động, pin 40 giờ',
  popup_text: 'Freeship toàn quốc - Bảo hành 12 tháng - Đổi trả miễn phí 7 ngày',
  popup_image: '',
  popup_button: 'Mua ngay',
  popup_price: '299.000₫',
  popup_old_price: '599.000₫',
  popup_rating: '4.9',
  popup_sold: '12,5k',
  popup_countdown: '15', // minutes, 0 = hide
  popup_delay: '0', // seconds
  popup_brand: 'SoundMax Official Store',
  popup_badge: '-50%',
  popup_layout: 'center', // center | fullscreen | bottom
  admin_username: process.env.ADMIN_USER || 'admin',
  admin_password: hashPassword(process.env.ADMIN_PASS || 'admin123'),
};

const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertDefault.run(k, v);

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

module.exports = { db, getSettings, setSetting, hashPassword, verifyPassword };
