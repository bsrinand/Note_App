'use strict';

// ---------- tiny API layer ----------
const api = {
  async get(u){ const r = await fetch(u); return r.json(); },
  async post(u, b){ const r = await fetch(u, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b||{})}); return r.json(); },
  async put(u, b){ const r = await fetch(u, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b||{})}); return r.json(); },
  async del(u){ const r = await fetch(u, {method:'DELETE'}); return r.json(); },
};

// ---------- state ----------
const state = {
  user: null,
  projects: [], notes: [],
  projectId: null, noteId: null,
  note: null,               // full loaded note
  strokes: [],              // vector ink
  pageType: 'ruled',
  penMode: false, eraser: false,
  penColor: '#2b5cff', penSize: 2.5,
};

// ---------- elements ----------
const $ = s => document.querySelector(s);
const projectList = $('#projectList'), noteList = $('#noteList');
const projectNameEl = $('#projectName'), newNoteBtn = $('#newNoteBtn');
const emptyState = $('#emptyState'), editorInner = $('#editorInner');
const titleInput = $('#noteTitle'), saveStatus = $('#saveStatus');
const page = $('#page'), textLayer = $('#textLayer'), canvas = $('#inkLayer');
const ctx = canvas.getContext('2d');
const penBtn = $('#penBtn'), eraserBtn = $('#eraserBtn');
const penColor = $('#penColor'), penSize = $('#penSize'), undoBtn = $('#undoBtn');
const imageBtn = $('#imageBtn'), fileInput = $('#fileInput');
const pageTypeSeg = $('#pageTypeSeg');

textLayer.setAttribute('data-ph', 'Start typing…  (toggle ✒️ Pen to write with a stylus)');

// ===================================================================
//  PROJECTS
// ===================================================================
async function loadProjects(){
  state.projects = await api.get('/api/projects');
  renderProjects();
}
function renderProjects(){
  projectList.innerHTML = '';
  state.projects.forEach(p => {
    const el = document.createElement('div');
    el.className = 'item' + (p.id === state.projectId ? ' active' : '');
    el.innerHTML = `<span class="name">📁 ${escapeHtml(p.name)}</span>
      <button class="row-btn" data-act="rename" title="Rename">✎</button>
      <button class="row-btn" data-act="delete" title="Delete">🗑</button>`;
    el.querySelector('.name').onclick = () => selectProject(p.id);
    el.querySelector('[data-act=rename]').onclick = e => { e.stopPropagation(); renameProject(p); };
    el.querySelector('[data-act=delete]').onclick = e => { e.stopPropagation(); deleteProject(p); };
    projectList.appendChild(el);
  });
}
async function newProject(){
  const name = prompt('New project folder name:', 'New Project');
  if (name === null) return;
  const p = await api.post('/api/projects', { name });
  await loadProjects();
  selectProject(p.id);
}
async function renameProject(p){
  const name = prompt('Rename folder:', p.name);
  if (name === null) return;
  await api.put(`/api/projects/${p.id}`, { name });
  await loadProjects();
  if (p.id === state.projectId) projectNameEl.textContent = name;
}
async function deleteProject(p){
  if (!confirm(`Delete folder "${p.name}" and all its notes?`)) return;
  await api.del(`/api/projects/${p.id}`);
  if (p.id === state.projectId){ state.projectId = null; state.noteId = null; clearEditor(); noteList.innerHTML=''; projectNameEl.textContent='Select a folder'; newNoteBtn.disabled=true; }
  await loadProjects();
}
async function selectProject(pid){
  await flushSave();
  state.projectId = pid;
  const p = state.projects.find(x => x.id === pid);
  projectNameEl.textContent = p ? p.name : '';
  newNoteBtn.disabled = false;
  renderProjects();
  await loadNotes();
}

