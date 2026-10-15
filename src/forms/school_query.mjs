/**
 * school_query.mjs — the two pure decisions inside `answer_school.mjs`, in a module a test can call.
 *
 * They are here rather than inline because they are the parts that can be WRONG IN SILENCE: a short query that does
 * not filter, and a pattern that matches the wrong school. `answer_school.mjs` needs a live page to do anything at
 * all; these two need nothing, so a test can pin them without a browser - which is the shape hard rule 11 asks for.
 *
 * The rules they encode, both from the references:
 *   - A remote-search school select needs the SHORT query. `Lakeside State University, Full` returned an EMPTY list
 *     on Stripe; `Fairview` returned the row after ~2 s (driving-widgets.md, item 2).
 *   - The list's spelling is not the profile's spelling. The profile holds
 *     `Lakeside State University, Fairview`, the list holds `Lakeside State University - Fairview`
 *     (driving-widgets-tools-4.md - the string mismatch that was mistaken for a broken widget).
 */

/**
 * The short distinctive word to type into a remote-search school control: the part after the last comma.
 * "Lakeside State University, Fairview" -> "Fairview".
 */
export function shortQuery(school) {
  const text = (school || "").trim();
  if (!text) return "";
  const tail = text.split(",").pop();
  return (tail || text).trim();
}

/**
 * A pattern that matches THE SAME NAME under a different separator - and nothing else.
 *
 * This is deliberately NOT a loose match. A school is a fact-bearing field, and `/fairview/` matches
 * "Fairview College", which is the false-credential failure this project has already paid for once (a school picker
 * reported OK for the wrong school). Every character of the real name is kept and escaped; only the JOINTS between
 * its comma-separated parts are tolerant, because a list may spell them with a hyphen or an en/em dash.
 */
export function nameTolerantRegex(school) {
  const text = (school || "").trim();
  if (!text) return "";
  const parts = text
    .split(/[,;]+|\s+[-\u2013\u2014]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${parts.map(esc).join("\\s*[,;\\u2013\\u2014-]?\\s*")}$`;
}
