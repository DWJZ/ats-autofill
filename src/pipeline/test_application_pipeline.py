from __future__ import annotations

import re
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import DATA_DIR  # noqa: E402  (the sys.path insert above is what makes it importable)

sys.path.insert(0, str(Path(__file__).resolve().parent))

import application_pipeline as pipeline


class TheStandingAnswerTableStaysSeparable(unittest.TestCase):
    """`ashby_yesno.mjs` answers yes/no pairs from `data/form_specs/ashby_pairs_standing.json` and must skip the rest.

    The table mixes control kinds: most rules are yes/no, but a third of them carry `answer: option` or `answer: value`
    and describe a select or a text field. The eight-script version computed `rule.answer === "yes" ? "Yes" : "No"`, so
    every one of those would have pressed **No** on whatever pair its pattern matched. This test pins the invariant the
    unified tool depends on: the two kinds stay distinguishable, and there really are non-yes/no rules to skip.
    """

    TABLE = DATA_DIR / "form_specs" / "ashby_pairs_standing.json"

    def rules(self):
        # The table is per-tenant configuration - Ashby wordings answered once for the boards this project
        # drives - and it is not one of the files `scripts/setup-examples.sh` creates. Without it these three
        # assertions have no subject, so they skip rather than assert against a table that is not here.
        if not self.TABLE.is_file():
            raise unittest.SkipTest(
                "data/form_specs/ashby_pairs_standing.json is per-tenant config that does not ship with this "
                "checkout, so the standing-answer table has no subject here")
        return json.loads(self.TABLE.read_text(encoding="utf-8")).get("rules", [])

    def test_the_table_parses_and_has_rules(self):
        rules = self.rules()
        self.assertGreater(len(rules), 0, "an empty table would make the yes/no tool press nothing")
        for rule in rules:
            self.assertIn("questionRe", rule)
            self.assertIn("answer", rule)

    def test_the_yesno_subset_is_identifiable_and_non_empty(self):
        rules = self.rules()
        yesno = [r for r in rules if str(r["answer"]).lower() in ("yes", "no")]
        self.assertGreater(len(yesno), 0)
        for rule in yesno:
            self.assertIn(str(rule["answer"]).lower(), ("yes", "no"))

    def test_rules_for_other_control_kinds_still_exist_and_are_skipped(self):
        """If this ever reaches zero, the filter and this test have both stopped meaning anything."""
        others = [r for r in self.rules() if str(r["answer"]).lower() not in ("yes", "no")]
        self.assertGreater(len(others), 0,
                           "no non-yes/no rules left — the skip in ashby_yesno.mjs is no longer exercised")
        for rule in others:
            self.assertTrue(str(rule["answer"]).lower() in ("option", "value", "text"),
                            f"unexpected answer kind {rule['answer']!r}; decide whether a tool must handle it")


class EveryDetectablePlatformIsOneThePipelineAccepts(unittest.TestCase):
    """`detect_platform` names the platform, and the caller that acts on that name must know the word.

    This was a reference-file lookup that fell back to the `unsupported` entry silently, which is how a platform
    ends up being handed another platform's instructions. That failure happened for real: a caller guessed the
    platform itself (defaulting to "ashby") and disagreed with `detect_platform` on 77 of the tracker's 1,328
    urls, including **25 Workday postings that would have been handed the Ashby map**. The files are gone; the
    invariant is not. `detect_platform` is what `prepare` and `handover` take their platform from, and both feed
    it into `PLATFORM_CHOICES`, so a platform this function can return and that list does not hold is a posting
    the pipeline detects correctly and then refuses to prepare.
    """

    # One real url per platform detect_platform recognises. A new platform must be added here, with a driver.
    SAMPLES = {
        "https://job-boards.greenhouse.io/twitch/jobs/1": "greenhouse",
        "https://jobs.ashbyhq.com/example/1": "ashby",
        "https://blackline.wd108.myworkdayjobs.com/en-US/BlackLineCareers/job/Remote---": "workday",
        "https://jobs.lever.co/loftorbital/efcaba8e-6bbb-4322-884c-c10c03469669": "lever",
        "https://jobs.smartrecruiters.com/oneclick-ui/company/ServiceNow/publication/8d": "smartrecruiters",
        "https://careers.chewy.com/us/en/job/R30695/Software-Engineer-I": "phenom",
        "https://apply.careers.microsoft.com/careers/job/1970393556977374": "eightfold",
        "https://apply.workable.com/j/457FBDEE30": "workable",
        "https://tracker.mccoy.io/postings/meta%3A1570473568087646": pipeline.UNSUPPORTED_PLATFORM,
    }

    def test_each_sample_resolves_to_the_platform_it_is_labelled_with(self):
        for url, expected in self.SAMPLES.items():
            with self.subTest(url=url):
                self.assertEqual(pipeline.detect_platform(url), expected)

    def test_every_detectable_platform_is_a_platform_the_pipeline_accepts(self):
        # The catch-all is the one name `--platform` must NOT accept: it is a refusal, not a platform, so it is
        # asserted to be absent from the choices below rather than present in them.
        for platform in set(self.SAMPLES.values()):
            with self.subTest(platform=platform):
                if platform == pipeline.UNSUPPORTED_PLATFORM:
                    self.assertNotIn(platform, pipeline.PLATFORM_CHOICES,
                                     "the catch-all must stay out of the choices - it is what prepare refuses")
                else:
                    self.assertIn(platform, pipeline.PLATFORM_CHOICES,
                                  f"{platform} would be detected and then rejected by every subcommand")


