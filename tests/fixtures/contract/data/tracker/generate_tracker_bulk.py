#!/usr/bin/env python3
"""generate_tracker_bulk.py - write the bulk half of the contract tracker fixture.

NOT A TEST, AND NOT RUN BY THE TEST SUITE. The generated file is COMMITTED under
`tests/fixtures/contract/data/tracker/bulk.csv`, because a fixture set that only exists on the
machine that generated it is not a fixture. This script is what makes the file reviewable: the
rows are a pattern, and the pattern is here rather than implicit in a thousand lines of CSV.

WHAT THE SCALE IS FOR. One assertion in `src/pipeline/test_application_pipeline.py` compares a
count of recognised hosts against a floor of 1000 and describes a full tracker rather than an
example one - `tracker.example.csv` holds two rows, so that check skips. The bulk file is the
tracker that check was written against: mostly one platform, with the other realistic host shapes
mixed in so that a `detect_platform` regression moves the counts loudly.

WHAT IT IS NOT. No row here is an application that happened. Every company, title and
requisition id is invented; the URLs use each ATS's real host shape because that is the input
`detect_platform` reads, and the invented board slugs are obvious about being invented.

Usage:  python3 tests/fixtures/contract/data/tracker/generate_tracker_bulk.py
        (writes bulk.csv beside this script)
"""
from __future__ import annotations

import csv
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "bulk.csv"

HEADER = ["date_added", "company", "title", "source", "eligibility", "recommended_track",
          "track_scores", "status", "notes"]

#: One url per platform `detect_platform` recognises, in that platform's own host shape. Rotating
#: through them keeps every branch of the detector exercised by a file whose size is the point.
URL_SHAPES = (
    lambda n: f"https://job-boards.greenhouse.io/example-board-{n}/jobs/{7000000000 + n}",
    lambda n: f"https://jobs.ashbyhq.com/example-ashby-{n}/00000000-0000-4000-8000-{n:012d}",
    lambda n: f"https://example{n}.wd1.myworkdayjobs.com/en-US/ExampleCareers/job/Remote/JR{n:06d}",
    lambda n: f"https://jobs.lever.co/example-lever-{n}/00000000-0000-4000-9000-{n:012d}",
    lambda n: f"https://jobs.smartrecruiters.com/oneclick-ui/company/Example{n}/publication/{n:08d}",
    lambda n: f"https://careers.chewy.com/us/en/job/R{n:05d}/Example-Engineer",
    lambda n: f"https://apply.workable.com/j/{n:010X}",
    lambda n: f"https://apply.careers.microsoft.com/careers/job/1970393{n:07d}",
)

#: How many rows to write. The floor the suite compares against is 1000 recognised hosts, and the
#: special rows that carry the tenant caps live in `fresh.csv` rather than here.
ROWS = 1075

TITLES = ("Software Engineer I", "Software Engineer II", "Backend Software Engineer",
          "Software Engineer, Platform", "Full Stack Software Engineer")


def main() -> int:
    with OUT.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(HEADER)
        for n in range(1, ROWS + 1):
            shape = URL_SHAPES[(n - 1) % len(URL_SHAPES)]
            status = "submitted_by_agent" if n % 40 == 0 else ("not_applied" if n % 17 == 0 else "materials_ready")
            writer.writerow([
                f"2025-{((n % 12) + 1):02d}-{((n % 27) + 1):02d}",
                f"Example Employer {n:04d}",
                TITLES[n % len(TITLES)],
                shape(n),
                "NO_EXPLICIT_RESTRICTION_FOUND",
                "backend",
                '{"backend": 5}',
                status,
                "FIXTURE ROW. Invented, one of a scale pattern - see generate_tracker_bulk.py. "
                "It is not an application and may never be treated as one.",
            ])
    print(f"wrote {ROWS} rows to {OUT.relative_to(HERE.parents[4])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
