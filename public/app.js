/* ============================================================
   1. CONSTANTS
   ============================================================ */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const PRIORITIES = { urgent:'Urgent', high:'High', medium:'Medium', low:'Low' };
const PRIORITY_RANK = { urgent:0, high:1, medium:2, low:3 };

const LABELS = [
  { name:'Design',   color:'#6C5CE7', bg:'#EFECFF' },
  { name:'Frontend', color:'#3C8DF0', bg:'#E7F1FE' },
  { name:'Backend',  color:'#00B894', bg:'#E1F7F1' },
  { name:'Bug',      color:'#FF5C68', bg:'#FFE8EA' },
  { name:'Research', color:'#F0A93B', bg:'#FDF1DF' },
  { name:'Content',  color:'#E84393', bg:'#FDE9F3' },
  { name:'QA',       color:'#00A8B5', bg:'#E0F5F7' }
];
const labelStyle = n => LABELS.find(l => l.name === n) || { color:'#5A5F73', bg:'#F5F6FA' };

/* The team comes from Supabase: profiles of everyone in the workspace. */
let MEMBERS = [];   // [{ id, name, email, color, role }]
const member = id => MEMBERS.find(m => m.id === id) || null;
const initials = n => String(n || '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0,2).toUpperCase() || '?';
const COL_DOTS = ['#9096AB','#3C8DF0','#00B894','#6C5CE7','#F0A93B','#E84393'];

/* ============================================================
   2. SUPABASE + SYNC
   Every board, column, task, checklist item, comment and attachment is a
   row in Supabase. The app keeps the nested shape it always had in memory;
   flatten() turns it into rows and build() turns rows back into boards.
   A save compares the rows with the last copy the server confirmed
   (`snapshot`) and writes only what changed.
   ============================================================ */
const CFG = window.FLOWLANE_CONFIG || {};
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const PREFS_KEY = 'flowlane:prefs';
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch(e){ return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };

let session = null;
let workspace = null;   // { id, name, role }
let invites = [];       // pending invites [{ email, role, created_at }]
let activity = [];      // newest first [{ id, board_id, task_id, actor_id, action, details, at }]
let isOnline = true, syncing = false, syncAgain = false;
const cacheKey = () => 'flowlane:cache:' + session.user.id;

/** Fields the app syncs for each table, parents before children. */
const SPEC = {
  boards:          ['id','workspace_id','name','position'],
  board_columns:   ['id','board_id','title','position','collapsed'],
  tasks:           ['id','board_id','column_id','title','description','priority','assignee_id','due_date','labels','position','archived'],
  checklist_items: ['id','task_id','text','done','position'],
  comments:        ['id','task_id','author_id','body','created_at'],
  attachments:     ['id','task_id','name','size_bytes']
};
const TABLES = Object.keys(SPEC);
const emptyRows = () => Object.fromEntries(TABLES.map(t => [t, new Map()]));
let snapshot = emptyRows();   // rows as the server last confirmed them

/** Canonical row: synced fields only, normalised so local and server copies compare equal. */
function canon(t, r){
  const o = {};
  for (const k of SPEC[t]) o[k] = r[k] === undefined ? null : r[k];
  if (t === 'tasks'){
    o.description = o.description || '';
    o.assignee_id = o.assignee_id || null;
    o.due_date = o.due_date || null;
    o.labels = Array.isArray(o.labels) ? o.labels : [];
  }
  if (t === 'comments') o.created_at = new Date(o.created_at || Date.now()).toISOString();
  if (t === 'attachments') o.size_bytes = Number(o.size_bytes) || 0;
  return o;
}
const fromServer = (t, r) => Object.assign(canon(t, r), { _createdAt: Date.parse(r.created_at) || Date.now(), _updatedAt: Date.parse(r.updated_at || r.created_at) || Date.now() });
const keyOf = (t, r) => r ? JSON.stringify(SPEC[t].map(k => r[k])) : '';
const payload = r => Object.fromEntries(Object.entries(r).filter(([k]) => k[0] !== '_'));

function flatten(boards){
  const rows = emptyRows();
  boards.forEach((b, bi) => {
    rows.boards.set(b.id, canon('boards', { id:b.id, workspace_id:workspace.id, name:b.name, position:bi }));
    b.columns.forEach((c, ci) => rows.board_columns.set(c.id, canon('board_columns', { id:c.id, board_id:b.id, title:c.title, position:ci, collapsed:!!c.collapsed })));
    const cols = new Set(b.columns.map(c => c.id)), pos = {};
    b.tasks.forEach(t => {
      if (!cols.has(t.colId)) return;
      pos[t.colId] = (pos[t.colId] ?? -1) + 1;
      rows.tasks.set(t.id, Object.assign(canon('tasks', {
        id:t.id, board_id:b.id, column_id:t.colId, title:t.title, description:t.desc, priority:t.priority,
        assignee_id:t.assignee, due_date:t.due, labels:t.labels, position:pos[t.colId], archived:!!t.archived
      }), { _createdAt:t.createdAt, _updatedAt:t.updatedAt }));
      t.checklist.forEach((k, ki) => rows.checklist_items.set(k.id, canon('checklist_items', { id:k.id, task_id:t.id, text:k.text, done:!!k.done, position:ki })));
      t.comments.forEach(c => rows.comments.set(c.id, canon('comments', { id:c.id, task_id:t.id, author_id:c.author, body:c.text, created_at:c.at })));
      t.attachments.forEach(a => rows.attachments.set(a.id, canon('attachments', { id:a.id, task_id:t.id, name:a.name, size_bytes:a.size })));
    });
  });
  return rows;
}

function build(rows){
  const byPos = (a, b) => a.position - b.position;
  const boards = [...rows.boards.values()].sort(byPos).map(r => ({ id:r.id, name:r.name, columns:[], tasks:[] }));
  const bMap = new Map(boards.map(b => [b.id, b]));
  const colPos = new Map();
  [...rows.board_columns.values()].sort(byPos).forEach(r => {
    const b = bMap.get(r.board_id); if (!b) return;
    b.columns.push({ id:r.id, title:r.title, collapsed:!!r.collapsed });
    colPos.set(r.id, r.position);
  });
  const tMap = new Map();
  [...rows.tasks.values()]
    .sort((a, b) => (colPos.get(a.column_id) ?? 0) - (colPos.get(b.column_id) ?? 0) || a.position - b.position)
    .forEach(r => {
      const b = bMap.get(r.board_id); if (!b || !colPos.has(r.column_id)) return;
      const t = { id:r.id, colId:r.column_id, title:r.title, desc:r.description || '',
        priority: PRIORITIES[r.priority] ? r.priority : 'medium', assignee:r.assignee_id || null, due:r.due_date || '',
        labels:[...(r.labels || [])], checklist:[], comments:[], attachments:[], archived:!!r.archived,
        createdAt:r._createdAt ?? Date.now(), updatedAt:r._updatedAt ?? Date.now() };
      b.tasks.push(t); tMap.set(t.id, t);
    });
  [...rows.checklist_items.values()].sort(byPos).forEach(r => tMap.get(r.task_id)?.checklist.push({ id:r.id, text:r.text, done:!!r.done }));
  [...rows.comments.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))
    .forEach(r => tMap.get(r.task_id)?.comments.push({ id:r.id, author:r.author_id, text:r.body, at:Date.parse(r.created_at) }));
  [...rows.attachments.values()].forEach(r => tMap.get(r.task_id)?.attachments.push({ id:r.id, name:r.name, size:r.size_bytes }));
  return boards;
}

/** A row belongs in this app only if its parent chain leads to the current workspace. */
function reachable(t, r, rows){
  switch (t){
    case 'boards':        return r.workspace_id === workspace.id;
    case 'board_columns': return rows.boards.has(r.board_id);
    case 'tasks':         return rows.boards.has(r.board_id) && rows.board_columns.has(r.column_id);
    default:              return rows.tasks.has(r.task_id);
  }
}

const isNetworkError = e => !navigator.onLine || (!e?.code && /fetch|network|load failed|timeout/i.test(String(e?.message || e)));

function setSyncStatus(s){
  const el = $('#syncStatus'); if (!el) return;
  const text = { saved:'All changes saved', saving:'Saving…', offline:'Offline — changes kept on this device', loading:'Connecting…' }[s];
  el.dataset.state = s; el.title = text;
  el.querySelector('span').textContent = s === 'offline' ? 'Offline' : s === 'saved' ? 'Saved' : text;
}
function setOnline(on){
  if (on === isOnline) return;
  isOnline = on;
  toast(on ? 'Back online — changes synced' : 'You are offline. Changes are kept on this device and sync when you reconnect.');
}
function savePrefs(){
  lsSet(PREFS_KEY, { theme: state.theme, activeBoardId: state.activeBoardId });
}
function cacheLocal(){
  if (!session || !workspace) return;
  lsSet(cacheKey(), {
    v: 2, workspace, members: MEMBERS, invites, activity: activity.slice(0, 100), boards: state.boards,
    snapshot: Object.fromEntries(TABLES.map(t => [t, [...snapshot[t].values()]]))
  });
}

