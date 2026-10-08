const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { db, getSettings, setSetting, hashPassword, verifyPassword } = require('./db');
const feeds = require('./feeds');

const PORT = process.env.PORT || 3000;
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 7 * 24 * 3600 * 1000 },
  })
);

// ---------- Upload ----------
const uploadDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// ---------- Helpers ----------
function slugify(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'bai-viet';
}

function uniqueSlug(base, excludeId = 0) {
  let slug = base;
  let i = 2;
  while (db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').get(slug, excludeId)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function absUrl(req, p) {
  if (!p) return '';
  if (/^https?:\/\//.test(p)) return p;
  return `${req.protocol}://${req.get('host')}${p}`;
}

function requireAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.redirect('/admin/login');
}

app.use((req, res, next) => {
  res.locals.settings = getSettings();
  res.locals.flash = req.session.flash;
  delete req.session.flash;
  next();
});

// ---------- Public ----------
app.get('/', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 12;
  const total = db.prepare('SELECT COUNT(*) c FROM posts WHERE published = 1').get().c;
  const posts = db
    .prepare('SELECT * FROM posts WHERE published = 1 ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(perPage, (page - 1) * perPage);
  res.render('index', { posts, page, totalPages: Math.ceil(total / perPage), popular: getPopular() });
});

function getPopular(excludeId = 0) {
  return db
    .prepare('SELECT id, title, slug, thumbnail, created_at FROM posts WHERE published = 1 AND id != ? ORDER BY views DESC, id DESC LIMIT 5')
    .all(excludeId);
}

function readingTime(html) {
  const words = String(html).replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

app.get('/p/:slug', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!post) return res.status(404).render('404');
  db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(post.id);

  const s = res.locals.settings;
  const related = db
    .prepare('SELECT id, title, slug, thumbnail, created_at FROM posts WHERE published = 1 AND id != ? ORDER BY id DESC LIMIT 4')
    .all(post.id);

  res.render('post', {
    post,
    related,
    popular: getPopular(post.id),
    readMinutes: readingTime(post.content),
    pageUrl: absUrl(req, `/p/${post.slug}`),
    ogImage: absUrl(req, post.thumbnail),
    popup: {
      enabled: s.popup_enabled === '1',
      redirectUrl: post.redirect_url || s.redirect_url,
      newTab: s.redirect_mode === 'new_tab',
      delay: parseInt(s.popup_delay) || 0,
      postId: post.id,
    },
  });
});

app.post('/api/click/:id', (req, res) => {
  db.prepare('UPDATE posts SET clicks = clicks + 1 WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- Admin: auth ----------
app.get('/admin/login', (req, res) => res.render('admin/login', { error: null }));

app.post('/admin/login', (req, res) => {
  const s = getSettings();
  const { username, password } = req.body;
  if (username === s.admin_username && verifyPassword(password || '', s.admin_password)) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: 'Sai tên đăng nhập hoặc mật khẩu' });
});

app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

// ---------- Admin: posts ----------
app.get('/admin', requireAdmin, (req, res) => {
  const posts = db.prepare('SELECT * FROM posts ORDER BY id DESC').all();
  res.render('admin/posts', { posts });
});

// Quick update of the default redirect link from the posts list
app.post('/admin/default-link', requireAdmin, (req, res) => {
  const url = (req.body.redirect_url || '').trim();
  if (!isValidUrl(url)) {
    req.session.flash = { type: 'error', msg: 'Link không hợp lệ (phải bắt đầu bằng http:// hoặc https://)' };
  } else {
    setSetting('redirect_url', url);
    req.session.flash = { type: 'success', msg: 'Đã lưu link chuyển hướng mặc định' };
  }
  res.redirect('/admin');
});

app.get('/admin/posts/new', requireAdmin, (req, res) => {
  res.render('admin/edit', { post: { id: 0, title: '', slug: '', summary: '', thumbnail: '', content: '', redirect_url: '', published: 1 } });
});

app.get('/admin/posts/:id/edit', requireAdmin, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.redirect('/admin');
  res.render('admin/edit', { post });
});

