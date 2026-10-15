/**
 * structured_query.mjs — which filter to type before choosing a long-list option, derived from the answer itself.
 *
 * THE PROBLEM. Some option controls do not have their options until something is typed: school pickers and address
 * autocompletes fetch their list from the server, so opening the control shows nothing. `pick_option.mjs` can drive
 * them, but only with a `--query`, and until now the only tool that DERIVED that query was `answer_school.mjs` -
 * everything else took the query from a person.
 *
 * ONE RULE CANNOT COVER BOTH SHAPES, and the two canonical values make that concrete:
 *
 *     Lakeside State University, Fairview      ->  Fairview        (the LAST segment is the distinctive one)
 *     Springfield, Illinois, United States        ->  Springfield        (the FIRST segment is the distinctive one)
 *
 * "Take the shortest segment" would pick Fairview and Springfield on these two - and pick wrong on the next pair, which
 * is the kind of rule that works until it silently does not. So this does not choose. It returns CANDIDATES, ordered,
 * and the caller tries them in turn: `pick_option` only reports success when the option it was asked for is the one the
 * control ends up displaying, so the EXACT MATCH is the arbiter and a wrong candidate costs one attempt rather than a
 * wrong answer.
 *
 * `shortQuery` is the school half and is imported rather than reimplemented - it has its own tests, including one that
 * it must NOT match "Fairview College".
 */
import { shortQuery } from "./school_query.mjs";

/** The part before the first comma - the city in `Springfield, Illinois, United States`. */
export function firstSegment(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.split(",")[0].trim();
}

/** How many segments a value has. A single-segment value has nothing to filter with but itself. */
export function segmentCount(value) {
  return String(value || "").split(",").map(s => s.trim()).filter(Boolean).length;
}

/**
 * Ordered candidate filters for `value`. Longest-lived first is NOT the ordering; the two ends come first because
 * they are the two that are actually correct for the shapes this project meets, and the whole value is last because it
 * filters least.
 *
 * Duplicates are removed, and an empty candidate is never returned - a query of "" would open the control with no
 * filter at all, which is the state that fails.
 */
export function queryCandidates(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const out = [];
  for (const candidate of [firstSegment(text), shortQuery(text), text]) {
    const c = String(candidate || "").trim();
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
