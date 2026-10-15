/**
 * test_widget_scan.mjs — the fixture pages, driven through the real scanners in a real browser.
 *
 * `fixtures/ats_widgets.html` reproduces, one fieldset per shape, the controls this project has
 * already been broken by. Each of them was worth a wasted round or a failed submission; the file
 * existed for months with nothing driving it. This is that driver.
 *
 * What is asserted here is deliberately NOT "the scanner returns something". It is the exact
 * inventory a filler depends on: which controls are listed at all, which of them share a ref, what
 * the question text is, and what the current options are. A scanner that quietly stops seeing a
 * control, or starts reporting it under another field's question, is the failure this file is for.
 *
 * A missing browser SKIPS. The cache holding a different build than `playwright-core` was pinned to
 * is an environment fact, not a defect in the code under test.
 */
import nodeTest, { after, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { browserCandidates, launchHeadless, withFixture } from "./fixture_browser.mjs";
import { withDeadline } from "./bounded_waits.mjs";
import { collectApplyAffordances, collectEmbeddedForms, collectExtraWidgets, collectFields } from "./widget_scan.mjs";
import { readAssociatedOptions } from "./widget_dom.mjs";
import { classifyWidget, summarizeWidgets } from "./widget_fingerprint.mjs";

const CACHE = join(process.env.HOME || "", "Library/Caches", "ms-playwright");
let browser = null;

// EVERY TEST IN THIS FILE DRIVES A REAL BROWSER, so every test is bounded. A fixture scan is ~50-600 ms;
// this is two orders of magnitude above that, and it exists so that a browser which stops answering produces
// a fast, named failure rather than a suite that never ends. `withFixture` bounds the page reads themselves;
// this is the outer limit for a test that never reaches its own failure.
const FIXTURE_TEST_TIMEOUT_MS = 45_000;
const test = (name, fnOrOpts, maybeFn) =>
  typeof fnOrOpts === "function"
    ? nodeTest(name, { timeout: FIXTURE_TEST_TIMEOUT_MS }, fnOrOpts)
    : nodeTest(name, { timeout: FIXTURE_TEST_TIMEOUT_MS, ...fnOrOpts }, maybeFn);

before(async () => {
  // Launching the browser is itself a wait that a wedged machine can stall. `launchHeadless` walks its
  // candidates and returns null rather than failing, so a slow launch must not hold the FILE open either.
  browser = await withDeadline(launchHeadless(browserCandidates(CACHE)), "launching the headless fixture browser", 60_000);
}, { timeout: 90_000 });

after(async () => {
  await withDeadline(browser?.close() ?? Promise.resolve(), "closing the headless fixture browser", 20_000).catch(() => {});
}, { timeout: 30_000 });

/** Scan a fixture once, classify everything, and union by ref exactly as inspect_ats_form.mjs does. */
const scans = new Map();
function scan(name) {
  if (!scans.has(name)) {
    scans.set(name, withFixture(browser, name, async (page) => {
      const raw = await page.evaluate(collectFields);
      const extras = await page.evaluate(collectExtraWidgets);
      const byRef = new Map();
      for (const f of raw) {
        const identity = f.ref || f.key;
        if (!byRef.has(identity)) byRef.set(identity, f);
      }
      const fields = [...byRef.values()];
      for (const f of [...fields, ...extras]) f.widget = classifyWidget(f);
      return { fields, extras, summary: summarizeWidgets([...fields, ...extras]) };
    }));
  }
  return scans.get(name);
}

function needsBrowser(t) {
  if (!browser) {
    t.skip(`no usable headless chromium in ${CACHE}`);
    return false;
  }
  return true;
}

const byRef = (fields, ref) => fields.find(f => f.ref === ref);

test("systemFields: the ids cdp_tabs.mjs dedupes a tab on are listed with their values", async (t) => {
  if (!needsBrowser(t)) return;
  const { fields } = await scan("ats_widgets.html");
  const name = byRef(fields, "id:_systemfield_name");
  const email = byRef(fields, "id:_systemfield_email");
  assert.ok(name, "id:_systemfield_name must be listed - dedupe-tabs reads it to tell a filled tab from a blank one");
  assert.ok(email, "id:_systemfield_email must be listed");
  assert.equal(name.label, "Name");
  assert.equal(name.value, "Test Candidate");
  assert.equal(name.widget.kind, "text_input");
  assert.equal(email.label, "Email");
  assert.equal(email.value, "candidate@example.com");
});

test("systemFields: the companion page carries the same two fields, left empty", async (t) => {
  if (!needsBrowser(t)) return;
  const { fields } = await scan("ats_widgets_blank.html");
  const name = byRef(fields, "id:_systemfield_name");
  assert.ok(name, "the blank page must still list the field - a tab without it is neither filled nor blank");
  assert.equal(name.value, "");
  assert.equal(name.widget.kind, "text_input");
});

test("nameOnlyPair: checkboxes named Yes/No stay two controls (Sprinter Health, 2026-10-03)", async (t) => {
  if (!needsBrowser(t)) return;
  const { fields } = await scan("ats_widgets.html");
  const yes = byRef(fields, "id:sprinter_yes");
  const no = byRef(fields, "id:sprinter_no");
  assert.ok(yes && no, "both halves of the name-only pair must be listed with distinct refs");
  assert.equal(yes.option_group, "Yes");
  assert.equal(no.option_group, "No");
  assert.notEqual(yes.key, no.key, "the two halves must not collapse onto one key");
  assert.deepEqual(yes.widget.options, ["Yes"]);
  assert.deepEqual(no.widget.options, ["No"]);
  assert.equal(yes.widget.kind, "checkbox");
});

test("hiddenPair: an Ashby button pair over a hidden checkbox becomes its own widget", async (t) => {
  if (!needsBrowser(t)) return;
  const { extras } = await scan("ats_widgets.html");
  const pair = extras.find(e => e.widget.kind === "button_pair");
  assert.ok(pair, "the button pair has no input a scanner can list - it must be reported as an extra widget");
  assert.equal(pair.ref, "id:hp_container");
  assert.equal(pair.widget.fingerprint, "widget/v1/button_pair/hidden-input");
  assert.equal(pair.widget.verificationStatus, "observable", "a hidden companion input is a readable state");
  assert.deepEqual(pair.widget.options, ["Yes", "No"]);
  assert.match(pair.label, /require visa sponsorship/);
});

test("radioPair: the same question drawn as radios is a radio_group, not a checkbox", async (t) => {
  if (!needsBrowser(t)) return;
  const { fields } = await scan("ats_widgets.html");
  const auth = byRef(fields, "name:auth_choice");
  assert.ok(auth, "radio inputs sharing a name must union onto one ref");
  assert.equal(auth.widget.kind, "radio_group");
  assert.deepEqual(auth.widget.options, ["Yes", "No"]);
  assert.equal(auth.value, "[unchecked]", "an unanswered radio reports its state, not an empty string");
});

test("reactSelect: the shell is a react_select even though it wraps a bare input", async (t) => {
  if (!needsBrowser(t)) return;
  const { fields } = await scan("ats_widgets.html");
  const input = byRef(fields, "id:school_input");
  assert.ok(input, "the inner input must be listed - it is the handle a press targets");
  assert.equal(input.widget.kind, "react_select");
  assert.equal(input.widget.recipe.tool, "pick_option.mjs");
  assert.equal(input.widget.recipe.optionsFrom, "visible listbox options");
});

test("divDropdown: a bare div reading SELECT... is its own widget", async (t) => {
  if (!needsBrowser(t)) return;
  const { extras } = await scan("ats_widgets.html");
  const dd = extras.find(e => e.widget.kind === "div_dropdown");
  assert.ok(dd, "a div trigger is invisible to the input inventory and must be reported as an extra widget");
  assert.equal(dd.ref, "id:state_trigger");
  assert.deepEqual(dd.widget.options, ["California", "Washington"]);
  assert.match(dd.label, /Which state do you plan on working from/);
});

test("ashbyRadioGroup: option text is reachable through the nested wrapper", async (t) => {
  if (!needsBrowser(t)) return;
  const { fields } = await scan("ats_widgets.html");
  const group = fields.filter(f => f.option_group === "rg_team");
  assert.equal(group.length, 4, "each radio has its own id, so the ref union cannot collapse them");
  const expected = ["Infrastructure", "Product Engineering", "Machine Learning", "Security"];
  for (const option of group) {
    assert.equal(option.widget.kind, "radio_group");
    assert.deepEqual(option.widget.options, expected,
      "the option text hangs off a nested div with no for= and no wrapper, and must still be read");
  }
});

test("ashbyCombobox: an input_combobox, not a react-select (TRM Labs, 2026-10-02)", async (t) => {
  if (!needsBrowser(t)) return;
  const { fields } = await scan("ats_widgets.html");
  const office = byRef(fields, "id:office_input");
  assert.ok(office, "the obfuscated-class input must be listed by its id");
  assert.equal(office.widget.kind, "input_combobox");
  assert.equal(office.widget.fingerprint, "widget/v1/input_combobox/toggle");
  assert.equal(office.widget.recipe.tool, "pick_option.mjs");
  assert.equal(office.widget_evidence.toggle, true, "the sibling _toggleButton_ is what opens the list");
});

test("ashbyCombobox: the question is read from its label div, not left empty", async (t) => {
  if (!needsBrowser(t)) return;
  const { fields } = await scan("ats_widgets.html");
  const office = byRef(fields, "id:office_input");
  // The question lives in `div._label_<hash>`, not in a <label>. Reading it as empty sends an
  // ordinary question down the "no profile mapping" path, which is what TRM Labs did on 2026-10-02.
  assert.equal(office.label, "Which office would you work from?");
});

test("every fixture control gets a settled driver, except the one kind that has none", async (t) => {
  if (!needsBrowser(t)) return;
  // `native_multi_select` is a RECOGNISED shape with no driver: the live native-select path commits a
  // single option, so a multi-select cannot be filled by it. It is the only kind allowed to be
  // reported without a recipe, and naming the exception here keeps it visible instead of letting the
  // count drift upward unnoticed.
  for (const fixture of ["ats_widgets.html", "ats_widgets_blank.html"]) {
    const { fields, extras } = await scan(fixture);
    const undriven = [...new Set([...fields, ...extras].filter(f => !f.widget.recipe).map(f => f.widget.kind))];
    // THE EXCEPTION IS GONE. This asserted `["native_multi_select"]` - the one kind allowed to be reported
    // without a driver, because `selectOption` set the selection and a second entry discarded the first. The
    // driver accumulates now and the round trip asserts both options survive, so every control in the fixture
    // has a settled driver and the count cannot drift at all.
    assert.deepEqual(undriven, [], `${fixture}: every control must have a settled driver`);
    assert.ok(fields.length > 0, `${fixture}: the scanner found no controls at all`);
  }
});

test("a shadow-root form is listed, not reported as zero fields", async (t) => {
  if (!needsBrowser(t)) return;
  // SmartRecruiters' One-Click UI renders the whole form inside shadow roots, where a plain
  // document.querySelectorAll sees nothing and the inventory said "fields: 0" on a form that was
  // visibly asking for name, email and phone. The fixture adds that shape on the fly so the walk is
  // exercised without a second file to keep in step.
  const { fields } = await withFixture(browser, "ats_widgets_blank.html", async (page) => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "shadowHost";
      document.body.appendChild(host);
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<div class="question"><label for="sr_phone">Phone</label>'
        + '<input type="text" id="sr_phone" value="+1 555 0100"></div>';
    });
    return { fields: await page.evaluate(collectFields) };
  });
  const phone = fields.find(f => f.ref === "id:sr_phone");
  assert.ok(phone, "a control inside a shadow root must be listed; Playwright locators pierce shadow DOM once it is");
  assert.equal(phone.label, "Phone");
  assert.equal(phone.value, "+1 555 0100");
});

