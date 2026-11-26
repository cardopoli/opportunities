// Match scores for Opportunities. Same rules as scripts/scoring.py (kept in step by
// tests/fixtures/opps-score.json). 0-100, no AI: ticked skills (precise / related / broad), where you
// are based, who can apply, career stage, the types you want, entry fees, known deadline/amount.

export const DEFAULT_EXCLUDE = ['clinical', 'medical', 'oncolog', 'military', 'defence', 'nuclear', 'semiconductor', 'hydrogen', 'phd scholarship'];
export const BASED = {UK: 'United Kingdom', IE: 'Ireland', IT: 'Italy', 'IT-FVG': 'Friuli Venezia Giulia', SI: 'Slovenia', EU: 'Elsewhere in the EU', OTHER: 'Outside Europe'};
const NEAR = {
  UK: {UK: 12, IE: 4}, IE: {IE: 12, UK: 4}, IT: {IT: 10, 'IT-FVG': 8, 'IT-SI': 8},
  'IT-FVG': {'IT-FVG': 14, 'IT-SI': 14, IT: 8}, SI: {SI: 12, 'IT-SI': 14}, EU: {}, OTHER: {},
};
const IN_EU = new Set(['IT', 'IT-FVG', 'SI', 'IE', 'EU']);

export function haystack(item) {
  return ' ' + [item.title, item.summary, item.source, item.programme, (item.kinds || []).join(' ')].filter(Boolean).join(' ').toLowerCase() + ' ';
}

const hit = (text, words) => (words || []).find(w => w && text.includes(String(w).toLowerCase())) || null;

export function index(tree) {
  const leaves = new Map(), families = new Map();
  for (const f of tree?.families || []) {
    families.set(f.id, f);
    for (const s of f.skills) leaves.set(s.id, {...s, family: f.id});
  }
  return {leaves, families, open: tree?.open || []};
}

export function regionPoints(region, based) {
  if (!based || !based.length || !region) return 0;
  if (region === 'International') return 5;
  if (region === 'EU') return based.some(b => IN_EU.has(b)) ? 6 : 2;
  const near = Math.max(...based.map(b => NEAR[b]?.[region] ?? -Infinity));
  return Number.isFinite(near) ? near : -20; // a national or regional funder where you are not based
}

export function match(item, profile, idx) {
  const out = {score: 0, reasons: []};
  if (!profile || item.status === 'closed') return out;
  if (profile.free_only && item.fee === true) return out;
  const text = haystack(item);
  if (hit(text, [...DEFAULT_EXCLUDE, ...(profile.exclude || [])])) return out;
  const sel = (profile.skills || []).map(id => idx.leaves.get(id)).filter(Boolean);
  const breadth = profile.breadth ?? 1;
  let s = 0, matched = false;
  const leafHits = sel.filter(l => hit(text, l.keywords));
  s += Math.min(leafHits.length, 3) * 22;
  out.reasons.push(...leafHits.slice(0, 3).map(l => l.name));
  if (leafHits.length) matched = true;
  const fams = [...new Set(sel.map(l => l.family))];
  if (breadth >= 1) {
    const famHits = fams.filter(f => !leafHits.some(l => l.family === f) && hit(text, idx.families.get(f)?.keywords));
    s += Math.min(famHits.length, 2) * 10;
    if (famHits.length) { matched = true; out.reasons.push(...famHits.slice(0, 2).map(f => idx.families.get(f).name)); }
  }
  if (breadth >= 2) {
    const related = [...new Set(fams.flatMap(f => idx.families.get(f)?.related || []))].filter(f => !fams.includes(f));
    const relHits = related.filter(f => { const fam = idx.families.get(f); return fam && (hit(text, fam.keywords) || fam.skills.some(x => hit(text, x.keywords))); });
    s += Math.min(relHits.length, 2) * 6;
    if (relHits.length) { matched = true; out.reasons.push(...relHits.slice(0, 2).map(f => idx.families.get(f).name)); }
    if (hit(text, idx.open)) { s += 12; matched = true; out.reasons.push('open to all disciplines'); }
  }
  const kinds = profile.kinds || [];
  if (kinds.length) s += (item.kinds || []).some(k => kinds.includes(k)) ? 10 : -10;
  const rp = regionPoints(item.region, profile.based);
  s += rp;
  if (rp > 6) out.reasons.push('near you');
  if (rp < 0) out.reasons.push('may need you based elsewhere');
  if (profile.as === 'individual' && item.applicants === 'organisations') { s -= 25; out.reasons.push('for organisations'); }
  if (profile.as === 'organisation' && item.applicants === 'individuals') { s -= 15; out.reasons.push('for individuals'); }
  if (profile.stage === 'established' && item.early_career) { s -= 15; out.reasons.push('early-career only'); }
  if (item.fee === false) out.reasons.push('free to enter');
  if (item.deadline) s += 5;
  if (item.amount) s += 3;
  if (sel.length && !matched) s = Math.min(s, 15);
  out.score = Math.max(0, Math.min(100, Math.round(s)));
  return out;
}