app.post('/admin/posts/save', requireAdmin, upload.single('thumbnail_file'), (req, res) => {
  const id = parseInt(req.body.id) || 0;
  const title = (req.body.title || '').trim();
  const redirectUrl = (req.body.redirect_url || '').trim();
  if (!title) {
    req.session.flash = { type: 'error', msg: 'Tiêu đề không được để trống' };
    return res.redirect(id ? `/admin/posts/${id}/edit` : '/admin/posts/new');
  }
  if (redirectUrl && !isValidUrl(redirectUrl)) {
    req.session.flash = { type: 'error', msg: 'Link chuyển hướng không hợp lệ (phải bắt đầu bằng http:// hoặc https://)' };
    return res.redirect(id ? `/admin/posts/${id}/edit` : '/admin/posts/new');
  }

  const slug = uniqueSlug(slugify(req.body.slug || title), id);
  const thumbnail = req.file ? `/uploads/${req.file.filename}` : (req.body.thumbnail || '').trim();
  const data = {
    title,
    slug,
    summary: (req.body.summary || '').trim(),
    thumbnail,
    content: req.body.content || '',
    redirect_url: redirectUrl,
    published: req.body.published ? 1 : 0,
  };

  if (id) {
    db.prepare(
      `UPDATE posts SET title=@title, slug=@slug, summary=@summary, thumbnail=@thumbnail, content=@content,
       redirect_url=@redirect_url, published=@published, updated_at=datetime('now','localtime') WHERE id=@id`
    ).run({ ...data, id });
  } else {
    db.prepare(
      `INSERT INTO posts (title, slug, summary, thumbnail, content, redirect_url, published)
       VALUES (@title, @slug, @summary, @thumbnail, @content, @redirect_url, @published)`
    ).run(data);
  }
  req.session.flash = { type: 'success', msg: 'Đã lưu bài viết' };
  res.redirect('/admin');
});

app.post('/admin/posts/:id/delete', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  db.prepare('UPDATE feed_items SET post_id = NULL WHERE post_id = ?').run(req.params.id);
  req.session.flash = { type: 'success', msg: 'Đã xóa bài viết' };
  res.redirect('/admin');
});

// Image upload for the rich text editor
app.post('/admin/upload', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Invalid file' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ---------- Admin: settings ----------
app.get('/admin/settings', requireAdmin, (req, res) => res.render('admin/settings'));

// Popup preview rendered inside an iframe on the settings page
app.get('/admin/popup-preview', requireAdmin, (req, res) => res.render('admin/popup-preview'));

app.post('/admin/settings', requireAdmin, upload.single('popup_image_file'), (req, res) => {
  const b = req.body;
  const redirectUrl = (b.redirect_url || '').trim();
  if (!isValidUrl(redirectUrl)) {
    req.session.flash = { type: 'error', msg: 'Link chuyển hướng không hợp lệ (phải bắt đầu bằng http:// hoặc https://)' };
    return res.redirect('/admin/settings');
  }

  setSetting('site_name', (b.site_name || '').trim());
  setSetting('site_description', (b.site_description || '').trim());
  setSetting('redirect_url', redirectUrl);
  setSetting('redirect_mode', b.redirect_mode === 'new_tab' ? 'new_tab' : 'same_tab');
  setSetting('popup_enabled', b.popup_enabled ? '1' : '0');
  setSetting('popup_title', b.popup_title || '');
  setSetting('popup_text', b.popup_text || '');
  setSetting('popup_button', b.popup_button || '');
  setSetting('popup_brand', (b.popup_brand || '').trim());
  setSetting('popup_badge', (b.popup_badge || '').trim());
  setSetting('popup_layout', ['center', 'fullscreen', 'bottom'].includes(b.popup_layout) ? b.popup_layout : 'center');
  setSetting('popup_delay', String(Math.max(0, parseInt(b.popup_delay) || 0)));
  if (req.file) setSetting('popup_image', `/uploads/${req.file.filename}`);
  else if (b.remove_popup_image) setSetting('popup_image', '');
  else if (b.popup_image !== undefined) setSetting('popup_image', b.popup_image.trim());

  if (b.admin_username && b.admin_username.trim()) setSetting('admin_username', b.admin_username.trim());
  if (b.new_password) {
    if (b.new_password.length < 6) {
      req.session.flash = { type: 'error', msg: 'Mật khẩu mới phải có ít nhất 6 ký tự (các cài đặt khác đã được lưu)' };
      return res.redirect('/admin/settings');
    }
    setSetting('admin_password', hashPassword(b.new_password));
  }

  req.session.flash = { type: 'success', msg: 'Đã lưu cài đặt' };
  res.redirect('/admin/settings');
});

// ---------- Admin: RSS sources ----------
app.get('/admin/feeds', requireAdmin, (req, res) => {
  const feedId = parseInt(req.query.feed) || 0;
  const status = req.query.status === 'imported' ? 'imported' : req.query.status === 'all' ? 'all' : 'new';
  const where = [];
  const params = [];
  if (feedId) { where.push('i.feed_id = ?'); params.push(feedId); }
  if (status === 'new') where.push('i.post_id IS NULL');
  if (status === 'imported') where.push('i.post_id IS NOT NULL');
  const items = db
    .prepare(
      `SELECT i.*, f.name AS feed_name FROM feed_items i JOIN feeds f ON f.id = i.feed_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.pub_date DESC LIMIT 200`
    )
    .all(...params);
  const feedList = db
    .prepare(
      `SELECT f.*, (SELECT COUNT(*) FROM feed_items i WHERE i.feed_id = f.id AND i.post_id IS NULL) AS new_count
       FROM feeds f ORDER BY f.id`
    )
    .all();
  res.render('admin/feeds', { items, feedList, feedId, status });
});

app.post('/admin/feeds/add', requireAdmin, async (req, res) => {
  const name = (req.body.name || '').trim();
  const url = (req.body.url || '').trim();
  if (!name || !isValidUrl(url)) {
    req.session.flash = { type: 'error', msg: 'Cần nhập tên và link RSS hợp lệ' };
    return res.redirect('/admin/feeds');
  }
  try {
    const info = db.prepare('INSERT INTO feeds (name, url) VALUES (?, ?)').run(name, url);
    const r = await feeds.fetchFeed({ id: info.lastInsertRowid, url });
    req.session.flash = r.error
      ? { type: 'error', msg: `Đã thêm nguồn nhưng không đọc được RSS: ${r.error}` }
      : { type: 'success', msg: `Đã thêm nguồn, lấy được ${r.added} tin` };
  } catch {
    req.session.flash = { type: 'error', msg: 'Link RSS này đã tồn tại' };
  }
  res.redirect('/admin/feeds');
});

app.post('/admin/feeds/:id/delete', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM feeds WHERE id = ?').run(req.params.id); // items are removed by ON DELETE CASCADE
  req.session.flash = { type: 'success', msg: 'Đã xóa nguồn' };
  res.redirect('/admin/feeds');
});