test("reactSelect: the menu appears on demand and is read only from its own control", async (t) => {
  if (!needsBrowser(t)) return;
  const result = await withFixture(browser, "ats_widgets.html", async (page) => {
    const closed = await page.locator("#school_input").evaluate(readAssociatedOptions);
    await page.click("#school_control");
    const opened = await page.locator("#school_input").evaluate(readAssociatedOptions);
    return { closed, opened };
  });
  assert.deepEqual(result.closed, [], "a menu that is not open must not hand over last round's options");
  assert.deepEqual(result.opened, ["Lakeside State University - Fairview", "Fairview College"]);
});

test("two open menus are still read apart, one control at a time", async (t) => {
  if (!needsBrowser(t)) return;
  // The bug this pins: reading every visible [role=listbox] assigned another field's options to the
  // control being filled, so a school question was offered "Seattle". Both menus are open at once here.
  const both = await withFixture(browser, "ats_widgets.html", async (page) => {
    await page.click("#school_control");
    await page.click("#office_input");
    return {
      school: await page.locator("#school_input").evaluate(readAssociatedOptions),
      office: await page.locator("#office_input").evaluate(readAssociatedOptions),
    };
  });
  assert.deepEqual(both.school, ["Lakeside State University - Fairview", "Fairview College"]);
  assert.deepEqual(both.office, ["San Francisco", "Seattle", "New York"]);
});