/** Writes changed rows (parents first), then removes deleted ones. */
async function sync(){
  if (!state || !workspace) return;
  if (syncing){ syncAgain = true; return; }
  syncing = true;
  setSyncStatus('saving');
  let failed = null;
  try {
    const local = flatten(state.boards);
    for (const t of TABLES){
      const changed = [...local[t].values()].filter(r => keyOf(t, r) !== keyOf(t, snapshot[t].get(r.id)));
      if (!changed.length) continue;
      const { error } = await sb.from(t).upsert(changed.map(payload));
      if (error) throw error;
      changed.forEach(r => snapshot[t].set(r.id, r));
    }
    for (const t of TABLES){
      const gone = [...snapshot[t].keys()].filter(id => !local[t].has(id));
      if (!gone.length) continue;
      const { error } = await sb.from(t).delete().in('id', gone);
      if (error) throw error;
      gone.forEach(id => snapshot[t].delete(id));
    }
    setOnline(true);
    setSyncStatus('saved');
  } catch(e){
    if (isNetworkError(e)){ setOnline(false); setSyncStatus('offline'); }
    else failed = e;
  } finally {
    syncing = false;
    cacheLocal();
  }
  if (failed){
    console.error(failed);
    toast('Could not save: ' + esc(failed.message || 'unknown error') + '. Showing the latest saved version.');
    syncAgain = false;
    return reload(true);
  }
  if (syncAgain){ syncAgain = false; sync(); }
}

