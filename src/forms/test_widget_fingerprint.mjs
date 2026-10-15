import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyWidget, RECIPES, summarizeWidgets } from "./widget_fingerprint.mjs";
import { readAssociatedOptions } from "./widget_dom.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const menu = (id, labels) => ({
  id, offsetWidth: 1, offsetHeight: 0, getClientRects: () => [],
  querySelectorAll: () => labels.map(textContent => ({ textContent, offsetWidth: 1, offsetHeight: 0, getClientRects: () => [] })),
});
const control = (menuId, menus) => ({
  getAttribute: name => name === "aria-controls" ? menuId : null,
  querySelector: () => null,
  getRootNode: () => ({ getElementById: id => menus.find(m => m.id === id) || null }),
});
const dom = menus => ({
  getElementById: id => menus.find(m => m.id === id) || null,
  querySelectorAll: () => menus,
});

test("the same question with a different control gets a different driver", () => {
  const label = "Are you legally authorized to work in the United States?";
  const native = classifyWidget({ label, tag: "select", options: ["Yes", "No"] });
  const radios = classifyWidget({ label, tag: "input", type: "radio", options: ["Yes", "No"] });
  assert.notEqual(native.fingerprint, radios.fingerprint);
  assert.equal(native.recipe.optionsFrom, "select.options");
  assert.equal(radios.recipe.verify, "checked radio and its label");
});

test("dynamic IDs, labels and option text do not split one control type", () => {
  const shape = { tag: "input", type: "text", role: "combobox", widget_evidence: { listbox: true, toggle: true } };
  const a = classifyWidget({ ...shape, ref: "id:office_123", label: "Office", options: ["Seattle", "SF"] });
  const b = classifyWidget({ ...shape, ref: "id:office_987", label: "Location", options: ["LA", "NY"] });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual(a.options, ["Seattle", "SF"]);
  assert.deepEqual(b.options, ["LA", "NY"]);
  assert.equal(a.recipe.tool, "pick_option.mjs");
});

test("a combobox role alone does not falsely identify a react-select", () => {
  const ashby = classifyWidget({ tag: "input", type: "text", role: "combobox",
    widget_evidence: { listbox: true, toggle: true }, options: ["San Francisco", "Seattle"] });
  const react = classifyWidget({ tag: "input", role: "combobox",
    widget_evidence: { selectControl: true, selectedDisplay: true, listbox: true },
    options: ["Lakeside State University - Fairview", "Fairview College"] });
  assert.equal(ashby.kind, "input_combobox");
  assert.equal(react.kind, "react_select");
  assert.notEqual(ashby.fingerprint, react.fingerprint);
  assert.equal(react.recipe.verify, "selected display node(s)");
});

test("single and multi-select controls have different verification recipes", () => {
  const single = classifyWidget({ tag: "input", role: "combobox", widget_evidence: { selectControl: true } });
  const multi = classifyWidget({ tag: "input", role: "combobox", widget_evidence: { selectControl: true, multiSelect: true } });
  const nativeMulti = classifyWidget({ tag: "select", widget_evidence: { nativeMultiple: true } });
  assert.notEqual(single.fingerprint, multi.fingerprint);
  assert.equal(multi.recipe.verify, "multi-value display set");
  assert.equal(nativeMulti.kind, "native_multi_select");
  // It HAD no recipe, because the driver only ever committed one option - `selectOption` sets the selection, so
  // a second entry naming the same `multiple` select discarded the first. The driver now adds to what is already
  // chosen, and its round trip asserts both options survive, so the fingerprint claims a driver like the rest.
  assert.equal(nativeMulti.recipe.commit, "selectOption, ADDING to what is already chosen");
  assert.equal(nativeMulti.verificationStatus, "observable");
});

test("selection state does not change a react-select's fingerprint", () => {
  const empty = classifyWidget({ tag: "input", role: "combobox", widget_evidence: { selectControl: true } });
  const filled = classifyWidget({ tag: "input", role: "combobox", widget_evidence: { selectControl: true, selectedDisplay: true },
    value: "Seattle" });
  assert.equal(empty.fingerprint, filled.fingerprint);
});

