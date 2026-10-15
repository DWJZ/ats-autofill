---
name: submitting-an-application
description: "Use when taking a job posting to a submitted application, a skip, or a handover in this repo: the order of the steps, what each one hands the next, the judgement at every transition, and when to stop and hand over instead."
---

# Submitting an application

Procedure and routing only. The *why* behind each step is in the source comments, and every lesson
this tool has learned is pinned by a test — read the test, not a paragraph.

This skill is also the **orchestrator**: nothing scripts the chain, so the order and the judgement at
each transition are what this file is for. Control mechanics are `skills/driving-ats-widgets/`; which
configuration file holds a fact is `docs/CONFIGURATION.md`. Neither is restated here.

## Non-negotiables

1. **Write and submit are separate steps.** `apply_form_spec.mjs` refuses a spec that asks it to
   submit; submission goes through `verify_and_submit.mjs` and its expectations, or it does not
   happen. Never call a submit helper to skip the gate.
2. **Read the value, not the field.** A placeholder reads back as a value, an ATS pre-fill is a claim
   the applicant never made, and a masked date control can accept a string while displaying another
   date. Read the *rendered* text of every fact-bearing field before the final click.
3. **Fill only from the canonical configuration.** An answer that is not in it stays blank and is
   listed. Never invent an employer, a date, a metric, a degree, an authorisation answer or a number.
   A question about a skill the applicant does not have is answered *no, and here is what they did
   use* — never a silent skip, never a claim.
4. **A blocker is not a bug to work around.** A login, a CAPTCHA, a 2FA prompt or a code you cannot
   read stops the run and is reported.
5. **Record the outcome at the moment you know it**, and re-read the row to confirm it landed.

## The runnable order, and what each step hands the next

| # | Do | With | Produces — the next step's input |
| --- | --- | --- | --- |
| 1 | Screen it: live, a hard bar, already applied to? | `screening/screen_urls.py`, `screening/check_duplicate.py` | a verdict: proceed, **skip**, or stop for a person |
| 2 | Will the tenant take one more? | `screening/tenant_caps.py` | proceed, or a skip on the cap |
| 3 | Tailor the documents | `application_pipeline.py prepare --profile <path>` | resume + cover-letter PDFs, **and the tracker row** — this step creates it |
| 4 | Inventory the open form (read-only) | `node src/forms/inspect_ats_form.mjs <url-substring> --options --out tmp/<slug>_fields.json` | the inventory JSON |
| 5 | Inventory → fill spec, from canonical data | `src/forms/draft_form_spec.py <inventory> --job … --resume … --cover-letter … --out <slug>.spec.json` | the spec, plus `<slug>.spec.needs_review.json` |
| 6 | Fill it — never submits | `node src/forms/apply_form_spec.mjs <spec>` | a filled page, and the blanks that stayed blank |
| 7 | Read every control back as rendered | `audit_form_fields.mjs`, `diagnose_form.mjs` | the values the gate is written against |
| 8 | Gate on expectations, then submit | `verify_and_submit.mjs <url-substring> <slug> --company <Name> --expect '<json>'`, `--dry-run` first | the submission, or a refusal naming what failed |
| 9 | Record it | `application_pipeline.py record-status --url <requisition-url> --status <status> --note "…"` | the tracker row, re-read |

Steps 4–6 repeat when a form reveals controls only after it has been filled — cascading EEO blocks do
this. `node src/forms/refill_until_stable.mjs <url-substring> --max-rounds 4` is that loop; it stops
when a round reveals **no new controls**, which is not "no blanks left".

## The transitions, which is the part nothing else decides

**5 → 6, `needs_review` is not empty.** Read it as three different things: a **fact the applicant has
and the configuration does not** → ask once, then **record the answer** where the next round finds it
(a rule in `data/form_specs/answer_rules.json`, or a value in the profile) and re-draft; a **control
the drafter cannot drive** → `driving-ats-widgets` names the driver, and if none fits, fill the rest
and take it to the gate's handover; **something nobody can answer truthfully** → leave it blank and
report it.

**`needs_review` lists what the drafter could NOT answer — not what it may have answered wrongly.**
Auto-answers and ATS pre-fills arrive as ordinary values, so before the gate re-read the fact-bearing
fields against the canonical profile: identity, contact, location, dates, and every yes/no whose wrong
direction is a false statement.

**6 → 7 → 8.** A blank for a fact nobody has stated is the correct outcome. What must not reach step 8
is a blank the drafter could have filled, or a value that is not the canonical one. The gate then
refuses or submits; a refusal that names nothing is itself a finding — screenshot before theorising.

**8 → 9.** A confirmation and a tracker write are separate steps, and the confirmation is not the
record.

**How a posting reaches `record-status`.** `prepare` created the row keyed on the requisition URL, so
step 9 matches on that exact URL and raises if it finds none. It **refuses to change a status that
already means "submitted"** and writes nothing at all when it refuses; `--force` corrects a genuinely
wrong record, never makes a row say something convenient. Which statuses count as sent is
`docs/CONFIGURATION.md`.

**A skip and a handover are recorded too.** Screening out a posting is `not_applied` with the reason
in the note. Stopping for a person is `application_pipeline.py handover --url … --class … --reason
"…"`, which does **not** touch the tracker — the row's status is a separate decision.

## When to stop and hand over

- **Decide the stop condition before the last attempt, not after it**, and record it as a decision
  with its reason.
- **Stop for a person** on an unsolvable image CAPTCHA, a password or 2FA the saved session cannot
  satisfy, an email code for a mailbox that cannot be read, an expired third-party session, or content
  only they can author. Fill everything else first, leave the tab open, record the handover.
- **Stop for the tool** when the gate refuses for an honest reason: a required question nobody can
  answer truthfully is a stop, not a reason to invent one — that is what `filled_for_review` is for.
- **Retry only when the trigger changed.** The same refusal twice is not progress; report the state
  reached and what would have to change.

## When something refuses

- **A field reports success and holds nothing** → `diagnose_form.mjs`, then `field_state.mjs`.
- **The submit is refused** → `find_form_errors.mjs` names what the page says is missing.
- **A page will not render** → `cdp_tabs.mjs` opens background tabs only; never `page.goto()` or
  `context.newPage()`, which take the user's focus — a rule, not a preference.
- **Nothing answers on the port** → `node src/forms/chrome_launch.mjs` starts a browser if none is
  running and attaches if there is. It never touches one it did not start.
- **A login, CAPTCHA or code stops you** → stop, leave the tab, record the handover.

## Routes

| Want | Read |
| --- | --- |
| What each configuration file holds and who reads it | `docs/CONFIGURATION.md` |
| The numbered rules a source comment cites | `docs/RULES.md` |
| Filling one control | `skills/driving-ats-widgets/SKILL.md` |
| What a bad fill looked like, and the test that pins it | `grep -rn "<the symptom>" src/forms/test_*.mjs src/forms/test_*.py` |
