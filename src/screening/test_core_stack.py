#!/usr/bin/env python3
"""The core-stack pass, which the screening gained because `do_not_claim` did not cover it.

Growfig: a Founding Engineer posting passed every screen - `do_not_claim` reported none - on a
stack sentence reading "How we build Kotlin and Spring Boot, React and NextJS, Postgres, GCP, Gemini and Anthropic".
Kotlin is not in `do_not_claim`; the exclusion comes from the role-priority rule instead, so two different sources
existed and the scanner read one. `screen_urls.py` read both afterwards, and nothing has tested it since.

The word boundaries in that check are not decoration, and they are the reason this file exists. `Java` is a
DROP_STACK language and `JavaScript` is an allowed one, so a substring test would skip every JavaScript role while
reporting that it had found Java.
"""
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("screen_urls", ROOT / "src/screening/screen_urls.py")
screen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(screen)


def stack_of(desc: str) -> list[str]:
    """What `report()` computes, without the printing."""
    import re
    return [k for k in screen.STACK
            if re.search(rf"(?<![A-Za-z]){re.escape(k)}(?![A-Za-z])", desc, re.I)]


class CoreStackTest(unittest.TestCase):
    def test_javascript_is_not_java(self):
        # The whole reason the matcher uses boundaries. A JavaScript role is allowed; a Java-core role is not.
        found = stack_of("We build with JavaScript and TypeScript on Node.")
        self.assertIn("JavaScript", found)
        self.assertNotIn("Java", found)
        self.assertEqual([k for k in found if k in screen.DROP_STACK], [],
                         "a JavaScript role must not be dropped as Java-core")

    def test_the_growfig_sentence_now_reads_both_sources(self):
        # The case's own stack sentence. `do_not_claim` reported none for this posting; the core-stack pass is what
        # catches it.
        desc = ("How we build Kotlin and Spring Boot, React and NextJS, Postgres, GCP, Gemini and Anthropic")
        dropped = [k for k in stack_of(desc) if k in screen.DROP_STACK]
        self.assertIn("Kotlin", dropped)

    def test_the_languages_the_role_priority_rule_names_are_the_ones_dropped(self):
        self.assertEqual(screen.DROP_STACK, {"Java", "Kotlin", "C#", "PHP", "Ruby"})

    def test_a_language_in_neither_list_is_not_an_automatic_skip(self):
        # The case is explicit: Rust, Go and Elixir are not skips. Footprint's backend role led with Rust and was
        # applied to, because the must-haves were about the work rather than the language.
        for lang in ("Rust", "Go"):
            found = stack_of(f"We are deep in {lang} and Postgres.")
            self.assertIn(lang, found, "the language must still be REPORTED as part of the stack")
            self.assertNotIn(lang, screen.DROP_STACK, "but it must not be a drop on its own")

    def test_a_language_mentioned_inside_another_word_is_not_a_hit(self):
        # Kotlin and C# have the same shape of problem available: a substring test finds them inside longer tokens.
        self.assertNotIn("C#", stack_of("The C#sharpening exercise is unrelated."))
        self.assertNotIn("Ruby", stack_of("We use RubyMine as an editor."))


if __name__ == "__main__":
    unittest.main()
