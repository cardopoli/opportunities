import {match, index, daysLeft, money, ics, encodeProfile, decodeProfile, BASED} from './score.mjs';
import {KitchenDropbox, authURL, random, challenge, callbackURL, validateCallback} from './dropbox.mjs';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null && k !== false)); return e; };
const read = (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };
const K = {state: 'opps.state', visit: 'opps.lastVisit', mine: 'opps.myProfiles', active: 'opps.active', auth: 'opps.dropbox', pending: 'opps.pending', key: 'opps.appKey', how: 'opps.howFolded'};
const STATUS = [['shortlist', 'Saved'], ['preparing', 'Preparing'], ['submitted', 'Sent'], ['won', 'Won'], ['declined', 'Not this time']];
const KIND_LABEL = {residency: 'Residencies', open_call: 'Open calls', commission: 'Commissions', prize: 'Prizes', fellowship: 'Fellowships', grant: 'Grants', tender: 'Tenders', training: 'Training'};
const REGION_LABEL = {UK: 'UK', IE: 'Ireland', IT: 'Italy', 'IT-FVG': 'Friuli Venezia Giulia', SI: 'Slovenia', 'IT-SI': 'Italy-Slovenia', EU: 'Europe (EU)', CH: 'Switzerland', International: 'International'};
const MIN = 25, MIN_WEAK = 10, PAGE = 40;
const today = new Date();

let data = {items: [], sources: []}, tree = {families: []}, idx = index(tree), presets = [], manual = [];
let mine = read(K.mine, []), active = read(K.active, null), shared = null, draft = null;
let state = Object.assign({pipeline: {}, hidden: {}, updatedAt: 0}, read(K.state, {}));
let view = 'leads', kinds = new Set(), limit = PAGE, lastVisit = null;
let db = null, session = read(K.auth) || null, syncTimer = 0;

