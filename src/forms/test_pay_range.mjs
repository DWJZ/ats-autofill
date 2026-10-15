/**
 * test_pay_range.mjs — the band must come out as a band, and nothing must come out when it is not one.
 *
 * The cases are the real Esri payload, escaped exactly as Greenhouse returns it, plus the Twitch numbers that the
 * page-based path already handled. Both failures this pins produced NO ERROR at the time: the first returned two
 * separate singles, the second called a span-less pair a band - and because the drafter takes the TOP of whatever it is
 * given, that second one would have put $79,040, the LOWER bound, on a live form as the candidate's expectation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, extractPayRange } from "./pay_range.mjs";

// Verbatim from boards-api.greenhouse.io/v1/boards/esri/jobs/5190253007 - escaped twice, and the endpoints separated
// by `&amp;mdash;` inside its own span.
const ESRI_API =
  '&lt;div class=&quot;title&quot;&gt;A reasonable estimate of the base salary range is&lt;/div&gt;' +
  '&lt;div class=&quot;pay-range&quot;&gt;&lt;span&gt;$79,040&lt;/span&gt;' +
  '&lt;span class=&quot;divider&quot;&gt;&amp;mdash;&lt;/span&gt;' +
  '&lt;span&gt;$133,016 USD&lt;/span&gt;&lt;/div&gt;';

test("the escaped Esri payload yields the whole band, not two singles", () => {
  const range = extractPayRange(ESRI_API);
  assert.deepEqual(range, { low: 79040, high: 133016 });
});

test("a markdown range and a plain one both work", () => {
  assert.deepEqual(extractPayRange("The band is $127,100 - $185,000 per year."), { low: 127100, high: 185000 });
  assert.deepEqual(extractPayRange("Pay range: $150,000 to $180,000"), { low: 150000, high: 180000 });
});

test("NEVER a band with no span: that is a lower bound wearing a range's clothes", () => {
  // The exact shape the bug produced. Returning {79040, 79040} would be drafted as $79,040 - the bottom of the band,
  // presented as the top, which is worse than having no number at all.
  assert.equal(extractPayRange("A reasonable estimate of the base salary range is $79,040."), null);
  assert.equal(extractPayRange("$133,016 USD"), null);
});

test("a referral bonus is not a salary", () => {
  assert.equal(extractPayRange("Earn a $1,000 referral bonus and $500 for equipment."), null);
});

test("the widest span wins when a posting names several figures", () => {
  const text = "Base salary $120,000 - $150,000. Signing bonus $10,000 - $25,000. Equity $50,000.";
  assert.deepEqual(extractPayRange(text), { low: 120000, high: 150000 });
});

test("no amounts at all is null rather than an empty range", () => {
  assert.equal(extractPayRange("Competitive compensation."), null);
  assert.equal(extractPayRange(""), null);
  assert.equal(extractPayRange(null), null);
});

test("decodeEntities turns the divider into a dash and leaves no entity behind", () => {
  const decoded = decodeEntities(ESRI_API);
  assert.ok(!decoded.includes("&"), `an entity survived: ${decoded.slice(0, 80)}`);
  // The tags are stripped by extractPayRange, not here, so the divider is still inside its span at this point: the
  // claim is that the ENTITY became a real dash, not that the surrounding markup is gone.
  assert.match(decoded, /divider">-</, "the mdash divider must decode to a real dash");
});
