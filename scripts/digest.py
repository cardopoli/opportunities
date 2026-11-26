"""Weekly Opportunities emails: one per person, matched to their own profile.

Secrets (repository → Settings → Secrets and variables → Actions):
  DIGEST_GMAIL_USER          Gmail address that sends
  DIGEST_GMAIL_APP_PASSWORD  Gmail app password (needs 2-Step Verification)
  DIGEST_PEOPLE              JSON list: [{"name": "Rosamond", "email": "...", "profile": {...}}, ...]
                             "profile" can be a profile object (use "Copy for weekly email" on the page)
                             or "preset:practice" / "preset:projects".
  DIGEST_TO                  your address. With the two Dropbox secrets below it gets ONE email built from
                             your own answers and Saved list on the page; without them, one per example profile.
  DROPBOX_APP_KEY            the Dropbox app key you use on the page
  DROPBOX_REFRESH_TOKEN      from the page: Saved → Calendar, backup and syncing → "Copy key 2"
Without the Gmail secrets it prints each email and sends nothing.
"""
from __future__ import annotations

import base64
import datetime as dt
import html
import json
import os
import smtplib
import sys
import urllib.parse
import urllib.request
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scoring import load_index, match  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data/opportunities.json'
PROFILES = ROOT / 'data/profiles.json'
PAGE = os.environ.get('OPPORTUNITIES_PAGE', 'https://cardopoli.github.io/opportunities/')
NEW_DAYS, SOON_DAYS = 7, 30
NEW_MIN, SOON_MIN = 35, 45
PER_SECTION = 12


def days_left(item: dict, today: dt.date):
    return (dt.date.fromisoformat(item['deadline']) - today).days if item.get('deadline') else None


def money(a) -> str:
    if not a or not a.get('max'):
        return ''
    sym = {'EUR': '€', 'GBP': '£', 'USD': '$'}.get(a.get('currency'), (a.get('currency') or '') + ' ')
    v = a['max']
    return sym + (f'{v / 1e6:.1f}m'.replace('.0m', 'm') if v >= 1e6 else f'{round(v / 1e3)}k' if v >= 1e4 else f'{v:,}')


def when(item: dict, today: dt.date) -> str:
    d = days_left(item, today)
    if d is None:
        return 'rolling' if item.get('status') == 'rolling' else 'deadline not found'
    day = dt.date.fromisoformat(item['deadline']).strftime('%-d %b')
    return f'closes {day} (today)' if d == 0 else f'closes {day} (tomorrow)' if d == 1 else f'closes {day} ({d} days)'


def share_link(profile: dict) -> str:
    keys = ('name', 'skills', 'breadth', 'based', 'as', 'stage', 'kinds', 'free_only', 'exclude')
    raw = json.dumps({k: profile.get(k) for k in keys}, separators=(',', ':'), ensure_ascii=False).encode()
    return PAGE + '#p=' + base64.urlsafe_b64encode(raw).decode().rstrip('=')


def dropbox_state() -> dict | None:
    """Your answers and Saved list, as the page keeps them in your Dropbox app folder."""
    key, refresh = (''.join(os.environ.get(k, '').split()) for k in ('DROPBOX_APP_KEY', 'DROPBOX_REFRESH_TOKEN'))
    if not (key and refresh):
        return None
    try:
        form = urllib.parse.urlencode({'grant_type': 'refresh_token', 'refresh_token': refresh, 'client_id': key}).encode()
        with urllib.request.urlopen(urllib.request.Request('https://api.dropboxapi.com/oauth2/token', data=form), timeout=30) as r:
            token = json.load(r)['access_token']
        req = urllib.request.Request('https://content.dropboxapi.com/2/files/download', method='POST', headers={
            'Authorization': 'Bearer ' + token, 'Dropbox-API-Arg': json.dumps({'path': '/opportunities/pipeline.json'})})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except Exception as e:  # never let Dropbox stop the email: fall back to the example profiles
        print(f'Could not read your Dropbox ({e}). Using the example profiles this week.')
        return None