// ===================================================================
//  NOTES
// ===================================================================
async function loadNotes(){
  state.notes = await api.get(`/api/projects/${state.projectId}/notes`);
  renderNotes();
}
function renderNotes(){
  noteList.innerHTML = '';
  if (!state.notes.length){
    noteList.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:13px">No notes yet. Click ＋ to add one.</div>';
    return;
  }
  const icon = {blank:'📄', ruled:'📝', grid:'▦'};
  state.notes.forEach(n => {
    const el = document.createElement('div');
    el.className = 'item' + (n.id === state.noteId ? ' active' : '');
    el.innerHTML = `<span class="name">${icon[n.pageType]||'📝'} ${escapeHtml(n.title)}<br><span class="sub">${timeAgo(n.updatedAt)}</span></span>
      <button class="row-btn" data-act="delete" title="Delete">🗑</button>`;
    el.querySelector('.name').onclick = () => openNote(n.id);
    el.querySelector('[data-act=delete]').onclick = e => { e.stopPropagation(); deleteNote(n); };
    noteList.appendChild(el);
  });
}
async function newNote(){
  const n = await api.post(`/api/projects/${state.projectId}/notes`, { title:'Untitled', pageType: state.pageType });
  await loadNotes();
  openNote(n.id);
}
async function deleteNote(n){
  if (!confirm(`Delete note "${n.title}"?`)) return;
  await api.del(`/api/projects/${state.projectId}/notes/${n.id}`);
  if (n.id === state.noteId){ state.noteId=null; clearEditor(); }
  await loadNotes();
}
async function openNote(nid){
  await flushSave();
  const n = await api.get(`/api/projects/${state.projectId}/notes/${nid}`);
  state.noteId = nid; state.note = n;
  state.strokes = Array.isArray(n.strokes) ? n.strokes : [];
  state.pageType = n.pageType || 'ruled';
  titleInput.value = n.title || '';
  textLayer.style.lineHeight = '';
  textLayer.innerHTML = n.html || '';
  emptyState.classList.add('hidden');
  editorInner.classList.remove('hidden');
  applyPageType();
  renderNotes();
  requestAnimationFrame(() => { resizeCanvas(); redraw(); });
  setSaved();
}
function clearEditor(){
  editorInner.classList.add('hidden');
  emptyState.classList.remove('hidden');
  state.note = null; state.strokes = [];
}

// ===================================================================
//  SAVING (debounced)
// ===================================================================
let saveTimer = null, saving = false, dirty = false;
function markDirty(){
  dirty = true; saveStatus.textContent = 'Editing…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 600);
}
async function doSave(){
  if (!state.noteId || !dirty || saving) return;
  saving = true; dirty = false; saveStatus.textContent = 'Saving…';
  try{
    await api.put(`/api/projects/${state.projectId}/notes/${state.noteId}`, {
      title: titleInput.value,
      html: textLayer.innerHTML,
      strokes: state.strokes,
      pageType: state.pageType,
    });
    setSaved();
    // refresh note list ordering/labels quietly
    const n = state.notes.find(x => x.id === state.noteId);
    if (n){ n.title = titleInput.value; n.pageType = state.pageType; n.updatedAt = new Date().toISOString(); }
  }catch{ saveStatus.textContent = 'Save failed'; }
  saving = false;
  if (dirty) markDirty();
}
async function flushSave(){ clearTimeout(saveTimer); if (dirty) await doSave(); }
function setSaved(){ saveStatus.textContent = 'Saved'; }

// ===================================================================
//  PAGE TYPES
// ===================================================================
function applyPageType(){
  page.classList.remove('pt-blank','pt-ruled','pt-grid');
  page.classList.add('pt-' + state.pageType);
  [...pageTypeSeg.children].forEach(b => b.classList.toggle('on', b.dataset.pt === state.pageType));
}
pageTypeSeg.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.pageType = b.dataset.pt; applyPageType(); markDirty();
});

// ===================================================================
//  INK CANVAS  (low-latency pointer drawing)
// ===================================================================
let dpr = Math.max(1, window.devicePixelRatio || 1);
function resizeCanvas(){
  dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = page.clientWidth, h = page.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
}
function redraw(){
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of state.strokes) drawStroke(s);
}
function drawStroke(s){
  if (!s.points.length) return;
  ctx.strokeStyle = s.color;
  ctx.beginPath();
  const p0 = s.points[0];
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < s.points.length; i++){
    const a = s.points[i-1], b = s.points[i];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    ctx.lineWidth = s.size * (0.6 + (b.p ?? 0.5));
    ctx.quadraticCurveTo(a.x, a.y, mx, my);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mx, my);
  }
  if (s.points.length === 1){
    ctx.lineWidth = s.size;
    ctx.lineTo(p0.x + 0.1, p0.y + 0.1); ctx.stroke();
  }
}