async function fetchTable(t){
  const out = [];
  for (let from = 0; ; from += 1000){
    const { data, error } = await sb.from(t).select('*').order('id').range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function fetchAll(){
  const lists = await Promise.all(TABLES.map(fetchTable));
  const rows = emptyRows();
  TABLES.forEach((t, i) => lists[i].forEach(r => {
    const row = fromServer(t, r);
    if (reachable(t, row, rows)) rows[t].set(row.id, row);
  }));
  return rows;
}
async function fetchActivity(){
  const { data, error } = await sb.from('activity').select('*')
    .eq('workspace_id', workspace.id).order('created_at', { ascending:false }).limit(200);
  if (error) throw error;
  return data.map(activityRow);
}
const activityRow = r => ({ id:r.id, board_id:r.board_id, task_id:r.task_id, actor_id:r.actor_id, action:r.action, details:r.details || {}, at:Date.parse(r.created_at) });

/** Loads the workspace, its members and pending invites. */
async function loadTeam(){
  const { data: mem, error } = await sb.from('workspace_members').select('workspace_id, user_id, role');
  if (error) throw error;
  const mine = mem.filter(m => m.user_id === session.user.id);
  if (!mine.length){ workspace = null; MEMBERS = []; return; }
  const wsId = workspace && mine.some(m => m.workspace_id === workspace.id) ? workspace.id : mine[0].workspace_id;
  const [ws, profs, inv] = await Promise.all([
    sb.from('workspaces').select('id, name').eq('id', wsId).single(),
    sb.from('profiles').select('id, email, full_name, color'),
    sb.from('workspace_invites').select('email, role, created_at').eq('workspace_id', wsId).order('created_at')
  ]);
  for (const r of [ws, profs, inv]) if (r.error) throw r.error;
  workspace = { id: wsId, name: ws.data.name, role: mine.find(m => m.workspace_id === wsId).role };
  MEMBERS = mem.filter(m => m.workspace_id === wsId).map(m => {
    const p = profs.data.find(x => x.id === m.user_id) || {};
    return { id:m.user_id, name:p.full_name || (p.email || '').split('@')[0] || 'Member', email:p.email || '', color:p.color || '#9096AB', role:m.role };
  }).sort((a, b) => a.name.localeCompare(b.name));
  invites = inv.data || [];
}

/**
 * Combines the server's rows with local ones. Local edits that have not
 * reached the server yet win, and are pushed by the next sync.
 */
function mergeAll(server, discardLocal){
  if (discardLocal || !state.boards.length){ snapshot = server; return build(server); }
  const local = flatten(state.boards), next = emptyRows();
  for (const t of TABLES){
    for (const [id, srv] of server[t]){
      const loc = local[t].get(id), snap = snapshot[t].get(id);
      if (loc && snap && keyOf(t, loc) !== keyOf(t, snap)) next[t].set(id, loc);   // edited here, not saved yet
      else if (!loc && snap) continue;                                                // deleted here, not saved yet
      else next[t].set(id, srv);
    }
    for (const [id, loc] of local[t]) if (!server[t].has(id) && !snapshot[t].has(id)) next[t].set(id, loc); // created here
  }
  snapshot = server;
  return build(next);
}

async function reload(discardLocal){
  try {
    await loadTeam();
    if (!workspace) return showNoWorkspace();
    const server = await fetchAll();
    state.boards = mergeAll(server, discardLocal);
    activity = await fetchActivity();
    setOnline(true);
    setSyncStatus('saved');
    undoStack = [];
    renderRemote();
    sync();
  } catch(e){
    if (isNetworkError(e)){ setOnline(false); setSyncStatus('offline'); }
    else console.error(e);
  }
}

/* ---------- live updates ---------- */
let remoteQueue = [], remoteTimer = null, teamTimer = null;
function onRemoteChange(t, p){
  if (t === 'activity'){
    if (p.eventType === 'INSERT' && p.new.workspace_id === workspace?.id && !activity.some(a => a.id === p.new.id)){
      activity.unshift(activityRow(p.new));
      activity = activity.slice(0, 200);
      if (ui.page === 'home') renderDashboard();
    }
    return;
  }
  if (t === 'profiles' || t === 'workspace_members' || t === 'workspace_invites'){
    clearTimeout(teamTimer);
    teamTimer = setTimeout(async () => {
      try { await loadTeam(); } catch(e){ return; }
      if (!workspace) return showNoWorkspace();
      renderAll(); if ($('#teamOverlay').classList.contains('open')) renderTeam(); cacheLocal();
    }, 150);
    return;
  }
  remoteQueue.push([t, p]);
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(applyRemoteQueue, 40);
}
function applyRemoteQueue(){
  const queue = remoteQueue; remoteQueue = [];
  const local = flatten(state.boards);
  let changed = false;
  for (const [t, p] of queue){
    const id = (p.new && p.new.id) || (p.old && p.old.id);
    if (!id) continue;
    const srv = p.eventType === 'DELETE' ? null : fromServer(t, p.new);
    const snap = snapshot[t].get(id);
    if (srv ? keyOf(t, srv) === keyOf(t, snap) : !snap) continue;           // our own write coming back
    if (srv && !reachable(t, srv, local)) continue;                          // not part of this workspace (yet)
    const loc = local[t].get(id);
    if (keyOf(t, loc) === keyOf(t, snap)) srv ? local[t].set(id, srv) : local[t].delete(id); // no local edits on this row
    srv ? snapshot[t].set(id, srv) : snapshot[t].delete(id);
    changed = true;
  }
  if (!changed) return;
  state.boards = build(local);
  undoStack = [];
  renderRemote();
  cacheLocal();
}

/** Re-renders after a remote change, unless the user is mid-edit or mid-drag. */
let pendingRemote = false;
function renderRemote(){
  const a = document.activeElement;
  if (dragTaskId || dragColId || (a && a.isContentEditable)){ pendingRemote = true; return; }
  pendingRemote = false;
  ensureActive();
  renderAll();
}
document.addEventListener('focusout', () => { if (pendingRemote) setTimeout(renderRemote, 0); });

let channel = null;
function listen(){
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('flowlane-' + workspace.id);
  for (const t of [...TABLES, 'activity', 'profiles', 'workspace_members', 'workspace_invites']){
    channel.on('postgres_changes', { event:'*', schema:'public', table:t }, p => onRemoteChange(t, p));
  }
  let wasDown = false;
  channel.subscribe(status => {
    if (status === 'SUBSCRIBED'){ if (wasDown){ wasDown = false; reload(false); } }
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') wasDown = true;
  });
}
addEventListener('online', () => reload(false));

/* ============================================================
   3. STATE
   ============================================================ */
let state = { activeBoardId: null, theme: 'light', me: null, boards: [] };
let ui = { page:'home', search:'', priority:'', assignee:'', label:'', due:'', status:'', sort:'manual' };
let undoStack = [];
let saveTimer = null;

const board  = () => state.boards.find(b => b.id === state.activeBoardId) || state.boards[0];
const uid    = () => crypto.randomUUID();
const task   = id => board().tasks.find(t => t.id === id);
const column = id => board().columns.find(c => c.id === id);

function ensureActive(){
  if (!state.boards.length) state.boards = seed().boards;
  if (!state.boards.some(b => b.id === state.activeBoardId)) state.activeBoardId = state.boards[0].id;
}

/** A sample board for a brand-new workspace. */
function seed(){
  const me = state.me;
  const c1 = uid(), c2 = uid(), c3 = uid();
  const now = Date.now(), day = 864e5;
  const d = off => new Date(now + off*day).toISOString().slice(0,10);
  const mk = o => Object.assign({
    id: uid(), colId:c1, title:'', desc:'', priority:'medium', assignee:null, due:'',
    labels:[], checklist:[], comments:[], attachments:[], archived:false, createdAt: now, updatedAt: now
  }, o);
  return { boards: [{
    id: uid(), name: 'Product Launch',
    columns: [ {id:c1,title:'To Do',collapsed:false}, {id:c2,title:'In Progress',collapsed:false}, {id:c3,title:'Done',collapsed:false} ],
    tasks: [
      mk({ title:'Design the empty states', desc:'Cover boards with no tasks and search with no results.', priority:'high', assignee:me, due:d(3), labels:['Design'],
           checklist:[{id:uid(),text:'Sketch three variants',done:true},{id:uid(),text:'Pick copy for each',done:false}] }),
      mk({ title:'Write the launch announcement', desc:'Short post for the changelog plus an email version.', due:d(9), labels:['Content'] }),
      mk({ title:'Fix overflow on long task titles', priority:'urgent', due:d(-2), labels:['Bug','Frontend'] }),
      mk({ colId:c2, title:'Build the drag-and-drop engine', desc:'Reorder inside a column and move across columns with a live drop indicator.', priority:'high', assignee:me, due:d(1), labels:['Frontend'],
           checklist:[{id:uid(),text:'Card reorder',done:true},{id:uid(),text:'Cross-column move',done:true},{id:uid(),text:'Column reorder',done:false}] }),
      mk({ colId:c2, title:'Interview five beta customers', due:d(5), labels:['Research'] }),
      mk({ colId:c3, title:'Set up the design tokens', desc:'Colour, spacing and radius scale shared across the app.', priority:'low', assignee:me, due:d(-6), labels:['Design','Frontend'] }),
      mk({ colId:c3, title:'Ship the dashboard statistics', assignee:me, due:d(-1), labels:['Backend'] })
    ]
  }] };
}

/* ============================================================
   4. UTILITIES
   ============================================================ */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayStr = () => new Date().toISOString().slice(0,10);

function fmtDate(d){
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  const opts = { month:'short', day:'numeric' };
  if (dt.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return dt.toLocaleDateString(undefined, opts);
}
function dueState(t){
  if (!t.due || isDone(t)) return '';
  const diff = (new Date(t.due+'T00:00:00') - new Date(todayStr()+'T00:00:00')) / 864e5;
  if (diff < 0) return 'due-over';
  if (diff <= 2) return 'due-soon';
  return '';
}
function relTime(ts){
  const s = (Date.now() - ts)/1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  if (s < 604800) return Math.floor(s/86400) + 'd ago';
  return new Date(ts).toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
/** Buckets a column into todo / progress / done for the dashboard. */
function kindOf(col){
  const cols = board().columns, i = cols.indexOf(col), t = (col.title||'').toLowerCase();
  if (/done|complete|shipped|finish/.test(t)) return 'done';
  if (/progress|doing|review|active/.test(t)) return 'progress';
  if (/to.?do|backlog|todo|inbox|new/.test(t)) return 'todo';
  return i === 0 ? 'todo' : (i === cols.length-1 ? 'done' : 'progress');
}
const isDone = t => { const c = column(t.colId); return c ? kindOf(c) === 'done' : false; };
const progressOf = t => t.checklist.length ? Math.round(t.checklist.filter(k=>k.done).length / t.checklist.length * 100) : 0;

/* ============================================================
   5. PERSISTENCE + UNDO
   ============================================================ */
function save(){
  savePrefs();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(sync, 250);
}
function pushUndo(){
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 30) undoStack.shift();
}
function undo(){
  if (!undoStack.length) return toast('Nothing left to undo');
  state = JSON.parse(undoStack.pop());
  applyTheme(); renderAll(); save();
  toast('Change undone');
}
/** commit() — persist and repaint. The description argument is kept for readability:
    the activity log itself is written by the database when the change is saved. */
function commit(){
  save(); renderAll();
}

/** Turns a structured activity row into a sentence (all user text escaped). */
function activityText(a){
  const d = a.details || {}, b = s => '<b>' + esc(s ?? '') + '</b>';
  switch (a.action){
    case 'task_created':        return 'created ' + b(d.title) + (d.column ? ' in ' + b(d.column) : '');
    case 'task_moved':          return 'moved ' + b(d.title) + ' to ' + b(d.to);
    case 'task_edited':         return 'changed the ' + esc((d.fields || []).join(', ')) + ' of ' + b(d.title);
    case 'task_archived':       return 'archived ' + b(d.title);
    case 'task_restored':       return 'restored ' + b(d.title);
    case 'task_deleted':        return 'deleted ' + b(d.title);
    case 'comment_added':       return 'commented on ' + b(d.title);
    case 'checklist_completed': return 'checked off ' + b(d.item) + ' on ' + b(d.title);
    case 'column_added':        return 'added the column ' + b(d.title);
    case 'column_renamed':      return 'renamed the column ' + b(d.from) + ' to ' + b(d.title);
    case 'column_deleted':      return 'deleted the column ' + b(d.title);
    case 'board_created':       return 'created the board ' + b(d.name);
    case 'board_renamed':       return 'renamed the board to ' + b(d.name);
    case 'board_deleted':       return 'deleted the board ' + b(d.name);
    default:                    return esc(a.action);
  }
}

/* ============================================================
   6. TOASTS
   ============================================================ */
function toast(msg, actionLabel, onAction, ms = 5000){
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<span class="msg">' + msg + '</span>';
  if (actionLabel){
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.onclick = () => { onAction(); close(); };
    el.appendChild(b);
  }
  const x = document.createElement('button');
  x.innerHTML = '<svg class="icon icon-sm" style="color:#fff;opacity:.6"><use href="#i-x"/></svg>';
  x.onclick = close;
  el.appendChild(x);
  $('#toasts').appendChild(el);
  const timer = setTimeout(close, ms);
  function close(){ clearTimeout(timer); el.classList.add('out'); setTimeout(()=>el.remove(), 240); }
  return close;
}

/* ============================================================
   7. FILTERING / SORTING
   ============================================================ */
function matchesFilters(t){
  const q = ui.search.trim().toLowerCase();
  if (q){
    const who = member(t.assignee)?.name.toLowerCase() || '';
    const hay = [t.title, t.desc, who, t.labels.join(' ')].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (ui.priority && t.priority !== ui.priority) return false;
  if (ui.assignee && (t.assignee || 'none') !== ui.assignee) return false;
  if (ui.label && !t.labels.includes(ui.label)) return false;
  if (ui.status && t.colId !== ui.status) return false;
  if (ui.due){
    const today = todayStr();
    if (ui.due === 'none' && t.due) return false;
    if (ui.due !== 'none'){
      if (!t.due) return false;
      const diff = (new Date(t.due+'T00:00:00') - new Date(today+'T00:00:00')) / 864e5;
      if (ui.due === 'overdue' && !(diff < 0)) return false;
      if (ui.due === 'today'   && diff !== 0)  return false;
      if (ui.due === 'week'    && !(diff >= 0 && diff <= 7)) return false;
    }
  }
  return true;
}
function tasksIn(colId){
  let list = board().tasks.filter(t => t.colId === colId && !t.archived && matchesFilters(t));
  const s = ui.sort;
  if (s === 'due')      list = [...list].sort((a,b) => (a.due||'9999').localeCompare(b.due||'9999'));
  if (s === 'priority') list = [...list].sort((a,b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  if (s === 'created')  list = [...list].sort((a,b) => b.createdAt - a.createdAt);
  if (s === 'alpha')    list = [...list].sort((a,b) => a.title.localeCompare(b.title));
  return list;
}
const filtersActive = () => !!(ui.search || ui.priority || ui.assignee || ui.label || ui.due || ui.status);

/* ============================================================
   8. RENDERING
   ============================================================ */
function renderAll(){
  renderChrome();
  renderDashboard();
  renderBoard();
}

/** Narrow screens have no room in the header, so the switcher moves into the page. */
const NARROW = window.matchMedia('(max-width:860px)');
function placeSwitcher(){
  const sw = $('#boardSwitcher');
  if (!sw) return;
  if (NARROW.matches){
    const slot = $('#page-' + ui.page + ' [data-slot]');
    if (slot && sw.parentElement !== slot) slot.appendChild(sw);
  } else {
    const bar = $('.top-actions');
    if (sw.parentElement !== bar) bar.insertBefore(sw, bar.firstElementChild);
  }
}
NARROW.addEventListener('change', placeSwitcher);

function renderChrome(){
  const b = board();
  $('#navCount').textContent = b.tasks.filter(t => !t.archived).length;
  $$('.nav-item[data-page]').forEach(n => n.classList.toggle('active', n.dataset.page === ui.page));
  $('#page-home').classList.toggle('active', ui.page === 'home');
  $('#page-board').classList.toggle('active', ui.page === 'board');

  const sw = $('#boardSwitcher');
  sw.innerHTML = state.boards.map(x => '<option value="'+x.id+'"'+(x.id===b.id?' selected':'')+'>'+esc(x.name)+'</option>').join('')
               + '<option value="__new">+ New board</option>';

  $('#teamAvatars').innerHTML = MEMBERS.map(m =>
    '<span class="avatar" title="'+esc(m.name)+'" style="background:'+m.color+'">'+initials(m.name)+'</span>').join('');

  const me = member(state.me) || { name: (session?.user?.email || 'You').split('@')[0], color:'#9096AB' };
  $('.brand-sub').textContent = workspace?.name || '';
  $('#meAvatar').textContent = initials(me.name);
  $('#meAvatar').style.background = me.color;
  $('#meName').textContent = me.name;
  $('#dashGreeting').textContent = 'Hello, ' + me.name.split(' ')[0];
  $('#themeLabel').textContent = state.theme === 'dark' ? 'Light mode' : 'Dark mode';
  $('#btnTheme').querySelector('use').setAttribute('href', state.theme === 'dark' ? '#i-sun' : '#i-moon');

  const arch = b.tasks.filter(t => t.archived).length;
  $('#archiveCount').textContent = arch ? ' · ' + arch : '';

  // filter dropdown options that depend on data
  const keep = (sel, v) => { sel.value = v; };
  const fa = $('#fAssignee');
  fa.innerHTML = '<option value="">Anyone</option>' + MEMBERS.map(m => '<option value="'+m.id+'">'+esc(m.name)+'</option>').join('') + '<option value="none">Unassigned</option>';
  keep(fa, ui.assignee);
  const fl = $('#fLabel');
  fl.innerHTML = '<option value="">Any label</option>' + LABELS.map(l => '<option value="'+l.name+'">'+l.name+'</option>').join('');
  keep(fl, ui.label);
  const fs = $('#fStatus');
  fs.innerHTML = '<option value="">Any status</option>' + b.columns.map(c => '<option value="'+c.id+'">'+esc(c.title)+'</option>').join('');
  keep(fs, ui.status);
  [['#fPriority','priority'],['#fDue','due'],['#fSort','sort']].forEach(([s,k]) => $(s).value = ui[k]);
  $$('.toolbar .select').forEach(s => s.classList.toggle('on', !!s.value && s.value !== 'manual'));
  $('#btnClearFilters').hidden = !filtersActive();
  placeSwitcher();
}

function renderDashboard(){
  const b = board();
  const live = b.tasks.filter(t => !t.archived);
  const counts = { todo:0, progress:0, done:0 };
  live.forEach(t => { const c = column(t.colId); if (c) counts[kindOf(c)]++; });
  const overdue = live.filter(t => t.due && !isDone(t) && t.due < todayStr()).length;
  const week = Date.now() - 7*864e5;
  const doneWeek = live.filter(t => isDone(t) && t.updatedAt >= week).length;

  const cards = [
    { t:'Total tasks',        n:live.length,     i:'i-layers',   c:'var(--purple)', bg:'var(--purple-soft)', f:b.columns.length + ' columns' },
    { t:'To Do',              n:counts.todo,     i:'i-board',    c:'var(--text-2)', bg:'var(--gray)',        f:'waiting to start' },
    { t:'In Progress',        n:counts.progress, i:'i-clock',    c:'var(--blue)',   bg:'var(--blue-soft)',   f:'being worked on' },
    { t:'Done',               n:counts.done,     i:'i-check',    c:'var(--green)',  bg:'var(--green-soft)',  f:'finished' },
    { t:'Overdue tasks',      n:overdue,         i:'i-alert',    c:'var(--red)',    bg:'var(--red-soft)',    f:overdue ? 'needs attention' : 'nothing late' },
    { t:'Completed this week',n:doneWeek,        i:'i-trend',    c:'var(--amber)',  bg:'var(--amber-soft)',  f:'last 7 days' }
  ];
  $('#statGrid').innerHTML = cards.map(c => `
    <div class="stat">
      <div class="top"><span class="badge" style="background:${c.bg};color:${c.c}"><svg class="icon icon-sm"><use href="#${c.i}"/></svg></span>${c.t}</div>
      <div class="num">${c.n}</div>
      <div class="foot">${c.f}</div>
    </div>`).join('');

  $('#dashSub').textContent = live.length
    ? overdue ? overdue + (overdue === 1 ? ' task is overdue.' : ' tasks are overdue.') + ' The rest is on track.'
              : 'Everything is on schedule across ' + b.columns.length + ' columns.'
    : 'The board is empty. Create your first task to get started.';

  const acts = activity.filter(a => a.board_id === b.id).slice(0, 8);
  $('#activityHint').textContent = acts.length ? 'last ' + acts.length : '';
  $('#activityList').innerHTML = acts.length ? acts.map(a => {
    const m = member(a.actor_id) || { name:'Someone', color:'#9096AB' };
    return `<li>
      <span class="avatar sm" style="background:${m.color}">${initials(m.name)}</span>
      <span class="txt"><b>${esc(m.name.split(' ')[0])}</b> ${activityText(a)}<time>${relTime(a.at)}</time></span>
    </li>`;
  }).join('') : '<div class="empty"><h4>No activity yet</h4>Changes you make to the board show up here.</div>';

  const total = counts.todo + counts.progress + counts.done || 1;
  const rows = [
    { n:'To Do', v:counts.todo, c:'#9096AB' },
    { n:'In Progress', v:counts.progress, c:'var(--blue)' },
    { n:'Done', v:counts.done, c:'var(--green)' }
  ];
  $('#distribution').innerHTML = rows.map(r => `
    <div class="dist-row">
      <div class="lab"><span>${r.n}</span><span>${r.v} · ${Math.round(r.v/total*100)}%</span></div>
      <div class="track"><div class="fill" style="width:${r.v/total*100}%;background:${r.c}"></div></div>
    </div>`).join('');
}

function taskHTML(t){
  const m = member(t.assignee);
  const done = t.checklist.filter(k=>k.done).length;
  const ds = dueState(t);
  return `<article class="task" draggable="true" data-id="${t.id}" tabindex="0">
    ${t.labels.length ? '<div class="labels">' + t.labels.map(l => {
        const s = labelStyle(l);
        return '<span class="tag" style="background:'+s.bg+';color:'+s.color+'">'+esc(l)+'</span>';
      }).join('') + '</div>' : ''}
    <h4 data-title spellcheck="false">${esc(t.title)}</h4>
    ${t.desc ? '<p class="desc">'+esc(t.desc)+'</p>' : ''}
    ${t.checklist.length ? '<div class="mini-track" title="'+done+' of '+t.checklist.length+' done"><i style="width:'+progressOf(t)+'%"></i></div>' : ''}
    <div class="task-foot">
      <span class="prio p-${t.priority}"><i></i>${PRIORITIES[t.priority]}</span>
      ${t.due ? '<span class="meta '+ds+'"><svg class="icon icon-sm" style="width:13px;height:13px"><use href="#i-calendar"/></svg>'+fmtDate(t.due)+'</span>' : ''}
      <span class="right">
        ${t.checklist.length ? '<span class="meta"><svg class="icon icon-sm" style="width:13px;height:13px"><use href="#i-check"/></svg>'+done+'/'+t.checklist.length+'</span>' : ''}
        ${t.comments.length ? '<span class="meta"><svg class="icon icon-sm" style="width:13px;height:13px"><use href="#i-msg"/></svg>'+t.comments.length+'</span>' : ''}
        ${t.attachments.length ? '<span class="meta"><svg class="icon icon-sm" style="width:13px;height:13px"><use href="#i-clip"/></svg>'+t.attachments.length+'</span>' : ''}
        ${m ? '<span class="avatar sm" title="'+esc(m.name)+'" style="background:'+m.color+'">'+initials(m.name)+'</span>'
            : '<span class="avatar sm" title="Unassigned" style="background:var(--gray);color:var(--text-3)"><svg class="icon" style="width:12px;height:12px"><use href="#i-user"/></svg></span>'}
      </span>
    </div>
  </article>`;
}

function renderBoard(){
  const b = board();
  $('#boardTitle').textContent = b.name;
  const shown = b.columns.reduce((n,c) => n + tasksIn(c.id).length, 0);
  const live = b.tasks.filter(t => !t.archived).length;
  $('#boardSub').textContent = filtersActive()
    ? 'Showing ' + shown + ' of ' + live + ' tasks'
    : live + (live === 1 ? ' task' : ' tasks') + ' across ' + b.columns.length + ' columns';

  $('#board').innerHTML = b.columns.map((c, i) => {
    const list = tasksIn(c.id);
    const all = b.tasks.filter(t => t.colId === c.id && !t.archived).length;
    return `<section class="column${c.collapsed ? ' collapsed' : ''}" data-id="${c.id}">
      <header class="col-head">
        <span class="col-title-wrap">
          <span class="col-dot" style="background:${COL_DOTS[i % COL_DOTS.length]}"></span>
          <span class="col-title" contenteditable="true" spellcheck="false" data-col-title>${esc(c.title)}</span>
          <span class="col-count">${all}</span>
        </span>
        <span class="col-actions">
          <button class="icon-btn" data-col-add title="Add task"><svg class="icon icon-sm"><use href="#i-plus"/></svg></button>
          <button class="icon-btn" data-col-menu title="Column options"><svg class="icon icon-sm"><use href="#i-dots"/></svg></button>
        </span>
        ${c.collapsed ? '<button class="icon-btn" data-col-expand title="Expand"><svg class="icon icon-sm"><use href="#i-chev-r"/></svg></button>' : ''}
      </header>
      <div class="col-body" data-col-body>
        ${list.map(taskHTML).join('') || '<div class="col-empty">'+(all ? 'No tasks match the current filters.' : 'Drop a task here or add one below.')+'</div>'}
      </div>
      <div class="col-add"><button class="btn" data-col-add><svg class="icon icon-sm"><use href="#i-plus"/></svg>Add task</button></div>
    </section>`;
  }).join('') + '<button class="add-column" id="btnAddColumn"><svg class="icon icon-sm"><use href="#i-plus"/></svg>Add column</button>';
}

function applyTheme(){
  document.documentElement.dataset.theme = state.theme;
}
/* ============================================================
   9. FLOATING MENU
   ============================================================ */
const menuEl = $('#menu');
function openMenu(x, y, items){
  menuEl.innerHTML = items.map((it, i) => {
    if (it.sep) return '<div class="sep"></div>';
    if (it.header) return '<div class="menu-label">'+esc(it.header)+'</div>';
    if (it.note)   return '<div class="menu-note">'+esc(it.note)+'</div>';
    return '<button data-i="'+i+'"'+(it.danger?' class="danger"':'')+'>'
      + (it.icon ? '<svg class="icon icon-sm"><use href="#'+it.icon+'"/></svg>' : '<span style="width:15px"></span>')
      + esc(it.label) + (it.check ? '<svg class="icon icon-sm" style="margin-left:auto;color:var(--purple)"><use href="#i-check"/></svg>' : '') + '</button>';
  }).join('');
  menuEl.classList.add('open');
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(12, Math.min(x, innerWidth - r.width - 12)) + 'px';
  menuEl.style.top  = Math.max(12, Math.min(y, innerHeight - r.height - 12)) + 'px';
  menuEl.onclick = e => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    items[+b.dataset.i].onClick?.();
  };
}
const closeMenu = () => menuEl.classList.remove('open');
document.addEventListener('pointerdown', e => { if (!e.target.closest('#menu')) closeMenu(); }, true);
addEventListener('resize', closeMenu);

/* ============================================================
   10. TASK MODAL
   ============================================================ */
let draft = null;        // working copy while a modal is open
let draftIsNew = true;

function blankTask(colId){
  return { id:uid('t'), colId: colId || board().columns[0]?.id, title:'', desc:'', priority:'medium',
           assignee:null, due:'', labels:[], checklist:[], comments:[], attachments:[],
           archived:false, createdAt:Date.now(), updatedAt:Date.now() };
}
function openTaskModal(id, colId){
  const b = board();
  if (!b.columns.length){ toast('Add a column before creating tasks'); return; }
  const existing = id ? task(id) : null;
  draftIsNew = !existing;
  draft = existing ? JSON.parse(JSON.stringify(existing)) : blankTask(colId);

  $('#taskModalTitle').textContent = draftIsNew ? 'Create task' : 'Task details';
  $('#btnSaveTask').textContent = draftIsNew ? 'Create task' : 'Save changes';
  ['#btnDuplicate','#btnArchiveTask','#btnDeleteTask'].forEach(s => $(s).hidden = draftIsNew);
  $('#editOnly').hidden = draftIsNew;

  $('#tTitle').value = draft.title;
  $('#tDesc').value  = draft.desc;
  $('#tPriority').value = draft.priority;
  $('#tDue').value = draft.due || '';
  $('#tAssignee').innerHTML = '<option value="">Unassigned</option>' +
    MEMBERS.map(m => '<option value="'+m.id+'">'+esc(m.name)+'</option>').join('');
  $('#tAssignee').value = draft.assignee || '';
  $('#tColumn').innerHTML = b.columns.map(c => '<option value="'+c.id+'">'+esc(c.title)+'</option>').join('');
  $('#tColumn').value = draft.colId;

  renderLabelPicker(); renderChecklist(); renderAttachments(); renderComments();
  openOverlay('#taskOverlay');
  setTimeout(() => $('#tTitle').focus(), 60);
}
function renderLabelPicker(){
  $('#tLabels').innerHTML = LABELS.map(l => {
    const on = draft.labels.includes(l.name);
    return '<button type="button" class="label-opt'+(on?' on':'')+'" data-label="'+l.name+'"'
      + (on ? ' style="background:'+l.bg+';color:'+l.color+'"' : '') + '>'+l.name+'</button>';
  }).join('');
}
function renderChecklist(){
  const done = draft.checklist.filter(k=>k.done).length;
  $('#checkProgress').textContent = draft.checklist.length ? '· ' + done + ' of ' + draft.checklist.length + ' done' : '';
  $('#tChecklist').innerHTML = draft.checklist.map(k =>
    `<label class="check-item${k.done?' done':''}">
      <input type="checkbox" data-check="${k.id}"${k.done?' checked':''} />
      <span contenteditable="true" data-check-text="${k.id}" spellcheck="false">${esc(k.text)}</span>
      <button type="button" class="icon-btn plain" style="width:26px;height:26px" data-check-del="${k.id}"><svg class="icon icon-sm"><use href="#i-x"/></svg></button>
    </label>`).join('') || '<div class="col-empty" style="border-style:dashed">No checklist items yet.</div>';
}
function renderAttachments(){
  $('#tAttachments').innerHTML = draft.attachments.map(a =>
    `<div class="attach"><svg class="icon icon-sm"><use href="#i-clip"/></svg>${esc(a.name)}
      <span style="color:var(--text-3)">${a.size ? Math.max(1,Math.round(a.size/1024))+' KB' : ''}</span>
      <button type="button" data-attach-del="${a.id}"><svg class="icon icon-sm"><use href="#i-trash"/></svg></button></div>`
  ).join('') || '<div class="col-empty" style="border-style:dashed">No files attached.</div>';
}
function renderComments(){
  $('#commentCount').textContent = draft.comments.length ? '· ' + draft.comments.length : '';
  $('#tComments').innerHTML = draft.comments.map(c => {
    const m = member(c.author) || { name:'Someone', color:'#9096AB' };
    return `<div class="comment"><span class="avatar sm" style="background:${m.color}">${initials(m.name)}</span>
      <div class="body"><b>${esc(m.name)}</b><time>${relTime(c.at)}</time><div>${esc(c.text)}</div></div></div>`;
  }).join('') || '<div class="col-empty" style="border-style:dashed">No comments yet.</div>';
}
function readDraft(){
  draft.title    = $('#tTitle').value.trim();
  draft.desc     = $('#tDesc').value.trim();
  draft.priority = $('#tPriority').value;
  draft.assignee = $('#tAssignee').value || null;
  draft.due      = $('#tDue').value;
  draft.colId    = $('#tColumn').value;
}
function saveTaskModal(){
  readDraft();
  if (!draft.title){ $('#tTitle').focus(); toast('Give the task a title first'); return; }
  pushUndo();
  const b = board();
  draft.updatedAt = Date.now();
  if (!column(draft.colId)) draft.colId = b.columns[0]?.id;      // column removed by someone else meanwhile
  if (!draftIsNew && !task(draft.id)) draftIsNew = true;          // task removed by someone else meanwhile
  if (draftIsNew){
    b.tasks.push(draft);
    commit('created <b>' + esc(draft.title) + '</b>');
    toast('Task created');
  } else {
    const i = b.tasks.findIndex(t => t.id === draft.id);
    const before = b.tasks[i];
    const movedTo = before.colId !== draft.colId ? column(draft.colId) : null;
    b.tasks[i] = draft;
    commit(movedTo ? 'moved <b>'+esc(draft.title)+'</b> to <b>'+esc(movedTo.title)+'</b>'
                   : 'edited <b>'+esc(draft.title)+'</b>');
    toast('Changes saved');
  }
  closeOverlays();
}

/* ============================================================
   11. TASK ACTIONS
   ============================================================ */
function deleteTask(id){
  const t = task(id); if (!t) return;
  pushUndo();
  const b = board(), i = b.tasks.indexOf(t);
  b.tasks.splice(i, 1);
  commit('deleted <b>' + esc(t.title) + '</b>');
  toast('Deleted “' + esc(t.title) + '”', 'Undo', () => { undoStack.pop(); b.tasks.splice(i, 0, t); commit(); });
}
function duplicateTask(id){
  const t = task(id); if (!t) return;
  pushUndo();
  const copy = JSON.parse(JSON.stringify(t));
  copy.id = uid('t'); copy.title = t.title + ' (copy)'; copy.createdAt = copy.updatedAt = Date.now();
  copy.checklist.forEach(k => k.id = uid());
  copy.attachments.forEach(a => a.id = uid());
  copy.comments = [];   // comments stay with the original task and its authors
  board().tasks.splice(board().tasks.indexOf(t) + 1, 0, copy);
  commit('duplicated <b>' + esc(t.title) + '</b>');
  toast('Task duplicated');
}
function archiveTask(id, on = true){
  const t = task(id); if (!t) return;
  pushUndo(); t.archived = on; t.updatedAt = Date.now();
  commit((on ? 'archived ' : 'restored ') + '<b>' + esc(t.title) + '</b>');
  toast(on ? 'Task archived' : 'Task restored', 'Undo', undo);
}
function setField(id, key, value, label){
  const t = task(id); if (!t) return;
  pushUndo(); t[key] = value; t.updatedAt = Date.now();
  commit('changed ' + label + ' on <b>' + esc(t.title) + '</b>');
}
function moveTask(id, toColId, index){
  const b = board(), t = task(id); if (!t) return;
  pushUndo();
  const from = column(t.colId), to = column(toColId);
  const arr = b.tasks;
  arr.splice(arr.indexOf(t), 1);
  const colTasks = arr.filter(x => x.colId === toColId && !x.archived);
  t.colId = toColId; t.updatedAt = Date.now();
  const ref = (index === null || index === undefined) ? null : colTasks[index];
  if (ref) arr.splice(arr.indexOf(ref), 0, t);
  else if (colTasks.length) arr.splice(arr.indexOf(colTasks[colTasks.length-1]) + 1, 0, t);
  else arr.push(t);
  if (from && to && from.id !== to.id) commit('moved <b>'+esc(t.title)+'</b> to <b>'+esc(to.title)+'</b>');
  else commit();
}

/* ============================================================
   12. COLUMN ACTIONS
   ============================================================ */
function addColumn(){
  pushUndo();
  const c = { id:uid('c'), title:'New column', collapsed:false };
  board().columns.push(c);
  commit('added the column <b>New column</b>');
  const el = $('.column[data-id="'+c.id+'"] [data-col-title]');
  if (el){ el.focus(); document.getSelection().selectAllChildren(el); el.scrollIntoView({behavior:'smooth',inline:'center'}); }
}
function deleteColumn(id){
  const b = board(), c = column(id); if (!c) return;
  pushUndo();
  const idx = b.columns.indexOf(c);
  const removed = b.tasks.filter(t => t.colId === id);
  b.columns.splice(idx, 1);
  b.tasks = b.tasks.filter(t => t.colId !== id);
  commit('deleted the column <b>' + esc(c.title) + '</b>');
  toast('Column “'+esc(c.title)+'” deleted with ' + removed.length + ' task' + (removed.length===1?'':'s'), 'Undo', undo);
}
function moveColumn(id, dir){
  const b = board(), i = b.columns.findIndex(c => c.id === id), j = i + dir;
  if (j < 0 || j >= b.columns.length) return;
  pushUndo();
  const [c] = b.columns.splice(i, 1);
  b.columns.splice(j, 0, c);
  commit();
}

/* ============================================================
   13. DRAG AND DROP
   ============================================================ */
const boardEl = $('#board');
let dragTaskId = null, dragColId = null;
const placeholder = document.createElement('div');
placeholder.className = 'placeholder';

function afterElement(container, y){
  const els = [...container.querySelectorAll('.task:not(.dragging)')];
  let best = { off: -Infinity, el: null };
  els.forEach(el => {
    const box = el.getBoundingClientRect();
    const off = y - box.top - box.height/2;
    if (off < 0 && off > best.off) best = { off, el };
  });
  return best.el;
}
boardEl.addEventListener('dragstart', e => {
  const card = e.target.closest('.task');
  if (card){
    dragTaskId = card.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragTaskId);
    setTimeout(() => card.classList.add('dragging'), 0);
    return;
  }
  const col = e.target.closest('.column');
  if (col){
    dragColId = col.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragColId);
    setTimeout(() => col.classList.add('col-dragging'), 0);
  }
});
boardEl.addEventListener('dragover', e => {
  if (dragTaskId){
    const colEl = e.target.closest('.column');
    const body = colEl && !colEl.classList.contains('collapsed') ? colEl.querySelector('.col-body') : null;
    if (!body) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    body.classList.add('over');
    $$('.col-body.over').forEach(b => { if (b !== body) b.classList.remove('over'); });
    const empty = body.querySelector('.col-empty');
    if (empty) empty.style.display = 'none';
    const after = afterElement(body, e.clientY);
    if (after) body.insertBefore(placeholder, after); else body.appendChild(placeholder);
  } else if (dragColId){
    e.preventDefault();
    const over = e.target.closest('.column');
    const dragged = $('.column.col-dragging');
    if (over && dragged && over !== dragged){
      const r = over.getBoundingClientRect();
      boardEl.insertBefore(dragged, e.clientX < r.left + r.width/2 ? over : over.nextSibling);
    }
  }
});
boardEl.addEventListener('drop', e => {
  e.preventDefault();
  if (dragTaskId){
    const id = dragTaskId;
    const body = placeholder.parentElement;
    if (body){
      const colId = body.closest('.column').dataset.id;
      const index = [...body.children]
        .filter(c => c === placeholder || (c.classList.contains('task') && !c.classList.contains('dragging')))
        .indexOf(placeholder);
      cleanupDrag();
      moveTask(id, colId, index);
      const el = $('.task[data-id="'+id+'"]');
      if (el) el.classList.add('flash');
      if (ui.sort !== 'manual') toast('Sorting is on, so the manual order is not shown');
    }
  } else if (dragColId){
    const order = $$('.column', boardEl).map(c => c.dataset.id);
    pushUndo();
    board().columns.sort((a,b) => order.indexOf(a.id) - order.indexOf(b.id));
    commit();
  }
  cleanupDrag();
});
boardEl.addEventListener('dragend', cleanupDrag);
boardEl.addEventListener('dragleave', e => {
  const body = e.target.closest?.('.col-body');
  if (body && !body.contains(e.relatedTarget)) body.classList.remove('over');
});
function cleanupDrag(){
  placeholder.remove();
  $$('.task.dragging').forEach(el => el.classList.remove('dragging'));
  $$('.column.col-dragging').forEach(el => { el.classList.remove('col-dragging'); el.draggable = false; });
  $$('.col-body.over').forEach(el => el.classList.remove('over'));
  $$('.col-empty').forEach(el => el.style.display = '');
  dragTaskId = null; dragColId = null;
}
addEventListener('pointerup', () => $$('.column[draggable="true"]').forEach(c => { if (!c.classList.contains('col-dragging')) c.draggable = false; }));
// the column header doubles as the drag handle
boardEl.addEventListener('pointerdown', e => {
  const head = e.target.closest('.col-head');
  const col = e.target.closest('.column');
  if (head && col && !e.target.closest('[contenteditable="true"], button')) col.draggable = true;
});

/* ============================================================
   14. OVERLAYS
   ============================================================ */
function openOverlay(sel){ closeOverlays(); $(sel).classList.add('open'); document.body.style.overflow = 'hidden'; }
function closeOverlays(){ $$('.overlay.open').forEach(o => o.classList.remove('open')); document.body.style.overflow = ''; }
$$('.overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o || e.target.closest('[data-close]')) closeOverlays(); });
});

function openArchive(){
  const items = board().tasks.filter(t => t.archived);
  $('#archiveBody').innerHTML = items.length ? items.map(t =>
    `<div class="attach" style="padding:12px"><svg class="icon icon-sm"><use href="#i-archive"/></svg>
      <span style="flex:1">${esc(t.title)}</span>
      <button class="btn btn-ghost" data-restore="${t.id}">Restore</button>
      <button class="icon-btn plain" data-purge="${t.id}"><svg class="icon icon-sm"><use href="#i-trash"/></svg></button></div>`
  ).join('') : '<div class="empty"><h4>The archive is empty</h4>Archived tasks are kept here until you restore or delete them.</div>';
  openOverlay('#archiveOverlay');
}
$('#archiveBody').addEventListener('click', e => {
  const r = e.target.closest('[data-restore]'), p = e.target.closest('[data-purge]');
  if (r){ archiveTask(r.dataset.restore, false); openArchive(); }
  if (p){ deleteTask(p.dataset.purge); openArchive(); }
});

/* ============================================================
   15. IMPORT / EXPORT
   No control calls these at the moment — the header buttons were removed.
   Hook them up to any button (or call them from the console) to use them.
   ============================================================ */
function exportBoard(){
  const data = JSON.stringify({ type:'flowlane-board', version:1, board: board() }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type:'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = board().name.toLowerCase().replace(/[^a-z0-9]+/g,'-') + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Board exported as JSON');
}
function importBoard(file){
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const raw = parsed.board || parsed;
      if (!raw.columns || !raw.tasks) throw new Error('shape');
      pushUndo();
      // fresh ids for everything, so an import never collides with existing rows
      const str = v => typeof v === 'string' ? v : '', arr = v => Array.isArray(v) ? v : [];
      const colMap = {};
      const b = { id: uid(), name: str(raw.name) || 'Imported board', tasks: [],
        columns: arr(raw.columns).map(c => { const id = uid(); colMap[c.id] = id; return { id, title: str(c.title) || 'Untitled', collapsed: !!c.collapsed }; }) };
      b.tasks = arr(raw.tasks).filter(t => colMap[t.colId]).map(t => ({
        id: uid(), colId: colMap[t.colId], title: str(t.title) || 'Untitled', desc: str(t.desc),
        priority: PRIORITIES[t.priority] ? t.priority : 'medium', assignee: member(t.assignee) ? t.assignee : null,
        due: /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : '', labels: arr(t.labels).filter(l => typeof l === 'string'),
        checklist: arr(t.checklist).map(k => ({ id: uid(), text: str(k.text), done: !!k.done })), comments: [],
        attachments: arr(t.attachments).map(a => ({ id: uid(), name: str(a.name) || 'file', size: Number(a.size) || 0 })),
        archived: !!t.archived, createdAt: Date.now(), updatedAt: Date.now() }));
      state.boards.push(b);
      state.activeBoardId = b.id;
      commit('imported the board <b>' + esc(b.name) + '</b>');
      toast('Board imported', 'Undo', undo);
    } catch(err){
      toast('That file is not a Flowlane board export');
    }
  };
  reader.readAsText(file);
}