test("unexplained combobox remains unknown rather than receiving a guessed recipe", () => {
  const x = classifyWidget({ tag: "input", role: "combobox", options: [] });
  assert.equal(x.kind, "unknown");
  assert.equal(x.recipe, null);
  assert.equal(x.optionsStatus, "not_observed");
});

test("option inventory preserves exact current text and does not supply an answer", () => {
  const x = classifyWidget({ tag: "select", options: ["No, I have never.", "No, not currently", "Yes"] });
  assert.deepEqual(x.options, ["No, I have never.", "No, not currently", "Yes"]);
  assert.equal(x.optionsStatus, "observed");
  assert.equal("answer" in x, false);
});

test("plain text, upload and checkbox mechanisms stay separate", () => {
  const text = classifyWidget({ tag: "input", type: "text" });
  const file = classifyWidget({ tag: "input", type: "file" });
  const checkbox = classifyWidget({ tag: "input", type: "checkbox", options: ["I agree"] });
  assert.equal(text.recipe.commit, "type and blur");
  assert.equal(file.recipe.commit, "setInputFiles");
  assert.equal(checkbox.recipe.verify, "checked state and label");
  assert.equal(new Set([text.fingerprint, file.fingerprint, checkbox.fingerprint]).size, 3);
});

test("the fixture's hidden-checkbox button pair has its own mechanism", () => {
  const pair = classifyWidget({ tag: "button", role: "button", type: "button",
    options: ["Yes", "No"], widget_evidence: { buttonPair: true, hiddenCompanion: true } });
  assert.equal(pair.fingerprint, "widget/v1/button_pair/hidden-input");
  assert.equal(pair.recipe.verify, "companion input; aria-only needs submit gate");
  assert.equal(pair.verificationStatus, "observable");
  assert.deepEqual(pair.options, ["Yes", "No"]);
});

test("a button pair with no observable committed state stays unknown", () => {
  const pair = classifyWidget({ tag: "button", role: "button", type: "button",
    options: ["Yes", "No"], widget_evidence: { buttonPair: true } });
  assert.equal(pair.kind, "unknown");
  assert.equal(pair.recipe, null);
});

test("an aria-only button pair is recognized but needs server-side verification", () => {
  const pair = classifyWidget({ tag: "button", role: "button", type: "button",
    options: ["Yes", "No"], widget_evidence: { buttonPair: true, ariaPressed: true } });
  assert.equal(pair.kind, "button_pair");
  assert.equal(pair.verificationStatus, "provisional");
});

test("role-based button pairs remain visible without claiming an unsupported driver", () => {
  const pair = classifyWidget({ tag: "div", role: "button", options: ["Yes", "No"],
    widget_evidence: { buttonPair: true, ariaPressed: true } });
  assert.equal(pair.kind, "button_pair_role");
  assert.equal(pair.recipe, null);
  // AND NO REAL FORM HAS EVER PRODUCED ONE. That is what makes a null recipe honest here rather than a gap:
  // the corpus promises every shape it contains was filled to completion, and this shape is not in it, so
  // nothing is being left undrivable. The assertion below is the tripwire - if a live scan ever produces a
  // `button_pair_role`, the decision above deserves revisiting with the form in hand.
  //
  // It was checked by trying: a `[role=radio]` Yes/No pair was added to the fixture to render this branch, and
  // the fixture-driver gate refused it - "only a native multi-select may lack a driver". That gate was right
  // and the fixture was wrong, because rendering a shape no real form has shown would have pressured this
  // decision with an invention rather than evidence. The fixture is gone; the fact it established is here.
  const corpus = readFileSync(join(HERE, "fixtures/observed-shapes.json"), "utf8");
  assert.ok(!corpus.includes("button_pair_role"),
    "a real scan produced a role-based button pair - decide what drives it, or record it as the second known gap");
});

test("a bare SELECT... div is distinct from a native select", () => {
  const div = classifyWidget({ tag: "div", role: "button", options: ["California", "Washington"],
    widget_evidence: { divDropdown: true } });
  const native = classifyWidget({ tag: "select", options: ["California", "Washington"] });
  assert.equal(div.kind, "div_dropdown");
  assert.notEqual(div.fingerprint, native.fingerprint);
  assert.equal(div.recipe.verify, "control display");
});

