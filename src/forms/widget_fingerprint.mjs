/**
 * Classify one observed control by HOW it is operated. Question wording, IDs,
 * names, option text and current values belong to the instance, not the type.
 *
 * A fingerprint selects a driver, never an answer. The driver must still find the
 * current field, read its current options, and verify the committed value.
 */

export const RECIPES = Object.freeze({
  native_select: { tool: "apply_form_spec.mjs", open: "native", optionsFrom: "select.options", commit: "selectOption", verify: "selected option text" },
  react_select: { tool: "pick_option.mjs", open: "click control", optionsFrom: "visible listbox options", commit: "click exact option", verify: "selected display node(s)" },
  react_multi_select: { tool: "pick_option.mjs", open: "click control", optionsFrom: "visible listbox options", commit: "click each exact option", verify: "multi-value display set" },
  input_combobox: { tool: "pick_option.mjs", open: "click input or toggle", optionsFrom: "visible listbox options", commit: "click exact option", verify: "combobox value/display" },
  radio_group: { tool: "click_group_option.mjs", open: "none", optionsFrom: "associated radio labels", commit: "click exact label", verify: "checked radio and its label" },
  checkbox: { tool: "check_group_options.mjs", open: "none", optionsFrom: "associated checkbox labels", commit: "click exact label", verify: "checked state and label" },
  text_input: { tool: "apply_form_spec.mjs", open: "none", optionsFrom: "none", commit: "type and blur", verify: "input value" },
  textarea: { tool: "apply_form_spec.mjs", open: "none", optionsFrom: "none", commit: "type and blur", verify: "textarea value" },
  file_upload: { tool: "apply_form_spec.mjs", open: "none", optionsFrom: "none", commit: "setInputFiles", verify: "uploaded filename in form" },
  button_pair: { tool: "answer_by_question_text.mjs", open: "none", optionsFrom: "button text", commit: "click exact button", verify: "companion input; aria-only needs submit gate" },
  native_multi_select: { tool: "apply_form_spec.mjs", open: "none", optionsFrom: "the select's own options", commit: "selectOption, ADDING to what is already chosen", verify: "every selected option" },
  div_dropdown: { tool: "pick_option.mjs", open: "click control", optionsFrom: "option nodes", commit: "click exact option", verify: "control display" },
});

function kindOf(field) {
  const tag = String(field.tag || "").toLowerCase();
  const type = String(field.type || "").toLowerCase();
  const role = String(field.role || "").toLowerCase();
  const evidence = field.widget_evidence || {};

  if (tag === "select") return evidence.nativeMultiple ? "native_multi_select" : "native_select";
  if (type === "file") return "file_upload";
  if (type === "radio") return "radio_group";
  if (type === "checkbox") return "checkbox";
  if (tag === "textarea") return "textarea";
  if (evidence.buttonPair && tag !== "button") return "button_pair_role";
  if (evidence.buttonPair && (evidence.hiddenCompanion || evidence.ariaPressed)) return "button_pair";
  if (evidence.divDropdown) return "div_dropdown";
  // A role=combobox alone is NOT proof of react-select. Ashby uses a plain
  // input and a sibling toggle; treating it as react-select hid the real driver.
  if (evidence.selectControl) return evidence.multiSelect ? "react_multi_select" : "react_select";
  if (role === "combobox" && (evidence.listbox || evidence.toggle)) return "input_combobox";
  if (role === "combobox") return "unknown";
  if (tag === "input" && (!type || ["text", "email", "tel", "url", "number", "date", "search"].includes(type))) {
    return "text_input";
  }
  return "unknown";
}

/** The raw option strings are evidence from THIS page, never a cached answer. */
export function classifyWidget(field) {
  const kind = kindOf(field);
  const evidence = field.widget_evidence || {};
  const options = Array.isArray(field.options) ? field.options.filter((x) => typeof x === "string" && x.trim()) : [];
  const optionSource = RECIPES[kind]?.optionsFrom || (kind === "native_multi_select" ? "select.options" : "unknown");
  const variant = kind === "input_combobox" ? (evidence.toggle ? "toggle" : "input")
    : kind === "button_pair" ? (evidence.hiddenCompanion ? "hidden-input" : "aria")
    : "standard";
  const fingerprint = `widget/v1/${kind}/${variant}`;
  return {
    kind,
    fingerprint,
    options,
    optionsStatus: optionSource === "none" ? "not_applicable" : options.length ? "observed" : "not_observed",
    verificationStatus: !RECIPES[kind] ? "unknown"
      : kind === "button_pair" && !evidence.hiddenCompanion ? "provisional" : "observable",
    recipe: RECIPES[kind] || null,
  };
}

export function summarizeWidgets(widgets) {
  const byFingerprint = {};
  for (const item of widgets) {
    const key = item.widget?.fingerprint || "widget/v1/unknown/standard";
    byFingerprint[key] = (byFingerprint[key] || 0) + 1;
  }
  return {
    total: widgets.length,
    unknown: widgets.filter(item => !item.widget?.recipe).length,
    provisional: widgets.filter(item => item.widget?.verificationStatus === "provisional").length,
    by_fingerprint: byFingerprint,
  };
}
