/**
 * pay_range.mjs — read a salary band out of a job description, and refuse to invent one out of two singles.
 *
 * WHY THIS IS A MODULE. The extraction was inline in `inspect_ats_form.mjs` twice - once for the page and once for the
 * API - and it was wrong in the API path in a way that produced a CONFIDENT WRONG NUMBER, which is worse than no
 * number. It could not be tested where it lived, so the same two bugs travelled: a decode chain in the wrong order,
 * and a "band" with no span accepted as a band.
 *
 * THE TWO FAILURES, both from the Esri JD (`boards-api.greenhouse.io/v1/boards/esri/jobs/5190253007`):
 *
 *  1. THE CONTENT IS ESCAPED TWICE. The endpoints arrive as
 *         &lt;span&gt;$79,040&lt;/span&gt;&lt;span class=&quot;divider&quot;&gt;&amp;mdash;&lt;/span&gt;...$133,016 USD
 *     A chain that replaces `&mdash;` before `&amp;` matches nothing, because `&amp;mdash;` does not contain
 *     `&mdash;`. So `&amp;` is decoded first here, and the reason is written down rather than left to look like a
 *     mistake.
 *  2. A BAND IS A SPAN. When the separator was missed, the two amounts matched as separate singles, the widest
 *     "range" became `{low: 79040, high: 79040}`, and the drafter takes the TOP - so the LOWER bound would have been
 *     written as the candidate's expectation. `extractPayRange` returns null when nothing spans, and the caller's
 *     fallback then fires with its own note saying a fallback was used.
 */

/** Decode the entities a job description arrives with. `&amp;` first: the content is escaped twice. */
export function decodeEntities(html) {
  return String(html || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "-")
    .replace(/&ndash;/g, "-")
    .replace(/&nbsp;/g, " ");
}

/**
 * The widest credible salary band in `text`, or null.
 *
 * "Credible" is five figures or more, so a referral bonus is not mistaken for a salary; "widest" because a band is the
 * only thing in a posting that ranges over tens of thousands, and a sentence naming one figure is not a band.
 */
export function extractPayRange(text) {
  const clean = decodeEntities(text).replace(/<[^>]+>/g, " ");
  const found = [];
  for (const m of clean.matchAll(/\$\s?([\d,]{4,})(?:\s*(?:-|–|—|to)\s*\$?\s?([\d,]{4,}))?/g)) {
    const low = Number(m[1].replace(/,/g, ""));
    const high = m[2] ? Number(m[2].replace(/,/g, "")) : low;
    if (Number.isFinite(low) && low >= 10000) found.push({ low, high });
  }
  if (!found.length) return null;
  const best = found.reduce((a, b) => ((b.high - b.low) > (a.high - a.low) ? b : a));
  return best.high > best.low ? best : null;
}
