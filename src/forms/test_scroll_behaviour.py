#!/usr/bin/env python3
"""The page must not bounce under the user's hands, and ten call sites still centre it.

USER QUESTION, 2026-10-01: the user watches the same Chrome window these scripts drive, and asked why the page
sometimes scrolls up and down repeatedly. The cause was ours - 188 call sites used
`scrollIntoView({ block: "center" })`, one before nearly every interaction, so a long form or any retry loop re-centred
the page on every field. All of them were changed to `block: "nearest"`.

`nearest` is now the convention: 39 call sites against 10. `fullPage: true` is gone entirely. But ten `center` sites
remain, and they are not all stragglers:

  - `workday_experience_helper.mjs` centres the Degree button WITH `inline: "center"`, which was the fix for a sticky
    footer intercepting that click. `nearest` would leave the button at the viewport edge, which is where the footer
    is. Deliberate, and it should stay.
  - `pick_option.mjs` and `press_all_pairs.mjs` scroll before a COORDINATE click, and a coordinate has to be inside
    the viewport to be clickable at all.
  - the Ashby fillers scroll before pressing a pair or a radio by id.

So this does not ban the call - it ENUMERATES the sites that have it, and fails when a new one appears. A new one is
not necessarily wrong; it is necessarily a decision, and the decision has a cost the user can see. That is the same
shape as the focus guard: a check with per-line exemptions, so the exemption has to be written where it is used.

`fullPage: true` IS banned outright, because it is never a decision - Playwright scrolls internally to stitch the
image, which is the bounce by another route, and the case says use it only when a whole page genuinely has to be
captured, which no script has needed since.
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]

# Every `block: "center"` the tree is allowed to carry, and why. Adding a line here is the decision.
ALLOWED = {
    "src/forms/ashby_finish_form.mjs": 3,      # before pressing a pair / a radio by id
    "src/forms/ashby_yesno.mjs": 2,            # before pressing a button or its label
    "src/forms/press_all_pairs.mjs": 2,        # before a coordinate click
    "src/forms/pick_option.mjs": 1,            # before a coordinate click
    "src/autofill/workday/workday_experience_helper.mjs": 2,   # sticky footer over the Degree button
}


class ScrollBehaviourTest(unittest.TestCase):
    def sites(self):
        found: dict[str, int] = {}
        for path in sorted((ROOT / "src").rglob("*.mjs")):
            n = len(re.findall(r'block:\s*"center"', path.read_text(encoding="utf-8", errors="ignore")))
            if n:
                found[str(path.relative_to(ROOT))] = n
        return found

    def test_no_new_site_centres_the_page(self):
        found = self.sites()
        for path, count in sorted(found.items()):
            with self.subTest(file=path):
                self.assertIn(path, ALLOWED,
                              f"{path} centres the page {count} time(s) and is not on the list. `block: \"nearest\"` "
                              f"is the convention (39 sites); `center` re-centres on every field and the user sees "
                              f"the page jump. If this one is deliberate, add it to ALLOWED with the reason.")
                self.assertLessEqual(count, ALLOWED[path],
                                     f"{path} now centres the page {count} times, more than the {ALLOWED[path]} listed")

    def test_the_list_has_not_rotted(self):
        # A file that stopped using `center` should leave the list, or the next reader reads a stale exemption.
        found = self.sites()
        for path in ALLOWED:
            with self.subTest(file=path):
                self.assertIn(path, found, f"{path} no longer centres the page - remove it from ALLOWED")

    def test_nearest_is_the_convention_and_stays_the_majority(self):
        nearest = center = 0
        for path in (ROOT / "src").rglob("*.mjs"):
            text = path.read_text(encoding="utf-8", errors="ignore")
            nearest += len(re.findall(r'block:\s*"nearest"', text))
            center += len(re.findall(r'block:\s*"center"', text))
        self.assertGreater(nearest, center,
                           "`nearest` must stay the majority: it is the one that does not move the page")

    def test_a_full_page_screenshot_is_banned(self):
        # Playwright scrolls internally to stitch the image - the bounce by another route - and no script has needed
        # one since the rule was written.
        offenders = []
        for path in sorted((ROOT / "src").rglob("*.mjs")):
            for i, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                if re.search(r"fullPage:\s*true", line) and not line.strip().startswith("//"):
                    offenders.append(f"{path.relative_to(ROOT)}:{i}")
        self.assertEqual(offenders, [], "a full-page screenshot scrolls the page the user is watching")


if __name__ == "__main__":
    unittest.main()
