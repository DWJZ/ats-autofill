#!/usr/bin/env python3
"""test_instruction_contract.py — the two things that reach an agent before it does anything, held to their promises.

Both halves of this module exist because the failure they describe is SILENT. A contract that forgets to say the
shipped configuration is an example does not error: the agent fills a real employer's form with `Example Candidate`
of Springfield. A `SKILL.md` whose frontmatter is not valid YAML does not error either: DSH drops the skill from the
session, so the procedure simply is not there and nothing says so. `docs/RULES.md` rule 10 records the mechanism.

WHY THE FIRST HALF IS A TEST AND NOT MORE PROSE. The unconfigured-checkout contract is a ROUTING INSTRUCTION, so
documenting it in `AGENTS.md` is the fix — there is no code path to assert. What a test can hold is that the
instruction is still there, still where a reader meets it before the rules, still NAMES the facts that have to come
from the person rather than from the files, and still routes to `docs/CONFIGURATION.md` instead of restating it.
That last one is the invariant that keeps the section from growing into the document it points at, and the length
budget below is how it is enforced rather than requested.

The second half is the frontmatter contract itself, which this repository had no test for. `AGENTS.md` states the
rule and the budget; a stated rule with nothing checking it is the class of thing rule 1 exists to stop.
"""
from __future__ import annotations

import pathlib
import re
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

AGENTS = ROOT / "AGENTS.md"
SKILLS = ROOT / "skills"

#: The budget the unconfigured-checkout section must stay inside. `AGENTS.md` as a whole has a hard 65,536-byte
#: limit from the harness; this section has a much smaller one because it is a pointer, and a pointer that grows
#: has stopped being one. Raising this number is a decision about where a fact belongs, so it is meant to be hard.
UNCONFIGURED_SECTION_BUDGET = 2600

#: The facts that cannot be inferred from anything shipped. Each one is a thing the person has to say, and every
#: entry is a phrase the section has to contain — a paraphrase that drops one is a section that will send an agent
#: to fill the rest and leave the rest blank without asking.
REQUIRED_FACTS = (
    "identity",
    "contact",
    "address",
    "education",
    "work history",
    "resume",
    "work authorisation",
    "sponsorship",
    "relocation",
    "consent",
    "demographics",
)


def read(path: pathlib.Path) -> str:
    return path.read_text(encoding="utf-8")


def section(text: str, heading: str) -> str:
    """Everything under `heading` up to the next heading of the same or a higher level."""
    match = re.search(rf"^{re.escape(heading)}$", text, flags=re.M)
    if not match:
        return ""
    rest = text[match.end():]
    stop = re.search(r"^## ", rest, flags=re.M)
    return rest[: stop.start()] if stop else rest