test("reactSelect: committing an option changes what the scanner reads back", async (t) => {
  if (!needsBrowser(t)) return;
  // `recipe.verify` promises the committed value is observable. This is that promise, end to end: the
  // option is clicked, then the ordinary inventory is asked what the field holds now.
  const readBack = await withFixture(browser, "ats_widgets.html", async (page) => {
    await page.click("#school_control");
    await page.click("#school_listbox [role=option]");
    const fields = await page.evaluate(collectFields);
    return fields.find(f => f.ref === "id:school_input")?.value;
  });
  assert.equal(readBack, "Lakeside State University - Fairview");
});

test("hiddenPair: pressing Yes flips the hidden checkbox the scanner reports", async (t) => {
  if (!needsBrowser(t)) return;
  // The pair has no readable input state of its own; the hidden companion is what makes its
  // verification "observable" rather than "provisional". If that stops holding, the recipe is wrong.
  const readBack = await withFixture(browser, "ats_widgets.html", async (page) => {
    const before = (await page.evaluate(collectFields)).find(f => f.ref === "id:hp_box")?.value;
    await page.click("#hp_container button[data-option=yes]");
    const after = (await page.evaluate(collectFields)).find(f => f.ref === "id:hp_box")?.value;
    return { before, after };
  });
  assert.equal(readBack.before, "[unchecked]");
  assert.equal(readBack.after, "[checked]", "the companion input must carry the answer the buttons committed");
});