test("option inventory reads the linked menu, never another open field's options", () => {
  const school = menu("school-list", ["Lakeside State University - Fairview", "Fairview College"]);
  const office = menu("office-list", ["Seattle", "San Francisco"]);
  assert.deepEqual(readAssociatedOptions(control("school-list", [school, office]), dom([school, office])),
    ["Lakeside State University - Fairview", "Fairview College"]);
});

test("two unlinked visible menus are ambiguous and yield no options", () => {
  const a = menu("a", ["Yes"]), b = menu("b", ["No"]);
  assert.deepEqual(readAssociatedOptions(control(null, [a, b]), dom([a, b])), []);
  assert.deepEqual(readAssociatedOptions(control(null, [a]), dom([a])), ["Yes"]);
});

test("a closed linked menu cannot borrow a different field's visible options", () => {
  const closed = { ...menu("school-list", ["School A"]), offsetWidth: 0 };
  const office = menu("office-list", ["Seattle"]);
  assert.deepEqual(readAssociatedOptions(control("school-list", [closed, office]), dom([closed, office])), []);
});

test("coverage summary counts unknown instances and stable control types", () => {
  const fields = [
    { widget: classifyWidget({ tag: "input", type: "text", label: "Name" }) },
    { widget: classifyWidget({ tag: "input", type: "text", label: "Email" }) },
    { widget: classifyWidget({ tag: "input", role: "combobox" }) },
    { widget: classifyWidget({ tag: "select", widget_evidence: { nativeMultiple: true }, options: ["A", "B"] }) },
  ];
  assert.deepEqual(summarizeWidgets(fields), {
    // ONE unknown, not two: a `multiple` select used to be counted here because it had no driver. It has one
    // now, and the bare `role=combobox` is what remains genuinely unrecognised - which is the count's purpose.
    total: 4, unknown: 1, provisional: 0,
    by_fingerprint: { "widget/v1/text_input/standard": 2, "widget/v1/unknown/standard": 1,
      "widget/v1/native_multi_select/standard": 1 },
  });
});

test("a textarea is its own mechanism, not a text input", () => {
  const area = classifyWidget({ tag: "textarea", label: "Anything else we should know?" });
  assert.equal(area.kind, "textarea");
  assert.equal(area.fingerprint, "widget/v1/textarea/standard");
  assert.equal(area.recipe.commit, "type and blur");
  assert.equal(area.optionsStatus, "not_applicable", "a textarea has no option list to inventory");
});

test("every single-line input the filler may type into is a text_input", () => {
  for (const type of ["", "text", "email", "tel", "url", "number", "date", "search"]) {
    assert.equal(classifyWidget({ tag: "input", type }).kind, "text_input", `type=${JSON.stringify(type)}`);
  }
});

test("a password field is never handed a driver", () => {
  const w = classifyWidget({ tag: "input", type: "password", label: "Password" });
  assert.equal(w.kind, "unknown");
  assert.equal(w.recipe, null, "an autofill path must not be able to reach a credential field");
});

test("an element carrying no evidence is unknown rather than guessed", () => {
  const w = classifyWidget({ tag: "div" });
  assert.equal(w.kind, "unknown");
  assert.equal(w.fingerprint, "widget/v1/unknown/standard");
  assert.equal(w.optionsStatus, "not_observed");
  assert.equal(w.verificationStatus, "unknown");
});

test("an input_combobox with no toggle differs from one with a toggle", () => {
  const plain = classifyWidget({ tag: "input", role: "combobox", widget_evidence: { listbox: true } });
  const toggled = classifyWidget({ tag: "input", role: "combobox", widget_evidence: { listbox: true, toggle: true } });
  assert.equal(plain.fingerprint, "widget/v1/input_combobox/input");
  assert.equal(toggled.fingerprint, "widget/v1/input_combobox/toggle");
});

