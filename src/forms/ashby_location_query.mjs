/**
 * ashby_location_query.mjs — the Ashby-facing name for the shared place rule.
 *
 * This file used to HOLD the rule. It moved to `location_place.mjs` on 2026-10-14, when Greenhouse's own
 * `Location (City)` typeahead failed exactly the way Ashby's did (see that module's header): the rule is about a
 * place PICKER, not about Ashby, and the drafter/filler that now need it as well run for every platform. Keeping a
 * per-platform copy is how the two halves - what is typed, and what counts as committed - come apart, which is the
 * one defect this rule exists to prevent.
 *
 * The re-export is deliberately complete rather than a partial one: `ashby_location_keys.mjs`, `ashby_finish_form.mjs`
 * and `test_ashby_location_query.mjs` import these names from HERE, and a name that quietly disappeared would be a
 * runtime `undefined` in a browser-driving script rather than a load-time error.
 */
export {
  STATE_CODES,
  splitAddress,
  stateCode,
  countryForms,
  locationAddress,
  locationQueries,
  locationExpectations,
  committedMatches,
  locationPlan,
} from "./location_place.mjs";