/* ============================================================
   16. EVENT WIRING
   ============================================================ */
function go(page){ ui.page = page; renderChrome(); $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('open'); }

$$('.nav-item[data-page]').forEach(n => n.onclick = () => go(n.dataset.page));
$('#btnGoBoard').onclick = e => {
  // one board: go straight there. More than one: pick which board to open.
  if (state.boards.length < 2) return go('board');
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.right - 250, r.bottom + 8, [
    { header:'Open board' },
    ...state.boards.map(bd => {
      const n = bd.tasks.filter(t => !t.archived).length;
      return {
        label: bd.name + ' · ' + n + (n === 1 ? ' task' : ' tasks'),
        icon:'i-board',
        check: bd.id === state.activeBoardId,
        onClick: () => { state.activeBoardId = bd.id; save(); renderAll(); go('board'); }
      };
    })
  ]);
};
$('#btnMenu').onclick = () => { $('#sidebar').classList.toggle('open'); $('#scrim').classList.toggle('open'); };
$('#scrim').onclick = () => { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('open'); };
$('#btnNewTask').onclick = () => openTaskModal(null, null);
$('#btnNewTaskTop').onclick = () => { go('board'); openTaskModal(null, null); };
$('#btnArchive').onclick = openArchive;
$('#btnTheme').onclick = () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme(); renderChrome(); save(); };

