/**
 * location_place.mjs — what to TYPE into a place picker, and what a committed row must LOOK LIKE.
 *
 * WHY THIS IS HERE AND NOT IN THE ASHBY MODULE IT CAME FROM. This rule was written for Ashby's Location
 * autocomplete (`ashby_location_query.mjs`, 2026-10-01: `, CA` welded onto one person's address, and an acceptance
 * test defaulted to "california"). Greenhouse's `Location (City)` is the same KIND of control - a combobox whose
 * option list does not exist until a query is typed - and on the greenhouse board (posting 8279799, 2026-10-14) it
 * failed the same way the Ashby field once did: the drafter emitted the place as an OPTION
 * (`{"option": "Toronto, Ontario, Canada"}`), the filler asked the control for that option, the control had never
 * been given a query, and the field reported `option not found` while holding nothing.
 *
 * The answer is NOT a second copy of the rule. What is typed and what is accepted have to come from the same
 * address, because the defect this file exists to prevent is precisely the two halves drifting apart: a query list
 * that named California next to an acceptance test that could only be satisfied by California, on a candidate who
 * lived in Toronto. A per-platform copy re-opens that the first time one copy is edited. So the rule lives here,
 * `ashby_location_query.mjs` re-exports it for the Ashby scripts that already call it, and Greenhouse's drafter and
 * filler read the same functions.
 *
 * PURE ON PURPOSE. Every function takes an address (or its parts) and returns strings - no browser, no profile
 * read, no page. That is what makes the rule testable without rendering a fixture
 * (`test_ashby_location_query.mjs` pins it, and `test_fill_roundtrip.mjs` drives the filler that consumes it).
 */

/**
 * US states, DC, PR and the Canadian provinces and territories: the name a profile writes -> the two-letter form
 * a place list spells after a comma.
 *
 * WHY A TABLE LIVES IN CODE RATHER THAN IN THE PROFILE. `candidate.address` carries the state's NAME and nothing
 * carries its abbreviation; adding a second profile field would put one fact in two places that can disagree, and
 * the reader who has to keep them in step is the one least likely to notice a drift. This list is a closed public
 * mapping - not a fact about a person - so it belongs here. The literal it replaces was a table of size one
 * (", CA") welded into the query list, which is how every candidate became Californian. An unknown state yields NO
 * abbreviation rather than a guess: the query list then falls back to the state name and the bare city, and the
 * acceptance test to the state name and the country.
 */
export const STATE_CODES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI",
  idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "puerto rico": "PR", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB",
  "newfoundland and labrador": "NL", "northwest territories": "NT", "nova scotia": "NS", nunavut: "NU",
  ontario: "ON", "prince edward island": "PE", quebec: "QC", saskatchewan: "SK", yukon: "YT",
};

/** "Springfield, Illinois, United States of America" -> {city, state, country}, the shape the profile stores.
 *
 *  Everything after the second comma stays in the country, so a country that carries a comma of its own is not
 *  silently cut in half. Fewer parts than three is normal - a profile may hold only a city, or a city and a
 *  country with no state at all (Berlin, Germany) - and each missing part is simply empty rather than guessed. */
export function splitAddress(address) {
  const parts = String(address || "").split(",").map((part) => part.trim()).filter(Boolean);
  return { city: parts[0] || "", state: parts[1] || "", country: parts.slice(2).join(", ") };
}

/** The two-letter form of a state or province, or "" when this table does not know it.
 *
 *  A profile that already holds the abbreviation is passed through as it is: `state` is written by hand in a JSON
 *  file, and answering "CA" with nothing because the table is keyed by full names would drop the abbreviation of
 *  exactly the candidate who wrote the short form. */
export function stateCode(state) {
  const value = String(state || "").trim();
  if (!value) return "";
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  return STATE_CODES[value.toLowerCase()] || "";
}

/** How a place list may spell the country the profile names in full.
 *
 *  The acceptance test is a substring check (`committed.includes(expect)`), so an alias has to be long enough not
 *  to turn up inside an unrelated word, which is why there is no "usa"/"us"/"uk" here: "uk" is inside "Ukraine" and
 *  a two-letter country alias would accept half the world's place names. The profile's own spelling is always
 *  accepted, plus its form with any "of ..." tail removed - "United States of America" and the "United States" a
 *  place list actually prints are the two spellings in circulation. */