function status(msg, bad = false) { const s = $('status'); s.textContent = msg || ''; s.classList.toggle('bad', !!bad); }
const fmtDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'});
const ago = iso => { const h = Math.round((Date.now() - Date.parse(iso)) / 36e5); return h < 1 ? 'just now' : h === 1 ? 'an hour ago' : h < 36 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`; };
const slugify = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').slice(0, 50);
function download(text, name, type) { const a = el('a', {href: URL.createObjectURL(new Blob([text], {type})), download: name}); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
async function copy(text, done) { try { await navigator.clipboard.writeText(text); status(done); } catch { prompt('Copy this link:', text); } }
function when(i) {
  const d = daysLeft(i, today);
  if (d == null) return el('div', {className: 'when'}, i.status === 'rolling' ? 'No fixed deadline' : 'Deadline not found: check the page');
  if (d < 0) return el('div', {className: 'when'}, 'Closed ' + fmtDate(i.deadline));
  const cls = d <= 14 ? 'urgent' : d <= 45 ? 'soon' : '';
  return el('div', {className: 'when', title: i.deadline_text || ''}, 'Closes ', el('b', {className: cls, textContent: fmtDate(i.deadline)}), d === 0 ? ' (today)' : d === 1 ? ' (tomorrow)' : ` (in ${d} days)`);
}

// ---------- profiles ----------
const defaults = () => ({id: 'me', name: 'You', skills: [], breadth: 1, based: [], as: 'both', stage: 'any', kinds: [], free_only: false, exclude: []});
function profile() {
  if (active === 'shared' && shared) return shared;
  if (active === 'all') return null;
  if (active?.startsWith('preset:')) return presets.find(p => 'preset:' + p.id === active) || null;
  return mine[0] || null;
}
function profileName() {
  if (active === 'all') return 'everything';
  if (active === 'shared' && shared) return shared.name;
  if (active?.startsWith('preset:')) return profile()?.name || 'an example';
  return 'you';
}
function saveMine(p) { mine = [{...defaults(), ...p, id: 'me', name: 'You', updatedAt: Date.now()}, ...mine.slice(1)]; write(K.mine, mine); active = 'me'; write(K.active, active); save(); }
function setActive(key) { active = key; if (key !== 'shared') write(K.active, key); limit = PAGE; draw(); }

// ---------- setup (two questions) ----------
function openSetup() {
  const base = mine[0] || defaults();
  draft = {...base, skills: [...base.skills], based: [...base.based]};
  $('setup').hidden = false; $('leads-wrap').hidden = true; $('s-cancel').hidden = !mine[0] && !active;
  $('s-search').value = ''; drawSetup();
}
function closeSetup() { draft = null; $('setup').hidden = true; $('leads-wrap').hidden = false; }
function drawSetup() {
  const fam = $('s-families'); fam.replaceChildren();
  for (const f of tree.families) {
    const ids = f.skills.map(s => s.id), on = ids.every(id => draft.skills.includes(id));
    const b = el('button', {type: 'button', className: 'chip', textContent: f.name}); b.setAttribute('aria-pressed', String(on));
    b.onclick = () => { draft.skills = on ? draft.skills.filter(id => !ids.includes(id)) : [...new Set([...draft.skills, ...ids])]; drawSetup(); };
    fam.append(b);
  }
  const q = $('s-search').value.trim().toLowerCase();
  const leaves = [...idx.leaves.values()];
  const show = q ? leaves.filter(s => (s.name + ' ' + s.keywords.join(' ')).toLowerCase().includes(q)).slice(0, 18)
    : leaves.filter(s => draft.skills.includes(s.id) && !tree.families.find(f => f.id === s.family).skills.every(x => draft.skills.includes(x.id)));
  $('s-skills').replaceChildren(...show.map(s => { const on = draft.skills.includes(s.id); const b = el('button', {type: 'button', className: 'chip', textContent: s.name}); b.setAttribute('aria-pressed', String(on)); b.onclick = () => { draft.skills = on ? draft.skills.filter(x => x !== s.id) : [...draft.skills, s.id]; drawSetup(); }; return b; }));
  $('s-based').replaceChildren(...Object.entries(BASED).map(([k, label]) => { const on = draft.based.includes(k); const b = el('button', {type: 'button', className: 'chip', textContent: label}); b.setAttribute('aria-pressed', String(on)); b.onclick = () => { draft.based = on ? draft.based.filter(x => x !== k) : [...draft.based, k]; drawSetup(); }; return b; }));
}
function finishSetup() {
  if (!draft.skills.length) return status('Tap at least one thing you do.', true);
  saveMine(draft); if (shared) { shared = null; history.replaceState(null, '', location.pathname); }
  closeSetup(); status('Done. These are the calls that fit you. Press Save on the ones you like.'); limit = PAGE; draw(); window.scrollTo({top: $('leads-wrap').offsetTop - 70, behavior: 'smooth'});
}

// ---------- state & sync ----------
function save() { state.updatedAt = Date.now(); write(K.state, state); if (db) { clearTimeout(syncTimer); syncTimer = setTimeout(() => push().catch(e => status(e.message, true)), 1200); } }
function mergeStates(a, b) {
  const out = {pipeline: {...a.pipeline}, hidden: {...a.hidden, ...b.hidden}, updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0)};
  for (const [id, p] of Object.entries(b.pipeline || {})) if (!out.pipeline[id] || (p.updatedAt || 0) > (out.pipeline[id].updatedAt || 0)) out.pipeline[id] = p;
  return out;
}
function takeProfiles(list) {
  // The newest answers win, so a change on your phone reaches your computer and the Monday email.
  const theirs = Array.isArray(list) ? list[0] : null;
  if (!theirs?.skills?.length || (mine[0]?.updatedAt || 0) >= (theirs.updatedAt || 0)) return false;
  mine = [theirs, ...mine.slice(1)]; write(K.mine, mine);
  if (!active || active === 'me') { active = 'me'; write(K.active, active); }
  return true;
}
async function pull() {
  let remote = null;
  try { remote = JSON.parse(await db.download('/opportunities/pipeline.json')); } catch (e) { if (e.status && e.status !== 409) throw e; }
  if (remote) { state = mergeStates(state, remote); write(K.state, state); if (takeProfiles(remote.profiles) && !$('setup').hidden) closeSetup(); }
  if (!remote || (mine[0]?.updatedAt || 0) > (remote.profiles?.[0]?.updatedAt || 0) || (state.updatedAt || 0) > (remote.updatedAt || 0)) await push();
}
async function push() { await db.upload('/opportunities/pipeline.json', JSON.stringify({...state, profiles: mine, v: 2}, null, 1)); status('Saved to Dropbox.'); }
async function connect() {
  const key = $('app-key').value.trim() || read(K.key, '');
  if (!/^[A-Za-z0-9_-]{5,100}$/.test(key)) { $('sync-setup').open = true; $('app-key').focus(); throw Error('Add your Dropbox app key first (see One-off setup).'); }
  write(K.key, key);
  const verifier = random(), st = random(), redirect = callbackURL(location.href);
  sessionStorage.setItem(K.pending, JSON.stringify({key, verifier, state: st, redirect, remember: true, created: Date.now()}));
  location.assign(authURL(key, redirect, st, await challenge(verifier)));
}
async function callback() {
  const u = new URL(location.href);
  if (!u.searchParams.has('code') && !u.searchParams.has('error')) return;
  const pending = JSON.parse(sessionStorage.getItem(K.pending) || 'null'); sessionStorage.removeItem(K.pending);
  history.replaceState(null, '', callbackURL(location.href));
  validateCallback(pending, u.searchParams.get('state'));
  if (u.searchParams.has('error')) throw Error('Dropbox connection was cancelled.');
  session = {key: pending.key, remember: true};
  db = new KitchenDropbox(session, s => write(K.auth, s));
  await db.token({client_id: pending.key, grant_type: 'authorization_code', code: u.searchParams.get('code'), code_verifier: pending.verifier, redirect_uri: pending.redirect});
  view = 'saved';
}
function disconnect() {
  const access = db?.session?.access_token; db?.close(); db = null; session = null; localStorage.removeItem(K.auth);
  if (access) fetch('https://api.dropboxapi.com/2/auth/token/revoke', {method: 'POST', headers: {Authorization: 'Bearer ' + access}, referrerPolicy: 'no-referrer'}).catch(() => {});
  drawSync(); status('Dropbox disconnected. Everything stays in this browser.');
}
function drawSync() { $('sync-on').hidden = !db; $('sync-off').hidden = !!db; $('email-keys').hidden = !db; $('callback').textContent = callbackURL(location.href); $('app-key').value = read(K.key, ''); }

// ---------- leads ----------
function filtered() {
  const p = profile(), q = $('q').value.trim().toLowerCase(), region = $('region').value, w = $('when').value, sort = $('sort').value;
  const min = $('weak').checked ? MIN_WEAK : MIN;
  let list = data.items.filter(i => i.present !== false && i.status !== 'closed' && !state.hidden[i.id]);
  if (q) list = list.filter(i => [i.title, i.summary, i.source, i.programme].join(' ').toLowerCase().includes(q));
  if (kinds.size) list = list.filter(i => (i.kinds || []).some(k => kinds.has(k)));
  if (region) list = list.filter(i => i.region === region);
  if ($('free').checked) list = list.filter(i => i.fee !== true);
  if ($('only-new').checked && lastVisit) list = list.filter(i => i.first_seen > lastVisit);
  if (w) list = list.filter(i => { const d = daysLeft(i, today); return w === 'rolling' ? i.status === 'rolling' : d != null && d >= 0 && d <= Number(w); });
  const scored = list.map(i => ({i, m: p ? match(i, p, idx) : null})).filter(x => !x.m || x.m.score >= min);
  const dl = x => daysLeft(x.i, today) ?? 9999;
  scored.sort(sort === 'soon' || !p ? (a, b) => dl(a) - dl(b) : sort === 'new' ? (a, b) => b.i.first_seen.localeCompare(a.i.first_seen) : (a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0) || dl(a) - dl(b));
  return scored;
}
function saveLead(i) {
  state.pipeline[i.id] = {id: i.id, stage: 'shortlist', notes: '', item: {id: i.id, title: i.title, url: i.url, source: i.source, region: i.region, kinds: i.kinds, deadline: i.deadline || null, amount: i.amount || null, summary: i.summary || ''}, addedAt: Date.now(), updatedAt: Date.now()};
  save(); drawTabs();
}
function row({i, m}) {
  const isSaved = () => !!(state.pipeline[i.id] && !state.pipeline[i.id].deleted);
  const meta = [money(i.amount), i.source, REGION_LABEL[i.region] || i.region, i.fee === true ? 'entry fee' : null, i.applicants === 'organisations' ? 'for organisations' : null, i.early_career ? 'early career' : null].filter(Boolean).join(' · ');
  const saveBtn = el('button', {type: 'button', className: 'btn'});
  const paint = () => { const s = isSaved(); saveBtn.textContent = s ? 'Saved ✓' : 'Save'; saveBtn.classList.toggle('on', s); };
  saveBtn.onclick = () => { if (isSaved()) { view = 'saved'; draw(); } else { saveLead(i); paint(); status(`Saved. Find it under Saved.`); } };
  paint();
  const hide = el('button', {type: 'button', className: 'link small', textContent: 'Not for me'});
  hide.onclick = () => { state.hidden[i.id] = Date.now(); save(); drawLeads(); status('Hidden. Changed your mind? More options → Leads you hid.'); };
  const details = el('details', {}, el('summary', {textContent: 'More about this call'}),
    i.summary ? el('p', {textContent: i.summary}) : null,
    i.deadline ? el('p', {}, el('button', {type: 'button', className: 'link', textContent: 'Add the deadline to my calendar', onclick: () => download(ics([i]), slugify(i.title) + '.ics', 'text/calendar')})) : null,
    ...(i.also_on || []).map(a => el('p', {className: 'small'}, 'Also listed on ', el('a', {href: a.url, target: '_blank', rel: 'noopener', textContent: a.source}))),
    el('p', {className: 'small', textContent: 'Found automatically. Check eligibility, fees and rights on the funder\'s own page.'}));
  const isNew = lastVisit && i.first_seen > lastVisit;
  return el('li', {className: 'lead'},
    el('a', {className: 'title', href: i.url, target: '_blank', rel: 'noopener', textContent: i.title}), isNew ? el('span', {className: 'new', textContent: 'New'}) : null,
    when(i), meta ? el('div', {className: 'meta', textContent: meta}) : null,
    m && m.reasons.length ? el('div', {className: 'why', textContent: 'Why it fits: ' + m.reasons.slice(0, 3).join(', ')}) : null,
    el('div', {className: 'acts'}, saveBtn, hide), details);
}
function drawLeads() {
  const list = filtered();
  $('for').replaceChildren('Showing calls for ', el('b', {textContent: profileName()}));
  $('count').textContent = `${list.length} call${list.length === 1 ? '' : 's'}${profile() ? ', best fit first' : ''}`;
  $('leads').replaceChildren(...list.slice(0, limit).map(row));
  $('more').hidden = list.length <= limit;
  $('none').hidden = list.length > 0;
}
function drawOptions() {
  const p = mine[0];
  const editable = active === 'me' && p;
  $('o-as').disabled = !editable; document.querySelectorAll('[name=o-breadth]').forEach(r => { r.disabled = !editable; r.checked = editable && Number(r.value) === p.breadth; }); $('o-exclude').disabled = !editable;
  if (editable) { $('o-as').value = p.as || 'both'; $('o-exclude').value = (p.exclude || []).join(', '); }
}

// ---------- saved ----------
function stageOf(p) { return p.stage === 'result' ? (p.result === 'won' ? 'won' : 'declined') : p.stage; }
function card(p) {
  const i = p.item, st = stageOf(p);
  const sel = el('select', {}, ...STATUS.map(([v, l]) => el('option', {value: v, textContent: l, selected: st === v}))); sel.setAttribute('aria-label', 'Status');
  sel.onchange = () => { const v = sel.value; if (v === 'won' || v === 'declined') { p.stage = 'result'; p.result = v; } else { p.stage = v; p.result = ''; } p.updatedAt = Date.now(); save(); drawSaved(); };
  const notes = el('textarea', {value: p.notes || '', placeholder: 'What to send, who to ask, partners…', rows: 3});
  notes.onchange = () => { p.notes = notes.value; p.updatedAt = Date.now(); save(); };
  const dl = el('input', {type: 'date', value: i.deadline || ''}); dl.setAttribute('aria-label', 'Deadline');
  dl.onchange = () => { i.deadline = dl.value || null; p.updatedAt = Date.now(); save(); drawSaved(); };
  const del = el('button', {type: 'button', className: 'link small', textContent: 'Remove'});
  del.onclick = () => { if (confirm(`Remove “${i.title}” from Saved?`)) { state.pipeline[p.id] = {id: p.id, deleted: true, updatedAt: Date.now()}; save(); drawSaved(); drawTabs(); } };
  return el('li', {className: 'card' + (st === 'won' || st === 'declined' ? ' done' : '')},
    i.url ? el('a', {className: 'title', href: i.url, target: '_blank', rel: 'noopener', textContent: i.title}) : el('span', {className: 'title', textContent: i.title}),
    when(i), el('div', {className: 'meta', textContent: [money(i.amount), i.source].filter(Boolean).join(' · ')}),
    el('div', {className: 'row'}, sel, del),
    el('details', {open: !!p.notes}, el('summary', {textContent: p.notes ? 'Notes' : 'Add notes or change the deadline'}), notes, el('div', {className: 'row'}, el('span', {className: 'small', textContent: 'Deadline'}), dl)));
}
function drawSaved() {
  const items = Object.values(state.pipeline).filter(p => p && !p.deleted && p.item);
  const rank = p => { const st = stageOf(p); if (st === 'won' || st === 'declined') return 3e6; const d = daysLeft(p.item, today); return d == null ? 1e6 : d < 0 ? 2e6 - d : d; };
  items.sort((a, b) => rank(a) - rank(b));
  $('saved').replaceChildren(...items.map(card));
  $('saved-empty').hidden = items.length > 0;
}
function drawTabs() { const n = Object.values(state.pipeline).filter(p => p && !p.deleted).length; $('saved-count').textContent = n ? ` (${n})` : ''; }
const MONTHS = {january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, dicembre: 12};
function readCall(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = n => doc.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content?.trim() || '';
  doc.querySelectorAll('script,style,nav,header,footer').forEach(n => n.remove());
  const text = (doc.body?.textContent || '').replace(/\s+/g, ' ');
  let deadline = null;
  for (const m of text.matchAll(/(deadline|closing date|closes|apply by|scadenza|entro il|rok za oddajo)[^.]{0,120}?(\d{1,2})(?:st|nd|rd|th)?[\s./-]+(\d{1,2}|[a-z]+)[\s./-]+(20\d\d)/gi)) {
    const mo = /^\d+$/.test(m[3]) ? Number(m[3]) : MONTHS[m[3].toLowerCase()];
    if (!mo) continue;
    const iso = `${m[4]}-${String(mo).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(iso)) && iso >= today.toISOString().slice(0, 10)) { deadline = iso; break; }
  }
  return {title: meta('og:title') || doc.querySelector('h1')?.textContent?.trim() || doc.title?.trim() || '', summary: meta('og:description') || meta('description'), deadline};
}
async function addByLink() {
  const url = $('add-url').value.trim(), title = $('add-title').value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) throw Error('Paste the full web address of the call, starting with https://');
  const known = data.items.find(i => i.url === url);
  if (known) { saveLead(known); $('add-url').value = ''; drawSaved(); return status('Saved.'); }
  let found = {};
  if (db && !title) {
    status('Reading the page through your Dropbox…');
    const path = `/opportunities/inbox/${Date.now()}.html`;
    try { await db.saveUrl(path, url); found = readCall(await db.download(path)); } catch (e) { status(e.message + ' Add a title by hand instead.', true); } finally { db.remove(path).catch(() => {}); }
  }
  const t = title || found.title;
  if (!t) { $('add-title').focus(); throw Error('Add a title for this call.'); }
  const id = 'own-' + Date.now().toString(36);
  state.pipeline[id] = {id, stage: 'shortlist', notes: '', item: {id, title: t, url, source: new URL(url).hostname.replace(/^www\./, ''), deadline: $('add-deadline').value || found.deadline || null, amount: null, summary: found.summary || ''}, addedAt: Date.now(), updatedAt: Date.now()};
  save(); $('add-url').value = ''; $('add-title').value = ''; $('add-deadline').value = '';
  drawSaved(); drawTabs(); status(`Added “${t}”.`);
}
function importBackup(file) {
  file.text().then(t => {
    const got = JSON.parse(t);
    if (!got || typeof got.pipeline !== 'object') throw Error('That file is not an Opportunities backup.');
    state = mergeStates(state, got); takeProfiles(got.profiles);
    save(); drawSaved(); drawTabs(); status(`Restored ${Object.keys(got.pipeline).length} saved calls.`);
  }).catch(e => status(e.message, true));
}

