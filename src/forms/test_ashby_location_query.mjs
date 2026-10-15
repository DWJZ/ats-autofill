/**
 * test_ashby_location_query.mjs — the Ashby Location rule, pinned without a browser.
 *
 * The rule used to live inline in `ashby_finish_form.mjs` (one person's city, with `, California, United States`
 * welded on) and in `ashby_location_keys.mjs` (a query list ending in `base + ", CA"`, an acceptance test defaulted
 * to `"california"`). Neither could be asserted without driving a live tenant, which is how both halves of the same
 * mistake survived in the same call path. The functions under test take an address and return strings, so the case
 * that paid for the fix is a table here rather than a paragraph anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  committedMatches,
  locationAddress,
  locationPlan,
  locationQueries,
  locationExpectations,
  splitAddress,
  stateCode,
} from "./ashby_location_query.mjs";

const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

// A line of CODE, not of comment: the incident's own literals are quoted in the comments above the lines they used
// to be, and a guard that reads prose would forbid explaining the fix where the next reader needs it.
const codeLines = (text) => text.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));

test("a Canadian address is queried as a Canadian place, never as a Californian one", () => {
  // THE CASE THAT PAID FOR THIS. The finisher typed `${city}, California, United States` with the city as the
  // acceptance test, and the picker's own list appended ", CA" and ", California" to what it was given. A candidate
  // in Toronto therefore had the autocomplete queried with a US address and an expectation ("california") that no
  // Canadian row can ever contain - so the run ended "NOT COMMITTED" over a field the widget had answered
  // correctly, or committed the US address it was told to look for.
  const plan = locationPlan({ city: "Toronto", state: "Ontario", country: "Canada" });
  assert.deepEqual(plan.queries, ["Toronto, Ontario, Canada", "Toronto, Ontario", "Toronto, ON", "Toronto"]);
  assert.deepEqual(plan.expectations, ["ontario", ", on", "canada"]);
  assert.ok(!JSON.stringify(plan).toLowerCase().includes("california"), "no part of the plan may name California");
  assert.ok(!JSON.stringify(plan).toLowerCase().includes("san francisco"), "and no part may name a default city");
});

test("a committed row is matched on its state or country, not on the city it shares with a namesake", () => {
  // THE WRONG-COMMIT CASE, verbatim from Luma AI's tenant (2026-10-01): the bare city query committed a row in
  // Newfoundland, and the picker accepted it because the only thing it checked was the city name - which the wrong
  // row contains too. The state is what tells the two rows apart.
  const { expectations } = locationPlan({ city: "Springfield", state: "Illinois", country: "United States of America" });
  assert.equal(committedMatches("Springfield, Illinois, United States", expectations), true);
  assert.equal(committedMatches("Springfield, IL, United States", expectations), true, "a list that spells the state short is the same place");
  assert.equal(committedMatches("Springfield, Newfoundland and Labrador, Canada", expectations), false,
    "the namesake row must NOT count as committed - that is the commit the operator would never see");
});

test("a US address is queried with the profile's own state and country", () => {
  // The same shape the old line hardcoded, but for whoever the profile actually describes. The country is spelled
  // out in the profile ("United States of America") and shortened in the acceptance list, because a place list
  // prints "United States" and a substring check against the long form would miss the row it just committed.
  const plan = locationPlan("Springfield, Illinois, United States of America");
  assert.deepEqual(plan.queries, [
    "Springfield, Illinois, United States of America",
    "Springfield, Illinois",
    "Springfield, IL",
    "Springfield",
  ]);
  assert.deepEqual(plan.expectations, ["illinois", ", il", "united states of america", "united states"]);
  assert.equal(committedMatches("Springfield, IL, United States", plan.expectations), true);
  assert.equal(committedMatches("Springfield, Illinois, United States of America", plan.expectations), true);
});

test("an unknown state yields no abbreviation rather than a guess", () => {
  // A guess is how ", CA" happened. Freedonia is not in the table, so the code query is simply absent and the
  // remaining queries - the state name and the city - still run.
  assert.equal(stateCode("Freedonia"), "");
  assert.equal(stateCode("Illinois"), "IL");
  assert.equal(stateCode("Ontario"), "ON");
  assert.equal(stateCode("IL"), "IL", "a profile that already holds the abbreviation keeps it");
  assert.deepEqual(locationQueries({ city: "Somewhere", state: "Freedonia", country: "United States" }),
    ["Somewhere, Freedonia, United States", "Somewhere, Freedonia", "Somewhere"]);
});

test("a place with no state part is still accepted by its country", () => {
  // Berlin, Germany - the European shape. There is no state to check, so the country is what distinguishes it, and
  // the query list is the full place and then the city.
  const plan = locationPlan({ city: "Berlin", state: "", country: "Germany" });
  assert.deepEqual(plan.queries, ["Berlin, Germany", "Berlin"]);
  assert.deepEqual(plan.expectations, ["germany"]);
  assert.equal(committedMatches("Berlin, Germany", plan.expectations), true);
});

test("a city with nothing else around it falls back to being its own expectation", () => {
  // The one case where the city is all there is to check. Nothing else is available, and returning no expectation
  // at all would report NOT COMMITTED for every commit the widget makes.
  const plan = locationPlan("Springfield");
  assert.deepEqual(plan.queries, ["Springfield"]);
  assert.deepEqual(plan.expectations, ["springfield"]);
});

test("ASHBY_LOCATION_CITY overrides the city and only the city", () => {
  // The override keeps working - it is how a run answers "where would you work from" for a posting whose field
  // means something other than the home address - but the state and the country stay the profile's. Appending a
  // city to a hardcoded state is exactly the drift this file exists to stop.
  const address = { city: "Springfield", state: "Illinois", country: "United States of America" };
  assert.equal(locationAddress(address), "Springfield, Illinois, United States of America");
  assert.equal(locationAddress(address, "Los Angeles"), "Los Angeles, Illinois, United States of America");
  assert.equal(locationAddress({}, "Toronto"), "Toronto", "an override with no profile address is still a place to type");
});

test("no address and no override is an empty value, so nothing gets typed", () => {
  // A blank location is visible in the audit; a city typed from a literal is a statement about the candidate that
  // nobody made. The finisher reports this case instead of filling the field.
  assert.equal(locationAddress({}), "");
  assert.equal(locationAddress(undefined, "   "), "");
  assert.deepEqual(locationQueries(""), []);
  assert.deepEqual(locationExpectations(""), []);
});

test("splitAddress keeps a country's own comma instead of cutting it in half", () => {
  assert.deepEqual(splitAddress("Springfield, Illinois, United States of America"),
    { city: "Springfield", state: "Illinois", country: "United States of America" });
  assert.deepEqual(splitAddress("Berlin, Germany"), { city: "Berlin", state: "Germany", country: "" },
    "two parts is city+state by position; a reader who meant country is the case the profile field labels");
});

test("no place is typed from a literal in the two Ashby location scripts", () => {
  // The enforced half of the fix. `ASHBY_LOCATION_CITY` may override the city, but no DEFAULT place may exist, and
  // the query list may not carry a state name of its own - that is what ", CA" and "california" were, and they are
  // the reason a candidate outside California could not have the field answered.
  const literals = [/San Francisco/, /California/, /\bcalifornia\b/i];
  for (const name of ["ashby_finish_form.mjs", "ashby_location_keys.mjs"]) {
    for (const line of codeLines(source(name))) {
      for (const literal of literals) {
        assert.ok(!literal.test(line), `${name} still names a place in code: ${line.trim().slice(0, 100)}`);
      }
    }
  }
  // And the acceptance test is derived from the address rather than defaulted: a default expectation is the half of
  // the defect a browser test cannot see, because the widget reports COMMITTED either way.
  assert.match(source("ashby_location_keys.mjs"), /locationPlan\(address\)/);
  assert.ok(!/process\.argv\[4\]\s*\|\|\s*"california"/.test(source("ashby_location_keys.mjs")));
});
