// Inkwell — zero-dependency Node server with multi-user auth.
// Passwords hashed with scrypt; sessions are signed HttpOnly cookies (stateless).
// Each user's notes live under data/u_<userId>/. Run with:  node server.js

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4321;
const MAX_USERS = 10;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, '.secret');

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.webp':'image/webp', '.ico':'image/x-icon',
};

const id = () => crypto.randomBytes(9).toString('hex');
const now = () => new Date().toISOString();

// ---- fs helpers ---------------------------------------------------
async function ensureDir(p){ await fsp.mkdir(p, { recursive: true }); }
async function readJSON(p, fb=null){ try{ return JSON.parse(await fsp.readFile(p,'utf-8')); }catch{ return fb; } }
async function writeJSON(p, o){ await fsp.writeFile(p, JSON.stringify(o,null,2),'utf-8'); }
function safeName(s){ return String(s||'').replace(/[<>:"/\\|?*]/g,'').trim().slice(0,80) || 'Untitled'; }

// ---- secret (for signing cookies) ---------------------------------
let SECRET = '';
async function loadSecret(){
  await ensureDir(DATA_DIR);
  SECRET = await readJSON(SECRET_FILE)?.k || null;
  if (!SECRET){ SECRET = crypto.randomBytes(32).toString('hex'); await writeJSON(SECRET_FILE, { k: SECRET }); }
}

// ---- password + session -------------------------------------------
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')){
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash){
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sign(uid){
  const mac = crypto.createHmac('sha256', SECRET).update(uid).digest('hex');
  return uid + '.' + mac;
}
function verifyToken(tok){
  if (!tok || !tok.includes('.')) return null;
  const i = tok.lastIndexOf('.');
  const uid = tok.slice(0, i), mac = tok.slice(i+1);
  const good = crypto.createHmac('sha256', SECRET).update(uid).digest('hex');
  const a = Buffer.from(mac), b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? uid : null;
}
function parseCookies(req){
  const out = {}; const raw = req.headers.cookie || '';
  raw.split(';').forEach(p => { const i = p.indexOf('='); if (i>0) out[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1).trim()); });
  return out;
}

// ---- users --------------------------------------------------------
async function loadUsers(){ return (await readJSON(USERS_FILE, [])) || []; }
async function saveUsers(u){ await writeJSON(USERS_FILE, u); }
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, createdAt: u.createdAt });
async function currentUser(req){
  const uid = verifyToken(parseCookies(req).session);
  if (!uid) return null;
  const users = await loadUsers();
  return users.find(u => u.id === uid) || null;
}

// ---- data paths (user-scoped) -------------------------------------
const userRoot  = uid => path.join(DATA_DIR, 'u_' + uid);
const projectDir = (uid,pid) => path.join(userRoot(uid), pid);
const notesDir   = (uid,pid) => path.join(projectDir(uid,pid), 'notes');
const assetsDir  = (uid,pid) => path.join(projectDir(uid,pid), 'assets');

async function listProjects(uid){
  await ensureDir(userRoot(uid));
  const entries = await fsp.readdir(userRoot(uid), { withFileTypes:true });
  const out = [];
  for (const e of entries){
    if (!e.isDirectory()) continue;
    const meta = await readJSON(path.join(userRoot(uid), e.name, 'project.json'));
    if (meta) out.push(meta);
  }
  out.sort((a,b)=> a.createdAt < b.createdAt ? -1 : 1);
  return out;
}
async function listNotes(uid,pid){
  try{
    const files = await fsp.readdir(notesDir(uid,pid));
    const out = [];
    for (const f of files){
      if (!f.endsWith('.json')) continue;
      const n = await readJSON(path.join(notesDir(uid,pid), f));
      if (n) out.push({ id:n.id, title:n.title, pageType:n.pageType, updatedAt:n.updatedAt, createdAt:n.createdAt });
    }
    out.sort((a,b)=> a.updatedAt < b.updatedAt ? 1 : -1);
    return out;
  }catch{ return []; }
}