test("nameOnlyPair: choosing one half does not silently choose the other", async (t) => {
  if (!needsBrowser(t)) return;
  const state = await withFixture(browser, "ats_widgets.html", async (page) => {
    await page.click("#sprinter_yes");
    return page.evaluate(() => ({
      yes: document.getElementById("sprinter_yes").checked,
      no: document.getElementById("sprinter_no").checked,
      answer: window.__nameOnlyAnswer,
    }));
  });
  assert.equal(state.yes, true);
  assert.equal(state.no, false, "a Yes/No pair must never end up holding both answers");
  assert.equal(state.answer, "Yes");
});

test("noRefInput: the question is read, and the field still has no stable handle", async (t) => {
  if (!needsBrowser(t)) return;
  // Alchemy's live Ashby form, 2026-10-07. Pinned as it is rather than fixed: a fill spec cannot
  // address this field reliably, and that gap is the thing worth earning next.
  const { fields } = await scan("ats_widgets.html");
  const hit = fields.find(f => f.label === "How did you hear about this role?");
  assert.ok(hit, "the question lives in a div._label_, not a <label>, and must still be read");
  assert.equal(hit.widget.kind, "input_combobox");
  assert.equal(hit.ref, "", "no id and no name means no ref; the spec has nothing stable to target");
  assert.match(hit.key, /^input:\d+$/, "the fallback key is an ordinal, so it moves when sections mount in another order");
});

