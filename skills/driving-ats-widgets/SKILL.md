---
name: driving-ats-widgets
description: "Use when filling one control on an ATS form, or when a field looks filled and is not: identifying which of the many combobox/select/radio/upload mechanisms a page is using, driving it, and reading the committed value back off the rendered page."
---

# Driving ATS widgets

Procedure and routing only. Every mechanism below was added because a real form did something that
broke a simpler approach, and the thing that broke is pinned by a fixture test.

## Start by asking the page, not by guessing

```
node src/forms/chrome_launch.mjs               # attach if the port answers, otherwise start a browser
node src/forms/inspect_ats_form.mjs <url-substring> --options
```

The launcher probes the port first and starts nothing when something answers, so it is safe to run before every
round; `--visible` is for a person's sign-in or CAPTCHA, and `--print-command` reports what it would run.

It prints, per control: the mechanism it detected, the label it resolved, the options it can see, and
whether a value is committed. **Read the mechanism off that output** and pick the driver from the
table below. Guessing from the visible text is how a react-select gets typed into as if it were a
text input, which looks successful and commits nothing.

`src/forms/inspect_ats_form.mjs` is read-only. Run it as often as you like; a rescan after every
refusal is cheaper than a theory about a missing control.

## The mechanisms, and what drives each

| The page looks like | Drive it with |
| --- | --- |
| A real `<select>` | `src/forms/fill_by_label.mjs` |
| `role="combobox"`, or a `class*="select__control"` react-select | `src/forms/pick_option.mjs` — on **exact option text** |
| A plain `<div>` whose only visible text is `SELECT...` | `src/forms/answer_div_dropdown.mjs` |
| A control whose options only exist after typing (a remote school or city list) | `src/forms/pick_option.mjs` with a `--query`, or `src/forms/fill_big_autocomplete.mjs`. The query comes from `src/forms/structured_query.mjs` — never "take the shortest segment", which is right for a school and wrong for a city |
| A Yes/No pair of hidden checkboxes or buttons | `src/forms/answer_by_question_text.mjs`, `src/forms/ashby_yesno.mjs`; list them first with `src/forms/list_yesno_pairs.mjs` |
| A radio group | `src/forms/set_radio.mjs`, or `click_group_option.mjs` when the group must be decided **once**, not once per option |
| A free-text field that holds the wrong thing | `src/forms/retype_all_text.mjs` — never type into whatever happens to have focus |

Identify the mechanism from the scan, not from the screenshot. Three dropdown kinds can sit on one
Greenhouse form, and a `role="combobox"` can share a listbox with another one further down the page —
which is why option reads must be scoped to the control's own listbox rather than read page-wide.

## The rule that catches everything else

**After writing, read the rendered value back — and decide whether it is a real answer.**
`src/forms/field_state.mjs` answers "is this a value, or is the control telling you it has none": a
placeholder, an empty option, a row of blank boxes. `src/forms/audit_form_fields.mjs` applies it to
every control on the page; `src/forms/diagnose_form.mjs` explains what it found.

Two failures this exists to catch, both of which *look* fine on screen:

- **A widget can display an option as container text without storing it.** The read-back is the only
  check that sees the difference.
- **A pre-filled value can be a claim nobody made** — an ATS default in a location, salary or date
  field. Read those too, and correct them before submitting.

## Never do this

- `page.goto()` or `context.newPage()` — they pull the browser to the front and take the user's
  focus. Open background tabs with `src/forms/cdp_tabs.mjs open` and close what you opened.
- `page.bringToFront()` or `page.focus()` on a Frame. `src/tools/check_no_focus_steal.py` is the test
  that says so.
- Start a browser yourself, or end one: `src/forms/chrome_launch.mjs` owns that, and it will not quit
  or restart an instance it did not start. Port 9222 belongs to another program — the launcher refuses it.
- Believe a toast or a checkmark. `Success!` is also what a failed upload prints.

## Adding a mechanism, or fixing one

The fixtures are the contract. `src/forms/fixtures/ats_widgets.html` renders in a private **headless**
browser via `src/forms/fixture_browser.mjs`, so a shape can be reproduced and driven without touching
a live application. A missing browser is a **skip**, not a failure — the suite must not depend on a
download having happened.

1. Add the shape to a fixture, named by `src/forms/test_widget_scan.mjs`.
2. Drive it in `src/forms/test_fill_roundtrip.mjs`.
3. If the shape has been seen on a real form, `src/forms/fixtures/observed-shapes.json` must list it —
   `src/forms/test_shape_coverage.mjs` fails when a shape is seen but not rendered anywhere.

That third step is what stops a new shape being handled in code while nothing tests it.
