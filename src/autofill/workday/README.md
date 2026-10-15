# Workday

The Workday layer of this toolkit — three Node modules, and nothing for any other platform. `src/forms/`
is the generic half (scan a form, fill it, read every value back); this directory holds the parts a
Workday wizard needs and the generic tools cannot supply.

## What is here

| File | What it does |
| --- | --- |
| `workday_runner.mjs` | Drives a whole Workday application from one payload plus one answer plan: the Autofill-with-Resume upload (or "Use My Last Application", when this tenant's account already holds one), the My Experience step through the helper below, then the plan applied step by step, with every select and checkbox read back before it moves on |
| `workday_experience_helper.mjs` | The My Experience page itself: work-history rows, education rows with the degree and field-of-study lookups, LinkedIn, the resume upload, and removal of the websites the profile excludes. Dates go through the tenant's own calendar, because Workday's date masks rewrite bare digits (`8` for `08`) |
| `workday_playwright_adapter.mjs` | `makeWorkdayTab(page)` and `makeWorkdayHelper()` — the bridge that lets the helper run against a plain Playwright page from this repo's CDP session |

The helper exports `fillMyExperiencePage(tab, payload)` for the whole page, plus the parts it is built
from: `fillWorkExperience`, `chooseEducationFields`, `fillLinkedIn`, `uploadResume`,
`removeExcludedWebsites`, `setFullDateByMonthCalendar`. Every function takes its `tab` explicitly, so the
same helper drives a page wrapped by the adapter or by anything else exposing `tab.playwright`.

One thing to edit before the first Workday run: the school alias and search-term maps near the top of
`workday_experience_helper.mjs` are an **example**, not shipped data. Workday's school lookup spells one
institution several ways and a tenant's list is narrower than the real one, so those maps pair the name
in your payload with the spellings a tenant renders — replace them with your own schools. An unlisted
school falls back to its own name, which is the honest default and not an error.

## How it is driven

`prepare` builds the payload from `application_profile.json` and writes it into the data directory —
`<data>/autofill/workday/<slug>_payload.json`, with the other generated per-job configs. Then, with the
tenant's posting already open in the debugging Chrome:

```bash
node src/autofill/workday/workday_runner.mjs <data>/autofill/workday/<slug>_payload.json \
    --answers <path-to-your-answers>.json
```

`--answers` is a per-step plan you write, keyed by the numbers on the wizard's own step bar (1 Autofill,
2 My Information, 3 My Experience, 4/5 Application Questions, 6 Voluntary Disclosures / Self Identify,
7 Review). Each step names questions by regex and options by their exact text:

```json
{ "2": { "texts":   { "First Name": "…" },
         "selects": [ { "q": "country", "option": "United States of America" } ] },
  "6": { "selects": [ { "q": "gender", "option": "…" } ] } }
```

Without `--answers` the runner still does step 1 and step 3 — the upload and the settled helper — and
prints the questions it left for a person. Two flags make a plan writable from evidence instead of from
guessing: `--discover` walks the wizard printing every control and its options, and `--dump` prints the
current page and stops. `--goto <regex>` jumps to a step by name (a tenant that uploads first can skip
My Experience), `--back <n>` presses Back, and `--email` / `--account-password` / `--reset-password` are
for the tenants that want a Workday account before they will show a form.

The runner attaches to the Chrome on `--cdp` (default `http://127.0.0.1:9223`) and picks its tab from the
payload's job URL, so it cannot land on another tenant's Workday tab.

## It does not submit unless you ask it to

`--submit` is off by default. Given it, the runner clicks Submit on the final step and records a ledger
`submit` event with the outcome it could confirm — but the rule this toolkit works to is that the submit
click goes through `src/forms/verify_and_submit.mjs` and its expectations (`AGENTS.md`, rule 5;
`skills/submitting-an-application/SKILL.md`), so pass `--submit` only once that gate has held on the form
in front of you.