test("eeocRadioGroup: one question with three options is reported as three fields", async (t) => {
  if (!needsBrowser(t)) return;
  // Ashby gives every option its own id, so unioning by ref cannot collapse them. On Alchemy's live
  // form the gender, race and veteran groups produced 14 rows for 3 questions.
  const { fields } = await scan("ats_widgets.html");
  const group = fields.filter(f => f.option_group === "veteran_status");
  assert.equal(group.length, 3);
  for (const row of group) {
    assert.equal(row.widget.kind, "radio_group");
    assert.equal(row.widget.options.length, 3, "each row carries the whole group's options");
  }
  assert.deepEqual(group.map(r => r.label), [
    "I identify as one or more of the classifications of protected veteran listed above",
    "I am not a protected veteran",
    "I decline to self-identify for protected veteran status",
  ], "the label is the option's own text, not the question - which is why the duplication stayed invisible");
});

test("eeocRadioGroup: the group's own question is reported on every row", async (t) => {
  if (!needsBrowser(t)) return;
  // Read live off Alchemy on 2026-10-08: the question is a `div._heading_<hash>` that is a DIRECT
  // CHILD of the field entry, and the fieldset Ashby uses carries no legend. Without this the drafter
  // sees three rows reading "I am not a protected veteran" and no question anywhere among them.
  const { fields } = await scan("ats_widgets.html");
  const group = fields.filter(f => f.option_group === "veteran_status");
  assert.equal(group.length, 3);
  for (const row of group) {
    assert.equal(row.group_label, "Veteran Status");
  }
});

test("siblingLabelControl: a label's asterisk is the only required signal the field carries", async (t) => {
  if (!needsBrowser(t)) return;
  // driving-widgets-cases-3: "on a Greenhouse embed, REQUIRED is an asterisk in the label - not the input's
  // `required` property". This fixture's label ends in `*` and its input carries neither `required` nor
  // `aria-required`, which is that shape exactly. Read as optional, a required question stays blank and never
  // reaches `needs_review` - the drafter has no reason to look at it - and the miss is only discovered when
  // the server refuses the submission.
  const { fields } = await scan("ats_widgets.html");
  const control = byRef(fields, "id:slc_input");
  assert.ok(control, "the control must be listed");
  assert.equal(control.required, true, "the asterisk is the only signal this field carries");
});

test("multiCheckboxGroup: a required checkbox group is reported, with its question", async (t) => {
  if (!needsBrowser(t)) return;
  // OKX, driving-widgets-cases-3: "a required CHECKBOX GROUP is invisible to a scan that filters checkboxes
  // out". Before this fixture the only checkbox groups here were a PAIR behind a button and a hidden
  // companion, so `group_label` had only ever been exercised on RADIOS - and the shape matters because the
  // Agave/Tenex over-check bug was this one: a filler that ticks every box in a group makes a false skills
  // claim, which `do_not_claim` makes a correctness failure rather than a style one.
  const { fields } = await scan("ats_widgets.html");
  const group = fields.filter(f => String(f.ref).startsWith("id:mcg_"));
  assert.equal(group.length, 3, "every box in the group must be reported, not filtered out");
  for (const row of group) {
    assert.match(row.group_label, /^Which languages/,
      "the legend is the group's question, and without it the three rows are three bare language names");
  }
});

test("siblingValueLeak: a control's value comes from ITS OWN display, not from the wrapper's", async (t) => {
  if (!needsBrowser(t)) return;
  // THE ONE BUG IN THIS FILE THAT REPORTS NOTHING WHEN IT RETURNS. Two react-selects share a question wrapper; the
  // first is answered `No` and the second is empty. Reading the wrapper's `select__single-value` nodes gives the
  // second control the FIRST one's answer - which is what happened on the Twitch form, where `race` read `No`, the
  // value of the `hispanic_ethnicity` control above it. `draft_form_spec.py` only drafts BLANK fields, so it treated
  // `race` as answered, never emitted it, and no check could report it: not drafted, not in needs_review, not blank.
  //
  // Greenhouse's EEO block is this shape, and `audit_form_fields.mjs` carries the same fix from 2026-10-10.
  const { fields } = await scan("ats_widgets.html");
  const first = fields.find(f => f.ref === "id:svl_first");
  const second = fields.find(f => f.ref === "id:svl_second");
  assert.ok(first && second, "both controls must be found - they share a wrapper, not a value");
  assert.equal(first.value, "No", "the answered control reports its own value");
  assert.notEqual(second.value, "No",
    "the empty control must NOT inherit its sibling's value; treating it as answered hides a required field");
  assert.equal(second.value, "", "an unanswered react-select reads as empty");
});

