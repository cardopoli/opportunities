# Opportunities

Grants, open calls, residencies, commissions, prizes and foundation funding for creative people. Checked every morning and matched to your skills, with a private pipeline and a weekly email.

**Site:** https://cardopoli.github.io/opportunities/

## How it works

- **Every morning (07:23 UTC)** `.github/workflows/daily.yml` runs `scripts/collect.py`. It:
  - asks the EU Funding & Tenders Portal's public search API for open and upcoming calls;
  - reads the listing pages in `scripts/sources.json`, respecting `robots.txt` and pausing between requests to the same site;
  - opens each new lead once to find its deadline, amount, fee, who can apply and its real title (up to 300 a day, shared fairly between sites), and re-reads open leads every 14 days;
  - merges duplicates, closes expired calls, then saves `data/opportunities.json` and redeploys the site.
- **Profiles** are skills picked from `data/skills.json`: 14 families and their skills, with keywords in English, Italian and Slovene. Each profile also sets:
  - how wide to match: Precise, Related or Broad;
  - where you're based;
  - whether you apply as a person or an organisation;
  - your career stage;
  - the types of call you want;
  - free-to-enter only, and words to exclude.

  The examples are in `data/profiles.json`. Anyone can make their own on the page, then share it as a link (`#p=...`).
- **Matching** is plain keyword counting, no AI. `assets/score.mjs` (the page) and `scripts/scoring.py` (the email) follow the same rules, and `tests/fixtures/opps-score.json` keeps them in step. Each lead shows why it matched.
- **The pipeline** (Shortlist, Preparing, Submitted, Result, with notes) lives in your browser. It can sync privately to your own Dropbox app folder (`/opportunities/pipeline.json`), and saved profiles go with it.
- **Every Monday (07:41 UTC)** `.github/workflows/weekly-email.yml` sends each person on the list their own summary: new matches, anything closing soon, and sources not answering.

## Set up the weekly email (once, about five minutes)

1. The sending Google account needs **2-Step Verification** on: myaccount.google.com, then Security.
2. Create an **app password** at myaccount.google.com/apppasswords. Name it *Opportunities* and copy the 16 characters.
3. In this repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `DIGEST_GMAIL_USER`: the Gmail address that sends
   - `DIGEST_GMAIL_APP_PASSWORD`: the 16 characters
   - `DIGEST_PEOPLE`: who gets an email, as a list. On the page, pick a profile and press **Copy for weekly email**, change the address, and paste one entry per person between square brackets:
     ```
     [{"name": "Enrico", "email": "...", "profile": "preset:practice"},
      {"name": "Rosamond", "email": "...", "profile": { ...copied... }}]
     ```
     `"preset:practice"` and `"preset:projects"` use the example profiles.
   - `DIGEST_TO` (optional): a single address that gets both example profiles, used when `DIGEST_PEOPLE` is empty.
4. Test it under **Actions → Weekly email → Run workflow**.

Changing the Google password cancels app passwords. Make a new one and update the secret. Without the secrets, the job only prints the emails in its log.

## Dropbox sync (optional, per person)

Create an app at dropbox.com/developers/apps with **App folder** access and the permissions `files.content.read`, `files.content.write` and `files.metadata.read`. Under **Redirect URIs** add `https://cardopoli.github.io/opportunities/`. Then paste the app key on the Pipeline page.

## Add or fix a source

Copy a line in `scripts/sources.json`. The `kind` is one of:

- `html`: a listing page
- `rss`: a feed
- `sedia`: the EU portal
- `manual`: shown on the page to check by hand, for sites that block automated checks

Optional fields:

- `include`: a regex the link must match
- `exclude`
- `min_slug`: skip short category links
- `offsite`: allow links to other sites

Run `python3 scripts/collect.py --report "Source name"` to see what a source returns.

## Tests

`python3 -m unittest discover -s tests -p 'test_*.py'` and `node --test tests/*.test.mjs`