// ---------- sources ----------
function drawSources() {
  const ok = data.sources.filter(s => s.status === 'ok').length;
  $('src-summary').textContent = `${ok} of ${data.sources.length} sites answered this morning, plus ${manual.length} that block automatic checks and are worth a look by hand.`;
  $('src-list').replaceChildren(...data.sources.map(s => el('li', {}, el('a', {href: s.url, target: '_blank', rel: 'noopener', textContent: s.name}), el('span', {textContent: s.status === 'ok' ? `${s.listings} listed` : 'not answering'}))));
  $('manual-list').replaceChildren(...manual.map(s => el('li', {}, el('a', {href: s.url, target: '_blank', rel: 'noopener', textContent: s.name}), el('span', {textContent: s.why || ''}))));
  const hidden = Object.keys(state.hidden).map(id => data.items.find(i => i.id === id)).filter(Boolean);
  $('hidden-count').textContent = hidden.length;
  $('hidden-list').replaceChildren(...hidden.map(i => { const b = el('button', {type: 'button', className: 'link small', textContent: 'Show again'}); b.onclick = () => { delete state.hidden[i.id]; save(); draw(); }; return el('li', {}, el('span', {textContent: i.title}), b); }));
}

function draw() {
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  $('v-leads').hidden = view !== 'leads'; $('v-saved').hidden = view !== 'saved';
  $('intro').hidden = view !== 'leads'; $('how').hidden = view !== 'leads';
  drawTabs();
  if (view === 'leads') { drawLeads(); drawOptions(); drawSources(); }
  if (view === 'saved') drawSaved();
}