$('#btnWhoami').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.left, r.top - 170, [
    { header: session?.user?.email || 'Account' },
    { label: workspace?.role === 'owner' ? 'Team & invites' : 'Team', icon:'i-user', onClick: openTeam },
    { label: 'Keyboard shortcuts', icon:'i-kbd', onClick: () => openOverlay('#kbdOverlay') },
    { sep:true },
    { label: 'Sign out', icon:'i-x', danger:true, onClick: signOut }
  ]);
};

$('#search').addEventListener('input', e => { ui.search = e.target.value; renderBoard(); renderChrome(); });
[['#fPriority','priority'],['#fAssignee','assignee'],['#fLabel','label'],['#fDue','due'],['#fStatus','status'],['#fSort','sort']]
  .forEach(([sel,key]) => $(sel).addEventListener('change', e => { ui[key] = e.target.value; renderBoard(); renderChrome(); }));
$('#btnClearFilters').onclick = () => {
  Object.assign(ui, { search:'', priority:'', assignee:'', label:'', due:'', status:'' });
  $('#search').value = '';
  renderBoard(); renderChrome();
};
function renameBoardInline(){
  go('board');
  const t = $('#boardTitle');
  t.focus(); document.getSelection().selectAllChildren(t);
  t.scrollIntoView({ behavior:'smooth', block:'center' });
}
function newBoard(){
  pushUndo();
  const nb = { id:uid(), name:'Untitled board',
    columns:[{id:uid('c'),title:'To Do',collapsed:false},{id:uid('c'),title:'In Progress',collapsed:false},{id:uid('c'),title:'Done',collapsed:false}], tasks:[] };
  state.boards.push(nb); state.activeBoardId = nb.id;
  commit(); go('board'); renameBoardInline();
  toast('Board created — name it above');
}
function deleteBoard(){
  if (state.boards.length < 2){
    toast('This is your only board. Create another one before deleting it.');
    return;
  }
  pushUndo();
  const b = board(), i = state.boards.indexOf(b);
  state.boards.splice(i, 1);
  state.activeBoardId = state.boards[Math.max(0, i-1)].id;
  commit('deleted the board <b>' + esc(b.name) + '</b>');
  toast('Board “' + esc(b.name) + '” deleted', 'Undo', undo, 9000);
}
$('#btnBoardMenu').onclick = e => {
  const r = e.currentTarget.getBoundingClientRect();
  const b = board();
  const n = b.tasks.length;
  const short = b.name.length > 22 ? b.name.slice(0,22) + '…' : b.name;
  openMenu(r.right - 190, r.bottom + 8, [
    { label:'Delete board…', icon:'i-trash', danger:true, onClick: () => {
        if (state.boards.length < 2) return deleteBoard();
        openMenu(r.right - 250, r.bottom + 8, [
          { note:'Delete “'+short+'” and its '+n+' task'+(n===1?'':'s')+'? You can undo this straight after.' },
          { label:'Yes, delete this board', icon:'i-trash', danger:true, onClick: deleteBoard },
          { label:'Keep the board', icon:'i-x' }
        ]);
      } }
  ]);
};
$('#boardSwitcher').onchange = e => {
  if (e.target.value === '__new') return newBoard();
  state.activeBoardId = e.target.value;
  save(); renderAll();
};

