const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    nickname TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_by TEXT,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS time_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    page TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, page),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS daily_time (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    page TEXT NOT NULL,
    date TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, page, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

try { db.exec("ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE sessions ADD COLUMN nickname TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''"); } catch (e) {}

const AVATAR_DIR = path.join(ROOT, 'avatars');
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

const migrated = db.prepare("SELECT COUNT(*) as c FROM daily_time").get();
if (migrated.c === 0) {
  const old = db.prepare('SELECT user_id, page, seconds FROM time_records').all();
  const today = new Date().toISOString().slice(0, 10);
  const ins = db.prepare('INSERT OR IGNORE INTO daily_time (user_id, page, date, seconds) VALUES (?, ?, ?, ?)');
  old.forEach(r => ins.run(r.user_id, r.page, today, r.seconds));
}

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd + '_ftc_salt').digest('hex');
}

function generateInviteCode() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) code += chars[bytes[i] % 36];
  return code;
}

const existingAdmin = db.prepare('SELECT id, nickname FROM users WHERE username = ?').get('admin');
if (!existingAdmin) {
  db.prepare('INSERT INTO users (id, username, nickname, password, role) VALUES (?, ?, ?, ?, ?)').run(
    crypto.randomUUID(), 'admin', 'admin', hashPassword('admin123'), 'admin'
  );
} else if (!existingAdmin.nickname) {
  db.prepare("UPDATE users SET nickname = username WHERE nickname = '' OR nickname IS NULL").run();
}

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
db.prepare('DELETE FROM invite_codes WHERE expires_at < ?').run(Date.now());

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    cookies[k] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (!sid) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE sid = ? AND expires_at > ?').get(sid, Date.now());
  if (!row) return null;
  return { sid, userId: row.user_id, username: row.username, nickname: row.nickname || row.username, role: row.role };
}

function createSession(userId, username, nickname, role) {
  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (sid, user_id, username, nickname, role, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    sid, userId, username, nickname || username, role, Date.now() + 7 * 24 * 3600 * 1000
  );
  return sid;
}

