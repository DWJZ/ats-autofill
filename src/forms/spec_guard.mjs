/**
 * spec_guard.mjs — refuse a fill spec that carries a submit action.
 *
 * This is the safety property the whole fill path rests on: `apply_form_spec.mjs` never presses Submit, so a spec
 * that *asks* for a submit is either a mistake or a format the filler does not understand. Both must fail loudly
 * rather than be silently half-applied.
 *
 * It used to live in `src/autofill/unified_runner.mjs`, which nothing called — so the guard existed but never ran,
 * and the only thing exercising it was `apply_form_spec.test.mjs`, which no runner ran either. It now sits beside
 * the filler that uses it, and `src/pipeline/test_application_pipeline.py` drives the real module under node.
 */

/** Visit every value in a nested JSON structure, with the path that reached it. */
function walk(value, visitor, path = []) {
  visitor(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, [...path, index]));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => walk(item, visitor, [...path, key]));
  }
}

/**
 * Throw when a fill spec contains anything that would submit the form.
 * @param {object} spec - the parsed fill spec, before any of it is applied.
 * @throws {Error} naming every offending path, so one run reports all of them.
 */
export function assertNoSubmit(spec) {
  const violations = [];
  walk(spec, (value, path) => {
    const key = String(path.at(-1) ?? "").toLowerCase();
    if (key === "submit" && value === true) violations.push(path.join("."));
    if (typeof value === "string" && /^(submit|submit application)$/i.test(value.trim())) {
      violations.push(path.join("."));
    }
  });
  if (violations.length > 0) {
    throw new Error(`Unsafe autofill config contains a submit action: ${violations.join(", ")}`);
  }
}
