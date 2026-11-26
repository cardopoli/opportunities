import {match, index, daysLeft, money, ics, encodeProfile, decodeProfile, BASED} from './score.mjs';
import {KitchenDropbox, authURL, random, challenge, callbackURL, validateCallback} from './dropbox.mjs';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null && k !== false)); return e; };
const read = (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };
const K = {state: 'opps.state', visit: 'opps.lastVisit', mine: 'opps.myProfiles', active: 'opps.active', auth: 'opps.dropbox', pending: 'opps.pending', key: 'opps.appKey'};
const STAGES = [['shortlist', 'Shortlist'], ['preparing', 'Preparing'], ['submitted', 'Submitted'], ['result', 'Result']];
const KIND_LABEL = {residency: 'Residency', open_call: 'Open call', commission: 'Commission', prize: 'Prize', fellowship: 'Fellowship', grant: 'Grant', tender: 'Tender', training: 'Training', other: 'Other'};
const REGION_LABEL = {UK: 'UK', IE: 'Ireland', IT: 'Italy', 'IT-FVG': 'Friuli Venezia Giulia', SI: 'Slovenia', 'IT-SI': 'Italy-Slovenia', EU: 'Europe (EU)', CH: 'Switzerland', International: 'International'};
const BREADTH = ['Precise', 'Related', 'Broad'];
const today = new Date();

let data = {items: [], sources: []}, tree = {families: []}, idx = index(tree), presets = [], manual = [];
let mine = read(K.mine, []), active = read(K.active, 'preset:practice'), shared = null, editing = null;
let state = Object.assign({pipeline: {}, hidden: {}, updatedAt: 0}, read(K.state, {}));
let view = 'leads', kinds = new Set(), limit = 60, lastVisit = null;
let db = null, session = read(K.auth) || null, syncTimer = 0;

