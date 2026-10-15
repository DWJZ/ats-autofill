"""Marks this directory as a package so `unittest discover` will recurse into it.

Empty on purpose, but not deletable: without it `python3 -m unittest discover` finds zero tests
here and reports success, which is the worst possible failure mode for a test runner. See
scripts/run-contract-tests.sh and `npm test`.
"""
