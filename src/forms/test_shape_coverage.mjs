/**
 * test_shape_coverage.mjs — every control shape a real application has ever produced must render in a
 * fixture, and this is the gate that says so.
 *
 * The premise: 1,156 applications were submitted successfully, so every control shape in that corpus
 * was driven to completion at least once. Those shapes are the specification. `fixtures/observed-
 * shapes.json` is the list of them, read out of 905 saved inventories (16,246 controls), and each
 * entry names the fixture that renders it.
 *
 * The list is not aspirational - `uncovered` must be EMPTY. A shape that appears in a new scan and has
 * no fixture is a shape nothing can regress on, which is how a scanner silently stops seeing a
 * control. Adding one to the list without a fixture fails here.
 *
 * This gate is about shapes, not behaviour: `test_widget_scan.mjs` asserts what each fixture means.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserCandidates, launchHeadless, withFixture } from "./fixture_browser.mjs";
import { withDeadline } from "./bounded_waits.mjs";
import { collectExtraWidgets, collectFields } from "./widget_scan.mjs";
import { classifyWidget } from "./widget_fingerprint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const CACHE = join(process.env.HOME || "", "Library/Caches", "ms-playwright");
const SHAPES = JSON.parse(readFileSync(join(FIXTURES, "observed-shapes.json"), "utf8"));

/** Listed shapes whose `tag/type` no fixture renders. */
export function missingShapes(renderedShapes, listed) {
  return listed.filter(shape => !renderedShapes.has(`${shape.tag}/${shape.type}`));
}

let browser = null;
before(async () => {
  // Bounded for the same reason as the tests below: a launch that stalls must not hold the file open.
  browser = await withDeadline(launchHeadless(browserCandidates(CACHE)), "launching the headless fixture browser", 60_000);
}, { timeout: 90_000 });
after(async () => {
  await withDeadline(browser?.close() ?? Promise.resolve(), "closing the headless fixture browser", 20_000).catch(() => {});
}, { timeout: 30_000 });

function needsBrowser(t) {
  if (!browser) {
    t.skip(`no usable headless chromium in ${CACHE}`);
    return false;
  }
  return true;
}

let cache = null;
async function render() {
  if (cache) return cache;
  const shapes = new Set();
  const fingerprints = new Set();
  for (const name of readdirSync(FIXTURES).filter(f => f.endsWith(".html")).sort()) {
    const rows = await withFixture(browser, name, async (page) => [
      ...(await page.evaluate(collectFields)),
      ...(await page.evaluate(collectExtraWidgets)),
    ]);
    for (const field of rows) {
      shapes.add(`${(field.tag || "").toLowerCase()}/${(field.type || "").toLowerCase()}`);
      const widget = classifyWidget(field);
      if (widget.fingerprint) fingerprints.add(widget.fingerprint);
    }
  }
  cache = { shapes, fingerprints };
  return cache;
}

test("the shape list is not empty and records where it came from", () => {
  assert.ok(SHAPES.generated_from.inventories > 100, "the list must come from the whole corpus");
  assert.ok(SHAPES.element_shapes.length >= 15, "a suddenly short list means the extraction broke");
});

test("every control shape the corpus has produced renders in a fixture", async (t) => {
  if (!needsBrowser(t)) return;
  const { shapes } = await render();
  const missing = missingShapes(shapes, SHAPES.element_shapes);
  assert.deepEqual(
    missing.map(s => `${s.tag}/${s.type || "-"} (seen ${s.seen}x, e.g. ${s.example})`), [],
    "add a fieldset that renders it, then re-run the generator");
});

test("nothing in the corpus is left uncovered", () => {
  // The generator writes uncovered shapes here rather than dropping them, so an unrenderable shape is
  // a failing test and not a quietly shorter list.
  assert.deepEqual(SHAPES.uncovered, []);
});

test("every fingerprint the list records is still produced by a fixture", async (t) => {
  if (!needsBrowser(t)) return;
  const { fingerprints } = await render();
  const missing = SHAPES.fingerprints.map(f => f.fingerprint).filter(fp => !fingerprints.has(fp));
  assert.deepEqual(missing, [], "a fixture stopped rendering a fingerprint the list depends on");
});

test("the gate catches a shape no fixture renders", () => {
  // Without this the check above could pass vacuously - a typo in the tag/type join would make every
  // comparison fail open.
  assert.deepEqual(
    missingShapes(new Set(["input/text"]), [{ tag: "marquee", type: "" }]),
    [{ tag: "marquee", type: "" }]);
  assert.deepEqual(missingShapes(new Set(["input/text"]), [{ tag: "input", type: "text" }]), []);
});