function wire() {
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { view = b.dataset.view; draw(); window.scrollTo({top: 0}); });
  for (const id of ['q', 'region', 'when', 'sort', 'only-new', 'free', 'weak']) $(id).addEventListener('input', () => { limit = PAGE; drawLeads(); });
  $('kinds').replaceChildren(...Object.entries(KIND_LABEL).map(([k, label]) => {
    const b = el('button', {type: 'button', className: 'chip', textContent: label}); b.setAttribute('aria-pressed', 'false');
    b.onclick = () => { kinds.has(k) ? kinds.delete(k) : kinds.add(k); b.setAttribute('aria-pressed', String(kinds.has(k))); limit = PAGE; drawLeads(); };
    return b;
  }));
  $('more').onclick = () => { limit += PAGE; drawLeads(); };
  $('change').onclick = openSetup;
  $('share').onclick = () => { const p = profile(); const link = location.origin + location.pathname + (p ? '#p=' + encodeProfile({...p, name: p.name === 'You' ? 'A friend' : p.name}) : ''); copy(link, 'Link copied. Whoever opens it sees these calls, and can make them their own.'); };
  $('s-search').oninput = drawSetup;
  $('s-go').onclick = finishSetup;
  $('s-cancel').onclick = () => { closeSetup(); draw(); };
  $('o-as').onchange = () => { if (mine[0]) { saveMine({...mine[0], as: $('o-as').value}); drawLeads(); } };
  document.querySelectorAll('[name=o-breadth]').forEach(r => r.onchange = () => { if (mine[0]) { saveMine({...mine[0], breadth: Number(r.value)}); drawLeads(); } });
  $('o-exclude').onchange = () => { if (mine[0]) { saveMine({...mine[0], exclude: $('o-exclude').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)}); drawLeads(); } };
  const how = $('how'), setHow = f => { how.classList.toggle('folded', f); $('how-toggle').textContent = f ? 'Show' : 'Hide'; $('how-toggle').setAttribute('aria-expanded', String(!f)); };
  setHow(read(K.how, false)); $('how-toggle').onclick = () => { const f = !how.classList.contains('folded'); write(K.how, f); setHow(f); };
  $('add-go').onclick = () => addByLink().catch(e => status(e.message, true));
  $('ics-all').onclick = () => { const items = Object.values(state.pipeline).filter(p => p && !p.deleted && p.item?.deadline && p.stage !== 'result').map(p => p.item); if (!items.length) return status('No saved deadlines yet.'); download(ics(items), 'opportunities-deadlines.ics', 'text/calendar'); };
  $('backup').onclick = () => download(JSON.stringify({...state, profiles: mine, v: 2}, null, 1), `opportunities-backup-${today.toISOString().slice(0, 10)}.json`, 'application/json');
  $('restore').onchange = e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; };
  $('connect').onclick = () => connect().catch(e => status(e.message, true));
  $('disconnect').onclick = disconnect;
  $('copy-key1').onclick = () => copy(db?.session?.key || read(K.key, ''), 'Key 1 copied. In GitHub, add it as DROPBOX_APP_KEY.');
  $('copy-key2').onclick = () => { const t = db?.session?.refresh_token; if (!t) return status('Connect Dropbox first.', true); copy(t, 'Key 2 copied. In GitHub, add it as DROPBOX_REFRESH_TOKEN. Keep it private, like a password.'); };
  const regions = [...new Set(data.items.map(i => i.region).filter(Boolean))].sort((a, b) => (REGION_LABEL[a] || a).localeCompare(REGION_LABEL[b] || b));
  $('region').append(...regions.map(r => el('option', {value: r, textContent: REGION_LABEL[r] || r})));
}