function destroySession(sid) {
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.apk': 'application/vnd.android.package-archive', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const deviceMap = new Map();

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/api/login' && req.method === 'POST') {
    const { username, password } = await parseBody(req);
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, hashPassword(password));
    if (!user) return json(res, 401, { error: '账号或密码错误' });
    const nickname = user.nickname || user.username;
    const sid = createSession(user.id, user.username, nickname, user.role);
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    return json(res, 200, { message: '登录成功', username: user.username, nickname, role: user.role });
  }

  if (pathname === '/api/register' && req.method === 'POST') {
    const { username, nickname, password, confirmPassword, inviteCode } = await parseBody(req);
    if (!username || !password) return json(res, 400, { error: '账号和密码不能为空' });
    if (!inviteCode) return json(res, 400, { error: '邀请码不能为空' });
    if (password !== confirmPassword) return json(res, 400, { error: '两次密码不一致' });
    if (password.length < 6) return json(res, 400, { error: '密码至少6位' });

    const code = db.prepare('SELECT * FROM invite_codes WHERE code = ? AND expires_at > ? AND used_by IS NULL').get(inviteCode.toUpperCase(), Date.now());
    if (!code) return json(res, 400, { error: '邀请码无效或已过期' });

    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) return json(res, 409, { error: '账号已存在' });

    const id = crypto.randomUUID();
    const nick = (nickname && nickname.trim()) || username;
    db.prepare('INSERT INTO users (id, username, nickname, password, role) VALUES (?, ?, ?, ?, ?)').run(id, username, nick, hashPassword(password), 'user');
    db.prepare('UPDATE invite_codes SET used_by = ? WHERE code = ?').run(id, code.code);

    const sid = createSession(id, username, nick, 'user');
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    return json(res, 201, { message: '注册成功', username, nickname: nick });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    if (cookies.sid) destroySession(cookies.sid);
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
    return json(res, 200, { message: '已退出' });
  }

  if (pathname === '/api/me') {
    const session = getSession(req);
    if (!session) return json(res, 401, { error: '未登录' });
    const user = db.prepare('SELECT avatar FROM users WHERE id = ?').get(session.userId);
    return json(res, 200, { username: session.username, nickname: session.nickname, role: session.role, avatar: (user && user.avatar) || '' });
  }

  if (pathname === '/api/avatar' && req.method === 'POST') {
    const session = getSession(req);
    if (!session) return json(res, 401, { error: '未登录' });
    const body = await parseBody(req);
    if (!body.data) return json(res, 400, { error: '无数据' });
    const match = body.data.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/);
    if (!match) return json(res, 400, { error: '格式无效' });
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const buf = Buffer.from(match[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) return json(res, 400, { error: '图片不能超过2MB' });
    const filename = session.userId + '.' + ext;
    fs.writeFileSync(path.join(AVATAR_DIR, filename), buf);
    const avatarUrl = '/avatars/' + filename;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, session.userId);
    return json(res, 200, { avatar: avatarUrl });
  }

  if (pathname === '/api/profile' && req.method === 'PUT') {
    const session = getSession(req);
    if (!session) return json(res, 401, { error: '未登录' });
    const body = await parseBody(req);
    if (body.nickname !== undefined) {
      const nickname = body.nickname.trim() || session.username;
      db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, session.userId);
      db.prepare('UPDATE sessions SET nickname = ? WHERE user_id = ?').run(nickname, session.userId);
    }
    if (body.password) {
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(body.password), session.userId);
    }
    const updated = db.prepare('SELECT username, nickname, role FROM users WHERE id = ?').get(session.userId);
    return json(res, 200, { username: updated.username, nickname: updated.nickname, role: updated.role });
  }

  if (pathname === '/api/invite' && req.method === 'POST') {
    const session = getSession(req);
    if (!session) return json(res, 401, { error: '未登录' });
    const code = generateInviteCode();
    const expiresAt = Date.now() + 2 * 3600 * 1000;
    db.prepare('INSERT INTO invite_codes (code, created_by, expires_at) VALUES (?, ?, ?)').run(code, session.userId, expiresAt);
    return json(res, 201, { code, expiresAt });
  }

  if (pathname === '/api/time' && req.method === 'POST') {
    const session = getSession(req);
    if (!session) return json(res, 401, { error: '未登录' });
    const { page, seconds, device } = await parseBody(req);
    if (!page || !seconds || seconds <= 0) return json(res, 400, { error: '参数无效' });

    const now = Date.now();
    const entry = deviceMap.get(session.userId);
    const clientDevice = device || 'desktop';
    if (entry && entry.device !== clientDevice && (now - entry.lastReport) < 60000) {
      return json(res, 200, { ok: false, reason: 'other_device_active' });
    }
    deviceMap.set(session.userId, { device: clientDevice, lastReport: now });

    const capped = Math.min(Math.floor(seconds), 120);
    const today = new Date().toISOString().slice(0, 10);
    db.prepare('INSERT INTO time_records (user_id, page, seconds) VALUES (?, ?, ?) ON CONFLICT(user_id, page) DO UPDATE SET seconds = seconds + ?').run(session.userId, page, capped, capped);
    db.prepare('INSERT INTO daily_time (user_id, page, date, seconds) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, page, date) DO UPDATE SET seconds = seconds + ?').run(session.userId, page, today, capped, capped);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/time' && req.method === 'GET') {
    const session = getSession(req);
    if (!session) return json(res, 401, { error: '未登录' });
    const today = new Date().toISOString().slice(0, 10);
    const allPages = db.prepare('SELECT page, SUM(seconds) as seconds FROM daily_time WHERE user_id = ? GROUP BY page').all(session.userId);
    const todayPages = db.prepare('SELECT page, seconds FROM daily_time WHERE user_id = ? AND date = ?').all(session.userId, today);
    const total = allPages.reduce((s, r) => s + r.seconds, 0);
    const todayTotal = todayPages.reduce((s, r) => s + r.seconds, 0);
    return json(res, 200, { total, pages: allPages, todayTotal, todayPages });
  }

  if (pathname === '/api/version') {
    const versionFile = path.join(ROOT, 'version.json');
    try {
      const data = JSON.parse(fs.readFileSync(versionFile, 'utf-8'));
      return json(res, 200, data);
    } catch (e) { return json(res, 500, { error: '版本信息读取失败' }); }
  }

  if (pathname.startsWith('/api/users')) {
    const session = getSession(req);
    if (!session) return json(res, 401, { error: '未登录' });
    if (session.role !== 'admin') return json(res, 403, { error: '无权限' });

    if (pathname === '/api/users' && req.method === 'GET') {
      const users = db.prepare('SELECT id, username, nickname, role, created_at FROM users ORDER BY created_at').all();
      return json(res, 200, users.map(u => ({ ...u, createdAt: u.created_at, nickname: u.nickname || u.username })));
    }

    if (pathname === '/api/users' && req.method === 'POST') {
      const { username, password, role, nickname } = await parseBody(req);
      if (!username || !password) return json(res, 400, { error: '账号和密码不能为空' });
      const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (exists) return json(res, 409, { error: '账号已存在' });
      const id = crypto.randomUUID();
      const nick = (nickname && nickname.trim()) || username;
      db.prepare('INSERT INTO users (id, username, nickname, password, role) VALUES (?, ?, ?, ?, ?)').run(id, username, nick, hashPassword(password), role || 'user');
      return json(res, 201, { id, username, nickname: nick, role: role || 'user' });
    }

    const match = pathname.match(/^\/api\/users\/(.+)$/);
    if (match) {
      const id = match[1];
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!user) return json(res, 404, { error: '用户不存在' });

      if (req.method === 'PUT') {
        const body = await parseBody(req);
        if (body.nickname !== undefined) db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(body.nickname.trim() || user.username, id);
        if (body.password) db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(body.password), id);
        if (body.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, id);
        const updated = db.prepare('SELECT id, username, nickname, role, created_at FROM users WHERE id = ?').get(id);
        return json(res, 200, { ...updated, createdAt: updated.created_at });
      }

      if (req.method === 'DELETE') {
        if (user.username === 'admin') return json(res, 400, { error: '不能删除默认管理员' });
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        return json(res, 200, { message: '已删除' });
      }
    }
  }

  const protectedPages = ['/', '/index.html', '/admin.html', '/profile.html', '/settings.html'];
  if (protectedPages.includes(pathname)) {
    const session = getSession(req);
    if (!session) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
    if (pathname === '/admin.html' && session.role !== 'admin') { res.writeHead(302, { Location: '/' }); return res.end(); }
  }

  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    const ext = path.extname(filePath);
    const ct = MIME[ext] || (ext === '.jpg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'application/octet-stream');
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': stats.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(handleRequest);
server.listen(8080, '0.0.0.0', () => console.log('Server running on http://0.0.0.0:8080'));