class ThePlatformIsNeverAHardcodedLiteral(unittest.TestCase):
    """`prepare` resolves the platform from the posting, not from whatever a caller asserts.

    Measured when a caller asserted it: the tracker holds 1,328 urls, of which 730 are Ashby and 598 (45%) are
    not; over the profiles `prepare` actually receives, 538 of 1,270 (42%) were mis-declared. `prepare` does not
    merely label with that value - it drives `build_or_update_platform_config`, which has a per-platform branch,
    so a Greenhouse posting was written an Ashby-shaped config.

    These guard the resolution end: every real posting must resolve to something other than a guess, and an
    explicit `--platform` must still win. The assertions that read a CALLER's text went with the private driver
    they were reading - a checkout has no caller of its own to inspect, and `prepare` defaults to `auto`.
    """

    def test_prepare_resolves_the_platform_from_the_profile_it_is_handed(self):
        """`auto` is only correct because prepare does this itself. Pin the line, so the two do not drift apart."""
        source = (pipeline.ROOT / "src" / "pipeline" / "application_pipeline.py").read_text(encoding="utf-8")
        self.assertIn('detect_platform(role_profile["source"], args.platform)', source)

    def test_every_tracker_url_resolves_and_the_unknowns_are_few_and_known(self):
        """Not an equality assertion: the count of unrecognised hosts is a fact to watch, not a target. What must
        hold is that the recognised ones vastly outnumber them, so a detection regression is loud."""
        sys.path.insert(0, str(pipeline.ROOT / "src" / "screening"))
        from tracker_index import load_rows

        resolved, unknown = 0, 0
        for row in load_rows():
            url = (row.get("source") or "").strip()
            if not url:
                continue
            if pipeline.detect_platform(url, "auto") == "unsupported":
                unknown += 1
            else:
                resolved += 1
        # The floor is about the tracker this was written against (1,328 urls), and the example tracker
        # shipped with a fresh checkout holds two rows - a scale at which neither count means anything.
        if resolved + unknown < 1000:
            raise unittest.SkipTest(
                f"the installed tracker holds {resolved + unknown} urls; this check compares a recognised-host "
                "count against a floor of 1000 and describes a full tracker, not an example one")
        self.assertGreater(resolved, 1000)
        self.assertLess(unknown, 40, "the unrecognised-host count jumped; check detect_platform before trusting it")

    def test_an_explicit_platform_still_overrides_detection(self):
        """The escape hatch prepare's error message points at must keep working."""
        self.assertEqual(pipeline.detect_platform("https://example.invalid/job/1", "greenhouse"), "greenhouse")


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class TheFillerRefusesToSubmit(unittest.TestCase):
    """The safety property the fill path rests on: a spec that asks for a submit must be refused.

    `assertNoSubmit` used to live in `src/autofill/unified_runner.mjs`, which nothing called, and the only test
    that exercised it was not run by `npm test` or the hook — so the guard existed and never executed. It now sits
    in `src/forms/spec_guard.mjs` next to the filler that imports it, and these tests drive that real module.
    """

    GUARD = ROOT / "src" / "forms" / "spec_guard.mjs"

    def drive(self, spec: dict) -> subprocess.CompletedProcess:
        """Run assertNoSubmit from the real module under node, so the module itself is under test."""
        with tempfile.TemporaryDirectory() as tmp:
            driver = Path(tmp) / "drive.mjs"
            payload = Path(tmp) / "spec.json"
            payload.write_text(json.dumps(spec), encoding="utf-8")
            driver.write_text(
                f'import {{ readFileSync }} from "node:fs";\n'
                f'import {{ assertNoSubmit }} from "{self.GUARD}";\n'
                f'assertNoSubmit(JSON.parse(readFileSync("{payload}", "utf8")));\n'
                f'console.log("accepted");\n',
                encoding="utf-8",
            )
            return subprocess.run(["node", str(driver)], capture_output=True, text=True, timeout=60)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_a_spec_that_submits_is_refused(self):
        for bad in ({"target": "x", "submit": True},
                    {"target": "x", "actions": [{"type": "click", "name": "Submit"}]},
                    {"target": "x", "actions": [{"type": "click", "name": "Submit application"}]},
                    {"texts": [{"ref": "a", "value": "x"}], "nested": {"submit": True}}):
            with self.subTest(spec=bad):
                result = self.drive(bad)
                self.assertNotEqual(result.returncode, 0, "the guard must reject this")
                self.assertIn("submit action", result.stderr)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_the_shapes_the_filler_actually_accepts_still_pass(self):
        good = {"target": "job_application_requests", "texts": [{"ref": "id:first_name", "value": "Example"}],
                "selects": [{"ref": "id:q2", "option": "Yes", "search": "Yes"}],
                "checks": [{"ref": "id:cb1", "checked": True}], "files": [{"ref": "group:Resume/CV", "path": "/a.pdf"}],
                "verify_blank": True, "submit": False}
        result = self.drive(good)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("accepted", result.stdout)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_every_real_spec_on_disk_passes_the_guard(self):
        specs = sorted((DATA_DIR / "form_specs").glob("*.json"))
        if not specs:
            self.skipTest("no specs on disk")
        with tempfile.TemporaryDirectory() as tmp:
            driver = Path(tmp) / "sweep.mjs"
            driver.write_text(
                f'import {{ readFileSync, readdirSync }} from "node:fs";\n'
                f'import {{ assertNoSubmit }} from "{self.GUARD}";\n'
                f'const dir = "{DATA_DIR / "form_specs"}";\n'
                f'const bad = [];\n'
                f'for (const name of readdirSync(dir).filter(n => n.endsWith(".json"))) {{\n'
                f'  try {{ assertNoSubmit(JSON.parse(readFileSync(dir + "/" + name, "utf8"))); }}\n'
                f'  catch (e) {{ bad.push(name + ": " + e.message); }}\n'
                f'}}\n'
                f'if (bad.length) {{ console.error(bad.slice(0, 10).join("\\n")); process.exit(1); }}\n'
                f'console.log("all clean");\n',
                encoding="utf-8",
            )
            result = subprocess.run(["node", str(driver)], capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr[:600])
            self.assertIn("all clean", result.stdout)