def saved_soon(state: dict | None, today: dt.date, days: int = 21) -> list[dict]:
    out = []
    for p in ((state or {}).get('pipeline') or {}).values():
        it = (p or {}).get('item') or {}
        if not p or p.get('deleted') or p.get('stage') == 'result' or not it.get('deadline'):
            continue
        left = days_left(it, today)
        if left is not None and 0 <= left <= days:
            out.append({**it, '_stage': p.get('stage')})
    return sorted(out, key=lambda i: i['deadline'])


def build(data: dict, profile: dict, idx, today: dt.date, state: dict | None = None) -> dict:
    items = [i for i in data.get('items', []) if i.get('present', True) and i.get('status') != 'closed']
    since = (today - dt.timedelta(days=NEW_DAYS)).isoformat()
    scored = [(match(i, profile, idx), i) for i in items]
    new = sorted([(m, i) for m, i in scored if m['score'] >= NEW_MIN and i.get('first_seen', '')[:10] >= since], key=lambda x: (-x[0]['score'], x[1].get('deadline') or '9999'))[:PER_SECTION]
    soon = sorted([(m, i) for m, i in scored if m['score'] >= SOON_MIN and days_left(i, today) is not None and 0 <= days_left(i, today) <= SOON_DAYS], key=lambda x: (x[1]['deadline'], -x[0]['score']))[:PER_SECTION]
    broken = [s for s in data.get('sources', []) if s.get('status') == 'error']
    saved = saved_soon(state, today)
    saved_ids = {i.get('id') for i in saved}
    soon = [(m, i) for m, i in soon if i.get('id') not in saved_ids]
    return {'profile': profile, 'new': new, 'soon': soon, 'saved': saved, 'broken': broken, 'total': len(items)}


def render(d: dict, today: dt.date, person: str = '') -> tuple[str, str, str]:
    p = d['profile']
    if p.get('id') == 'me':
        p = {**p, 'name': 'your answers on the page'}
    who = person or p.get('name', 'you')
    saved = d.get('saved') or []
    lead = f"{len(saved)} saved closing soon, " if saved else ''
    subject = f"Opportunities for {who} - {lead}{len(d['new'])} new, {len(d['soon'])} closing soon (w/c {today.strftime('%-d %b')})"
    link = PAGE if p.get('id') == 'me' else share_link(p)
    txt = [f"Opportunities this week, matched to “{p.get('name', 'your profile')}”", f"{d['total']} open leads tracked. Your view: {link}", '']
    h = ['<div style="font:15px/1.5 Helvetica,Arial,sans-serif;color:#111;max-width:640px">',
         f'<h1 style="font-size:24px;margin:0 0 4px">Opportunities this week</h1>'
         f'<p style="color:#666;margin:0 0 20px">Matched to “{html.escape(p.get("name", "your profile"))}” · {d["total"]} open leads tracked · <a href="{html.escape(link)}" style="color:#d88424">open your view</a></p>']
    if saved:
        txt.append('Your saved calls closing soon:')
        h.append('<h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#c0392b;border-top:3px solid #111;padding-top:8px;margin:22px 0 10px">Your saved calls closing soon</h2><ul style="padding-left:18px;margin:0">')
        for i in saved:
            url = i.get('url') or PAGE
            meta = ' · '.join(x for x in (when(i, today), {'preparing': 'preparing', 'submitted': 'sent'}.get(i.get('_stage'), ''), i.get('source', '')) if x)
            txt.append(f"- {i['title']}\n  {meta}\n  {url}")
            h.append(f'<li style="margin:0 0 14px"><a href="{html.escape(url)}" style="color:#111;font-weight:600;text-decoration:none">{html.escape(i["title"])}</a>'
                     f'<br><span style="color:#666;font-size:13px">{html.escape(meta)}</span></li>')
        h.append('</ul>')
        txt.append('')
    for label, rows in (('New this week', d['new']), (f'Closing in the next {SOON_DAYS} days', d['soon'])):
        txt.append(label + ':')
        h.append(f'<h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#d88424;border-top:3px solid #111;padding-top:8px;margin:22px 0 10px">{label}</h2>')
        if not rows:
            txt.append('  (nothing this week)')
            h.append('<p style="color:#999;margin:0">Nothing this week.</p>')
            continue
        h.append('<ul style="padding-left:18px;margin:0">')
        for m, i in rows:
            url = i.get('url') or PAGE
            why = ', '.join(m['reasons'][:3])
            meta = ' · '.join(x for x in (i.get('source', ''), when(i, today), money(i.get('amount')), f"match {m['score']}" + (f' ({why})' if why else '')) if x)
            txt.append(f"- {i['title']}\n  {meta}\n  {url}")
            h.append(f'<li style="margin:0 0 14px"><a href="{html.escape(url)}" style="color:#111;font-weight:600;text-decoration:none">{html.escape(i["title"])}</a>'
                     f'<br><span style="color:#666;font-size:13px">{html.escape(meta)}</span></li>')
        h.append('</ul>')
        txt.append('')
    if d['broken']:
        names = ', '.join(s['name'] for s in d['broken'][:12])
        txt.append(f"Sources not answering ({len(d['broken'])}): {names}")
        h.append(f'<p style="color:#999;font-size:12px;margin-top:28px;border-top:1px solid #ddd;padding-top:10px">Sources not answering this week ({len(d["broken"])}): {html.escape(names)}</p>')
    note = "Listings are leads found automatically: check eligibility, deadlines and fees on the funder's page."
    txt.append(note)
    h.append(f'<p style="color:#999;font-size:12px">{note}</p></div>')
    return subject, '\n'.join(txt), ''.join(h)