let drawing = false, current = null;
function ptFromEvent(e){
  const r = page.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure && e.pressure > 0 ? e.pressure : 0.5 };
}
canvas.addEventListener('pointerdown', e => {
  if (!state.penMode) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  if (state.eraser){ drawing = true; eraseAt(ptFromEvent(e)); return; }
  drawing = true;
  current = { color: state.penColor, size: parseFloat(penSize.value), points: [ptFromEvent(e)] };
  state.strokes.push(current);
});
canvas.addEventListener('pointermove', e => {
  if (!drawing) return;
  e.preventDefault();
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  if (state.eraser){ for (const ev of events) eraseAt(ptFromEvent(ev)); return; }
  for (const ev of events){
    const pt = ptFromEvent(ev);
    const pts = current.points, last = pts[pts.length-1];
    pts.push(pt);
    // incremental low-latency segment
    ctx.strokeStyle = current.color;
    ctx.lineWidth = current.size * (0.6 + pt.p);
    ctx.beginPath();
    const mx = (last.x + pt.x)/2, my = (last.y + pt.y)/2;
    ctx.moveTo(last.x, last.y);
    ctx.quadraticCurveTo(last.x, last.y, mx, my);
    ctx.stroke();
  }
});
function endStroke(e){
  if (!drawing) return;
  drawing = false; current = null;
  if (state.eraser) redraw();
  markDirty();
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
canvas.addEventListener('pointerleave', e => { if (drawing) endStroke(e); });

function eraseAt(pt){
  const R = 14;
  const before = state.strokes.length;
  state.strokes = state.strokes.filter(s => !s.points.some(p => Math.hypot(p.x-pt.x, p.y-pt.y) < R + s.size));
  if (state.strokes.length !== before) redraw();
}

// ---------- pen toolbar ----------
function setPenMode(on){
  state.penMode = on;
  if (on) state.eraser = false;
  page.classList.toggle('pen', on);
  penBtn.classList.toggle('on', on);
  eraserBtn.classList.toggle('on', on && state.eraser);
}
penBtn.onclick = () => setPenMode(!state.penMode);
eraserBtn.onclick = () => {
  if (!state.penMode) setPenMode(true);
  state.eraser = !state.eraser;
  eraserBtn.classList.toggle('on', state.eraser);
};
penColor.oninput = () => { state.penColor = penColor.value; };
penSize.onchange = () => { state.penSize = parseFloat(penSize.value); };
undoBtn.onclick = () => { if (state.strokes.length){ state.strokes.pop(); redraw(); markDirty(); } };

// ===================================================================
//  TYPING + IMAGES
// ===================================================================
titleInput.addEventListener('input', markDirty);
textLayer.addEventListener('input', markDirty);

// ---------- rich-text formatting (font family, size, styles, color) ----------
let savedRange = null;
document.addEventListener('selectionchange', () => {
  const s = window.getSelection();
  if (s.rangeCount && textLayer.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
});
function restoreRange(){
  textLayer.focus();
  if (!savedRange) return;
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange);
}
try { document.execCommand('styleWithCSS', false, true); } catch {}

function exec(cmd, val = null){ restoreRange(); document.execCommand(cmd, false, val); markDirty(); updateStyleStates(); }

const styleSeg = $('#styleSeg');
styleSeg.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
styleSeg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) exec(b.dataset.cmd); });

$('#fontFamily').addEventListener('change', e => {
  restoreRange();
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('fontName', false, e.target.value || 'inherit');
  markDirty();
});
$('#fontSize').addEventListener('change', e => setFontSize(parseInt(e.target.value, 10)));
$('#textColor').addEventListener('input', e => exec('foreColor', e.target.value));

function setFontSize(px){
  restoreRange();
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;         // need selected text
  // fontSize must emit a <font size="7"> marker, so turn styleWithCSS OFF here
  document.execCommand('styleWithCSS', false, false);
  document.execCommand('fontSize', false, '7');
  document.execCommand('styleWithCSS', false, true);
  textLayer.querySelectorAll('font[size="7"]').forEach(el => {
    el.removeAttribute('size'); el.style.fontSize = px + 'px';
  });
  markDirty();
}
function updateStyleStates(){
  [['boldBtn','bold'],['italicBtn','italic'],['underlineBtn','underline'],['strikeBtn','strikeThrough']]
    .forEach(([id, cmd]) => { try { $('#'+id).classList.toggle('on', document.queryCommandState(cmd)); } catch {} });
  // alignment active state
  const alignMap = { justifyLeft:'left', justifyCenter:'center', justifyRight:'right', justifyFull:'full' };
  document.querySelectorAll('#alignSeg button').forEach(b => {
    try { b.classList.toggle('on', document.queryCommandState(b.dataset.align)); } catch {}
  });
}
textLayer.addEventListener('keyup', updateStyleStates);
textLayer.addEventListener('mouseup', updateStyleStates);

