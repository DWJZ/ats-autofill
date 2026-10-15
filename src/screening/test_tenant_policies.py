#!/usr/bin/env python3
"""The tenant policy file is data, and data needs a shape it cannot drift out of.

A tenant fact - "Tailscale refuses for sponsorship", "CrowdStrike's bar is company-wide" - is not a
lesson and cannot become a test: it says what one employer does, not how to do anything. It belongs in
`data/tenant_policies.json` rather than in the case narrative, where it had to be found by reading.

What CAN be tested is the file's shape and the facts that were expensive to learn. The two guard rails
below are deliberately different in kind: one keeps the schema honest, the other is a short list of
entries whose loss would mean a wasted tailoring cycle or a wasted application.
"""
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

POLICIES = DATA_DIR / "tenant_policies.json"
POLICIES_ALLOWED = {"skip", "no_sponsorship", "cap", "form_only_bar"}
EVIDENCE_ALLOWED = {"posting", "form", "rejection_mail", "board_wide", "confirmation_page"}


class TenantPolicyFileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(POLICIES.read_text(encoding="utf-8"))
        cls.tenants = cls.data["tenants"]

    def test_the_file_is_readable_and_self_describing(self):
        self.assertIn("_note", self.data, "the file must say why it exists and what replaced")
        self.assertIn("_fields", self.data, "the field meanings belong in the file, not in a reader's head")
        self.assertTrue(self.tenants, "an empty policy file is not a policy file")

    def test_every_entry_carries_a_policy_and_its_evidence(self):
        problems = []
        for entry in self.tenants:
            for field in ("tenant", "policy", "evidence", "learned", "detail"):
                if not entry.get(field):
                    problems.append(f"{entry.get('tenant', '?')}: missing {field}")
            if entry.get("policy") not in POLICIES_ALLOWED:
                problems.append(f"{entry.get('tenant')}: unknown policy {entry.get('policy')!r}")
            if entry.get("evidence") not in EVIDENCE_ALLOWED:
                problems.append(f"{entry.get('tenant')}: unknown evidence {entry.get('evidence')!r}")
        self.assertEqual(problems, [])

    def test_caps_are_NOT_recorded_here(self):
        # The anti-duplication guard, and it is here because I broke it. `data/form_specs/tenant_caps.json`
        # already held all of these in machine-readable form and `preflight_role.py` reads it to refuse a
        # capped board BEFORE a form is opened. I distilled the same eleven caps out of prose into this file
        # without checking, which made two sources for one number - the exact shape of problem this whole
        # line of work exists to remove. A cap belongs where it is enforced.
        caps_here = [entry["tenant"] for entry in self.tenants if entry["policy"] == "cap"]
        self.assertEqual(caps_here, [],
                         "caps belong in data/form_specs/tenant_caps.json, which the preflight reads")
        self.assertIn("_see_also", self.data,
                      "this file must point at the caps rather than quietly not mentioning them")

    def test_no_tenant_is_recorded_twice(self):
        # Two rows for one tenant means one of them is stale, and a stale skip costs applications.
        names = [entry["tenant"] for entry in self.tenants]
        self.assertEqual(len(names), len(set(names)), f"duplicate tenant: {names}")

    def test_the_expensive_facts_are_still_here(self):
        # Each of these cost a tailoring cycle or an application to learn, and each is the kind of thing
        # a tidy-up would drop. Named individually so dropping one fails here rather than in a form.
        #
        # THEY ARE ONE PERSON'S OWN HISTORY, so a checkout carrying only `examples/` has none of them: the file
        # then records a different set of tenants entirely and this ratchet has nothing to hold. It skips in
        # that case rather than reporting eight missing entries nobody ever had, and it still FAILS when the
        # file does carry this history and one entry has gone - which is the state it exists to catch.
        wanted = ["Tailscale", "Render", "CrowdStrike", "Teamworks", "Babel Street",
                  "Garner Health", "Retell AI", "Skydio"]
        by_tenant = {entry["tenant"]: entry for entry in self.tenants}
        if not any(tenant in by_tenant for tenant in wanted):
            raise unittest.SkipTest(
                "the installed tenant_policies.json records none of these tenants: they are this project's "
                "own learned history (one rejection, posting or form per tenant) and the example file ships "
                "different, invented ones")
        for tenant in wanted:
            self.assertIn(tenant, by_tenant, f"{tenant} is a recorded tenant policy")
        self.assertEqual(by_tenant["Tailscale"]["evidence"], "rejection_mail",
                         "Tailscale is the case where only the rejection reveals the bar")
        self.assertEqual(by_tenant["Babel Street"]["evidence"], "form",
                         "Babel Street is the case where only the form reveals the bar")

    def test_the_scanner_reads_the_skips_from_this_file(self):
        """A `skip` policy is only enforced if the scanner that surfaces candidates actually reads it.

        `scan_registry_fresh.py` carried its own literal set of do-not-retry tenants with a comment asking the
        next reader to keep it in step with the documentation, and it had drifted: five tenants this file
        records as `skip` were absent from it, so their roles were still reported as candidates. The scanner
        derives its set from this file now, and this is the assertion that keeps it derived - a policy added
        here that the scanner does not see fails here rather than in a scan nobody reads closely.

        A checkout whose policy file records no skip at all - the example file, which ships invented tenants -
        has nothing for this to hold, so it skips rather than asserting about a set nobody ever had.
        """
        skipping = {entry["tenant"].strip().lower() for entry in self.tenants if entry["policy"] == "skip"}
        if not skipping:
            raise unittest.SkipTest(
                "the installed tenant_policies.json records no `skip` policy, so there is no skip for the "
                "scanner to have read: the example file ships invented tenants with other policies")

        sys.path.insert(0, str(ROOT / "src" / "screening"))
        from tenant_caps import norm_slug, tenant_skip_names  # noqa: PLC0415 -- needs that path insert

        # Asked for THE INSTALLED FILE, not a copy of its contents: the subject is whether the reader and the
        # file agree, and passing `POLICIES` is what makes this fail when they stop agreeing.
        DO_NOT_RETRY = tenant_skip_names(POLICIES)

        for tenant in sorted(skipping):
            with self.subTest(tenant=tenant):
                self.assertIn(tenant, DO_NOT_RETRY,
                              f"{tenant} is a skip policy the scanner would still surface")
                # The board slug is the other form the scanner sees a tenant in, and the two do not have to
                # be spelled alike - the policy file carries a display name, the URL carries a slug.
                self.assertIn(norm_slug(tenant), DO_NOT_RETRY,
                              f"{tenant} would be skipped by name but not by its board slug")

        # The other direction, so this is the derivation and not a rubber stamp: every name the reader returns
        # comes from a `skip` entry in THIS file, which is what catches a reader keyed on some other field.
        self.assertTrue(DO_NOT_RETRY, "a skip set derived from this file must not be empty here")
        for name in DO_NOT_RETRY:
            self.assertTrue(
                name in skipping or name in {norm_slug(tenant) for tenant in skipping},
                f"{name} is in the scanner's skip set but is not a skip policy here")