test("idWithEmptyName: the id is the ref even when a name attribute is present and empty", async (t) => {
  if (!needsBrowser(t)) return;
  // DoorDash, driving-widgets-cases-3: `id="candidate-location"` with `name=""`. Addressed as
  // `[name="candidate-location"]` it matched NOTHING, the fallback click landed at the top of the form, and the
  // list that appeared belonged to the PHONE field - 244 international dialling codes - so the evidence on
  // screen said "this location widget returns countries" and it was misdiagnosed twice. The scanner prefers the
  // id, and this is the fixture that says so.
  const { fields } = await scan("ats_widgets.html");
  const control = fields.find(f => f.ref === "id:ien_location");
  assert.ok(control, "the control must be addressable, and by its id");
  assert.equal(control.label, "Location (City)*",
    "the question is reachable through the id; a name-based ref has nothing to attach the label to");
  // Deliberately NOT asserted: that every field has a ref. The `noRefInput` shape has neither attribute and is
  // addressed by its label instead, which is why `widget_scan` falls back to a positional key for it.
});

test("radioPair: a legend is the group's question when the tenant uses one", async (t) => {
  if (!needsBrowser(t)) return;
  const { fields } = await scan("ats_widgets.html");
  const auth = fields.find(f => f.ref === "name:auth_choice");
  assert.match(auth.group_label, /^radioPair/, "the enclosing fieldset's legend is the question here");
});

test("selectShellRemix: the remix-css react-select build is recognised too", async (t) => {
  if (!needsBrowser(t)) return;
  // Stripe and Affirm render `select-shell remix-css-*` where Chime, Lyft and Pinterest render
  // `select__control ... css-*`. Roblox is the tenant that forced the second prefix into the scanner,
  // and until now no fixture rendered it, so nothing proved the branch still worked.
  const { fields } = await scan("ats_widgets.html");
  const input = byRef(fields, "id:ssh_input");
  assert.ok(input, "the control inside the remix-css shell must be listed");
  assert.equal(input.widget.kind, "react_select");
  assert.equal(input.widget.recipe.tool, "pick_option.mjs");
});

test("dataFieldPathRadios: a group anchored by data-field-path is an ordinary radio_group", async (t) => {
  if (!needsBrowser(t)) return;
  const { fields } = await scan("ats_widgets.html");
  const yes = byRef(fields, "id:dfp_yes");
  const no = byRef(fields, "id:dfp_no");
  assert.ok(yes && no, "both rows must be listed");
  assert.equal(yes.widget.kind, "radio_group");
  assert.equal(yes.option_group, "dfp_sponsor");
});

test("datepickerField: a dangling label[for] is read through data-field-path", async (t) => {
  if (!needsBrowser(t)) return;
  // Ashby's start-date question, quoted verbatim in the reference: `label for="4250aa2c-…"` names an id
  // no element carries, the input has no id and no name, and `data-field-path` is the only anchor.
  // Before the scanner learned that attribute it reported this question as EMPTY, which downstream
  // reads as "no profile mapping" - a required date handed to a human for no reason.
  const { fields } = await scan("ats_widgets.html");
  const picker = fields.find(f => f.label === "When can you start a new role?");
  assert.ok(picker, "the question must be readable from the field-path entry");
  assert.equal(picker.widget.kind, "text_input");
  assert.equal(picker.required, true);
  assert.equal(picker.ref, "", "and the control still has no stable handle - that half is NOT fixed");
});