function status(msg, bad = false) { const s = $('status'); s.textContent = msg || ''; s.classList.toggle('bad', !!bad); }
const fmtDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'});
const ago = iso => { const h = Math.round((Date.now() - Date.parse(iso)) / 36e5); return h < 1 ? 'just now' : h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`; };
const slugify = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').slice(0, 50);
function download(text, name, type) { const a = el('a', {href: URL.createObjectURL(new Blob([text], {type})), download: name}); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
async function copy(text, done) { try { await navigator.clipboard.writeText(text); status(done); } catch { prompt('Copy this:', text); } }

// ---------- profiles ----------
function allProfiles() { return [...presets.map(p => ({...p, key: 'preset:' + p.id, preset: true})), ...mine.map(p => ({...p, key: 'mine:' + p.id})), ...(shared ? [{...shared, key: 'shared'}] : [])]; }
function activeProfile() { return active === 'all' ? null : allProfiles().find(p => p.key === active) || allProfiles()[0] || null; }
function setActive(key) { active = key; if (key !== 'shared') write(K.active, key); limit = 60; draw(); }
const blank = () => ({id: Date.now().toString(36), name: 'My profile', skills: [], breadth: 1, based: [], as: 'individual', stage: 'any', kinds: [], free_only: false, exclude: []});

function drawProfiles() {
  const box = $('profiles'); box.replaceChildren();
  const btn = (key, name, sub) => { const b = el('button', {type: 'button'}, el('b', {textContent: name}), el('small', {textContent: sub})); b.setAttribute('aria-pressed', String(active === key || (key !== 'all' && activeProfile()?.key === key && active !== 'all'))); b.onclick = () => setActive(key); return b; };
  for (const p of allProfiles()) box.append(btn(p.key, p.name, p.preset ? 'Example profile' : p.key === 'shared' ? 'Shared with you' : `${p.skills.length} skills · ${BREADTH[p.breadth]}`));
  box.append(btn('all', 'Everything', 'No matching, all open leads'));
  const add = el('button', {type: 'button', className: 'new-profile'}, el('b', {textContent: '+ New profile'}), el('small', {textContent: 'Pick your skills'}));
  add.onclick = () => openBuilder(blank(), true);
  box.append(add);
  const p = activeProfile();
  $('profile-actions').hidden = !p || active === 'all';
  if (p && active !== 'all') {
    $('pa-name').textContent = p.name;
    $('pa-edit').textContent = p.preset ? 'Copy and edit' : p.key === 'shared' ? 'Save as mine' : 'Edit';
    $('pa-delete').hidden = !!p.preset || p.key === 'shared';
  }
}

// ---------- builder ----------
function openBuilder(p, isNew) {
  editing = {...p, skills: [...p.skills], based: [...(p.based || [])], kinds: [...(p.kinds || [])], exclude: [...(p.exclude || [])], isNew};
  $('builder').hidden = false; $('b-name').value = editing.name; $('b-search').value = '';
  drawBuilder(); $('builder').scrollIntoView({behavior: 'smooth', block: 'start'}); $('b-name').focus();
}
function drawBuilder() {
  const e = editing; if (!e) return;
  const q = $('b-search').value.trim().toLowerCase();
  const box = $('b-tree'); box.replaceChildren();
  for (const f of tree.families) {
    const skills = f.skills.filter(s => !q || (s.name + ' ' + f.name + ' ' + s.keywords.join(' ')).toLowerCase().includes(q));
    if (!skills.length) continue;
    const ticked = f.skills.filter(s => e.skills.includes(s.id)).length;
    const det = el('details', {className: 'fam', open: !!q || ticked > 0}, el('summary', {}, el('b', {textContent: f.name}), ticked ? el('span', {className: 'count', textContent: ticked}) : null));
    for (const s of skills) {
      const cb = el('input', {type: 'checkbox', checked: e.skills.includes(s.id)});
      cb.onchange = () => { e.skills = cb.checked ? [...e.skills, s.id] : e.skills.filter(x => x !== s.id); drawBuilder(); };
      det.append(el('label', {className: 'skill', title: s.keywords.join(', ')}, cb, s.name));
    }
    box.append(det);
  }
  document.querySelectorAll('[name=b-breadth]').forEach(r => r.checked = Number(r.value) === e.breadth);
  $('b-breadth-help').textContent = ['Only calls that mention the exact skills you ticked.', 'Also calls for the wider field, e.g. “visual arts” when you ticked photobooks.', 'Also neighbouring fields and calls open to all disciplines.'][e.breadth];
  const based = $('b-based'); based.replaceChildren(...Object.entries(BASED).map(([k, label]) => { const cb = el('input', {type: 'checkbox', checked: e.based.includes(k)}); cb.onchange = () => { e.based = cb.checked ? [...e.based, k] : e.based.filter(x => x !== k); preview(); }; return el('label', {className: 'opt'}, cb, label); }));
  document.querySelectorAll('[name=b-as]').forEach(r => r.checked = r.value === e.as);
  document.querySelectorAll('[name=b-stage]').forEach(r => r.checked = r.value === e.stage);
  const kb = $('b-kinds'); kb.replaceChildren(...Object.entries(KIND_LABEL).filter(([k]) => k !== 'other').map(([k, label]) => { const b = el('button', {type: 'button', className: 'chip', textContent: label}); b.setAttribute('aria-pressed', String(e.kinds.includes(k))); b.onclick = () => { e.kinds = e.kinds.includes(k) ? e.kinds.filter(x => x !== k) : [...e.kinds, k]; drawBuilder(); }; return b; }));
  $('b-free').checked = !!e.free_only;
  $('b-exclude').value = e.exclude.join(', ');
  $('b-picked').textContent = e.skills.length ? e.skills.map(id => idx.leaves.get(id)?.name).filter(Boolean).join(' · ') : 'Nothing ticked yet.';
  preview();
}
function preview() {
  if (!editing) return;
  const n = data.items.filter(i => i.present !== false && i.status !== 'closed' && match(i, editing, idx).score >= Number($('min').value)).length;
  $('b-preview').textContent = editing.skills.length ? `${n} open lead${n === 1 ? '' : 's'} would match at your current minimum (${$('min').value})` : 'Tick a few skills to see matches.';
}
function saveBuilder() {
  const e = editing; if (!e) return;
  e.name = $('b-name').value.trim() || 'My profile';
  e.exclude = $('b-exclude').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!e.skills.length) return status('Tick at least one skill first.', true);
  const {isNew, key, preset, ...clean} = e;
  if (isNew || preset || key === 'shared') { clean.id = Date.now().toString(36); mine.push(clean); }
  else mine = mine.map(m => m.id === clean.id ? clean : m);
  if (key === 'shared') { shared = null; history.replaceState(null, '', location.pathname); }
  write(K.mine, mine); editing = null; $('builder').hidden = true;
  setActive('mine:' + clean.id); status(`Saved “${clean.name}” on this device.`);
}

// ---------- state & sync ----------
function save() { state.updatedAt = Date.now(); write(K.state, state); if (db) { clearTimeout(syncTimer); syncTimer = setTimeout(() => push().catch(e => status(e.message, true)), 1200); } }
function mergeStates(a, b) {
  const out = {pipeline: {...a.pipeline}, hidden: {...a.hidden, ...b.hidden}, profiles: a.profiles, updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0)};
  for (const [id, p] of Object.entries(b.pipeline || {})) if (!out.pipeline[id] || (p.updatedAt || 0) > (out.pipeline[id].updatedAt || 0)) out.pipeline[id] = p;
  return out;
}
async function pull() {
  let remote = null;
  try { remote = JSON.parse(await db.download('/opportunities/pipeline.json')); } catch (e) { if (e.status && e.status !== 409) throw e; }
  if (remote) {
    state = mergeStates(state, remote); write(K.state, state);
    if (Array.isArray(remote.profiles)) { const ids = new Set(mine.map(m => m.id)); mine = [...mine, ...remote.profiles.filter(p => !ids.has(p.id))]; write(K.mine, mine); }
  }
}
async function push() { await db.upload('/opportunities/pipeline.json', JSON.stringify({...state, profiles: mine, v: 2}, null, 1)); status('Saved to Dropbox.'); }
async function connect() {
  const key = $('app-key').value.trim() || read(K.key, '') || read('cookbook.appKey', '');
  if (!/^[A-Za-z0-9_-]{5,100}$/.test(key)) { $('sync-setup').open = true; $('app-key').focus(); throw Error('Add your Dropbox app key first.'); }
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
}
function disconnect() {
  const access = db?.session?.access_token; db?.close(); db = null; session = null; localStorage.removeItem(K.auth);
  if (access) fetch('https://api.dropboxapi.com/2/auth/token/revoke', {method: 'POST', headers: {Authorization: 'Bearer ' + access}, referrerPolicy: 'no-referrer'}).catch(() => {});
  drawSync(); status('Dropbox disconnected. Everything stays in this browser.');
}
function drawSync() { $('sync-on').hidden = !db; $('sync-off').hidden = !!db; $('callback').textContent = callbackURL(location.href); $('app-key').value = read(K.key, '') || read('cookbook.appKey', ''); }

// ---------- leads ----------
function filtered() {
  const p = activeProfile(), q = $('q').value.trim().toLowerCase(), region = $('region').value, when = $('when').value, min = Number($('min').value), sort = $('sort').value;
  const onlyNew = $('only-new').checked, free = $('free').checked;
  let list = data.items.filter(i => i.present !== false && i.status !== 'closed' && !state.hidden[i.id]);
  if (q) list = list.filter(i => [i.title, i.summary, i.source, i.programme].join(' ').toLowerCase().includes(q));
  if (kinds.size) list = list.filter(i => (i.kinds || []).some(k => kinds.has(k)));
  if (region) list = list.filter(i => i.region === region);
  if (free) list = list.filter(i => i.fee !== true);
  if (onlyNew && lastVisit) list = list.filter(i => i.first_seen > lastVisit);
  if (when) list = list.filter(i => { const d = daysLeft(i, today); return when === 'rolling' ? i.status === 'rolling' : when === 'dated' ? d != null : d != null && d >= 0 && d <= Number(when); });
  const usep = active !== 'all' && p;
  const scored = list.map(i => ({i, m: usep ? match(i, p, idx) : null})).filter(x => !x.m || x.m.score >= min);
  const dl = x => daysLeft(x.i, today) ?? 9999;
  scored.sort(sort === 'soon' ? (a, b) => dl(a) - dl(b) : sort === 'new' ? (a, b) => b.i.first_seen.localeCompare(a.i.first_seen) : (a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0) || dl(a) - dl(b));
  return scored;
}
function deadlineBadge(i) {
  const d = daysLeft(i, today);
  if (d == null) return el('span', {className: 'dl muted', textContent: i.status === 'rolling' ? 'Rolling' : 'No date found'});
  const cls = d < 0 ? 'past' : d <= 14 ? 'urgent' : d <= 45 ? 'soon' : 'ok';
  return el('span', {className: 'dl ' + cls, title: i.deadline_text || ''}, el('b', {textContent: fmtDate(i.deadline)}), el('small', {textContent: d < 0 ? 'passed' : d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'}`}));
}
function row({i, m}) {
  const inPipe = state.pipeline[i.id] && !state.pipeline[i.id].deleted;
  const tags = [i.fee === true ? 'entry fee' : null, i.applicants === 'organisations' ? 'organisations' : i.applicants === 'individuals' ? 'individuals' : null, i.early_career ? 'early-career' : null].filter(Boolean);
  const meta = [i.source, REGION_LABEL[i.region] || i.region, (i.kinds || []).map(k => KIND_LABEL[k] || k).join(', '), money(i.amount), ...tags].filter(Boolean).join(' · ');
  const isNew = lastVisit && i.first_seen > lastVisit;
  const star = el('button', {type: 'button', className: 'icon' + (inPipe ? ' on' : ''), title: inPipe ? 'In your pipeline' : 'Add to pipeline', textContent: inPipe ? '★' : '☆'});
  star.setAttribute('aria-label', star.title);
  star.onclick = () => { if (!inPipe) addToPipeline(i); else { view = 'pipeline'; draw(); } };
  const hide = el('button', {type: 'button', className: 'icon', title: 'Hide this lead', textContent: '×'}); hide.setAttribute('aria-label', 'Hide this lead');
  hide.onclick = () => { state.hidden[i.id] = Date.now(); save(); draw(); status('Hidden. Undo it under Sources → Hidden leads.'); };
  const cal = i.deadline ? el('button', {type: 'button', className: 'icon', title: 'Add deadline to calendar', textContent: '⧗'}) : null;
  if (cal) { cal.setAttribute('aria-label', cal.title); cal.onclick = () => download(ics([i]), slugify(i.title) + '.ics', 'text/calendar'); }
  const details = el('details', {}, el('summary', {textContent: 'Details'}),
    i.summary ? el('p', {textContent: i.summary}) : null,
    i.deadline_text ? el('p', {className: 'small', textContent: 'Deadline found in: “' + i.deadline_text + '”'}) : null,
    i.amount?.text ? el('p', {className: 'small', textContent: 'Amount found in: “' + i.amount.text + '”'}) : null,
    ...(i.also_on || []).map(a => el('p', {className: 'small'}, 'Also on ', el('a', {href: a.url, target: '_blank', rel: 'noopener', textContent: a.source}))),
    el('p', {className: 'small', textContent: `First seen ${fmtDate(i.first_seen.slice(0, 10))}. Found automatically: check eligibility, fees and rights on the funder's page.`}));
  return el('li', {className: 'lead'},
    el('div', {className: 'main'},
      el('a', {className: 'title', href: i.url, target: '_blank', rel: 'noopener', textContent: i.title}), isNew ? el('span', {className: 'new', textContent: 'New'}) : null,
      el('div', {className: 'meta', textContent: meta}),
      m && m.reasons.length ? el('div', {className: 'why', textContent: 'Why: ' + m.reasons.slice(0, 4).join(', ')}) : null, details),
    el('div', {className: 'side'}, deadlineBadge(i), m ? el('div', {className: 'match', title: 'Match with this profile'}, el('span', {style: `width:${m.score}%`}), el('small', {textContent: m.score})) : null,
      el('div', {className: 'acts'}, star, cal, hide)));
}
function drawLeads() {
  const list = filtered(), p = activeProfile();
  $('count').textContent = `${list.length} lead${list.length === 1 ? '' : 's'}` + (active !== 'all' && p ? ` for “${p.name}”` : '');
  $('leads').replaceChildren(...list.slice(0, limit).map(row));
  $('more').hidden = list.length <= limit;
  $('none').hidden = list.length > 0;
  $('min-wrap').hidden = active === 'all';
}