// ---------- Word-style paragraph & list controls ----------
// helper: a toolbar button that runs a command while keeping the text selection
function toolBtn(id, fn){
  const el = $('#'+id); if (!el) return;
  el.addEventListener('mousedown', e => e.preventDefault());  // don't steal selection
  el.addEventListener('click', fn);
}

// paragraph style (headings, quote, code, normal)
$('#blockStyle').addEventListener('change', e => {
  restoreRange();
  document.execCommand('formatBlock', false, e.target.value);
  markDirty();
});

// alignment
const alignSeg = $('#alignSeg');
alignSeg.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
alignSeg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) exec(b.dataset.align); });

// simple command buttons
toolBtn('tUndo', () => exec('undo'));
toolBtn('tRedo', () => exec('redo'));
toolBtn('ulBtn', () => exec('insertUnorderedList'));
toolBtn('olBtn', () => exec('insertOrderedList'));
toolBtn('indentBtn', () => exec('indent'));
toolBtn('outdentBtn', () => exec('outdent'));
toolBtn('supBtn', () => exec('superscript'));
toolBtn('subBtn', () => exec('subscript'));
toolBtn('hrBtn', () => exec('insertHorizontalRule'));
toolBtn('clearBtn', () => {
  restoreRange();
  document.execCommand('removeFormat');
  document.execCommand('formatBlock', false, 'P');
  markDirty();
});
toolBtn('linkBtn', () => {
  restoreRange();
  const url = prompt('Link URL:', 'https://');
  if (url) document.execCommand('createLink', false, url);
  markDirty();
});

// highlight color
$('#hiliteColor').addEventListener('input', e => {
  restoreRange();
  if (!document.execCommand('hiliteColor', false, e.target.value))
    document.execCommand('backColor', false, e.target.value);
  markDirty();
});

// line spacing (applied to the selected paragraphs, or whole note if none selected)
$('#lineSpacing').addEventListener('change', e => {
  if (e.target.value) setLineSpacing(e.target.value);
  e.target.selectedIndex = 0;
});
function setLineSpacing(v){
  restoreRange();
  const sel = window.getSelection();
  if (sel.rangeCount){
    const range = sel.getRangeAt(0);
    const blocks = [...textLayer.querySelectorAll('p,div,h1,h2,h3,h4,li,blockquote,pre')]
      .filter(el => range.intersectsNode(el));
    if (blocks.length){ blocks.forEach(el => el.style.lineHeight = v); markDirty(); return; }
  }
  textLayer.style.lineHeight = v;   // fallback: whole note
  markDirty();
}

// keep canvas sized to the (growing) page
const ro = new ResizeObserver(() => { resizeCanvas(); redraw(); });
ro.observe(page);
window.addEventListener('resize', () => { resizeCanvas(); redraw(); });

async function uploadImage(file){
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file);
  });
  const r = await api.post(`/api/projects/${state.projectId}/assets/upload`, { dataUrl });
  return r.url;
}
function insertImageAtCaret(url){
  textLayer.focus();
  const ok = document.execCommand('insertHTML', false, `<img src="${url}" alt="">`);
  if (!ok){ textLayer.insertAdjacentHTML('beforeend', `<img src="${url}" alt="">`); }
  markDirty();
}
imageBtn.onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const f = fileInput.files[0]; if (!f) return;
  insertImageAtCaret(await uploadImage(f)); fileInput.value = '';
};
textLayer.addEventListener('paste', async e => {
  const items = [...(e.clipboardData?.items || [])];
  const img = items.find(i => i.type.startsWith('image/'));
  if (img){ e.preventDefault(); insertImageAtCaret(await uploadImage(img.getAsFile())); }
});
textLayer.addEventListener('dragover', e => e.preventDefault());
textLayer.addEventListener('drop', async e => {
  const f = [...(e.dataTransfer?.files||[])].find(x => x.type.startsWith('image/'));
  if (f){ e.preventDefault(); insertImageAtCaret(await uploadImage(f)); }
});