// ---- http helpers -------------------------------------------------
function send(res, code, body, headers={}){ res.writeHead(code, { 'Cache-Control':'no-store', ...headers }); res.end(body); }
function sendJSON(res, code, obj, headers={}){ send(res, code, JSON.stringify(obj), { 'Content-Type':'application/json; charset=utf-8', ...headers }); }
function readBody(req, limit=40*1024*1024){
  return new Promise((resolve,reject)=>{
    let size=0; const chunks=[];
    req.on('data', c=>{ size+=c.length; if(size>limit){ reject(new Error('Payload too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', ()=>resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function jsonBody(req){ try{ return JSON.parse((await readBody(req)).toString() || '{}'); }catch{ return {}; } }
function cookieHeader(tok){
  const week = 60*60*24*30; // 30 days
  return `session=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${week}`;
}
const clearCookie = 'session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';

// ===================================================================
//  AUTH ROUTES
// ===================================================================
async function handleAuth(req, res, parts){
  const method = req.method, sub = parts[2];

  if (sub === 'signup' && method === 'POST'){
    const b = await jsonBody(req);
    const name = safeName(b.name);
    const email = String(b.email||'').trim().toLowerCase();
    const pw = String(b.password||'');
    if (!email.includes('@') || pw.length < 6) return sendJSON(res, 400, { error:'Enter a valid email and a password of at least 6 characters.' });
    const users = await loadUsers();
    if (users.length >= MAX_USERS) return sendJSON(res, 403, { error:`This Inkwell instance is limited to ${MAX_USERS} users and is full.` });
    if (users.some(u => u.email === email)) return sendJSON(res, 409, { error:'An account with that email already exists.' });
    const { salt, hash } = hashPassword(pw);
    const u = { id:id(), name: name || email.split('@')[0], email, salt, hash, createdAt: now() };
    users.push(u); await saveUsers(users);
    await ensureDir(userRoot(u.id));
    return sendJSON(res, 201, publicUser(u), { 'Set-Cookie': cookieHeader(sign(u.id)) });
  }

  if (sub === 'login' && method === 'POST'){
    const b = await jsonBody(req);
    const email = String(b.email||'').trim().toLowerCase();
    const users = await loadUsers();
    const u = users.find(x => x.email === email);
    if (!u || !verifyPassword(String(b.password||''), u.salt, u.hash))
      return sendJSON(res, 401, { error:'Incorrect email or password.' });
    return sendJSON(res, 200, publicUser(u), { 'Set-Cookie': cookieHeader(sign(u.id)) });
  }

  if (sub === 'logout' && method === 'POST')
    return sendJSON(res, 200, { ok:true }, { 'Set-Cookie': clearCookie });

  if (sub === 'me'){
    const u = await currentUser(req);
    if (!u) return sendJSON(res, 401, { error:'not authenticated' });
    if (method === 'GET') return sendJSON(res, 200, publicUser(u));
    if (method === 'PUT'){ // edit display name
      const b = await jsonBody(req);
      const users = await loadUsers();
      const me = users.find(x => x.id === u.id);
      me.name = safeName(b.name) || me.name;
      await saveUsers(users);
      return sendJSON(res, 200, publicUser(me));
    }
  }

  if (sub === 'password' && method === 'PUT'){
    const u = await currentUser(req);
    if (!u) return sendJSON(res, 401, { error:'not authenticated' });
    const b = await jsonBody(req);
    if (!verifyPassword(String(b.current||''), u.salt, u.hash))
      return sendJSON(res, 401, { error:'Current password is incorrect.' });
    if (String(b.next||'').length < 6) return sendJSON(res, 400, { error:'New password must be at least 6 characters.' });
    const users = await loadUsers();
    const me = users.find(x => x.id === u.id);
    const { salt, hash } = hashPassword(String(b.next));
    me.salt = salt; me.hash = hash;
    await saveUsers(users);
    return sendJSON(res, 200, { ok:true });
  }

  return sendJSON(res, 404, { error:'unknown auth endpoint' });
}

// ===================================================================
//  NOTES / PROJECTS ROUTES  (all require a logged-in user)
// ===================================================================
async function handleData(req, res, parts, uid){
  const method = req.method;

  if (parts.length === 2 && parts[1] === 'projects'){
    if (method === 'GET') return sendJSON(res, 200, await listProjects(uid));
    if (method === 'POST'){
      const b = await jsonBody(req); const pid = id();
      const proj = { id:pid, name: safeName(b.name)||'New Project', createdAt: now() };
      await ensureDir(notesDir(uid,pid)); await ensureDir(assetsDir(uid,pid));
      await writeJSON(path.join(projectDir(uid,pid),'project.json'), proj);
      return sendJSON(res, 201, proj);
    }
  }

  if (parts.length === 3 && parts[1] === 'projects'){
    const pid = parts[2];
    if (method === 'PUT'){
      const b = await jsonBody(req); const mp = path.join(projectDir(uid,pid),'project.json');
      const meta = await readJSON(mp); if (!meta) return sendJSON(res, 404, { error:'not found' });
      meta.name = safeName(b.name); await writeJSON(mp, meta); return sendJSON(res, 200, meta);
    }
    if (method === 'DELETE'){ await fsp.rm(projectDir(uid,pid), { recursive:true, force:true }); return sendJSON(res, 200, { ok:true }); }
  }

  if (parts.length === 4 && parts[1] === 'projects' && parts[3] === 'notes'){
    const pid = parts[2];
    if (method === 'GET') return sendJSON(res, 200, await listNotes(uid,pid));
    if (method === 'POST'){
      const b = await jsonBody(req); const nid = id();
      const note = { id:nid, title:safeName(b.title)||'Untitled',
        pageType:['blank','ruled','grid'].includes(b.pageType)?b.pageType:'ruled',
        html:'', strokes:[], createdAt:now(), updatedAt:now() };
      await ensureDir(notesDir(uid,pid));
      await writeJSON(path.join(notesDir(uid,pid), nid+'.json'), note);
      return sendJSON(res, 201, note);
    }
  }

  if (parts.length === 5 && parts[1] === 'projects' && parts[3] === 'notes'){
    const pid = parts[2], nid = parts[4];
    const np = path.join(notesDir(uid,pid), nid+'.json');
    if (method === 'GET'){ const n = await readJSON(np); return n ? sendJSON(res,200,n) : sendJSON(res,404,{error:'not found'}); }
    if (method === 'PUT'){
      const b = await jsonBody(req);
      const n = await readJSON(np) || { id:nid, createdAt:now() };
      if (typeof b.title === 'string') n.title = safeName(b.title);
      if (typeof b.html === 'string') n.html = b.html;
      if (Array.isArray(b.strokes)) n.strokes = b.strokes;
      if (['blank','ruled','grid'].includes(b.pageType)) n.pageType = b.pageType;
      n.id = nid; n.updatedAt = now();
      await writeJSON(np, n);
      return sendJSON(res, 200, { ok:true, updatedAt:n.updatedAt });
    }
    if (method === 'DELETE'){ await fsp.rm(np, { force:true }); return sendJSON(res, 200, { ok:true }); }
  }

  if (parts.length === 5 && parts[1] === 'projects' && parts[3] === 'assets' && parts[4] === 'upload' && method === 'POST'){
    const pid = parts[2]; const b = await jsonBody(req);
    const m = /^data:(image\/(png|jpeg|jpg|gif|webp));base64,(.+)$/.exec(b.dataUrl||'');
    if (!m) return sendJSON(res, 400, { error:'invalid image' });
    const ext = m[2]==='jpeg'?'jpg':m[2]; const fname = id()+'.'+ext;
    await ensureDir(assetsDir(uid,pid));
    await fsp.writeFile(path.join(assetsDir(uid,pid), fname), Buffer.from(m[3],'base64'));
    return sendJSON(res, 201, { url:`/api/projects/${pid}/assets/${fname}` });
  }

  if (parts.length === 5 && parts[1] === 'projects' && parts[3] === 'assets' && method === 'GET'){
    const pid = parts[2], file = safeName(parts[4]);
    try{
      const data = await fsp.readFile(path.join(assetsDir(uid,pid), file));
      return send(res, 200, data, { 'Content-Type': MIME[path.extname(file).toLowerCase()]||'application/octet-stream', 'Cache-Control':'private, max-age=31536000' });
    }catch{ return sendJSON(res, 404, { error:'not found' }); }
  }

  return sendJSON(res, 404, { error:'unknown endpoint' });
}

// ---- static -------------------------------------------------------
async function serveStatic(req, res, url){
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const fp = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!fp.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  try{
    const data = await fsp.readFile(fp);
    return send(res, 200, data, { 'Content-Type': MIME[path.extname(fp).toLowerCase()]||'application/octet-stream' });
  }catch{ return send(res, 404, 'Not found'); }
}

// ---- server -------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try{
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api'){
      if (parts[1] === 'auth') return await handleAuth(req, res, parts);
      const u = await currentUser(req);
      if (!u) return sendJSON(res, 401, { error:'not authenticated' });
      return await handleData(req, res, parts, u.id);
    }
    return await serveStatic(req, res, url);
  }catch(err){ sendJSON(res, 500, { error:String(err && err.message || err) }); }
});

(async () => {
  await loadSecret();
  server.listen(PORT, () => {
    console.log(`\n  Inkwell running:  http://localhost:${PORT}`);
    console.log(`  Data folder: ${DATA_DIR}   (max ${MAX_USERS} users)\n`);
  });
})();
