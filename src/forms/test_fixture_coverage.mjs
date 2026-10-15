/**
 * test_fixture_coverage.mjs — a fixture shape with no test is a fixture that will rot.
 *
 * `fixtures/ats_widgets.html` is how this project remembers what broke it: one fieldset per control
 * shape, each one a round that was lost or a submission that failed. It sat unused for months, so
 * nothing caught it when a scanner stopped seeing one of the shapes.
 *
 * This gate is what keeps a new shape from being added without a test: every `<fieldset id=...>` in
 * every fixture must be named by some `test_*.mjs`. The convention is to open the test's name with
 * the fieldset id, which is also how a reader finds the case for a shape they just hit.
 *
 * It checks presence, not quality - a test that names a shape and asserts nothing would pass. The
 * point is that adding a shape forces the author to open the file rather than forgetting it exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = "test_fixture_coverage.mjs";

/** The `id` of every `<fieldset>` in a fixture page, in document order. */
export function fieldsetsIn(html) {
  return [...html.matchAll(/<fieldset[^>]*\bid="([^"]+)"/g)].map(m => m[1]);
}

/** Those ids that no test source mentions. */
export function unnamedShapes(sources, ids) {
  return ids.filter(id => !sources.includes(id));
}

const fixtures = readdirSync(join(HERE, "fixtures")).filter(f => f.endsWith(".html")).sort();
const sources = readdirSync(HERE)
  .filter(f => f.startsWith("test_") && f.endsWith(".mjs") && f !== SELF)
  .map(f => readFileSync(join(HERE, f), "utf8"))
  .join("\n");

test("the fixtures directory still holds pages to check", () => {
  assert.ok(fixtures.length > 0, "no .html fixture found - the gate would pass vacuously");
});

test("the gate catches a shape no test names", () => {
  // Without this, a typo in the source scan would turn the gate below into a no-op that always passes.
  assert.deepEqual(unnamedShapes(sources, ["aShapeNoTestCouldPossiblyName"]), ["aShapeNoTestCouldPossiblyName"]);
  assert.deepEqual(unnamedShapes(sources, ["systemFields"]), []);
});

for (const file of fixtures) {
  test(`${file}: every fieldset shape is named by a test`, () => {
    const ids = fieldsetsIn(readFileSync(join(HERE, "fixtures", file), "utf8"));
    assert.ok(ids.length > 0, `${file}: no <fieldset id=...> found - the regex or the fixture changed shape`);
    assert.deepEqual(unnamedShapes(sources, ids), [],
      `${file}: add a test whose name starts with the fieldset id, or delete the fixture if the shape is gone`);
  });
}