test("the two button-pair variants are told apart", () => {
  const aria = classifyWidget({ tag: "button", role: "button", widget_evidence: { buttonPair: true, ariaPressed: true } });
  const hidden = classifyWidget({ tag: "button", role: "button", widget_evidence: { buttonPair: true, hiddenCompanion: true } });
  assert.equal(aria.fingerprint, "widget/v1/button_pair/aria");
  assert.equal(hidden.fingerprint, "widget/v1/button_pair/hidden-input");
  assert.notEqual(aria.fingerprint, hidden.fingerprint);
});

test("an entry carrying no widget at all still counts as unknown", () => {
  const s = summarizeWidgets([{ ref: "id:x" }, { widget: classifyWidget({ tag: "select" }) }]);
  assert.equal(s.unknown, 1);
  assert.deepEqual(s.by_fingerprint, {
    "widget/v1/unknown/standard": 1, "widget/v1/native_select/standard": 1,
  });
});

test("a wrapper whose descendant declares the menu resolves to that menu", () => {
  // `inspect_ats_form.mjs` evaluates this against whatever the ref points at, and on some tenants
  // that is the wrapping element rather than the input that carries aria-controls.
  const school = menu("school-list", ["School A", "School B"]);
  const wrapper = {
    getAttribute: () => null,
    querySelector: sel => (sel === "[aria-controls]" ? { getAttribute: () => "school-list" } : null),
    getRootNode: () => ({ getElementById: id => (id === "school-list" ? school : null) }),
  };
  assert.deepEqual(readAssociatedOptions(wrapper, dom([school])), ["School A", "School B"]);
});

test("a menu resolves from the document when the root has no lookup", () => {
  const school = menu("school-list", ["School A"]);
  const el = {
    getAttribute: name => (name === "aria-controls" ? "school-list" : null),
    querySelector: () => null,
    getRootNode: () => ({}), // a shadow root mid-teardown, or a stand-in without the method
  };
  assert.deepEqual(readAssociatedOptions(el, dom([school])), ["School A"]);
});

test("option text is trimmed and collapsed, and a blank option is dropped", () => {
  const m = menu("m", ["  Seattle  ", "San   Francisco", "   "]);
  assert.deepEqual(readAssociatedOptions(control("m", [m]), dom([m])), ["Seattle", "San Francisco"]);
});

test("an option that is not visible is not offered as a choice", () => {
  const hidden = { textContent: "Atlantis", offsetWidth: 0, offsetHeight: 0, getClientRects: () => [] };
  const shown = { textContent: "Seattle", offsetWidth: 1, offsetHeight: 0, getClientRects: () => [] };
  const m = { id: "m", offsetWidth: 1, offsetHeight: 0, getClientRects: () => [], querySelectorAll: () => [hidden, shown] };
  assert.deepEqual(readAssociatedOptions(control("m", [m]), dom([m])), ["Seattle"]);
});

test("every recipe is complete, and names a driver that is actually there", () => {
  // The tools behind these names have been renamed and merged more than once: `fixtures/ats_widgets.html`
  // still refers to answer_by_checkbox.mjs, pick_select_option.mjs and click_radio_plan.mjs, and not one
  // of those is in src/forms any more. A recipe that names a tool nobody can run reads like a settled
  // answer while being a dead end, so the pointer is checked rather than trusted.
  for (const [kind, recipe] of Object.entries(RECIPES)) {
    for (const field of ["tool", "open", "optionsFrom", "commit", "verify"]) {
      assert.ok(recipe[field], `${kind}: recipe declares no ${field}`);
    }
    assert.ok(existsSync(join(HERE, recipe.tool)), `${kind}: recipe names ${recipe.tool}, absent from src/forms/`);
  }
});

test("a fingerprint reads back as its version, kind and variant", () => {
  // Downstream dispatch would parse this string, so its shape is pinned now, while nothing parses it
  // yet and the format is still free to change deliberately.
  const w = classifyWidget({ tag: "input", role: "combobox", widget_evidence: { listbox: true, toggle: true } });
  const [prefix, version, kind, variant] = w.fingerprint.split("/");
  assert.equal(prefix, "widget");
  assert.equal(version, "v1");
  assert.equal(kind, w.kind);
  assert.equal(variant, "toggle");
});
