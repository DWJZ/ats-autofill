/**
 * field_state.mjs — is a control's DISPLAYED value a real answer, or the control telling you it has none?
 *
 * WHY THIS EXISTS. `audit_form_fields.mjs` reported `ok` for a race field that was visibly empty:
 *
 *     ok   opt race   text   Please identify your race   = Select...
 *
 * The emptiness test only knew two things - an empty string, and `[unchecked]` - and the value it was given was the
 * placeholder `Select...`. The control reads its value from the react-select container's own text (a fallback added
 * for Chakra-flavoured Greenhouse tenants, which render the chosen value as container text with no `singleValue`
 * node), and for an UNFILLED control that text IS the placeholder. So a placeholder became a value, the field counted
 * as answered, and the audit's clean report was wrong in the direction that matters: it says a required field is done
 * when the employer will refuse the submission over it.
 *
 * This is the same failure the project keeps meeting from different sides - a check that answers "is there a value
 * here" while the question is "is this a real value". It is a module rather than two lines inside the audit so that it
 * can be tested without a browser.
 */

/**
 * The strings a control shows when NOTHING has been chosen.
 *
 * Kept deliberately short and literal. A placeholder is a fixed piece of interface furniture, not a pattern to be
 * clever about: a false positive here would mark a real answer as missing, and a false negative leaves the bug above.
 */
const PLACEHOLDERS = [
  "select...",
  "select..",
  "select.",
  "select",
  "select an option",
  "select option",
  "please select",
  "please select...",
  "choose...",
  "choose an option",
  "choose",
  "none selected",
  "no selection",
  "not selected",
  "--",
  "-",
  "—",
  "–",
  "n/a",
  "na",
];

/**
 * True when `displayed` is not an answer: nothing, an unticked box, or a placeholder.
 *
 * @param {string} displayed the control's displayed value, already whitespace-collapsed
 */
export function isEmptyDisplayed(displayed) {
  const text = String(displayed || "").replace(/\s+/g, " ").trim();
  if (!text) return true;
  if (text === "[unchecked]") return true;
  const lowered = text.toLowerCase();
  if (PLACEHOLDERS.includes(lowered)) return true;
  // `Select…` with the single-character ellipsis is the same placeholder, and a tenant may ship either.
  if (lowered.replace(/\u2026/g, "...").replace(/\.+$/, ".") === "select.") return true;
  return false;
}

/**
 * The same question for a whole row, so callers do not each re-implement the three cases.
 * A row is `{displayed, invalid}` as `audit_form_fields.mjs` builds it.
 */
export function isBlankRow(row) {
  return isEmptyDisplayed(row && row.displayed);
}