export function countryForms(country) {
  const full = String(country || "").trim().toLowerCase();
  if (!full) return [];
  const short = full.replace(/\s+of\s+.*$/, "").trim();
  return short && short !== full ? [full, short] : [full];
}

/** The place to commit, from the profile's address parts and an optional city override.
 *
 *  `ASHBY_LOCATION_CITY` remains an override and overrides the CITY only - the name says city, and the state and
 *  country are facts it has no business changing. With no address and no override this returns "" and the caller
 *  types nothing: a blank location is visible in the audit, while a plausible-looking city nobody recorded is a
 *  claim about the candidate. */
export function locationAddress(address, overrideCity = "") {
  const parts = address && typeof address === "object" ? address : splitAddress(address);
  const city = String(overrideCity || "").trim() || String(parts.city || "").trim();
  return [city, parts.state, parts.country].map((part) => String(part || "").trim()).filter(Boolean).join(", ");
}

/** The queries to type, most specific first: the full place, then the state, then its abbreviation, then the city.
 *
 *  Order matters because the picker tries them in turn and stops at the first commit it accepts. The full form
 *  comes first because that is the shape a place list prints; each later query is shorter, so a list that spells
 *  the state or the country differently still has something it can match, and the bare city is the last resort. */
export function locationQueries(address) {
  const { city, state, country } = typeof address === "string" ? splitAddress(address) : (address || {});
  const code = stateCode(state);
  const queries = [];
  if (city && state && country) queries.push(`${city}, ${state}, ${country}`);
  if (city && state) queries.push(`${city}, ${state}`);
  if (city && code) queries.push(`${city}, ${code}`);
  if (city && !state && country) queries.push(`${city}, ${country}`);
  if (city) queries.push(city);
  return [...new Set(queries)];
}

/** The lowercase substrings a committed value must contain to count as the candidate's own place.
 *
 *  THE STATE OR THE COUNTRY, NOT THE CITY - and that is the whole point of the list. The city is what was just
 *  typed, so checking it accepts a row in the wrong place whose name happens to match: "Springfield" committed
 *  "Springfield, Newfoundland and Labrador, Canada" on Luma's tenant and the picker called it COMMITTED. A state
 *  name, its abbreviation in the comma-delimited form a list writes (", CA" - the bare two-letter code would match
 *  inside other words) and the country are what distinguish the right row from its namesake. The city is used as
 *  the last resort only when the address names no state or country, because then there is nothing else to check. */
export function locationExpectations(address) {
  const { city, state, country } = typeof address === "string" ? splitAddress(address) : (address || {});
  const code = stateCode(state);
  const wanted = [];
  if (state) wanted.push(String(state).trim().toLowerCase());
  if (code) wanted.push(`, ${code.toLowerCase()}`);
  wanted.push(...countryForms(country));
  if (!wanted.length && city) wanted.push(String(city).trim().toLowerCase());
  return [...new Set(wanted)];
}

/** Does the value the widget committed belong to this address?
 *
 *  ANY expectation is enough: the same place is written "Springfield, IL, United States", "Springfield, Illinois"
 *  or "Springfield, Illinois, United States of America" by different lists, and insisting on one spelling is what
 *  ends a run with "NOT COMMITTED" over a field that is already holding the right answer.
 *
 *  AN ABBREVIATION HAS TO BE A WHOLE FIELD, which is what the leading comma in the expectation list means. A plain
 *  substring test on ", ca" accepts "Springfield, Newfoundland and Labrador, ca·nada" - the very namesake commit this
 *  list exists to reject, and the shape (", on" inside "Ontario" too) that a live run would report as COMMITTED. So
 *  a short form is compared against the comma-delimited fields the value is made of, and a field that carries a
 *  postal code after it ("IL 62704") still counts. Long forms - a state name, a country - stay substrings, because
 *  no other place contains them. */
export function committedMatches(value, expectations) {
  const committed = String(value || "").toLowerCase();
  const fields = committed.split(",").map((field) => field.trim());
  return (expectations || []).some((expectation) => {
    if (!expectation) return false;
    if (!expectation.startsWith(",")) return committed.includes(expectation);
    const code = expectation.slice(1).trim();
    return fields.some((field) => field === code || field.startsWith(`${code} `));
  });
}

/** The queries and the acceptance list together, derived from one address so the two cannot disagree. */
export function locationPlan(address) {
  const parts = typeof address === "string" ? splitAddress(address) : (address || {});
  return { ...parts, queries: locationQueries(parts), expectations: locationExpectations(parts) };
}
