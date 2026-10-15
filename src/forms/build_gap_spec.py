#!/usr/bin/env python3
"""build_gap_spec.py - turn a small ANNOTATED answers file into an apply_form_spec spec, addressed by LABEL.

WHY IT EXISTS. `draft_form_spec.py` maps the canonical profile onto a form automatically and is right for the
standard fields, but everything it cannot map (the role-specific essay, the salary question, the EEO radios, the
18-or-over pair) then has to be filled by hand - and filling it by hand means copying field UUIDs out of an
inventory dump into a JSON literal, one UUID at a time, for every application. That is slow, it is where wrong
answers get typed into the wrong control, and the copying itself lands in the agent's context.

So: the agent writes an answers file using the words that are PRINTED ON THE FORM, and this resolves each one to a
ref, refusing to guess.

    answers.json
    {
      "texts":     { "Full Name": "<name from the profile>", "What is your desired salary range?": "$000,000" },
      "textareas": { "What excites you about <Company>?": "@data/scratch/essay_<slug>.txt" },
      "radios":    { "6-8 years": true, "Male": true, "Asian (Not Hispanic or Latino)": true },
      "checks":    { "I agree": true },
      "selects":   { "Country*": "United States +1", "Discipline*": "Engineering" },
      "files":     { "Resume": "data/application_bundles/<slug>.json" }
    }

Selects are emitted as apply_form_spec `selects` entries ({"ref", "option"}), which drive both native selects and
react-selects whose rows it can find. A control that apply_form_spec cannot drive goes to `pick_select_option.mjs`
instead, which opens the list and picks the rendered row.

RULES THIS ENCODES, EACH LEARNED BY GETTING IT WRONG:
  * A value beginning with "@" is a FILE whose text is the answer (essays live in files, not in the shell command
    line, where a long paragraph with quotes gets refused).
  * Ambiguity is a REFUSAL, not a coin flip. A label that matches more than one control on the form stops the run
    and names the candidates, because "No" is a veteran answer, a sponsorship answer and a consent answer at once.
  * Matching is exact-first, then case-insensitive, then unique-substring. Never prefix-match a short option: /^Man/i
    once ticked the language "Mandarin" (ClickUp).
  * Selects/native dropdowns are NOT handled here; use pick_select_option.mjs, which reads the rendered rows.

USAGE
  .venv/bin/python3 src/forms/build_gap_spec.py <inventory_fields.json> --answers <answers.json> --out <spec.json>
                                                                     [--url <form url>] [--job <label>]

Exit codes: 0 = spec written; 2 = usage error; 4 = an answer could not be resolved unambiguously (nothing written).
"""
import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load_answers(path):
    data = json.loads(pathlib.Path(path).read_text())
    unknown = set(data) - {"texts", "textareas", "radios", "checks", "selects", "files"}
    if unknown:
        sys.exit(f"unknown answer group(s): {sorted(unknown)} - allowed: texts, textareas, radios, checks, files")
    return data


def resolve(fields, label, kinds):
    """Return (ref, kind) for exactly one control whose label matches, or explain why not."""
    wanted = label.strip().lower()
    candidates = [f for f in fields if (f.get("type") or f.get("tag") or "") in kinds]
    exact = [f for f in candidates if str(f.get("label", "")).strip().lower() == wanted]
    if len(exact) == 1:
        return exact[0], None
    pool = exact or [f for f in candidates if wanted in str(f.get("label", "")).strip().lower()]
    if len(pool) == 1:
        return pool[0], None
    if not pool:
        return None, f"no {sorted(kinds)} control on this form has a label matching {label!r}"
    listing = "; ".join(f"{f.get('label','')!r} ({f.get('ref','')[:52]})" for f in pool[:6])
    return None, f"{label!r} is ambiguous ({len(pool)} candidates): {listing}"


def read_value(value):
    if isinstance(value, str) and value.startswith("@"):
        p = value[1:]
        p = p if p.startswith("/") else str(ROOT / p)
        return pathlib.Path(p).read_text().strip()
    return value


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fields", help="JSON written by inspect_ats_form.mjs")
    ap.add_argument("--answers", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--url", default="")
    ap.add_argument("--job", default="")
    a = ap.parse_args()

    inv = json.loads(pathlib.Path(a.fields).read_text())
    fields = inv.get("fields", inv if isinstance(inv, list) else [])
    answers = load_answers(a.answers)

    spec = {"job": a.job or inv.get("job", ""), "url": a.url or inv.get("url", ""), "target": "",
            "texts": [], "textareas": [], "selects": [], "checks": [], "files": []}
    problems = []

    for label, value in (answers.get("texts") or {}).items():
        f, err = resolve(fields, label, {"text", "email", "tel", "url", ""})
        (spec["texts"].append({"ref": f["ref"], "value": read_value(value)}) if f else problems.append(err))

    for label, value in (answers.get("textareas") or {}).items():
        f, err = resolve(fields, label, {"textarea", ""})
        (spec["textareas"].append({"ref": f["ref"], "value": read_value(value)}) if f else problems.append(err))

    for label, want in list((answers.get("radios") or {}).items()) + list((answers.get("checks") or {}).items()):
        f, err = resolve(fields, label, {"radio", "checkbox"})
        # A group's options share a ref prefix but each option has its own ref; require an exact option label.
        (spec["checks"].append({"ref": f["ref"], "checked": bool(want)}) if f else problems.append(err))

    for label, option in (answers.get("selects") or {}).items():
        f, err = resolve(fields, label, {"text", "select", ""})
        if f:
            spec["selects"].append({"ref": f["ref"], "option": read_value(option)})
        else:
            problems.append(err)

    for label, path in (answers.get("files") or {}).items():
        f, err = resolve(fields, label, {"file"})
        if f:
            spec["files"].append({"ref": f["ref"], "path": read_value(path)})
        else:
            problems.append(err)

    if problems:
        print("REFUSED - nothing written:", file=sys.stderr)
        for p in problems:
            print("  -", p, file=sys.stderr)
        return 4

    pathlib.Path(a.out).write_text(json.dumps(spec, indent=2) + "\n")
    print(f"wrote {a.out}: {len(spec['texts'])} texts, {len(spec['textareas'])} textareas, "
          f"{len(spec['checks'])} checks/radios, {len(spec['files'])} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
