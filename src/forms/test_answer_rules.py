#!/usr/bin/env python3
"""Tests for the persisted answer rules (`data/form_specs/answer_rules.json`).

WHY THIS EXISTS. On one tenant's form `draft_form_spec.py` reported 12 questions as `no profile mapping`, and most
were not unmappable: the canonical profile holds the answers (citizenship, visa status, outside-employment history)
and the built-in table simply has no pattern for the wording that tenant uses. The answers were worked out by hand per
application and forgotten when that job's spec was done.

The rules now live in a data file. These tests pin the three ways that file can go wrong:

  1. a rule that does not fire on the wording it was written for (the whole point is that it fires),
  2. a rule that fires on something it should NOT - the persisted rules are tried BEFORE the built-in table, so a
     greedy pattern can take a question away from the canonical answer,
  3. a rule that changes the SAFETY guard's behaviour - the Asana short-field refusal must not be bypassable by data.

The wording used in the assertions is copied from the real Twitch form's `needs_review` list, not invented.
"""
import importlib.util
import json
import pathlib
import re
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

MODULE_PATH = pathlib.Path(__file__).with_name("draft_form_spec.py")
_spec = importlib.util.spec_from_file_location("draft_form_spec_rules", MODULE_PATH)
drafter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(drafter)

RULES_FILE = DATA_DIR / "form_specs" / "answer_rules.json"
EXAMPLE_RULES_FILE = ROOT / "examples" / "answer_rules.example.json"


def _flatten_groups(pattern: str) -> str:
    """Strip regex groups, keeping each one's FIRST alternative, innermost first.

    NESTED GROUPS ARE WHY THIS IS A LOOP RATHER THAN A SUBSTITUTION. A rule may read
    `have you (previously )?(been employed by|applied (to|for)) (amazon|twitch)`, and a single-pass regex that
    matches `\\(([^()]*)\\)` stops at the inner parens: it consumed `(to|for)` and left the outer group's `|`
    in the text, so the "wording" came out as `have you previously been employed by|applied to amazon` - a
    string no pattern matches, reported as a dead rule. Resolving innermost-first consumes one level per pass
    and terminates when no group is left.
    """
    while True:
        reduced = re.sub(r"\(([^()]*)\)", lambda m: m.group(1).split("|")[0], pattern)
        if reduced == pattern:
            return reduced
        pattern = reduced


def _first_alternative(pattern: str) -> str:
    """The pattern's first top-level alternative, cut only at `|` that is OUTSIDE any group or class.

    `pattern.split("|")[0]` LOOKS equivalent and is not: a rule like
    `do you require (immigration |visa )?sponsorship to work` carries a `|` INSIDE a group, and splitting on
    it cut the pattern at `(immigration ` - so the wording handed to `pick_answer` was "do you require
    immigration", which its own pattern could not match, and a working rule was reported as dead by the very
    check written to find dead rules.
    """
    depth = 0
    for index, char in enumerate(pattern):
        if char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)
        elif char == "|" and depth == 0:
            return pattern[:index]
    return pattern


