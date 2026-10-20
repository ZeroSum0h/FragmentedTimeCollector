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
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    role TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd + '_ftc_salt').digest('hex');
}

const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existingAdmin) {
  db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(
    crypto.randomUUID(), 'admin', hashPassword('admin123'), 'admin'
  );
}

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

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
  return { sid, userId: row.user_id, username: row.username, role: row.role };
}

function createSession(userId, username, role) {
  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (sid, user_id, username, role, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    sid, userId, username, role, Date.now() + 7 * 24 * 3600 * 1000
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

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/api/login' && req.method === 'POST') {
    const { username, password } = await parseBody(req);
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, hashPassword(password));
    if (!user) return json(res, 401, { error: '用户名或密码错误' });
    const sid = createSession(user.id, user.username, user.role);
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    return json(res, 200, { message: '登录成功', username: user.username, role: user.role });
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
    return json(res, 200, { username: session.username, role: session.role });
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
      const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all();
      return json(res, 200, users.map(u => ({ ...u, createdAt: u.created_at })));
    }

    if (pathname === '/api/users' && req.method === 'POST') {
      const { username, password, role } = await parseBody(req);
      if (!username || !password) return json(res, 400, { error: '用户名和密码不能为空' });
      const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (exists) return json(res, 409, { error: '用户名已存在' });
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(id, username, hashPassword(password), role || 'user');
      return json(res, 201, { id, username, role: role || 'user' });
    }

    const match = pathname.match(/^\/api\/users\/(.+)$/);
    if (match) {
      const id = match[1];
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!user) return json(res, 404, { error: '用户不存在' });

      if (req.method === 'PUT') {
        const body = await parseBody(req);
        if (body.username) db.prepare('UPDATE users SET username = ? WHERE id = ?').run(body.username, id);
        if (body.password) db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(body.password), id);
        if (body.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, id);
        const updated = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id);
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

  if (pathname === '/' || pathname === '/index.html') {
    const session = getSession(req);
    if (!session) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
  }
  if (pathname === '/admin.html') {
    const session = getSession(req);
    if (!session) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
    if (session.role !== 'admin') { res.writeHead(302, { Location: '/' }); return res.end(); }
  }

  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': (MIME[ext] || 'application/octet-stream') + '; charset=utf-8', 'Content-Length': stats.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(handleRequest);
server.listen(8080, '0.0.0.0', () => console.log('Server running on http://0.0.0.0:8080'));