class ApplicationPipelineTests(unittest.TestCase):
    # One saved role profile per application, written for a specific posting: this is the author's own
    # application record and is NOT part of this checkout. It used to be read in setUp, so its absence raised
    # FileNotFoundError before a single test ran and took down the tests here that need no such file at all.
    ROLE_PROFILE = DATA_DIR / "resume_profiles" / "twitch_software_engineer_i_memberships.json"

    def setUp(self):
        self.application_profile = json.loads((DATA_DIR / "application_profile.json").read_text())
        self.candidate_profile = json.loads((DATA_DIR / "candidate_profile.json").read_text())

    def role_profile(self) -> dict:
        """The saved role profile an assertion is written against, or a skip when this checkout has none."""
        if not self.ROLE_PROFILE.is_file():
            raise unittest.SkipTest(
                "data/resume_profiles/ holds one saved role profile per application - private material that "
                "does not ship with this checkout - so this assertion has no profile to read")
        return json.loads(self.ROLE_PROFILE.read_text())

    def test_detect_platform(self):
        cases = {
            "https://job-boards.greenhouse.io/twitch/jobs/1": "greenhouse",
            "https://jobs.ashbyhq.com/example/1": "ashby",
            "https://example.wd1.myworkdayjobs.com/job/1": "workday",
            "https://careers.chewy.com/us/en/job/1": "phenom",
            "https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/1": "smartrecruiters",
            "https://example.com/jobs/1": "unsupported",
        }
        for url, expected in cases.items():
            self.assertEqual(pipeline.detect_platform(url), expected)

    def test_current_twitch_profile_passes_claim_validation(self):
        result = pipeline.validate_profile(
            self.role_profile(), self.application_profile, self.candidate_profile
        )
        self.assertTrue(result["ok"])

    def test_forbidden_claim_does_not_confuse_java_with_javascript(self):
        # AN INLINE PROFILE, not the saved one. The subject is `validate_profile`'s own word-boundary matching,
        # and the saved profile this used to read is one application's private record. The forbidden term is
        # supplied here so the case states its own premise instead of depending on somebody's do_not_claim list.
        role = {"company": "Example", "role": "Example Engineer", "source": "https://example.invalid/jobs/1",
                "summary": "Built production JavaScript applications."}
        candidate = {"do_not_claim": ["Java"]}
        pipeline.validate_profile(role, self.application_profile, candidate)

        java_claim = dict(role, summary="Built production Java services.")
        with self.assertRaisesRegex(ValueError, "Java"):
            pipeline.validate_profile(java_claim, self.application_profile, candidate)

    def test_tracker_preserves_submitted_status(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = Path(directory) / "applications.csv"
            original = {
                "date_added": "2026-09-10",
                "company": "Example",
                "title": "Engineer",
                "source": "https://example.com/jobs/1",
                "eligibility": "NO_EXPLICIT_RESTRICTION_FOUND",
                "recommended_track": "backend",
                "track_scores": "{}",
                "status": "submitted_by_agent",
                "notes": "submitted",
            }
            pipeline.upsert_tracker(original, tracker)
            update = dict(original, status="materials_ready", notes="prepared again")
            result = pipeline.upsert_tracker(update, tracker)
            self.assertEqual(result["status"], "submitted_by_agent")

    def test_resume_paths_are_rewritten_recursively(self):
        config = {
            "resume_path": "/old/resume.docx",
            "steps": {"one": [{"type": "upload", "path": "/old/resume.docx"}]},
        }
        expected = Path("/new/resume.pdf")
        pipeline.recursively_replace_resume_paths(config, expected)
        self.assertEqual(config["resume_path"], str(expected))
        self.assertEqual(config["steps"]["one"][0]["path"], str(expected))

    def test_existing_workday_config_receives_pdf_path(self):
        # An inline role profile for the same reason as the Java/JavaScript case above: the subject is what
        # `build_or_update_platform_config` writes into the config, not any one saved application.
        role = {"company": "Example", "role": "Example Engineer", "source": "https://example.invalid/jobs/1",
                "summary": "Example summary."}
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "workday.json"
            config_path.write_text("{}")
            pdf_path = Path(directory) / "resume.pdf"
            result_path, mapped = pipeline.build_or_update_platform_config(
                "workday",
                "unused",
                role,
                self.application_profile,
                {"work_experience": []},
                pdf_path,
                config_path,
            )
            saved = json.loads(result_path.read_text())
            self.assertTrue(mapped)
            self.assertEqual(saved["resume_path"], str(pdf_path))

    # preflight used to print the platform's per-ATS reference file here, and with the reference files gone the
    # tests that resolved and read one had no subject left: `read_first_block` returning a block, the guidance
    # banner naming the file, and the tenant half appearing only for a known company. The duplication that made
    # them worth keeping is gone with the mechanism - the routing itself is asserted by
    # `EveryDetectablePlatformIsOneThePipelineAccepts` above.
    def test_atoms_profile_uses_reusable_gpa_paragraph_replacement(self):
        # One application's saved role profile again - "atoms" is a tenant, and the assertion is about the
        # wording that tenant's form needed. Private material, so the subject is absent here.
        atoms = DATA_DIR / "resume_profiles" / "atoms_software_engineer_new_grad.json"
        if not atoms.is_file():
            raise unittest.SkipTest(
                "data/resume_profiles/atoms_software_engineer_new_grad.json is a saved per-application "
                "profile and is not part of this checkout")
        profile = json.loads(atoms.read_text())
        self.assertEqual(
            profile["paragraph_replacements"]["M.S. in Example Field of Study"],
            "M.S. in Example Field of Study | GPA: 4.0",
        )


def load_assistant_with_profile(case: unittest.TestCase, profile: dict):
    """`job_app_assistant` with a candidate profile THIS TEST supplies, not the installed one.

    The module reads its profile path from `ATS_DATA_DIR` at import time (`src/paths.py` reads the setting
    once, deliberately), so a test that wants a stated `work_authorization` or a profile of its own shape
    has to set the directory and re-import rather than mutate somebody's installed profile. The directory
    comes back with the module, because a test that drives the CLI as a SUBPROCESS has to set the variable
    for that process too - the re-import only reaches this one.

    THE DIRECTORY IS REMOVED BY THE CASE'S OWN CLEANUP, and the case is a parameter because of it: this
    function cannot remove what it hands back - the directory has to outlive the call, one caller points a
    subprocess at it - and a temporary file nobody owns is the leak this suite had 16 of per run.
    `addCleanup` is the whole mechanism: it runs on every way out of a test, passing, failing, erroring or
    skipping, which is more than a line after the call would cover.
    """
    directory = tempfile.mkdtemp(prefix="assistant-profile-")
    case.addCleanup(shutil.rmtree, directory, ignore_errors=True)
    path = Path(directory) / "candidate_profile.json"
    path.write_text(json.dumps(profile, ensure_ascii=False), encoding="utf-8")
    previous = os.environ.get("ATS_DATA_DIR")
    os.environ["ATS_DATA_DIR"] = directory
    import importlib
    import job_app_assistant

    try:
        return Path(directory), profile, importlib.reload(job_app_assistant)
    finally:
        if previous is None:
            os.environ.pop("ATS_DATA_DIR", None)
        else:
            os.environ["ATS_DATA_DIR"] = previous
        importlib.reload(job_app_assistant)


class GeneratedStateStaysOutOfTheSourceTree(unittest.TestCase):
    """A file derived from the applicant's profile is written under the data directory, never in src/.

    THE FILE THAT MADE THIS A TEST. `prepare` wrote `src/autofill/greenhouse/<slug>.json` holding the
    applicant's name, email, phone, city and standard answers. `src/autofill/` also holds real source
    (the Workday helpers), and nothing in .gitignore covered it - so `git add -A` in a configured
    checkout committed a stranger's phone number, which is the one thing rule 3 forbids outright.
    """

    def test_the_autofill_directory_is_inside_the_data_directory(self):
        self.assertEqual(pipeline.AUTOFILL_DIR, DATA_DIR / "autofill")

    def test_no_platform_config_directory_sits_in_the_source_tree(self):
        source = str(pipeline.ROOT / "src")
        for platform in pipeline.PLATFORM_CONFIG_DIRS:
            directory = str(pipeline.AUTOFILL_DIR / platform)
            self.assertFalse(directory.startswith(source),
                             f"{platform} configs would be written inside the source tree: {directory}")

    def test_a_real_run_returns_a_path_under_the_data_directory(self):
        # The load-bearing half: the constant can be right while a platform branch still builds its
        # own path from ROOT. This calls the function that writes the file.
        role = {"company": "Example Corp", "role": "Backend Engineer",
                "source": "https://job-boards.greenhouse.io/example/jobs/1234567",
                "summary": "I am an example.", "track": "backend"}
        app_profile = {
            "candidate": {"name": "Example Candidate", "first_name": "Example",
                          "last_name": "Candidate", "email": "candidate@example.edu",
                          "phone": {"formatted": "+1 555 123 4567"},
                          "address": {"city": "Springfield", "state": "Illinois",
                                      "country": "United States of America"},
                          "linkedin": "https://www.linkedin.com/in/example-candidate"},
            "education": [{"school": "Example State University", "degree": "M.S.",
                           "field_of_study_workday": "Software Engineering"}],
            "work_experience": [{"company": "Example Corp", "title": "Engineer"}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            resume = Path(tmp) / "resume.pdf"
            resume.write_bytes(b"%PDF-1.4\n")
            # `stem` is what names the file; a temp stem keeps this from colliding with a real run.
            written, mapped = pipeline.build_or_update_platform_config(
                "greenhouse", "test_generated_state_stays_out_of_src", role, app_profile, {}, resume)
        self.assertIsNotNone(written, "greenhouse produced no config path at all")
        resolved = Path(written).resolve()
        self.assertTrue(str(resolved).startswith(str(DATA_DIR.resolve())),
                        f"a generated config was written outside the data directory: {resolved}")
        self.assertFalse(str(resolved).startswith(str((pipeline.ROOT / "src").resolve())),
                         f"a generated config was written into the source tree: {resolved}")
        # And it is a file that carries the applicant's own facts, which is why this matters at all.
        self.assertIn("autofill", str(resolved))
        Path(resolved).unlink(missing_ok=True)


class TheTrackerRowSurvivesADataDirectoryOutsideTheCheckout(unittest.TestCase):
    """`prepare` with `ATS_DATA_DIR` outside the repository wrote everything except the tracker row.

    WHAT BROKE, AND FOR WHOM. README.md and docs/CONFIGURATION.md both promise that a second person's
    configuration "can live outside the checkout", and the note that `prepare` writes into the tracker
    spelled the manifest as `manifest_path.relative_to(ROOT)` - which raises `ValueError: '<data>/...' is
    not in the subpath of '<repo>'` for exactly that person. It was raised while the `tracker_row` DICT
    LITERAL was being built, so `upsert_tracker()` on the next line never ran: the DOCX, the PDF, the
    manifest and the autofill config were all on disk and the tracker held no row at all. A later
    `duplicates` or a daily screen therefore could not see that the materials had ever been produced, and
    the only trace of the run was the exception.
    """

    def test_a_manifest_outside_the_checkout_is_a_path_that_still_finds_it(self):
        # `TemporaryDirectory` rather than `mkdtemp`: the assertions below need the directory to exist, and the
        # block removes it on every way out of it - including an assertion failing half way through. It is the
        # idiom the rest of this file already uses for a directory that lives for one test, and the `mkdtemp`
        # this replaces left an empty directory in the machine's temp directory once per run.
        with tempfile.TemporaryDirectory(prefix="manifest-outside-") as directory:
            outside = Path(directory) / "application_bundles" / "role.json"
            spelled = pipeline.manifest_note_path(outside)
            self.assertTrue(Path(spelled).is_absolute(), f"{spelled} is not a path that resolves from elsewhere")
            self.assertEqual(Path(spelled), outside)
            with self.assertRaises(ValueError):
                outside.relative_to(pipeline.ROOT)  # the premise: this is what used to be called

    def test_a_manifest_inside_the_checkout_keeps_the_short_repository_relative_form(self):
        inside = pipeline.ROOT / "data" / "application_bundles" / "role.json"
        self.assertEqual(pipeline.manifest_note_path(inside), str(Path("data") / "application_bundles" / "role.json"))

    def test_the_tracker_write_comes_before_every_other_write_in_the_block(self):
        """The row is recorded before anything else in that block can raise.

        A second assertion on the source, because the first one pins the note's spelling and this pins the
        ORDER, and the order is what made the failure invisible: the same `relative_to` call moved back
        into the literal would pass the two tests above and lose the row again.
        """
        source = (pipeline.ROOT / "src" / "pipeline" / "application_pipeline.py").read_text(encoding="utf-8")
        block = source.split("if not args.no_tracker:", 1)[1].split("ledger.record(", 1)[0]
        self.assertNotIn("manifest_path.relative_to(ROOT)", block,
                         "the note's path is computed inside the block again; the helper is the one place it goes")
        self.assertIn("manifest_note = manifest_note_path(manifest_path)", block)
        self.assertLess(block.index("upsert_tracker(tracker_row)"), block.index("write_json(manifest_path, manifest)"),
                        "the tracker row must be written before any other write in this block")


class NoEmptyEducationRowIsWrittenIntoTheAutofillConfig(unittest.TestCase):
    """A second education entry with an unmapped degree produced `{school: "Other", degree: ""}`.

    WHAT BROKE, AND FOR WHOM. A bachelor's-only applicant - or anyone whose second school carries a degree
    this mapping does not name, `Diploma` among them - got a second education entry in
    `data/autofill/greenhouse/<slug>.json` reading `{school: "Other", degree: "", discipline: "Practical
    Nursing"}` with real start and end years beside it. `degree_option` returns "" for a spelling it does
    not know, and the entry was written anyway. A filler types that row: a form is left saying the
    applicant attended "Other" and holds nothing. The `Other` strategy itself is deliberate and must stay
    - a school absent from a tenant's list is answered as Other - so the subject here is the empty degree,
    not the school name.
    """

    ROLE = {"company": "Example Corp", "role": "Example Nurse", "source": "https://example.invalid/jobs/1",
            "summary": "Example summary."}

    def scaffold_education(self, second_degree) -> list[dict]:
        app_profile = json.loads((DATA_DIR / "application_profile.json").read_text())
        second = dict(app_profile["education"][1])
        if second_degree is None:
            second.pop("degree", None)
        else:
            second["degree"] = second_degree
        app_profile["education"] = [app_profile["education"][0], second]
        config = pipeline.greenhouse_scaffold(self.ROLE, app_profile, Path("/tmp/example_resume.pdf"))
        return config["education"]

    def test_a_second_school_whose_degree_is_unmapped_writes_no_row_at_all(self):
        education = self.scaffold_education("Diploma")
        self.assertEqual(len(education), 1, f"an entry with a degree the mapping cannot fill: {education}")
        self.assertFalse([entry for entry in education if entry.get("school") == "Other"],
                         "the second school is still answered, without a degree to answer with")

    def test_an_absent_degree_is_never_written_as_an_empty_one(self):
        for degree in (None, "Diploma", "Certificate"):
            with self.subTest(degree=degree):
                education = self.scaffold_education(degree)
                empty = [entry for entry in education if entry.get("school") == "Other" and not entry.get("degree")]
                self.assertEqual(empty, [], f"a row a filler would type as 'Other' with no degree: {empty}")

    def test_a_second_school_with_a_known_degree_is_still_answered_as_other(self):
        """The deliberate half. Dropping the empty row must not drop the school answer with it."""
        education = self.scaffold_education("B.S.")
        self.assertEqual(len(education), 2, education)
        self.assertEqual(education[1]["school"], "Other")
        self.assertEqual(education[1]["degree"], "Bachelor's Degree")

    def test_the_first_entry_is_untouched_whatever_the_second_one_holds(self):
        education = self.scaffold_education("Diploma")
        self.assertNotEqual(education[0]["school"], "Other")
        self.assertEqual(education[0]["degree"], "Master's Degree")


class NoTrackIsNamedInCode(unittest.TestCase):
    """The assistant recommended "backend" to people who do not have a backend track.

    WHAT BROKE, AND FOR WHOM. `build_analysis` fell back to the literal `"backend"` whenever every track
    scored 0 - the ordinary case for a posting written without the toolkit's vocabulary - and then indexed
    `profile["resume_tracks"]["backend"]`. A posting phrased without those keywords is normal, so for the
    second person's profile, whose tracks are `nursing` and `paralegal`, EVERY such posting died with
    `KeyError: 'backend'`, and the same literal was the `--track` choices list, so no track they could name
    was accepted either. The tracks are defined in `data/candidate_profile.json`; the code names one.
    """

    TRACKS = {
        "platform_data": {"label": "Platform & Data Engineer", "keywords": ["kubernetes", "etl"],
                          "template_docx": "data/resume_templates/master.docx", "resume_files": []},
        "web_ui": {"label": "Web UI Engineer", "keywords": ["react", "design system"],
                   "template_docx": "data/resume_templates/master.docx", "resume_files": []},
    }
    POSTING = "We are hiring a generalist engineer to work with the team on our product."

    def profile(self, **extra) -> dict:
        return {"candidate": {"name": "Second Person"}, "resume_tracks": dict(self.TRACKS),
                "do_not_claim": [], **extra}

    def test_a_posting_that_names_no_track_still_recommends_one_the_profile_defines(self):
        _directory, _, assistant = load_assistant_with_profile(self, self.profile())
        analysis = assistant.build_analysis(self.POSTING, "https://example.invalid/jobs/1", self.profile())
        self.assertEqual(analysis.track_scores, {"platform_data": 0, "web_ui": 0})
        self.assertIn(analysis.recommended_track, self.TRACKS,
                      f"recommended {analysis.recommended_track!r}, which this profile does not define")
        self.assertIn("Platform & Data Engineer", analysis.summary)

    def test_a_declared_default_track_decides_when_nothing_scored(self):
        profile = self.profile(default_track="web_ui")
        _directory, _, assistant = load_assistant_with_profile(self, profile)
        analysis = assistant.build_analysis(self.POSTING, "https://example.invalid/jobs/1", profile)
        self.assertEqual(analysis.recommended_track, "web_ui")

    def test_a_track_that_does_score_still_wins(self):
        profile = self.profile(default_track="web_ui")
        _directory, _, assistant = load_assistant_with_profile(self, profile)
        analysis = assistant.build_analysis("React and design system work.", "https://example.invalid/jobs/1", profile)
        self.assertEqual(analysis.recommended_track, "web_ui")
        self.assertGreater(analysis.track_scores["web_ui"], 0)

    def test_a_profile_with_no_tracks_is_a_message_and_not_a_key_error(self):
        profile = {"candidate": {"name": "Nobody"}, "resume_tracks": {}, "do_not_claim": []}
        _directory, _, assistant = load_assistant_with_profile(self, profile)
        with self.assertRaises(SystemExit) as raised:
            assistant.build_analysis(self.POSTING, "https://example.invalid/jobs/1", profile)
        self.assertIn("resume_tracks", str(raised.exception))

    def test_the_tailor_track_choices_are_the_profiles_own_names(self):
        """`tailor --track` used to offer one profile's three names to everybody.

        Driven through the CLI, because that is where the choices list lives and argparse is what rejects
        the caller: the profile here defines no `backend`, so a run naming one must be refused with the
        names this profile DOES define.
        """
        directory, profile, assistant = load_assistant_with_profile(self, self.profile())
        result = subprocess.run(
            [sys.executable, str(assistant.__file__), "tailor", "--track", "backend", "--file", "-"],
            input="A posting.", capture_output=True, text=True, timeout=60,
            # The subprocess reads the profile the CLI is parsing choices from, not the installed one.
            env=dict(os.environ, ATS_DATA_DIR=str(directory)),
        )
        self.assertEqual(result.returncode, 2, result.stderr[:400])
        self.assertIn("platform_data", result.stderr)
        self.assertIn("web_ui", result.stderr)


class ACitizenshipRequirementIsABarOnlyForSomeoneWhoCannotMeetIt(unittest.TestCase):
    """`job_app_assistant` dropped a posting for everyone the moment it named citizenship or U.S. person.

    WHAT BROKE, AND FOR WHOM. Its own pattern list carried the reasoning "a citizenship or U.S.-person
    requirement is disqualifying for everyone", so a candidate who IS a citizen was told to skip the
    postings most open to them - including the ones a defense contractor writes for exactly that person -
    and the wording "Applicants must be US citizens." (no full stops after the U and the S) was not
    recognised at all, so it came back `NO_EXPLICIT_RESTRICTION_FOUND` instead: the opposite answer from
    the same sentence in a different spelling. `src/screening/daily_screen.py` was changed to ask
    `candidate.standard_answers.work_authorization` instead, and this module now imports that model rather
    than holding a second copy of it.
    """

    NO_FULL_STOPS = "Applicants must be US citizens."
    WITH_FULL_STOPS = "Applicants must be U.S. citizens."
    US_PERSON = "You must have ITAR eligibility as a U.S. Person"

    def setUp(self):
        _directory, _, self.assistant = load_assistant_with_profile(self, {"candidate": {"name": "Example"}})

    def screen(self, sentence: str, applicant: str) -> tuple[str, list[str]]:
        return self.assistant.screen_eligibility(sentence.lower(), applicant)

    def test_the_sentence_without_full_stops_is_recognised(self):
        for applicant in ("us_citizen", "requires_sponsorship"):
            with self.subTest(applicant=applicant):
                status, notes = self.screen(self.NO_FULL_STOPS, applicant)
                self.assertNotEqual(status, "NO_EXPLICIT_RESTRICTION_FOUND",
                                    "the same sentence with full stops is caught; this spelling must be too")
                self.assertIn("requires_u_s_citizenship", notes)

    def test_a_citizen_keeps_the_citizenship_posting_and_an_uncertain_applicant_does_not(self):
        kept = self.screen(self.WITH_FULL_STOPS, "us_citizen")
        self.assertEqual(kept[0], "NEEDS_CONFIRMATION", kept)
        self.assertIn("requires_u_s_citizenship", kept[1])
        blocked = self.screen(self.WITH_FULL_STOPS, "requires_sponsorship")
        self.assertEqual(blocked[0], "NOT_ELIGIBLE_OR_HIGH_RISK", blocked)

    def test_the_same_reason_is_a_wall_for_one_applicant_and_an_open_door_for_another(self):
        """`us_person` is met by a permanent resident and not by someone who needs sponsorship."""
        resident = self.screen(self.US_PERSON, "permanent_resident")
        self.assertEqual(resident[0], "NEEDS_CONFIRMATION", resident)
        sponsored = self.screen(self.US_PERSON, "requires_sponsorship")
        self.assertEqual(sponsored[0], "NOT_ELIGIBLE_OR_HIGH_RISK", sponsored)
        self.assertEqual(resident[1].count("requires_u_s_person"), 1)

    def test_an_unstated_status_filters_nothing(self):
        """Unstated and unrecognised are the same case, and it KEEPS the posting - see `requirement_applies`.

        Kept, and not "met": the two are different claims about the applicant, so the verdict stays the same
        as it was when the module could not ask - what changed is that the requirement is now named in the
        notes instead of being reported as a finding of no requirement at all.
        """
        for unstated in ("", "yes", None):
            with self.subTest(status=unstated):
                status, notes = self.screen(self.WITH_FULL_STOPS, unstated)
                self.assertEqual(status, "NO_EXPLICIT_RESTRICTION_FOUND", notes)
                self.assertIn("requires_u_s_citizenship", notes)
                self.assertIn("nothing was filtered", " ".join(notes))

    def test_the_profile_is_what_decides_when_the_caller_does_not(self):
        profile = {"candidate": {"name": "Example", "standard_answers": {"work_authorization": "us_citizen"}},
                   "resume_tracks": {"backend": {"label": "Backend Engineer", "keywords": ["backend"]}},
                   "do_not_claim": []}
        _directory, _, assistant = load_assistant_with_profile(self, profile)
        analysis = assistant.build_analysis("Applicants must be US citizens. We build backend services.",
                                            "https://example.invalid/jobs/1", profile)
        self.assertEqual(analysis.eligibility, "NEEDS_CONFIRMATION", analysis.eligibility_notes)
        self.assertIn("requires_u_s_citizenship", analysis.eligibility_notes)

    def test_the_phrasings_the_imported_model_does_not_carry_are_still_read_as_bars(self):
        """The import must not LOSE a sentence this module already refused.

        Measured when the local pattern list was replaced by the screening model's: of fourteen phrasings
        the old list caught, `daily_screen.classify_auth` reads three as the GOOD direction - `mentions_opt`
        is the `likely_accepts` status, on a sentence saying OPT is not eligible. A screen that lets those
        through is worse than the blanket bar this change removed, because it recommends the posting to the
        one applicant it excludes, so the patterns are kept here and this pins the OUTCOME, not the list.
        """
        invisible_to_the_model = [
            ("OPT students are not eligible for this role.", "opt_not_eligible"),
            ("CPT candidates are not eligible for this role.", "cpt_not_eligible"),
            ("F-1 visa holders are not eligible.", "f1_not_eligible"),
        ]
        for sentence, expected_reason in invisible_to_the_model:
            with self.subTest(sentence=sentence):
                status, notes = self.screen(sentence, "requires_sponsorship")
                self.assertEqual(status, "NOT_ELIGIBLE_OR_HIGH_RISK", notes)
                self.assertIn(expected_reason, notes)

    def test_a_sponsorship_requirement_phrased_as_must_not_require_it_is_a_bar(self):
        sponsored = self.screen("You must not require sponsorship. We build backend services.",
                                "requires_sponsorship")
        self.assertEqual(sponsored[0], "NOT_ELIGIBLE_OR_HIGH_RISK", sponsored)
        citizen = self.screen("You must not require sponsorship. We build backend services.", "us_citizen")
        self.assertEqual(citizen[0], "NEEDS_CONFIRMATION", citizen)



    """A file derived from the applicant's profile is written under the data directory, never in src/.

    THE FILE THAT MADE THIS A TEST. `prepare` wrote `src/autofill/greenhouse/<slug>.json` holding the
    applicant's name, email, phone, city and standard answers. `src/autofill/` also holds real source
    (the Workday helpers), and nothing in .gitignore covered it - so `git add -A` in a configured
    checkout committed a stranger's phone number, which is the one thing rule 3 forbids outright.
    """

    def test_the_autofill_directory_is_inside_the_data_directory(self):
        self.assertEqual(pipeline.AUTOFILL_DIR, DATA_DIR / "autofill")

    def test_no_platform_config_directory_sits_in_the_source_tree(self):
        source = str(pipeline.ROOT / "src")
        for platform in pipeline.PLATFORM_CONFIG_DIRS:
            directory = str(pipeline.AUTOFILL_DIR / platform)
            self.assertFalse(directory.startswith(source),
                             f"{platform} configs would be written inside the source tree: {directory}")

    def test_a_real_run_returns_a_path_under_the_data_directory(self):
        # The load-bearing half: the constant can be right while a platform branch still builds its
        # own path from ROOT. This calls the function that writes the file.
        role = {"company": "Example Corp", "role": "Backend Engineer",
                "source": "https://job-boards.greenhouse.io/example/jobs/1234567",
                "summary": "I am an example.", "track": "backend"}
        app_profile = {
            "candidate": {"name": "Example Candidate", "first_name": "Example",
                          "last_name": "Candidate", "email": "candidate@example.edu",
                          "phone": {"formatted": "+1 555 123 4567"},
                          "address": {"city": "Springfield", "state": "Illinois",
                                      "country": "United States of America"},
                          "linkedin": "https://www.linkedin.com/in/example-candidate"},
            "education": [{"school": "Example State University", "degree": "M.S.",
                           "field_of_study_workday": "Software Engineering"}],
            "work_experience": [{"company": "Example Corp", "title": "Engineer"}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            resume = Path(tmp) / "resume.pdf"
            resume.write_bytes(b"%PDF-1.4\n")
            # `stem` is what names the file; a temp stem keeps this from colliding with a real run.
            written, mapped = pipeline.build_or_update_platform_config(
                "greenhouse", "test_generated_state_stays_out_of_src", role, app_profile, {}, resume)
        self.assertIsNotNone(written, "greenhouse produced no config path at all")
        resolved = Path(written).resolve()
        self.assertTrue(str(resolved).startswith(str(DATA_DIR.resolve())),
                        f"a generated config was written outside the data directory: {resolved}")
        self.assertFalse(str(resolved).startswith(str((pipeline.ROOT / "src").resolve())),
                         f"a generated config was written into the source tree: {resolved}")
        # And it is a file that carries the applicant's own facts, which is why this matters at all.
        self.assertIn("autofill", str(resolved))
        Path(resolved).unlink(missing_ok=True)


def temporary_directories(*prefixes: str) -> set[str]:
    """The names directly under the machine's temp directory that start with one of `prefixes`.

    The measurement this leak was found with - `ls "$TMPDIR" | grep '^assistant-profile-'` - and the one
    `scripts/run-contract-tests.sh` now makes over a whole run. It counts NAMES rather than entries, which is
    what makes it usable on a machine where other programs are also writing to the temp directory: a
    directory this suite did not make is never in the set, so only a name that appeared between the two counts
    can be a difference.
    """
    return {entry.name for entry in Path(tempfile.gettempdir()).iterdir() if entry.name.startswith(prefixes)}


class NoTestInThisModuleLeavesATemporaryDirectoryBehind(unittest.TestCase):
    """The two families of temporary directory this module used to leave, and the count that says it no longer does.

    WHAT IT COST, AND WHY NOTHING SAW IT. `load_assistant_with_profile` called `mkdtemp(prefix=
    "assistant-profile-")` and returned the directory, and `test_a_manifest_outside_the_checkout...` did the
    same with `manifest-outside-`; nothing removed either. Measured on the tree this was written for: 16
    directories of the first family and one of the second, per python run. A `mkdtemp` with no matching
    cleanup looks exactly like one that has it - the removal is on another line, or in another method - so the
    only thing that finds it is counting the directory both of them went into.

    WHY THE SUBPROCESS IS THE POINT. No assertion inside a test can see the end of that test: `addCleanup`
    runs after the method returns, and the manifest test's block closes after its last assertion too. So the
    tests that write the directories are run as their own process and the count is compared ACROSS it, which
    is the only place the answer exists. The classes are named rather than discovered, so this keeps measuring
    the same subject as the rest of the module grows.
    """

    WATCHED = ("assistant-profile-", "manifest-outside-")
    CLASSES = (
        "NoTrackIsNamedInCode",                                        # four calls to the profile helper
        "ACitizenshipRequirementIsABarOnlyForSomeoneWhoCannotMeetIt",  # one more of them, in `setUp`
        "TheTrackerRowSurvivesADataDirectoryOutsideTheCheckout",       # the manifest spelled from outside
    )

    def test_running_them_removes_what_they_make(self):
        before = temporary_directories(*self.WATCHED)
        result = subprocess.run(
            [sys.executable, "-m", "unittest", "-v",
             *[f"test_application_pipeline.{name}" for name in self.CLASSES]],
            cwd=Path(__file__).resolve().parent,
            capture_output=True, text=True, timeout=180,
            # The subprocess reads the same data directory this one does, and writes no bytecode into src/:
            # a `__pycache__` this run added would be a file the contract runner's tree guard reports.
            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
        )
        self.assertEqual(result.returncode, 0,
                         "the subprocess run has to pass for the count below to mean anything:\n"
                         f"{result.stderr[-2000:]}")
        # A run that matched no test at all also exits clean, so the count is read rather than assumed - the
        # same reason the contract runner refuses a run that reports a skip.
        ran = re.search(r"^Ran (\d+) tests?", result.stderr, re.MULTILINE)
        self.assertIsNotNone(ran, f"the subprocess reported no run at all:\n{result.stderr[-2000:]}")
        self.assertGreater(int(ran.group(1)), 0)
        left = temporary_directories(*self.WATCHED) - before
        self.assertEqual(left, set(), f"these tests left temporary directories behind: {sorted(left)}")


if __name__ == "__main__":
    unittest.main()