// ---------- pipeline ----------
function addToPipeline(i, stage = 'shortlist') {
  state.pipeline[i.id] = {id: i.id, stage, notes: '', item: {id: i.id, title: i.title, url: i.url, source: i.source, region: i.region, kinds: i.kinds, deadline: i.deadline || null, amount: i.amount || null, summary: i.summary || ''}, addedAt: Date.now(), updatedAt: Date.now()};
  save(); draw(); status(`Added to your shortlist: ${i.title}`);
}
function card(p) {
  const i = p.item;
  const stage = el('select', {}, ...STAGES.map(([v, l]) => el('option', {value: v, textContent: l, selected: p.stage === v}))); stage.setAttribute('aria-label', 'Stage');
  stage.onchange = () => { p.stage = stage.value; p.updatedAt = Date.now(); save(); draw(); };
  const result = el('select', {hidden: p.stage !== 'result'}, ...[['', 'Waiting'], ['won', 'Won'], ['declined', 'Not this time'], ['withdrawn', 'Withdrawn']].map(([v, l]) => el('option', {value: v, textContent: l, selected: (p.result || '') === v}))); result.setAttribute('aria-label', 'Result');
  result.onchange = () => { p.result = result.value; p.updatedAt = Date.now(); save(); };
  const notes = el('textarea', {value: p.notes || '', placeholder: 'Notes: requirements, partners, what to send…', rows: 3});
  notes.onchange = () => { p.notes = notes.value; p.updatedAt = Date.now(); save(); };
  const dl = el('input', {type: 'date', value: i.deadline || ''}); dl.setAttribute('aria-label', 'Deadline');
  dl.onchange = () => { i.deadline = dl.value || null; p.updatedAt = Date.now(); save(); draw(); };
  const del = el('button', {type: 'button', className: 'link', textContent: 'Remove'});
  del.onclick = () => { if (confirm(`Remove “${i.title}” from your pipeline?`)) { state.pipeline[p.id] = {id: p.id, deleted: true, updatedAt: Date.now()}; save(); draw(); } };
  return el('li', {className: 'card' + (p.result ? ' r-' + p.result : '')},
    i.url ? el('a', {className: 'title', href: i.url, target: '_blank', rel: 'noopener', textContent: i.title}) : el('span', {className: 'title', textContent: i.title}),
    el('div', {className: 'meta', textContent: [i.source, money(i.amount)].filter(Boolean).join(' · ')}),
    el('div', {className: 'row'}, deadlineBadge(i), dl), el('div', {className: 'row'}, stage, result), notes, el('div', {className: 'row end'}, del));
}
function drawPipeline() {
  const items = Object.values(state.pipeline).filter(p => p && !p.deleted && p.item);
  const box = $('columns'); box.replaceChildren();
  for (const [stage, label] of STAGES) {
    const rank = p => { const d = daysLeft(p.item, today); return d == null ? 1e6 : d < 0 ? 2e6 - d : d; };
    const list = items.filter(p => p.stage === stage).sort((a, b) => rank(a) - rank(b));
    box.append(el('section', {className: 'col'}, el('h3', {}, label, el('small', {textContent: list.length})), el('ol', {}, ...list.map(card))));
  }
  $('pipe-empty').hidden = items.length > 0;
}
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
  if (known) { addToPipeline(known); $('add-url').value = ''; return; }
  let found = {};
  if (db && !title) {
    status('Dropbox is fetching the page…');
    const path = `/opportunities/inbox/${Date.now()}.html`;
    try { await db.saveUrl(path, url); found = readCall(await db.download(path)); } catch (e) { status(e.message + ' Add a title by hand instead.', true); } finally { db.remove(path).catch(() => {}); }
  }
  const t = title || found.title;
  if (!t) { $('add-title').focus(); throw Error('Add a title for this call (or connect Dropbox so the page can be read for you).'); }
  const id = 'own-' + Date.now().toString(36);
  state.pipeline[id] = {id, stage: 'shortlist', notes: '', item: {id, title: t, url, source: new URL(url).hostname.replace(/^www\./, ''), deadline: $('add-deadline').value || found.deadline || null, amount: null, summary: found.summary || ''}, addedAt: Date.now(), updatedAt: Date.now()};
  save(); $('add-url').value = ''; $('add-title').value = ''; $('add-deadline').value = '';
  view = 'pipeline'; draw(); status(`Added “${t}” to your shortlist${found.deadline ? ' with its deadline' : ''}.`);
}
function importBackup(file) {
  file.text().then(t => {
    const got = JSON.parse(t);
    if (!got || typeof got.pipeline !== 'object') throw Error('That file is not an Opportunities backup.');
    state = mergeStates(state, got);
    if (Array.isArray(got.profiles)) { const ids = new Set(mine.map(m => m.id)); mine = [...mine, ...got.profiles.filter(p => !ids.has(p.id))]; write(K.mine, mine); }
    save(); view = 'pipeline'; draw(); status(`Imported ${Object.keys(got.pipeline).length} pipeline items.`);
  }).catch(e => status(e.message, true));
}