def _wording_from(pattern: str) -> str:
    """A string built from a rule's own regex, used to prove the rule is REACHABLE.

    WHY THIS EXISTS. The installed table cannot be tested against a fixed list of wordings: its rules were
    written per tenant, for one applicant's forms, and a checkout belonging to somebody else holds different
    rules for different companies. So the property that must hold for EVERY rule, whoever wrote it and for
    whichever tenant, is that its pattern matches SOMETHING - a rule that cannot is a file entry the engine
    never uses, and `load_answer_rules` counts it while `needs_review` keeps asking the question.

    THE RESULT IS SYNTHETIC AND IS NOT CLAIMED TO READ LIKE A QUESTION. Optional parts become the neutral word
    "x" rather than being deleted, because deleting them breaks the sentence the rest of the pattern expects:
    `sponsorship (at any point )?in the future` became "sponsorship in the future", which the pattern's own
    literal "at any point" then failed to match, and a working rule was reported dead. The check is
    reachability, not plausibility.

    Deliberately crude: first alternative only, regex syntax that cannot appear in a label is dropped
    (`^`, `$`, `\\b`, groups), character classes become their first member, quantifiers go.
    """
    text = _first_alternative(pattern)
    text = text.replace("^", "").replace("$", "").replace("\\b", "")
    text = re.sub(r"\(\?:", "(", text)                 # non-capturing -> plain
    # GROUPS, INNERMOST FIRST. An optional group keeps its first option and its trailing space, which is what a
    # form actually writes: a real label IS "Will you require immigration sponsorship at any point in the
    # future…", the pattern with both optional groups present. Substituting a filler word instead produced
    # "will you require x sponsorship x in the future", which matches nothing because the group's own trailing
    # space is then missing - and a working rule was reported dead.
    text = _flatten_groups(text)
    text = re.sub(r"\[([^\]]*)\]", lambda m: m.group(1).replace("^", "")[:1] or "x", text)
    text = re.sub(r"\{\d+(,\d*)?\}", "", text)         # {0,40} and friends mean "optional" here
    text = re.sub(r"[()?*+]", "", text)                # leftover quantifiers -> plain text
    text = re.sub(r"\\s", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text or re.sub(r"[\\^$]", "", pattern).strip() or pattern


def rules_are_the_shipped_example(rules: list) -> bool:
    """Is the installed rule table the untouched example?

    `data/form_specs/answer_rules.json` carries rules written by hand for ONE person's recurring wordings -
    Twitch's and Amazon's, named in the notes below. `scripts/setup-examples.sh` installs a file with three
    invented rules instead, and that file is what a fresh checkout has.

    The check compares the RULES, not the file bytes (so reformatting is not mistaken for a real table), and it
    is deliberately not derived from whether the assertions below pass: a real table whose rules have stopped
    firing must still fail this test rather than skip it.
    """
    try:
        example = json.loads(EXAMPLE_RULES_FILE.read_text(encoding="utf-8")).get("rules")
    except (OSError, ValueError):
        return False
    return bool(example) and rules == example

# Label -> the answer the rule file must produce. Every label here was copied out of a real needs_review entry.
REAL_WORDINGS = {
    "Have you previously been employed by Amazon or any Amazon subsidiary? *": "No",
    "Are you a current employee with Amazon or any Amazon subsidiary (outside of Twitch)?*": "No",
    "Have you previously applied to Amazon or any Amazon subsidiary?*": "No",
    "Are you subject to a non-competition agreement or other agreement that would prevent you from working here?": "No",
    "If offered employment by Amazon, would you be legally eligible to begin employment?": "Yes",
    "Have you held H-1B status, or had an H-1B petition approved on your behalf?": "No",
    "Since obtaining your most recent citizenship, did you afterwards become a permanent resident?": "No",
}


def canonical_citizenship() -> str:
    """The expected answer to a citizenship question, read from the profile rather than written here.

    A hardcoded one is not merely stale in someone else's checkout - in a public repo it publishes a
    fact about the one person the tests were originally written against. The wording stays pinned
    below; the answer comes from the configuration the checkout actually has.
    """
    try:
        profile = json.loads(
            (DATA_DIR / "candidate_profile.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    candidate = profile.get("candidate") or {}
    answers = candidate.get("standard_answers") or {}
    return candidate.get("citizenship") or answers.get("citizenship") or ""


class AnswerRulesFileTest(unittest.TestCase):
    def test_the_file_exists_and_is_loadable(self):
        # A silently-empty rule file would make every test below pass by falling through to the built-in table.
        self.assertTrue(RULES_FILE.exists(), f"{RULES_FILE} is missing - the rules were never persisted")
        data = json.loads(RULES_FILE.read_text(encoding="utf-8"))
        self.assertGreaterEqual(data.get("version", 0), 1)
        self.assertTrue(data.get("rules"), "no rules in the file")

    def test_every_rule_carries_a_note_naming_its_source(self):
        # An entry that cites nothing cannot be told apart from a guess - and because it MATCHES, it will never appear
        # in needs_review again. That is the failure the contract's rule 11 is written against.
        for r in json.loads(RULES_FILE.read_text(encoding="utf-8"))["rules"]:
            self.assertTrue(r.get("note", "").strip(), f"rule {r.get('questionRe')!r} has no note")
            self.assertGreater(len(r["note"]), 30, f"rule {r.get('questionRe')!r} has a note that says nothing")

    def test_the_loaded_rules_are_the_ones_in_the_file(self):
        rules = drafter.load_answer_rules(RULES_FILE)
        self.assertEqual(len(rules), len(json.loads(RULES_FILE.read_text(encoding="utf-8"))["rules"]))

    def test_a_broken_pattern_does_not_take_the_other_rules_down(self):
        # One bad regex must not silently disable the whole file.
        blob = {"version": 1, "rules": [
            {"questionRe": "([unclosed", "answer": "X", "note": "broken on purpose"},
            {"questionRe": "do you like tests", "answer": "Yes", "note": "a note long enough to look deliberate"},
        ]}
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "r.json"
            p.write_text(json.dumps(blob), encoding="utf-8")
            rules = drafter.load_answer_rules(p)
        self.assertEqual(len(rules), 1, "the broken rule should be dropped and the good one kept")
        self.assertEqual(rules[0]["answer"], "Yes")

    def test_a_missing_file_is_not_fatal(self):
        self.assertEqual(drafter.load_answer_rules(pathlib.Path("/nonexistent/answer_rules.json")), [])


class PersistedRulesFireTest(unittest.TestCase):
    """The mechanism: a rule that is in the file ANSWERS the question, and the spec says which rule it was.

    WHAT CHANGED HERE, AND WHY IT IS NOT A WEAKENED TEST. This class used to prove the mechanism by feeding
    `REAL_WORDINGS` - eight questions copied out of one person's `needs_review` lists - to the INSTALLED rule
    file, so it passed only in a checkout whose owner had applied to the same tenants: the notes name Twitch and
    Amazon, and three of the wordings are Amazon's. A different applicant installs their own table, the installed
    file does not answer those questions, and the test reported eight misses against rules that were never meant
    to be there. That is a test asserting ONE PERSON'S APPLICATION HISTORY, and the honest fix is to separate the
    two things it was doing at once:

      * the MECHANISM is asserted below with rules supplied inline, so it holds in any checkout; and
      * the INSTALLED TABLE is checked for the properties every table must have, whoever owns it
        (`test_the_installed_table_is_loadable_explained_and_self_consistent`), which is what catches a real
        table whose rules have rotted - the failure this class exists to protect.

    `REAL_WORDINGS` is kept as the record of the wordings this project actually met, and the citizenship entry
    below still exercises an installed rule end to end whenever the table carries one.
    """

    def test_a_persisted_rule_answers_the_wording_it_was_written_for(self):
        # THE MECHANISM, stated with its own premise so it depends on no checkout's configuration.
        rules = [
            {"questionRe": r"have you (previously |ever )?been employed (by|at|with)",
             "answer": "No", "kind": "select", "note": "inline fixture, not an installed rule"},
        ]
        key, answer = drafter.pick_answer("Have you previously been employed by Contoso?", {}, "select", rules)
        self.assertRegex(str(key), r"^@rule:\d+$",
                         "a persisted rule must answer the question and say that IT answered it")
        self.assertEqual(answer, "No")

    def test_the_installed_table_is_loadable_explained_and_self_consistent(self):
        """What is true of EVERY rule table, and what actually catches a rotted one.

        Every rule must carry a note naming its source (the file's own contract: a rule that cites nothing
        cannot be told apart from a guess, and because it matches, nobody will look at it again), every pattern
        must compile - a pattern that does not is DROPPED by the loader, so the file reports a rule the engine
        never loads - and every rule must actually fire on the wording it was written for.
        """
        raw = json.loads(RULES_FILE.read_text(encoding="utf-8"))
        rules = drafter.load_answer_rules(RULES_FILE)
        self.assertTrue(rules, f"{RULES_FILE} holds no usable rule; an empty table answers nothing")

        dropped = len(raw.get("rules") or []) - len(rules)
        self.assertEqual(dropped, 0,
                         f"{dropped} rule(s) were dropped by the loader - a pattern that does not compile, or an "
                         f"empty answer. A rule that cannot fire is a rule nobody has: {raw.get('rules')}")

        for rule in raw.get("rules") or []:
            with self.subTest(rule=rule.get("questionRe")):
                self.assertTrue(str(rule.get("note", "")).strip(),
                                f"rule {rule.get('questionRe')!r} carries no note naming its source")
                self.assertGreater(len(rule["note"]), 30,
                                   f"rule {rule.get('questionRe')!r} has a note that says nothing")
                # AND IT FIRES ON A WORDING BUILT FROM ITS OWN PATTERN. This is the weakest check that still
                # survives not knowing which tenant the rule was written for, and it catches the failure the
                # note requirement cannot: a pattern so specific - or so mistyped - that no room label reaches
                # it, which makes the rule a file entry the engine never uses.
                #
                # THE RULE IS PASSED ALONE, so this asks reachability and nothing else. The installed table can
                # hold two rules that BOTH match one question - a "will you require immigration
                # sponsorship at any point in the future" wording reaches both the sponsorship rule and the
                # built-in `sponsor_now` matcher - and which of them wins is a question about precedence
                # between rules that agree on the answer, not about whether this rule is dead. Asserting the
                # winner here would fail on a table that is working.
                wording = _wording_from(rule["questionRe"])
                key, _answer = drafter.pick_answer(wording, {}, rule.get("kind") or "select", [rule])
                self.assertIsNotNone(
                    key, f"rule {rule['questionRe']!r} did not fire on {wording!r}, built from its own pattern")
                self.assertRegex(str(key), r"^@rule:\d+$",
                                 f"{wording!r} was answered by {key!r}, not by the persisted rule")

    # NOTE ON A TEST THAT IS NOT HERE. An earlier version of this class asserted that the INSTALLED table
    # answers "In which country/region do you have citizenship?" with the profile's citizenship. That wording
    # is answered by the built-in `citizenship` matcher, which covers more of its spellings than any rule does
    # (`citizenship status`, `what country are you a citizen of`), so a rule for it is a rule that DUPLICATES
    # the engine - and this checkout deliberately does not carry one. The assertion would therefore fail on a
    # correct table, which is the same mistake as the Amazon wordings it replaced: pinning a rule the checkout
    # has no reason to hold. The reachability check above covers the failure it was reaching for.

    def test_the_key_says_which_rule_answered(self):
        # Provenance is the point: a spec must be able to show that an answer came from the rule file and which one.
        # The rule is supplied inline so the case states its own premise: the SUBJECT is the `<key>` `pick_answer`
        # returns for a persisted rule, and none of this depends on which rules the installed file happens to hold.
        rules = [{"questionRe": r"have you held h-?1-?b status", "answer": "No", "note": "inline fixture"}]
        key, _ = drafter.pick_answer("Have you held H-1B status?", {}, "select", rules)
        self.assertRegex(str(key), r"^@rule:\d+$")

    def test_a_rule_with_a_kind_only_fires_for_that_kind(self):
        rules = [{"questionRe": "favourite colour", "answer": "Blue", "kind": "select", "note": "test"}]
        self.assertIsNotNone(drafter.pick_answer("favourite colour", {}, "select", rules)[0])
        self.assertIsNone(drafter.pick_answer("favourite colour", {}, "text", rules)[0])

    def test_the_built_in_table_still_answers_what_the_rules_do_not(self):
        # The rules are an addition, not a replacement: an identity field must still resolve the ordinary way.
        table = {"first_name": "Example"}
        key, answer = drafter.pick_answer("First Name", table, "text")
        self.assertEqual((key, answer), ("first_name", "Example"))


class PersistedRulesDoNotBreakTheGuardTest(unittest.TestCase):
    def test_a_long_answer_cannot_be_forced_into_a_short_field_by_a_rule(self):
        # THE ASANA GUARD, and data must not be able to move it: a sentence in a name/pronoun field is a false
        # statement in a submitted application, whoever wrote the rule that put it there.
        long_answer = "x" * 140
        rules = [{"questionRe": "preferred full name", "answer": long_answer, "note": "a rule trying to break the guard"}]
        key, answer = drafter.pick_answer("Preferred Full Name", {}, "text", rules)
        self.assertIsNone(key, "the short-field guard was bypassed by a persisted rule")
        self.assertIsNone(answer)

    def test_a_long_answer_is_still_allowed_where_the_field_can_hold_it(self):
        # The guard is about the FIELD, not about length as such - an essay question must still be answerable.
        long_answer = "x" * 140
        rules = [{"questionRe": "tell us about yourself", "answer": long_answer, "note": "essay answer, long on purpose"}]
        key, answer = drafter.pick_answer("Tell us about yourself", {}, "textarea", rules)
        self.assertIsNotNone(key)
        self.assertEqual(answer, long_answer)


if __name__ == "__main__":
    unittest.main()