def people(presets: dict, state: dict | None = None) -> list[dict]:
    """Who gets an email, from DIGEST_PEOPLE (or the simpler single DIGEST_TO)."""
    raw = os.environ.get('DIGEST_PEOPLE', '').strip()
    if raw:
        try:
            listed = json.loads(raw)
        except json.JSONDecodeError as e:
            raise SystemExit(f'DIGEST_PEOPLE is not valid JSON: {e}')
        out = []
        for n, entry in enumerate(listed if isinstance(listed, list) else [listed]):
            prof = entry.get('profile')
            if isinstance(prof, str) and prof.startswith('preset:'):
                prof = presets.get(prof.split(':', 1)[1])
            if not isinstance(prof, dict) or not entry.get('email'):
                print(f'Skipping entry {n + 1}: it needs an "email" and a "profile".')
                continue
            out.append({'name': entry.get('name') or prof.get('name', ''), 'email': entry['email'], 'profile': prof})
        return out
    to = ''.join(os.environ.get('DIGEST_TO', '').split())
    mine = ((state or {}).get('profiles') or [None])[0]
    if isinstance(mine, dict) and mine.get('skills'):
        return [{'name': 'you', 'email': to, 'profile': {**mine, 'id': 'me'}, 'state': state}]
    return [{'name': '', 'email': to, 'profile': p} for p in presets.values()]


def send(to: str, subject: str, text: str, html_body: str) -> bool:
    # Pasted values can carry invisible non-breaking spaces (Google shows the code in groups).
    user, password = (''.join(os.environ.get(k, '').split()) for k in ('DIGEST_GMAIL_USER', 'DIGEST_GMAIL_APP_PASSWORD'))
    if not (user and password and to):
        return False
    msg = EmailMessage()
    msg['Subject'], msg['From'], msg['To'] = subject, f'Opportunities <{user}>', to
    msg.set_content(text)
    msg.add_alternative(html_body, subtype='html')
    with smtplib.SMTP_SSL('smtp.gmail.com', 465, timeout=30) as smtp:
        smtp.login(user, password)
        smtp.send_message(msg)
    return True


def main():
    today = dt.datetime.now(dt.timezone.utc).date()
    data = json.loads(DATA.read_text())
    presets = {p['id']: p for p in json.loads(PROFILES.read_text())['presets']}
    idx = load_index(ROOT)
    sent = 0
    state = dropbox_state()
    for person in people(presets, state):
        subject, text, html_body = render(build(data, person['profile'], idx, today, person.get('state')), today, person['name'])
        print('=' * 70 + '\n' + subject + '\n\n' + text + '\n')
        if send(person['email'], subject, text, html_body):
            sent += 1
            print(f"Sent to {person['name'] or person['email']}.")
    if not sent:
        print('Nothing sent (Gmail secrets or recipients not set). The emails above are previews.')


if __name__ == '__main__':
    sys.exit(main())