/* board name inline edit */
const btitle = $('#boardTitle');
btitle.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); btitle.blur(); } });
btitle.addEventListener('blur', () => {
  const v = btitle.textContent.trim();
  if (!v){ btitle.textContent = board().name; return; }
  if (v !== board().name){ pushUndo(); board().name = v; commit('renamed the board to <b>'+esc(v)+'</b>'); }
});

/* board delegation: clicks */
boardEl.addEventListener('click', e => {
  const col = e.target.closest('.column');
  if (e.target.closest('#btnAddColumn')) return addColumn();
  if (e.target.closest('[data-col-add]')) return openTaskModal(null, col.dataset.id);
  if (e.target.closest('[data-col-expand]')){ pushUndo(); column(col.dataset.id).collapsed = false; return commit(); }
  if (e.target.closest('[data-col-menu]')){
    const r = e.target.closest('[data-col-menu]').getBoundingClientRect();
    const c = column(col.dataset.id);
    return openMenu(r.left - 150, r.bottom + 6, [
      { label:'Rename column', icon:'i-pencil', onClick: () => {
          const el = col.querySelector('[data-col-title]'); el.focus(); document.getSelection().selectAllChildren(el); } },
      { label:'Add task', icon:'i-plus', onClick: () => openTaskModal(null, c.id) },
      { label:c.collapsed ? 'Expand column' : 'Collapse column', icon:c.collapsed ? 'i-chev-r' : 'i-chev-l',
        onClick: () => { pushUndo(); c.collapsed = !c.collapsed; commit(); } },
      { sep:true },
      { label:'Move left',  icon:'i-chev-l', onClick: () => moveColumn(c.id, -1) },
      { label:'Move right', icon:'i-chev-r', onClick: () => moveColumn(c.id, 1) },
      { sep:true },
      { label:'Delete column', icon:'i-trash', danger:true, onClick: () => deleteColumn(c.id) }
    ]);
  }
  const card = e.target.closest('.task');
  if (!card || e.target.closest('[contenteditable="true"]')) return;
  // a click on the title waits a beat: a second click means "rename" instead of "open"
  if (e.target.closest('[data-title]')){
    clearTimeout(openTimer);
    openTimer = setTimeout(() => openTaskModal(card.dataset.id), 200);
  } else openTaskModal(card.dataset.id);
});
let openTimer = null;