CAPS = DATA_DIR / "form_specs" / "tenant_caps.json"
CAP_KINDS = {"count", "active", "one_at_a_time", "same_role_cooldown"}


class TenantCapFileTest(unittest.TestCase):
    """The operative caps file, which the preflight reads and nothing tested.

    It is the one file where a cap MUST live: the Mercor refusal on 2026-10-05 happened at Submit, after a
    complete fill and a passing gate, because the cap was documented in prose and nothing consulted it.
    """
    #: The boards this project's own caps were learned on. `examples/tenant_caps.example.json` records none of
    #: them, which is what the guard below keys on.
    LEARNED_BOARDS = ("roblox", "coinbase", "applied", "oneapp")

    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(CAPS.read_text(encoding="utf-8"))
        cls.caps = cls.data["caps"]

    def require_learned_boards(self) -> None:
        """Skip the per-board assertions when this checkout has none of the boards they are about.

        A cap is a fact found in one employer's posting, mail or form, so these three assertions describe this
        project's own caps file. The example file carries invented boards instead, and the check below is
        deliberately about PRESENCE: a real file that is missing `roblox` still fails.
        """
        if not any(entry["slug"] in self.LEARNED_BOARDS for entry in self.caps):
            raise unittest.SkipTest(
                "the installed caps file records none of this project's own boards "
                f"({', '.join(self.LEARNED_BOARDS)}): the examples ship invented ones, so the caps these "
                "three tests are about do not exist here")

    def test_every_entry_is_a_cap_the_preflight_can_use(self):
        # The preflight refuses a board by comparing a submission count against cap and window_days, so an
        # entry missing either, or carrying a kind it does not know, is an entry that silently does nothing.
        problems = []
        for entry in self.caps:
            for field in ("slug", "cap", "window_days", "kind", "note", "source"):
                if entry.get(field) in (None, ""):
                    problems.append(f"{entry.get('slug', '?')}: missing {field}")
            if entry.get("kind") not in CAP_KINDS:
                problems.append(f"{entry.get('slug')}: unknown kind {entry.get('kind')!r}")
            if not isinstance(entry.get("cap"), int) or entry["cap"] < 1:
                problems.append(f"{entry.get('slug')}: cap must be a positive integer")
        self.assertEqual(problems, [])

    def test_every_extra_stated_limit_is_usable_too(self):
        # `also_stated` rules are weighed exactly like the recorded one - the board is refused when ANY of them
        # is reached - so they need the same fields. A malformed extra rule is one that looks enforced and is not.
        problems = []
        for entry in self.caps:
            for extra in entry.get("also_stated") or []:
                for field in ("cap", "window_days", "kind", "source"):
                    if extra.get(field) in (None, ""):
                        problems.append(f"{entry['slug']}: also_stated missing {field}")
                if extra.get("kind") not in CAP_KINDS:
                    problems.append(f"{entry['slug']}: also_stated unknown kind {extra.get('kind')!r}")
                if not isinstance(extra.get("cap"), int) or extra["cap"] < 1:
                    problems.append(f"{entry['slug']}: also_stated cap must be a positive integer")
        self.assertEqual(problems, [])

    def test_no_board_is_listed_twice(self):
        slugs = [entry["slug"] for entry in self.caps]
        self.assertEqual(len(slugs), len(set(slugs)), "a slug twice means one entry never applies")

    def test_roblox_is_recorded(self):
        # The one cap the operative file was missing. It came from the mailbox rather than a posting, and it
        # is the harsher kind: Roblox CLOSES the excess instead of refusing it, so a sixth application inside
        # the window would not be rejected - it would be withdrawn.
        self.require_learned_boards()
        roblox = [entry for entry in self.caps if entry["slug"] == "roblox"]
        self.assertEqual(len(roblox), 1)
        self.assertEqual((roblox[0]["cap"], roblox[0]["window_days"]), (5, 30))

    def test_coinbase_keeps_both_of_the_limits_it_states(self):
        # 2026-10-09. The posting's tail says 3 per 6 months; the tenant's own mail says 4 per 30 days, and those
        # notices arrived for requisitions that had been submitted AND confirmed four days earlier. One number
        # cannot hold both, and the posted figure must not be relaxed to the mailed one just because it is looser.
        self.require_learned_boards()
        coinbase = [entry for entry in self.caps if entry["slug"] == "coinbase"]
        self.assertEqual(len(coinbase), 1)
        self.assertEqual((coinbase[0]["cap"], coinbase[0]["window_days"]), (3, 180),
                         "the recorded limit is the posting's, which is the stricter of the two")
        self.assertEqual([(extra["cap"], extra["window_days"]) for extra in coinbase[0].get("also_stated", [])],
                         [(4, 30)], "the limit its mail states is recorded too, not folded into the first")

    def test_the_two_caps_keyed_by_company_name_are_gone(self):
        # `applied intuition` and `onepay` are how the tracker spells two employers; the boards spell themselves
        # `applied` (Ashby) and `oneapp`. preflight_role.py is handed the board slug out of the posting's url, so
        # both entries could never match and neither limit ever fired. test_tenant_caps.py proves they now do.
        self.require_learned_boards()
        slugs = {entry["slug"] for entry in self.caps}
        self.assertIn("applied", slugs)
        self.assertIn("oneapp", slugs)
        self.assertNotIn("applied intuition", slugs)
        self.assertNotIn("onepay", slugs)


if __name__ == "__main__":
    unittest.main()