class TheUnconfiguredCheckoutIsNamedTest(unittest.TestCase):
    """`AGENTS.md` must say, early, that the shipped configuration is an example and what to do about it."""

    def setUp(self):
        self.text = read(AGENTS)
        self.section = section(self.text, "## First: is this checkout configured at all?")

    def test_the_section_exists_at_all(self):
        self.assertTrue(self.section, "AGENTS.md has no 'is this checkout configured' section")

    def test_it_is_read_before_the_rules_and_before_the_routing_table(self):
        # Order is the whole point of putting it here: a reader who reaches rule 1 first has already been handed
        # five rules that assume a configured toolkit, and the routing table's first row sends them into
        # `data/`. Position is asserted by index rather than by line number so the file can still be edited.
        body = self.text.index(self.section)
        self.assertLess(body, self.text.index("## Hard rules"), "the section must come before the hard rules")
        self.assertLess(body, self.text.index("## Routing table"), "the section must come before the routing table")

    def test_it_says_the_shipped_configuration_is_an_example_and_fictional(self):
        lowered = self.section.lower()
        self.assertIn("example", lowered)
        self.assertIn("fictional", lowered)
        # The concrete consequence, in the section's own words: the values read as answers to a real employer.
        self.assertIn("real employer", lowered)

    def test_it_covers_the_data_directory_being_absent_as_well_as_example_filled(self):
        # A fresh clone has no `data/` at all until `setup-examples.sh` runs, and that is the more common state.
        # A section that only described "the files hold the example" would leave the first reader unaddressed.
        lowered = self.section.lower()
        self.assertIn("does not exist", lowered)

    def test_it_says_stop_and_ask_rather_than_proceed(self):
        lowered = self.section.lower()
        self.assertIn("stop and ask", lowered)
        self.assertIn("the facts", lowered)

    def test_it_names_the_facts_that_have_to_come_from_the_person(self):
        lowered = self.section.lower()
        missing = [fact for fact in REQUIRED_FACTS if fact not in lowered]
        self.assertEqual(missing, [], f"the section does not ask for: {missing}")

    def test_it_names_the_compensating_rule(self):
        lowered = self.section.lower()
        self.assertIn("blank", lowered)
        self.assertIn("reported", lowered)
        self.assertIn("never invented", lowered)

    def test_it_forbids_filling_from_the_example_values(self):
        lowered = self.section.lower()
        self.assertIn("never fill a form from the example values", lowered)
        self.assertIn("never invent a fact", lowered)

    def test_a_reported_blank_is_named_as_the_correct_outcome(self):
        # The sentence that stops an agent treating an empty field as a failure to work around. Without it, the
        # rest of the section reads as advice and this reads as the one thing that is not allowed.
        self.assertIn("correct outcome", self.section.lower())

    def test_it_routes_to_the_configuration_document_instead_of_restating_it(self):
        # The progressive-disclosure contract: `docs/CONFIGURATION.md` owns which file holds which fact, and this
        # section must send the reader there. Restating the file map here is how the two documents start to
        # disagree, so the per-file vocabulary is asserted ABSENT as well as the pointer being present.
        self.assertIn("docs/CONFIGURATION.md", self.section)
        for restated in ("candidate_profile.json", "application_profile.json", "tenant_caps.json", "application.csv"):
            self.assertNotIn(restated, self.section, f"the section restates the file map ({restated})")

    def test_the_section_stays_a_pointer(self):
        # The length budget, enforced rather than requested. A section that can grow without a failing test grows
        # until it is the thing it was supposed to point at.
        size = len(self.section.encode("utf-8"))
        self.assertLess(size, UNCONFIGURED_SECTION_BUDGET,
                        f"the section is {size} bytes; the budget is {UNCONFIGURED_SECTION_BUDGET}")

    def test_the_one_sentence_the_whole_section_turns_on_is_not_buried(self):
        # "A blank the drafter reports is the correct outcome" is the instruction an agent needs at the moment it
        # is looking at an empty required field. Asserted separately from the list above because a rewrite that
        # kept every keyword and dropped this sentence would pass that test and lose the point. The distance bound
        # is generous on purpose, and `re.S` is required: in the shipped file the sentence wraps, so "blank" and
        # "reports" are separated by a newline and a line-leading bullet dash rather than by words.
        # `assertRegex` takes no flags argument — its third parameter is the failure message — so this searches
        # explicitly rather than passing `re.S` into a slot that would have swallowed it.
        self.assertTrue(re.search(r"[Bb]lank.{0,140}reports?.{0,140}correct outcome", self.section, re.S),
                        "the section must keep the sentence saying a reported blank is the correct outcome")