export const score = (item, profile, idx) => match(item, profile, idx).score;

export function daysLeft(item, today = new Date()) {
  if (!item.deadline) return null;
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const [y, m, d] = item.deadline.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - t) / 864e5);
}

export function money(a) {
  if (!a || !a.max) return '';
  const sym = {EUR: '€', GBP: '£', USD: '$'}[a.currency] || a.currency + ' ';
  const v = a.max >= 1e6 ? (a.max / 1e6).toFixed(a.max % 1e6 ? 1 : 0) + 'm' : a.max >= 1e4 ? Math.round(a.max / 1e3) + 'k' : a.max.toLocaleString('en-GB');
  return sym + v;
}

// Profiles travel in links as base64url JSON (#p=...).
export function encodeProfile(p) {
  const json = JSON.stringify({name: p.name, skills: p.skills, breadth: p.breadth, based: p.based, as: p.as, stage: p.stage, kinds: p.kinds, free_only: !!p.free_only, exclude: p.exclude || []});
  return btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeProfile(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0))));
  if (!p || !Array.isArray(p.skills)) throw Error('That profile link is damaged.');
  return {name: String(p.name || 'Shared profile').slice(0, 60), skills: p.skills.map(String).slice(0, 60), breadth: [0, 1, 2].includes(p.breadth) ? p.breadth : 1,
    based: (p.based || []).filter(b => b in BASED), as: ['individual', 'organisation', 'both'].includes(p.as) ? p.as : 'both',
    stage: ['any', 'emerging', 'established'].includes(p.stage) ? p.stage : 'any', kinds: (p.kinds || []).map(String).slice(0, 10), free_only: !!p.free_only, exclude: (p.exclude || []).map(String).slice(0, 30)};
}

// Calendar file for one or more deadlines (all-day events, reminder a week before).
export function ics(items, now = new Date()) {
  const esc = s => String(s || '').replace(/[\\;,]/g, m => '\\' + m).replace(/\r?\n/g, '\\n');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Opportunities//EN', 'CALSCALE:GREGORIAN'];
  for (const it of items.filter(i => i.deadline)) {
    const d = it.deadline.replace(/-/g, '');
    const next = new Date(Date.UTC(...it.deadline.split('-').map((n, i) => i === 1 ? n - 1 : +n)) + 864e5).toISOString().slice(0, 10).replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:${it.id}@opportunities`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${esc('Deadline: ' + it.title)}`, `DESCRIPTION:${esc([it.source, it.url].filter(Boolean).join('\n'))}`, it.url ? `URL:${it.url}` : '',
      'BEGIN:VALARM', 'TRIGGER:-P7D', 'ACTION:DISPLAY', `DESCRIPTION:${esc('One week left: ' + it.title)}`, 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).join('\r\n') + '\r\n';
}