// ---------- sources ----------
function drawSources() {
  const ok = data.sources.filter(s => s.status === 'ok').length;
  $('src-summary').textContent = `${ok} of ${data.sources.length} checked automatically answered on the last run · ${manual.length} to check by hand`;
  $('src-list').replaceChildren(...data.sources.map(s => el('li', {className: s.status}, el('a', {href: s.url, target: '_blank', rel: 'noopener', textContent: s.name}), el('span', {textContent: s.status === 'ok' ? `${s.listings} listed${s.new ? ` · ${s.new} new` : ''}` : `not answering (${s.error})`}))));
  $('manual-list').replaceChildren(...manual.map(s => el('li', {}, el('a', {href: s.url, target: '_blank', rel: 'noopener', textContent: s.name}), el('span', {textContent: s.why || ''}))));
  const hidden = Object.keys(state.hidden).map(id => data.items.find(i => i.id === id)).filter(Boolean);
  $('hidden-count').textContent = hidden.length;
  $('hidden-list').replaceChildren(...hidden.map(i => { const b = el('button', {type: 'button', className: 'link', textContent: 'Show again'}); b.onclick = () => { delete state.hidden[i.id]; save(); draw(); }; return el('li', {}, el('span', {textContent: i.title}), b); }));
}

function draw() {
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  document.body.classList.toggle('compact', view !== 'leads');
  for (const v of ['leads', 'pipeline', 'sources']) $('v-' + v).hidden = v !== view;
  const n = Object.values(state.pipeline).filter(p => p && !p.deleted).length;
  $('pipe-count').textContent = n ? ` (${n})` : '';
  if (view === 'leads') { drawProfiles(); drawLeads(); }
  if (view === 'pipeline') drawPipeline();
  if (view === 'sources') drawSources();
}