class SkillFrontmatterContractTest(unittest.TestCase):
    """Every `skills/*/SKILL.md` must keep the frontmatter DSH can actually load.

    The three failure modes are the ones `AGENTS.md` rule 10 records, and each is silent: an unquoted description
    containing `": "` makes the frontmatter a nested mapping (the skill is dropped), a `name` that does not match
    the folder makes it unroutable, and an oversized file has its middle replaced by a compaction summary when a
    session loads it. None of them raises anywhere; all three are load-time behaviour.
    """

    def setUp(self):
        self.skills = sorted(p for p in SKILLS.glob("*/SKILL.md") if p.is_file())

    def frontmatter(self, path: pathlib.Path) -> str:
        text = read(path)
        self.assertTrue(text.startswith("---\n"), f"{path} does not open with a YAML frontmatter block")
        end = text.index("\n---", 3)
        return text[4:end + 1]

    def test_there_are_skills_to_check(self):
        self.assertGreaterEqual(len(self.skills), 2, "no SKILL.md found — the gate would pass vacuously")

    def test_every_skill_parses_as_the_flat_yaml_frontmatter_dsh_expects(self):
        for path in self.skills:
            with self.subTest(skill=path.parent.name):
                block = self.frontmatter(path)
                self.assertTrue(block.strip(), f"{path} has an empty frontmatter block")
                for line in block.splitlines():
                    if not line.strip():
                        continue
                    self.assertRegex(line, r"^[A-Za-z_][\w-]*: \S",
                                     f"{path}: {line!r} is not a `key: value` pair — a continued or nested line "
                                     f"here is how the whole block stops being loadable YAML")

    def test_the_name_matches_the_folder_it_sits_in(self):
        for path in self.skills:
            with self.subTest(skill=path.parent.name):
                name = re.search(r"^name: (.+)$", self.frontmatter(path), flags=re.M)
                self.assertIsNotNone(name, f"{path} has no `name`")
                self.assertEqual(name.group(1).strip(), path.parent.name,
                                 "a skill whose name is not its folder cannot be routed to")

    def test_a_description_containing_a_colon_space_is_quoted(self):
        # The 2026-10-01 defect, and the reason this file exists. `description: Use when X: do Y` is not a string
        # to YAML — it is a mapping whose value is `do Y` — so the block fails and DSH drops the skill from every
        # session without a word. The rule is asserted as the parser reads it, on the raw line.
        for path in self.skills:
            with self.subTest(skill=path.parent.name):
                line = re.search(r"^description: (.+)$", self.frontmatter(path), flags=re.M)
                self.assertIsNotNone(line, f"{path} has no `description` — the routing line every session needs")
                value = line.group(1)
                if '": "' in value:
                    self.assertTrue(value.startswith(('"', "'")) and value.endswith(value[0]),
                                    f"{path} has an unquoted description containing '\": \"' — YAML reads that "
                                    f'as a nested mapping and drops the skill. Quote it: description: "{value}"')

    def test_the_description_fits_the_directory_line(self):
        # A description is what a harness shows in its skill list before anything is loaded. Past 300 characters
        # the line is truncated and the routing clue at its end is what gets lost.
        for path in self.skills:
            with self.subTest(skill=path.parent.name):
                line = re.search(r"^description: (.+)$", self.frontmatter(path), flags=re.M).group(1)
                value = line.strip().strip('"').strip("'")
                self.assertLessEqual(len(value), 300, f"{path}: description is {len(value)} characters")

    def test_every_skill_survives_being_loaded_whole(self):
        # DSH replaces an oversized skill result with its first ~4 KB and last ~1 KB, so a SKILL.md past the limit
        # reaches the session with a hole in the middle. The number is the harness's; the invariant is ours.
        for path in self.skills:
            with self.subTest(skill=path.parent.name):
                size = len(read(path).encode("utf-8"))
                self.assertLess(size, 8192, f"{path} is {size} bytes; a loaded skill must stay under 8192")

    def test_the_quoted_description_can_be_pasted_back(self):
        # The self-check `AGENTS.md` asks for: print the exact quoted form so a failing author has the line to
        # paste rather than a description of the line. Also proves quoting is a no-op for the values already
        # correct, which is what makes the instruction safe to apply to every skill.
        for path in self.skills:
            with self.subTest(skill=path.parent.name):
                value = re.search(r"^description: (.+)$", self.frontmatter(path), flags=re.M).group(1).strip()
                unquoted = value[1:-1] if value.startswith('"') and value.endswith('"') else value
                self.assertNotIn('"', unquoted, "a double quote inside the value must be escaped or avoided")


if __name__ == "__main__":
    unittest.main()