// rich-text keyboard shortcuts
textLayer.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'b'){ e.preventDefault(); document.execCommand('bold'); }
  else if (k === 'i'){ e.preventDefault(); document.execCommand('italic'); }
  else if (k === 'u'){ e.preventDefault(); document.execCommand('underline'); }
  else if (k === 's'){ e.preventDefault(); flushSave(); }
});

// ===================================================================
//  helpers + wiring
// ===================================================================
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function timeAgo(iso){
  const d = (Date.now() - new Date(iso).getTime())/1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d/60)+'m ago';
  if (d < 86400) return Math.floor(d/3600)+'h ago';
  return Math.floor(d/86400)+'d ago';
}
$('#newProjectBtn').onclick = newProject;
newNoteBtn.onclick = newNote;
setInterval(() => { if (dirty && !saving) doSave(); }, 4000);

// ===================================================================
//  TOP BAR: theme, account chip, settings modal
// ===================================================================
const themeToggle = $('#themeToggle');
function syncThemeIcon(){ themeToggle.textContent = document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙'; }
function setTheme(t){
  document.documentElement.dataset.theme = t;
  localStorage.setItem('inkwell-theme', t);
  syncThemeIcon();
  const sw = $('#darkSwitch'); if (sw) sw.checked = t === 'dark';
}
syncThemeIcon();
themeToggle.onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

// panel / toolbar visibility (persisted, class on <html>)
function applyChrome(){
  const d = document.documentElement;
  d.classList.toggle('hide-panels', localStorage.getItem('inkwell-panels') === 'off');
  d.classList.toggle('hide-toolbar', localStorage.getItem('inkwell-toolbar') === 'off');
  $('#panelsToggle').classList.toggle('on', localStorage.getItem('inkwell-panels') === 'off');
  $('#toolbarToggle').classList.toggle('on', localStorage.getItem('inkwell-toolbar') === 'off');
}
function toggleChrome(key){
  const off = localStorage.getItem(key) === 'off';
  localStorage.setItem(key, off ? 'on' : 'off');
  applyChrome();
  requestAnimationFrame(() => { if (state.noteId){ resizeCanvas(); redraw(); } });
}
$('#panelsToggle').onclick = () => toggleChrome('inkwell-panels');
$('#toolbarToggle').onclick = () => toggleChrome('inkwell-toolbar');
applyChrome();

const overlay = $('#settingsOverlay');
function openSettings(){
  $('#setName').value = state.user.name;
  $('#setEmail').textContent = state.user.email;
  $('#darkSwitch').checked = document.documentElement.dataset.theme === 'dark';
  $('#nameSaved').textContent = ''; $('#pwNote').textContent = '';
  overlay.classList.remove('hidden');
}
$('#settingsBtn').onclick = openSettings;
$('#userChip').onclick = openSettings;
$('#closeSettings').onclick = () => overlay.classList.add('hidden');
overlay.onclick = e => { if (e.target === overlay) overlay.classList.add('hidden'); };
$('#darkSwitch').onchange = e => setTheme(e.target.checked ? 'dark' : 'light');

$('#saveName').onclick = async () => {
  const name = $('#setName').value.trim();
  if (!name) return;
  const u = await api.put('/api/auth/me', { name });
  state.user = u; applyUser();
  const note = $('#nameSaved'); note.textContent = 'Saved ✓'; note.className = 'mini-note ok';
};
$('#savePw').onclick = async () => {
  const note = $('#pwNote');
  const r = await fetch('/api/auth/password', { method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ current: $('#curPw').value, next: $('#newPw').value }) });
  const d = await r.json();
  if (r.ok){ note.textContent = 'Password updated ✓'; note.className = 'mini-note ok'; $('#curPw').value=''; $('#newPw').value=''; }
  else { note.textContent = d.error || 'Could not update.'; note.className = 'mini-note err'; }
};
$('#logoutBtn').onclick = async () => {
  await flushSave();
  await api.post('/api/auth/logout');
  window.location = '/login.html';
};

function applyUser(){
  $('#userName').textContent = state.user.name;
  $('#userInitial').textContent = (state.user.name[0] || '?').toUpperCase();
}

// ===================================================================
//  BOOT: require auth, then load
// ===================================================================
(async () => {
  const r = await fetch('/api/auth/me');
  if (!r.ok){ window.location = '/login.html'; return; }
  state.user = await r.json();
  applyUser();
  await loadProjects();
})();