/* board delegation: right-click context menu on a card */
boardEl.addEventListener('contextmenu', e => {
  const card = e.target.closest('.task');
  if (!card) return;
  e.preventDefault();
  const id = card.dataset.id, t = task(id);
  openMenu(e.clientX, e.clientY, [
    { label:'Open details', icon:'i-board', onClick: () => openTaskModal(id) },
    { label:'Rename', icon:'i-pencil', onClick: () => startInlineTitle(card) },
    { label:'Duplicate', icon:'i-copy', onClick: () => duplicateTask(id) },
    { sep:true },
    { header:'Priority' },
    ...Object.entries(PRIORITIES).map(([k,v]) => ({ label:v, icon:'i-flag', check:t.priority===k, onClick: () => setField(id,'priority',k,'priority') })),
    { sep:true },
    { header:'Assignee' },
    ...MEMBERS.map(m => ({ label:m.name, icon:'i-user', check:t.assignee===m.id, onClick: () => setField(id,'assignee',m.id,'the assignee') })),
    { label:'Unassigned', icon:'i-user', check:!t.assignee, onClick: () => setField(id,'assignee',null,'the assignee') },
    { sep:true },
    { header:'Move to' },
    ...board().columns.filter(c => c.id !== t.colId).map(c => ({ label:c.title, icon:'i-board', onClick: () => moveTask(id, c.id, null) })),
    { sep:true },
    { label:'Archive', icon:'i-archive', onClick: () => archiveTask(id) },
    { label:'Delete task', icon:'i-trash', danger:true, onClick: () => deleteTask(id) }
  ]);
});

/* inline title editing on cards */
function startInlineTitle(card){
  const h = card.querySelector('[data-title]');
  card.draggable = false;
  h.setAttribute('contenteditable','true');
  h.focus();
  document.getSelection().selectAllChildren(h);
}
boardEl.addEventListener('dblclick', e => {
  const h = e.target.closest('[data-title]');
  if (!h) return;
  clearTimeout(openTimer);
  startInlineTitle(h.closest('.task'));
});
boardEl.addEventListener('keydown', e => {
  const h = e.target.closest('[data-title], [data-col-title]');
  if (!h) return;
  if (e.key === 'Enter'){ e.preventDefault(); h.blur(); }
  if (e.key === 'Escape'){ e.preventDefault(); renderBoard(); }
}, true);
boardEl.addEventListener('blur', e => {
  const h = e.target;
  if (h.matches?.('[data-title]')){
    const card = h.closest('.task'), t = task(card.dataset.id);
    const v = h.textContent.trim();
    h.setAttribute('contenteditable','false'); card.draggable = true;
    if (v && t && v !== t.title){ pushUndo(); t.title = v; t.updatedAt = Date.now(); commit('renamed a task to <b>'+esc(v)+'</b>'); }
    else h.textContent = t ? t.title : v;
  }
  if (h.matches?.('[data-col-title]')){
    const c = column(h.closest('.column').dataset.id);
    const v = h.textContent.trim();
    if (v && c && v !== c.title){ pushUndo(); c.title = v; commit('renamed a column to <b>'+esc(v)+'</b>'); }
    else if (c) h.textContent = c.title;
  }
}, true);

/* task modal wiring */
$('#tLabels').addEventListener('click', e => {
  const b = e.target.closest('[data-label]'); if (!b) return;
  const n = b.dataset.label;
  const i = draft.labels.indexOf(n);
  i > -1 ? draft.labels.splice(i,1) : draft.labels.push(n);
  renderLabelPicker();
});
$('#btnAddCheck').onclick = addCheckItem;
$('#checkInput').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); addCheckItem(); } });
function addCheckItem(){
  const v = $('#checkInput').value.trim(); if (!v) return;
  draft.checklist.push({ id:uid('k'), text:v, done:false });
  $('#checkInput').value = '';
  renderChecklist(); $('#checkInput').focus();
}
$('#tChecklist').addEventListener('change', e => {
  const c = e.target.closest('[data-check]'); if (!c) return;
  const k = draft.checklist.find(k => k.id === c.dataset.check);
  k.done = c.checked; renderChecklist();
});
$('#tChecklist').addEventListener('click', e => {
  const d = e.target.closest('[data-check-del]'); if (!d) return;
  e.preventDefault();
  draft.checklist = draft.checklist.filter(k => k.id !== d.dataset.checkDel);
  renderChecklist();
});
$('#tChecklist').addEventListener('blur', e => {
  const s = e.target.closest?.('[data-check-text]'); if (!s) return;
  const k = draft.checklist.find(k => k.id === s.dataset.checkText);
  if (k) k.text = s.textContent.trim() || k.text;
}, true);
$('#btnAttach').onclick = () => $('#fileAttach').click();
$('#fileAttach').onchange = e => {
  [...e.target.files].forEach(f => draft.attachments.push({ id:uid('a'), name:f.name, size:f.size }));
  e.target.value = ''; renderAttachments();
  toast('Files are linked by name — nothing is uploaded');
};
$('#tAttachments').addEventListener('click', e => {
  const d = e.target.closest('[data-attach-del]'); if (!d) return;
  draft.attachments = draft.attachments.filter(a => a.id !== d.dataset.attachDel);
  renderAttachments();
});
$('#btnAddComment').onclick = addComment;
$('#commentInput').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); addComment(); } });
function addComment(){
  const v = $('#commentInput').value.trim(); if (!v) return;
  draft.comments.push({ id:uid('m'), author:state.me, text:v, at:Date.now() });
  $('#commentInput').value = ''; renderComments();
}
$('#btnSaveTask').onclick = saveTaskModal;
$('#btnDuplicate').onclick   = () => { const id = draft.id; closeOverlays(); duplicateTask(id); };
$('#btnArchiveTask').onclick = () => { const id = draft.id; closeOverlays(); archiveTask(id, true); };
$('#btnDeleteTask').onclick  = () => { const id = draft.id; closeOverlays(); deleteTask(id); };

/* ============================================================
   17. KEYBOARD SHORTCUTS
   ============================================================ */
