import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {match, index, regionPoints, daysLeft, money, ics, encodeProfile, decodeProfile} from '../assets/score.mjs';

const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const fx = read('./fixtures/opps-score.json');
const idx = index(read('../data/skills.json'));

test('page scores and reasons match the weekly email exactly', () => {
  for (const [pid, p] of Object.entries(fx.profiles)) for (const it of fx.items) assert.deepEqual(match(it, p, idx), fx.expected[pid][it.id], `${pid}/${it.id}`);
});

test('the same call ranks differently for different people', () => {
  const s = (pid, id) => fx.expected[pid][id].score;
  assert.ok(s('practice', 'a') > s('practice', 'b'));
  assert.ok(s('projects', 'b') > s('projects', 'a'));
  assert.ok(s('dancer', 'g') > s('practice', 'g'));
  assert.equal(s('dancer', 'd'), 0, 'free-to-enter only hides fee-charging calls');
  assert.ok(s('practice', 'a') > s('precise', 'a'), 'related breadth adds family matches');
});

test('regions: home funders up, other countries down', () => {
  assert.equal(regionPoints('UK', ['UK']), 12);
  assert.equal(regionPoints('IT-SI', ['SI']), 14);
  assert.equal(regionPoints('UK', ['IT-FVG']), -20);
  assert.equal(regionPoints('EU', ['UK']), 2);
  assert.equal(regionPoints('EU', ['SI']), 6);
  assert.equal(regionPoints('International', ['OTHER']), 5);
  assert.equal(regionPoints('UK', []), 0);
});

test('every skill in the presets exists in the tree', () => {
  const presets = read('../data/profiles.json').presets;
  for (const p of presets) for (const s of p.skills) assert.ok(idx.leaves.has(s), `${p.id}: ${s}`);
  for (const f of idx.families.values()) for (const r of f.related) assert.ok(idx.families.has(r), `${f.id} -> ${r}`);
});

test('profiles survive a share link, including accents', () => {
  const p = {...fx.profiles.dancer, name: 'Danza è vita – Rosamond'};
  const back = decodeProfile(encodeProfile(p));
  assert.deepEqual(back, {name: p.name, skills: p.skills, breadth: 2, based: ['UK'], as: 'individual', stage: 'emerging', kinds: [], free_only: true, exclude: []});
  assert.equal(decodeProfile(encodeProfile({...p, based: ['UK', 'MARS'], as: 'alien'})).as, 'both');
  assert.throws(() => decodeProfile('bm90IGpzb24'));
});

test('days left, money and calendar export', () => {
  assert.equal(daysLeft({deadline: '2026-12-01'}, new Date('2026-11-26T15:00:00Z')), 5);
  assert.equal(money({max: 200000, currency: 'EUR'}), '€200k');
  assert.equal(money({max: 2500000, currency: 'GBP'}), '£2.5m');
  const cal = ics([{id: 'x1', title: 'Grant; with, commas', deadline: '2026-12-31', url: 'https://s/x'}, {id: 'none', title: 'no date'}], new Date('2026-11-26T10:00:00Z'));
  assert.match(cal, /DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101/);
  assert.ok(cal.includes('SUMMARY:Deadline: Grant\\; with\\, commas'));
  assert.equal((cal.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.doesNotMatch(cal, /Enrico|Policardo/);
});