app.post('/admin/feeds/refresh', requireAdmin, async (req, res) => {
  const r = await feeds.fetchAll();
  req.session.flash = r.errors.length
    ? { type: 'error', msg: `Lấy được ${r.added} tin mới. Lỗi: ${r.errors.join('; ')}` }
    : { type: 'success', msg: `Lấy được ${r.added} tin mới` };
  res.redirect('/admin/feeds');
});

// Create draft posts from feed items: title, short summary, thumbnail and a source credit only
async function importItem(itemId) {
  const item = db
    .prepare('SELECT i.*, f.name AS feed_name FROM feed_items i JOIN feeds f ON f.id = i.feed_id WHERE i.id = ?')
    .get(itemId);
  if (!item || item.post_id) return item ? item.post_id : null;

  const source = item.feed_name.split(' - ')[0];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const content =
    `<p>${esc(item.summary)}</p>` +
    `<p><em>Nguồn: <a href="${esc(item.link)}" target="_blank" rel="nofollow noopener">${esc(source)}</a></em></p>`;
  const thumbnail = await feeds.downloadImage(item.image, uploadDir);

  const info = db
    .prepare('INSERT INTO posts (title, slug, summary, thumbnail, content, published) VALUES (?, ?, ?, ?, ?, 0)')
    .run(item.title, uniqueSlug(slugify(item.title)), item.summary, thumbnail, content);
  db.prepare('UPDATE feed_items SET post_id = ? WHERE id = ?').run(info.lastInsertRowid, item.id);
  return info.lastInsertRowid;
}

app.post('/admin/feeds/import', requireAdmin, async (req, res) => {
  const back = req.get('Referrer') || '/admin/feeds';
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) {
    req.session.flash = { type: 'error', msg: 'Chưa chọn tin nào' };
    return res.redirect(back);
  }
  const postIds = [];
  for (const id of ids) {
    const postId = await importItem(id);
    if (postId) postIds.push(postId);
  }
  if (ids.length === 1 && postIds.length) {
    req.session.flash = { type: 'success', msg: 'Đã tạo bài nháp. Hãy viết thêm nội dung rồi bật "Hiển thị bài viết".' };
    return res.redirect(`/admin/posts/${postIds[0]}/edit`);
  }
  req.session.flash = { type: 'success', msg: `Đã tạo ${postIds.length} bài nháp. Vào mục Bài viết để chỉnh sửa và đăng.` };
  res.redirect(back);
});

app.use((req, res) => res.status(404).render('404'));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
});