async function start() {
  try { await callback(); } catch (e) { status(e.message, true); }
  if (!db && session?.refresh_token) db = new KitchenDropbox(session, s => write(K.auth, s));
  try {
    const [d, p, t, s] = await Promise.all([
      fetch('data/opportunities.json', {cache: 'no-cache'}).then(r => { if (!r.ok) throw Error('The first daily check has not run yet. Try again in a few minutes.'); return r.json(); }),
      fetch('data/profiles.json', {cache: 'no-cache'}).then(r => r.json()),
      fetch('data/skills.json', {cache: 'no-cache'}).then(r => r.json()),
      fetch('scripts/sources.json', {cache: 'no-cache'}).then(r => r.json()).catch(() => ({sources: []})),
    ]);
    data = d; presets = p.presets; tree = t; idx = index(tree); manual = s.sources.filter(x => x.kind === 'manual');
  } catch (e) { status(e.message, true); }
  // Older saves kept several profiles: keep the first personal one as "You".
  if (active?.startsWith('mine:')) { active = 'me'; write(K.active, active); }
  const m = /^#p=([\w-]+)$/.exec(location.hash);
  if (m) { try { shared = decodeProfile(m[1]); active = 'shared'; status(`Someone shared these calls with you. Like them? Tap Change, then “Show my opportunities” to keep this as yours.`); } catch (e) { status(e.message, true); } }
  const open = data.items.filter(i => i.present !== false && i.status !== 'closed').length;
  $('checked').textContent = data.checked_at ? `Last checked ${ago(data.checked_at)} · ${open} open calls` : '';
  if (data.sources?.length) $('how-sources').textContent = String(data.sources.length + manual.length);
  const seen = read(K.visit, null), marks = seen && typeof seen === 'object' ? seen : {previous: null, current: null};
  if (data.checked_at && marks.current !== data.checked_at) { marks.previous = marks.current; marks.current = data.checked_at; write(K.visit, marks); }
  lastVisit = marks.previous;
  if (lastVisit) $('only-new-label').textContent = `Only new since my last visit (${data.items.filter(i => i.first_seen > lastVisit && i.status !== 'closed').length})`;
  else $('only-new-wrap').hidden = true;
  wire(); drawSync();
  const examples = $('s-examples');
  for (const pr of presets) examples.append(el('button', {type: 'button', className: 'link', textContent: pr.name, onclick: () => { closeSetup(); setActive('preset:' + pr.id); }}));
  examples.append(el('button', {type: 'button', className: 'link', textContent: 'Everything', onclick: () => { closeSetup(); setActive('all'); }}));
  if (shared?.name === 'A friend') shared.name = 'a friend';
  draw();
  if (!active) openSetup();
  if (db) pull().then(() => { draw(); status('Synced with Dropbox.'); }).catch(e => status(e.message, true));
}

start();
