"""Match scores for Opportunities. Same rules as assets/score.mjs (kept in step by
tests/fixtures/opps-score.json). 0-100, no AI."""
from __future__ import annotations

import json
from pathlib import Path

DEFAULT_EXCLUDE = ['clinical', 'medical', 'oncolog', 'military', 'defence', 'nuclear', 'semiconductor', 'hydrogen', 'phd scholarship']
NEAR = {
    'UK': {'UK': 12, 'IE': 4}, 'IE': {'IE': 12, 'UK': 4}, 'IT': {'IT': 10, 'IT-FVG': 8, 'IT-SI': 8},
    'IT-FVG': {'IT-FVG': 14, 'IT-SI': 14, 'IT': 8}, 'SI': {'SI': 12, 'IT-SI': 14}, 'EU': {}, 'OTHER': {},
}
IN_EU = {'IT', 'IT-FVG', 'SI', 'IE', 'EU'}


def haystack(item: dict) -> str:
    parts = [item.get('title'), item.get('summary'), item.get('source'), item.get('programme'), ' '.join(item.get('kinds') or [])]
    return ' ' + ' '.join(str(p) for p in parts if p).lower() + ' '


def hit(text: str, words) -> bool:
    return any(w and str(w).lower() in text for w in words or [])


class Index:
    def __init__(self, tree: dict):
        self.leaves, self.families = {}, {}
        for f in tree.get('families', []):
            self.families[f['id']] = f
            for s in f['skills']:
                self.leaves[s['id']] = dict(s, family=f['id'])
        self.open = tree.get('open', [])


def load_index(root: Path) -> Index:
    return Index(json.loads((root / 'data/skills.json').read_text()))


def region_points(region, based) -> int:
    if not based or not region:
        return 0
    if region == 'International':
        return 5
    if region == 'EU':
        return 6 if any(b in IN_EU for b in based) else 2
    near = [NEAR.get(b, {}).get(region) for b in based]
    near = [n for n in near if n is not None]
    return max(near) if near else -20


def match(item: dict, profile: dict, idx: Index) -> dict:
    out = {'score': 0, 'reasons': []}
    if not profile or item.get('status') == 'closed':
        return out
    if profile.get('free_only') and item.get('fee') is True:
        return out
    text = haystack(item)
    if hit(text, DEFAULT_EXCLUDE + list(profile.get('exclude') or [])):
        return out
    sel = [idx.leaves[i] for i in profile.get('skills') or [] if i in idx.leaves]
    breadth = profile.get('breadth', 1)
    breadth = 1 if breadth is None else breadth
    s, matched = 0, False
    leaf_hits = [l for l in sel if hit(text, l['keywords'])]
    s += min(len(leaf_hits), 3) * 22
    out['reasons'] += [l['name'] for l in leaf_hits[:3]]
    if leaf_hits:
        matched = True
    fams = list(dict.fromkeys(l['family'] for l in sel))
    if breadth >= 1:
        fam_hits = [f for f in fams if not any(l['family'] == f for l in leaf_hits) and hit(text, idx.families.get(f, {}).get('keywords'))]
        s += min(len(fam_hits), 2) * 10
        if fam_hits:
            matched = True
            out['reasons'] += [idx.families[f]['name'] for f in fam_hits[:2]]
    if breadth >= 2:
        related = [f for f in dict.fromkeys(r for f in fams for r in idx.families.get(f, {}).get('related', [])) if f not in fams]
        rel_hits = [f for f in related if f in idx.families and (hit(text, idx.families[f]['keywords']) or any(hit(text, x['keywords']) for x in idx.families[f]['skills']))]
        s += min(len(rel_hits), 2) * 6
        if rel_hits:
            matched = True
            out['reasons'] += [idx.families[f]['name'] for f in rel_hits[:2]]
        if hit(text, idx.open):
            s += 12; matched = True
            out['reasons'].append('open to all disciplines')
    kinds = profile.get('kinds') or []
    if kinds:
        s += 10 if any(k in kinds for k in item.get('kinds') or []) else -10
    rp = region_points(item.get('region'), profile.get('based'))
    s += rp
    if rp > 6:
        out['reasons'].append('near you')
    if rp < 0:
        out['reasons'].append('may need you based elsewhere')
    if profile.get('as') == 'individual' and item.get('applicants') == 'organisations':
        s -= 25; out['reasons'].append('for organisations')
    if profile.get('as') == 'organisation' and item.get('applicants') == 'individuals':
        s -= 15; out['reasons'].append('for individuals')
    if profile.get('stage') == 'established' and item.get('early_career'):
        s -= 15; out['reasons'].append('early-career only')
    if item.get('fee') is False:
        out['reasons'].append('free to enter')
    if item.get('deadline'):
        s += 5
    if item.get('amount'):
        s += 3
    if sel and not matched:
        s = min(s, 15)
    out['score'] = max(0, min(100, int(s)))
    return out


def score(item: dict, profile: dict, idx: Index) -> int:
    return match(item, profile, idx)['score']