function wire() {
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { view = b.dataset.view; draw(); });
  for (const id of ['q', 'region', 'when', 'sort', 'only-new', 'free']) $(id).addEventListener('input', () => { limit = 60; drawLeads(); });
  $('min').addEventListener('input', () => { $('min-out').textContent = $('min').value; limit = 60; drawLeads(); });
  const kbox = $('kinds');
  for (const [k, label] of Object.entries(KIND_LABEL)) {
    if (k === 'other') continue;
    const b = el('button', {type: 'button', className: 'chip', textContent: label}); b.setAttribute('aria-pressed', 'false');
    b.onclick = () => { kinds.has(k) ? kinds.delete(k) : kinds.add(k); b.setAttribute('aria-pressed', String(kinds.has(k))); limit = 60; drawLeads(); };
    kbox.append(b);
  }
  $('more').onclick = () => { limit += 60; drawLeads(); };
  // profile actions
  $('pa-edit').onclick = () => { const p = activeProfile(); if (p) openBuilder(p, !!p.preset); };
  $('pa-share').onclick = () => { const p = activeProfile(); if (p) copy(location.origin + location.pathname + '#p=' + encodeProfile(p), 'Link copied. Anyone who opens it sees the leads through this profile.'); };
  $('pa-email').onclick = () => { const p = activeProfile(); if (!p) return; const {key, preset, id, ...prof} = p; copy(JSON.stringify({name: p.name, email: 'you@example.com', profile: prof}), 'Copied. Change the email, then paste it into the DIGEST_PEOPLE list (see the guide).'); };
  $('pa-delete').onclick = () => { const p = activeProfile(); if (p && !p.preset && confirm(`Delete the profile “${p.name}” from this device?`)) { mine = mine.filter(m => 'mine:' + m.id !== p.key); write(K.mine, mine); setActive('preset:' + (presets[0]?.id || '')); } };
  // builder
  $('b-search').oninput = drawBuilder;
  document.querySelectorAll('[name=b-breadth]').forEach(r => r.onchange = () => { editing.breadth = Number(r.value); drawBuilder(); });
  document.querySelectorAll('[name=b-as]').forEach(r => r.onchange = () => { editing.as = r.value; preview(); });
  document.querySelectorAll('[name=b-stage]').forEach(r => r.onchange = () => { editing.stage = r.value; preview(); });
  $('b-free').onchange = () => { editing.free_only = $('b-free').checked; preview(); };
  $('b-save').onclick = saveBuilder;
  $('b-cancel').onclick = () => { editing = null; $('builder').hidden = true; };
  // pipeline & sync
  $('add-go').onclick = () => addByLink().catch(e => status(e.message, true));
  $('ics-all').onclick = () => { const items = Object.values(state.pipeline).filter(p => p && !p.deleted && p.item?.deadline && p.stage !== 'result').map(p => p.item); if (!items.length) return status('No pipeline deadlines yet.'); download(ics(items), 'opportunities-deadlines.ics', 'text/calendar'); };
  $('backup').onclick = () => download(JSON.stringify({...state, profiles: mine, v: 2}, null, 1), `opportunities-backup-${today.toISOString().slice(0, 10)}.json`, 'application/json');
  $('restore').onchange = e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; };
  $('connect').onclick = () => connect().catch(e => status(e.message, true));
  $('disconnect').onclick = disconnect;
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
  const m = /^#p=([\w-]+)$/.exec(location.hash);
  if (m) { try { shared = decodeProfile(m[1]); active = 'shared'; status(`You're seeing leads through “${shared.name}”. Save it as yours to keep it.`); } catch (e) { status(e.message, true); } }
  const open = data.items.filter(i => i.present !== false && i.status !== 'closed').length;
  $('checked').textContent = data.checked_at ? `Checked ${ago(data.checked_at)} · ${open} open leads from ${data.sources_ok ?? '?'} sources` : '';
  const seen = read(K.visit, null);
  const marks = seen && typeof seen === 'object' ? seen : {previous: null, current: null};
  if (data.checked_at && marks.current !== data.checked_at) { marks.previous = marks.current; marks.current = data.checked_at; write(K.visit, marks); }
  lastVisit = marks.previous;
  if (lastVisit) $('only-new-label').textContent = `New since your last visit (${data.items.filter(i => i.first_seen > lastVisit && i.status !== 'closed').length})`;
  else $('only-new-wrap').hidden = true;
  wire(); drawSync(); draw();
  if (db) pull().then(() => { draw(); status('Synced with Dropbox.'); }).catch(e => status(e.message, true));
}

start();