test("siblingLabelControl: the question is read even though its control is a SIBLING", async (t) => {
  if (!needsBrowser(t)) return;
  // Samsara, 2026-10-05. A search that matched the question text returned the LABEL and concluded
  // `hasSelect: false, inputs: []`, because a react-select's label does not contain its control - they
  // are siblings inside a shared field wrapper. The scanner only finds this by walking outward from
  // the control to that wrapper, and no fixture had ever rendered the shape.
  const { fields } = await scan("ats_widgets.html");
  const control = byRef(fields, "id:slc_input");
  assert.ok(control, "the control must be listed even though nothing above it is a <label>");
  assert.equal(control.label, "AI Policy for Interviewers*");
  assert.equal(control.widget.kind, "react_select");
});

test("embeddedForm: the fields behind the host's frame are listed only in the frame itself", async (t) => {  if (!needsBrowser(t)) return;
  const direct = await scan("iframe_form.html");
  assert.deepEqual(direct.fields.map(f => f.ref), ["id:embed_name", "id:embed_email"]);
  for (const field of direct.fields) assert.equal(field.widget.kind, "text_input");
});

test("iframeHost: a zero inventory points at the frame instead of saying nothing", async (t) => {
  if (!needsBrowser(t)) return;
  // Asana, 2026-10-07: the posting redirects to asana.com and embeds the Greenhouse form. The silent
  // `fields: 0` read like an empty form and cost the round; the frame's src is the way back.
  const result = await withFixture(browser, "ats_widgets_iframe.html", async (page) => ({
    fields: await page.evaluate(collectFields),
    extras: await page.evaluate(collectExtraWidgets),
    frames: await page.evaluate(collectEmbeddedForms),
  }));
  assert.equal(result.fields.length, 0, "the top document carries no controls - that is the shape");
  assert.equal(result.extras.length, 0);
  assert.equal(result.frames.length, 1, "the frame is the only way to recover from a zero inventory");
  assert.equal(result.frames[0].id, "embed");
  assert.match(result.frames[0].src, /iframe_form\.html$/, "the src is the URL to open instead");
});

test("iframeHost: frames with no src of their own are not offered as leads", async (t) => {
  if (!needsBrowser(t)) return;
  // reCAPTCHA and tag managers leave src-less and about:blank frames on every page. Reporting those
  // would bury the one frame that is the actual form.
  const frames = await withFixture(browser, "ats_widgets_iframe.html", async (page) => {
    await page.evaluate(() => {
      const blank = document.createElement("iframe");
      blank.id = "srcLess";
      document.body.appendChild(blank);
      const about = document.createElement("iframe");
      about.id = "aboutBlank";
      about.src = "about:blank";
      document.body.appendChild(about);
    });
    return page.evaluate(collectEmbeddedForms);
  });
  assert.deepEqual(frames.map(f => f.id), ["embed"]);
});

test("nativeSelect: a real select is named, single and multiple", async (t) => {
  if (!needsBrowser(t)) return;
  // 65 of these live in the saved corpus and the fixture had none, so `native_select` was a
  // fingerprint no test had ever rendered. The `multiple` one is the shape with NO driver at all.
  const { fields } = await scan("ats_widgets.html");
  const single = byRef(fields, "id:ns_country");
  const multi = byRef(fields, "id:ns_offices");
  assert.ok(single && multi, "both selects must be listed");
  assert.equal(single.widget.kind, "native_select");
  assert.equal(single.widget.fingerprint, "widget/v1/native_select/standard");
  assert.deepEqual(single.widget.options, ["Select...", "United States", "Canada"]);
  assert.equal(single.widget.recipe.commit, "selectOption");
  assert.equal(multi.widget.kind, "native_multi_select");
  // It HAD no driver, and that was the honest state while `selectOption` SET the selection - two spec entries
  // naming one `multiple` select left only the second. The driver now adds to what is already chosen and the
  // round trip asserts both options survive, so this is the last corpus shape to stop being a known gap.
  assert.equal(multi.widget.recipe.commit, "selectOption, ADDING to what is already chosen");
});