addEventListener('keydown', e => {
  const typing = e.target.matches('input, textarea, select, [contenteditable="true"]');
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && $('#taskOverlay').classList.contains('open')){
    e.preventDefault(); return saveTaskModal();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing){ e.preventDefault(); return undo(); }
  if (e.key === 'Escape'){ closeMenu(); closeOverlays(); if (typing) e.target.blur(); return; }
  if (typing) return;
  if (e.key === '/'){ e.preventDefault(); $('#search').focus(); return; }
  if (e.key === '?'){ openOverlay('#kbdOverlay'); return; }
  const k = e.key.toLowerCase();
  if (k === 'n'){ e.preventDefault(); go('board'); openTaskModal(null, null); }
  if (k === 'c' && ui.page === 'board') addColumn();
  if (k === 'd') $('#btnTheme').click();
  if (e.key === '1') go('home');
  if (e.key === '2') go('board');
});

/* ============================================================
   18. TEAM DIALOG
   ============================================================ */
function openTeam(){
  $('#myName').value = member(state.me)?.name || '';
  renderTeam();
  openOverlay('#teamOverlay');
}
function renderTeam(){
  const owner = workspace?.role === 'owner';
  $('#teamTitle').textContent = workspace ? workspace.name : 'Team';
  $('#memberCount').textContent = '· ' + MEMBERS.length;
  $('#memberList').innerHTML = MEMBERS.map(m => `
    <div class="attach team-row">
      <span class="avatar sm" style="background:${m.color}">${initials(m.name)}</span>
      <span class="who"><b>${esc(m.name)}${m.id === state.me ? ' (you)' : ''}</b><small>${esc(m.email)}</small></span>
      <span class="role">${m.role}</span>
      ${owner && m.id !== state.me ? `<button type="button" class="btn btn-ghost" data-remove-member="${m.id}">Remove</button>` : ''}
    </div>`).join('');
  $('#inviteList').innerHTML = invites.length ? invites.map(i => `
    <div class="attach team-row">
      <svg class="icon icon-sm"><use href="#i-clock"/></svg>
      <span class="who"><b>${esc(i.email)}</b><small>Invited ${relTime(Date.parse(i.created_at))} · ${i.role}</small></span>
      ${owner ? `<button type="button" class="btn btn-ghost" data-revoke="${esc(i.email)}">Revoke</button>` : ''}
    </div>`).join('') : '<div class="col-empty">No pending invites.</div>';
  $('#inviteForm').hidden = !owner;
  $('#inviteNote').textContent = owner
    ? 'Invited people create their own account with this email on the sign-in screen.'
    : 'Only the workspace owner can invite or remove people.';
}
$('#btnSaveName').onclick = async () => {
  const v = $('#myName').value.trim();
  if (!v) return toast('Enter a name first');
  const { error } = await sb.from('profiles').update({ full_name: v }).eq('id', state.me);
  if (error) return toast('Could not save your name: ' + esc(error.message));
  await loadTeam(); renderAll(); renderTeam(); cacheLocal();
  toast('Name saved');
};
$('#inviteForm').onsubmit = async e => {
  e.preventDefault();
  const email = $('#inviteEmail').value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Enter a valid email address');
  if (MEMBERS.some(m => m.email === email)) return toast(esc(email) + ' is already on the team');
  const { error } = await sb.from('workspace_invites').insert({ workspace_id: workspace.id, email });
  if (error) return toast(error.code === '23505' ? esc(email) + ' is already invited' : 'Could not invite: ' + esc(error.message));
  $('#inviteEmail').value = '';
  await loadTeam(); renderTeam(); renderAll(); cacheLocal();
  toast(MEMBERS.some(m => m.email === email) ? esc(email) + ' already had an account and was added to the team' : 'Invite added for ' + esc(email));
};
$('#teamOverlay').addEventListener('click', async e => {
  const rm = e.target.closest('[data-remove-member]'), rv = e.target.closest('[data-revoke]');
  const btn = rm || rv; if (!btn) return;
  if (btn.dataset.armed !== '1'){                       // first click arms, second click confirms
    btn.dataset.armed = '1'; btn.textContent = 'Confirm?'; btn.classList.add('btn-danger');
    setTimeout(() => { if (btn.isConnected){ btn.dataset.armed = ''; btn.textContent = rm ? 'Remove' : 'Revoke'; btn.classList.remove('btn-danger'); } }, 3000);
    return;
  }
  const { error } = rm
    ? await sb.from('workspace_members').delete().eq('workspace_id', workspace.id).eq('user_id', rm.dataset.removeMember)
    : await sb.from('workspace_invites').delete().eq('workspace_id', workspace.id).eq('email', rv.dataset.revoke);
  if (error) return toast('Could not update the team: ' + esc(error.message));
  await loadTeam(); renderTeam(); renderAll(); cacheLocal();
  toast(rm ? 'Member removed' : 'Invite revoked');
});

/* ============================================================
   19. SIGN-IN
   ============================================================ */
let authMode = 'signin', started = false;
function showAuth(mode, msg, isError){
  authMode = mode;
  $('#authLoading').hidden = true;
  $('.app').hidden = true;
  $('#authScreen').hidden = false;
  $('#authPanel').hidden = false;
  $('#authBlocked').hidden = true;
  const up = mode === 'signup';
  $('#authTitle').textContent = up ? 'Create your account' : 'Sign in';
  $('#authSub').textContent = up ? 'Use the email your workspace owner invited.' : 'Sign in to your team’s boards.';
  $('#nameField').hidden = !up;
  $('#authPassword').autocomplete = up ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = up ? 'Create account' : 'Sign in';
  $('#authSwitchText').textContent = up ? 'Already have an account?' : 'Invited to a workspace?';
  $('#authSwitch').textContent = up ? 'Sign in' : 'Create an account';
  const m = $('#authMsg');
  m.textContent = msg || ''; m.classList.toggle('error', !!isError);
}
function showNoWorkspace(){
  started = false;
  $('#authLoading').hidden = true;
  $('.app').hidden = true;
  $('#authScreen').hidden = false;
  $('#authPanel').hidden = true;
  $('#authBlocked').hidden = false;
  $('#blockedEmail').textContent = session?.user?.email || '';
}
$('#authSwitch').onclick = () => showAuth(authMode === 'signin' ? 'signup' : 'signin');
$('#btnBlockedSignOut').onclick = () => signOut();
$('#authForm').onsubmit = async e => {
  e.preventDefault();
  const email = $('#authEmail').value.trim(), password = $('#authPassword').value, name = $('#authName').value.trim();
  const msg = $('#authMsg');
  const fail = t => { msg.textContent = t; msg.classList.add('error'); };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
  if (password.length < 6) return fail('The password needs at least 6 characters.');
  if (authMode === 'signup' && !name) return fail('Enter your name.');
  const btn = $('#authSubmit'); btn.disabled = true; msg.textContent = ''; msg.classList.remove('error');
  try {
    if (authMode === 'signin'){
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) fail(/confirm/i.test(error.message) ? 'Confirm your email first — check your inbox for the link.'
                    : /invalid/i.test(error.message) ? 'That email and password don’t match.' : error.message);
    } else {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: name }, emailRedirectTo: location.origin } });
      if (error) fail(/database error|invited/i.test(error.message)
        ? 'This email hasn’t been invited yet. Ask your workspace owner to invite it, then try again.'
        : error.message);
      else if (!data.session) showAuth('signin', 'Account created. Check your inbox to confirm your email, then sign in.');
    }
  } catch(err){
    fail(isNetworkError(err) ? 'Can’t reach the server. Check your connection.' : String(err.message || err));
  } finally { btn.disabled = false; }
};
async function signOut(){
  if (channel) sb.removeChannel(channel);
  await sb.auth.signOut().catch(() => {});
  location.reload();
}
sb.auth.onAuthStateChange((event, s) => {
  if (s) session = s;
  if (event === 'SIGNED_IN' && s && !started) setTimeout(() => start(s), 0);
  if (event === 'SIGNED_OUT' && started) location.reload();
});

/* ============================================================
   20. INIT
   ============================================================ */
async function start(s){
  if (started) return;
  started = true;
  session = s;
  state.me = s.user.id;
  $('#authScreen').hidden = true;
  $('.app').hidden = false;
  setSyncStatus('loading');

  const cache = lsGet(cacheKey());
  if (cache && cache.v === 2){
    workspace = cache.workspace; MEMBERS = cache.members || []; invites = cache.invites || [];
    activity = cache.activity || []; state.boards = cache.boards || [];
    snapshot = emptyRows();
    for (const t of TABLES) (cache.snapshot?.[t] || []).forEach(r => snapshot[t].set(r.id, r));
  }
  try {
    await loadTeam();
    if (!workspace) return showNoWorkspace();
    const server = await fetchAll();
    state.boards = mergeAll(server, false);
    activity = await fetchActivity();
    setSyncStatus('saved');
  } catch(e){
    if (!isNetworkError(e)) console.error(e);
    isOnline = false;
    setSyncStatus('offline');
    if (!workspace){ started = false; return showAuth('signin', 'Can’t reach the server. Check your connection and reload.', true); }
    toast('Cannot reach Supabase. Showing the copy saved on this device.');
  }
  ensureActive();
  renderAll();
  save();
  listen();
}

(async function init(){
  const prefs = lsGet(PREFS_KEY) || {};
  state.theme = prefs.theme === 'dark' ? 'dark' : 'light';
  state.activeBoardId = prefs.activeBoardId || null;
  applyTheme();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (!CFG.supabaseUrl || !window.supabase){ showAuth('signin', 'Supabase is not configured or could not load.', true); return; }
  const { data } = await sb.auth.getSession();
  if (data.session) start(data.session);
  else showAuth('signin');
})();