test("inputTypes: every single-line type folds into one text_input mechanism", async (t) => {
  if (!needsBrowser(t)) return;
  // `number` alone is 70 saved fields and the bare `<input>` with no type attribute is 261 more.
  // classifyWidget claims they are all one mechanism; that claim was only ever tested with "text".
  const { fields } = await scan("ats_widgets.html");
  for (const ref of ["id:it_number", "id:it_url", "id:it_search", "id:it_tel", "id:it_email", "id:it_bare"]) {
    const field = byRef(fields, ref);
    assert.ok(field, `${ref} must be listed`);
    assert.equal(field.widget.kind, "text_input", ref);
    assert.equal(field.widget.fingerprint, "widget/v1/text_input/standard", ref);
  }
  assert.equal(byRef(fields, "id:it_bare").type, "", "a tenant that never set a type is still a text input");
  assert.equal(byRef(fields, "id:it_number").widget.recipe.commit, "type and blur");
});

test("longText: a textarea is its own mechanism and carries no options", async (t) => {
  if (!needsBrowser(t)) return;
  // 665 saved fields are textareas - every long answer this project has written - and none was rendered.
  const { fields } = await scan("ats_widgets.html");
  const area = byRef(fields, "id:lt_summary");
  assert.ok(area, "a textarea must be listed");
  assert.equal(area.tag, "textarea");
  assert.equal(area.widget.kind, "textarea");
  assert.equal(area.widget.optionsStatus, "not_applicable");
  assert.deepEqual(area.widget.options, []);
});

test("fileUpload: the labelled and the unlabelled resume input are listed alike", async (t) => {
  if (!needsBrowser(t)) return;
  // The unlabelled one is the Chime bug of 2026-10-08: the resume was only recorded when a group's
  // name matched resume|cv, so a form whose input carries no label produced a spec with no file, and
  // the submit came back "Resume/CV is required."
  const { fields } = await scan("ats_widgets.html");
  const labelled = byRef(fields, "id:fu_resume");
  const bare = byRef(fields, "id:fu_bare");
  assert.ok(labelled && bare, "both file inputs must be listed");
  assert.equal(labelled.label, "Resume");
  assert.equal(bare.label, "", "the unlabelled resume input is the case that failed");
  for (const field of [labelled, bare]) {
    assert.equal(field.widget.kind, "file_upload");
    assert.equal(field.widget.recipe.commit, "setInputFiles");
  }
});

test("roleComboboxElements: role=combobox is collected by attribute, not by tag", async (t) => {
  if (!needsBrowser(t)) return;
  const { fields } = await scan("ats_widgets.html");
  const span = byRef(fields, "id:rce_country");
  assert.ok(span, "the scanner collects [role=combobox], so a span carrying it must be listed");
  assert.equal(span.tag, "span");
  assert.equal(span.widget.kind, "input_combobox");
  // And the button that looks identical is NOT a field: a button is never a control to fill, which is
  // why the scanner skips that type whatever role it carries.
  assert.equal(byRef(fields, "id:rce_loc"), undefined, "a type=button element is not a fillable field");
});

test("trackingFrames: an analytics frame is not offered as a form lead", async (t) => {
  if (!needsBrowser(t)) return;
  // Workable, 2026-10-08: the only frame on the page was Google Tag Manager, so the "open the frame
  // instead" hint pointed away from the real cause - the form had simply not been opened. A frame
  // with a src is not automatically a lead.
  const frames = await withFixture(browser, "ats_widgets_iframe.html", page => page.evaluate(collectEmbeddedForms));
  assert.deepEqual(frames.map(f => f.id), ["embed"],
    "the tracking frames have a src, so only the host filter keeps them out of the hint");
});

test("applyAffordance: a page whose form is not open names the control that opens it", async (t) => {
  if (!needsBrowser(t)) return;
  const result = await withFixture(browser, "ats_widgets_iframe.html", async (page) => ({
    fields: await page.evaluate(collectFields),
    affords: await page.evaluate(collectApplyAffordances),
  }));
  const hit = result.affords.find(a => /apply for this job/i.test(a.text));
  assert.ok(hit, "the description page carries the control and no form; naming it is the entire message");
  assert.equal(hit.tag, "a");
  assert.equal(hit.href, "?apply=1");
});
