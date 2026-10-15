/**
 * widget_scan.mjs — the two page-side collectors `inspect_ats_form.mjs` runs inside the tab.
 *
 * They live in a module rather than inline because a function passed to `page.evaluate` can only be
 * tested if something can import it. Inline, the whole inventory path was untestable, and the fixture
 * page in `fixtures/ats_widgets.html` — written for exactly this purpose — had no test driving it.
 * The scanners decide which controls exist and what their current options are; that is where the
 * repeated failures were, not in the classification that already had unit tests.
 *
 * BOTH FUNCTIONS MUST STAY SELF-CONTAINED. Playwright serializes the function source into the page,
 * so anything they reference from module scope arrives as `undefined` — and it fails as a wrong
 * inventory rather than an error. `test_widget_scan.mjs` runs both against the fixture, so that
 * mistake fails a test instead of a submission.
 */

/**
 * Inventory every visible control on the page.
 *
 * Shadow roots are walked, not just the light DOM: SmartRecruiters' One-Click UI renders its whole
 * form inside shadow roots, where `document.querySelectorAll` sees nothing and the inventory said
 * "fields: 0" on a form that was visibly asking for name, email and phone.
 *
 * @returns {Array<object>} one entry per control, with the evidence `classifyWidget` needs.
 */
export function collectFields() {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const vis = el => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const optionLabel = el => {
    const own = el.labels?.[0] || (el.id ? el.getRootNode().querySelector?.(`label[for="${CSS.escape(el.id)}"]`) : null);
    if (own) return clean(own.innerText);
    if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
    const parent = el.parentElement;
    return parent?.querySelectorAll("input").length === 1 ? clean(parent.innerText) : "";
  };
  // The QUESTION a radio/checkbox group asks. `label` above is the option's OWN text ("Male"),
  // which says nothing about what is being asked, and a group arrives as one field per option - so
  // without this the drafter sees eight fields reading "Asian (Not Hispanic or Latino)" and no
  // question anywhere among them.
  //
  // Read live off Alchemy on 2026-10-08: the question is the first DIRECT CHILD of the field entry
  // that carries no control - a `div._heading_<hash>` reading "Veteran Status" or "Are you legally
  // authorized to work ...". Only direct children are considered, because a descendant search finds
  // the option labels first. A <legend>, where a tenant uses one, is the same thing by another name.
  const questionOf = el => {
    const scope = el.closest("[class*=question], fieldset, div[class*=field], [data-field-path]") || el.parentElement;
    if (!scope) return "";
    for (const child of scope.children) {
      if (child.querySelector("input,textarea,select,[role=combobox]")) continue;
      const text = clean(child.innerText);
      if (text) return text;
    }
    return "";
  };
  const out = [];
  const collectControls = (root, out) => {
    for (const el of root.querySelectorAll("input,textarea,select,[role=combobox]")) out.push(el);
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) collectControls(el.shadowRoot, out);
    return out;
  };
  const controls = collectControls(document, []).filter(vis);
  const seen = new Set();
  for (const el of controls) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
    const id = el.id || "";
    const name = el.getAttribute("name") || "";
    const role = (el.getAttribute("role") || "").toLowerCase();
    const ref = id ? `id:${id}` : (name ? `name:${name}` : "");
    const key = ref || `${tag}:${out.length}`;
    if (ref && seen.has(ref) && type !== "checkbox" && type !== "radio") continue;
    seen.add(ref);
    // `[data-field-path]` is a field entry too, and on Ashby it is the ONLY one: read live off the
    // start-date question, the entry is a `div[data-field-path]` with no class of its own, its label
    // sits directly inside it and its `for=` names an id nothing carries. Without this the search fell
    // through to the two-levels-up fallback, landed on the date-picker wrapper, found no label there
    // and reported the question as empty - which downstream reads as "no profile mapping".
    const wrap = el.closest("[class*=question], fieldset, div[class*=field], [data-field-path]")
      || el.parentElement?.parentElement || el.parentElement;
    let label = "";
    if (id) {
      const lb = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lb) label = clean(lb.innerText);
    }
    if (!label) label = clean(el.getAttribute("aria-label"));
    if (!label) label = clean(wrap?.querySelector("label, legend")?.innerText);
    // Ashby puts the question in a `div._label_<hash>`, which is neither a <label> nor a <legend>:
    // TRM Labs (2026-10-02) is the shape, kept as `ashbyCombobox` in fixtures/ats_widgets.html.
    // Reading it as empty is not cosmetic. draft_form_spec.py routes a control with no question to
    // "no profile mapping", and answer_by_question_text.mjs can only find a field by its question,
    // so an ordinary field stops being fillable and starts being a human's job - every time.
    // Reached only when every real label source is empty, and it refuses a node that carries controls
    // of its own, so a wrapper cannot be mistaken for the question it wraps.
    if (!label) {
      const node = wrap?.querySelector('[class*="label"]');
      if (node && !node.querySelector("input,textarea,select,[role=combobox]")) label = clean(node.innerText);
    }
    // READ THIS CONTROL'S OWN DISPLAY, NOT THE WRAPPER'S. Greenhouse's EEO block puts more than one react-select
    // inside one question wrapper, so querying the wrapper returns a SIBLING's value: on the Twitch form `race` read
    // `No` - `hispanic_ethnicity`'s answer - and `draft_form_spec.py` skips fields that look answered, so the loop
    // could reveal the question and never fill it. `selectShell` is already computed above for the fingerprint and is
    // this control's own container; the label fallback twelve lines up refuses a node that carries controls of its
    // own for the same reason. The wrapper remains the last resort for a control with no shell of its own, where the
    // value comes from `el.value` anyway.
    let value = "";
    // Computed here rather than reusing `selectShell`, which is declared further down for the fingerprint - reading it
    // first is a ReferenceError, and a scan that throws writes no inventory at all.
    const ownShell = el.closest('[class*="select__control"], [class*="select-shell"]');
    const displayHolder = ownShell || el.closest('[class*="control"]')?.parentElement || wrap;
    if (displayHolder) {
      const sv = displayHolder.querySelectorAll("[class*=singleValue], [class*=multiValue], [class*=single-value]");
      if (sv.length) value = [...sv].map(n => clean(n.textContent)).filter(Boolean).join(" | ");
    }
    if (!value) {
      if (type === "checkbox" || type === "radio") value = el.checked ? "[checked]" : "[unchecked]";
      else if (["email", "tel", "password"].includes(type)) value = el.value ? "[masked]" : "";
      else value = clean(el.value);
    }
    const reactSelect = /select/i.test(el.className || "") || el.getAttribute("role") === "combobox";
    const selectShell = el.closest('[class*="select__control"], [class*="select-shell"]');
    const selectedDisplay = Boolean((selectShell || el.parentElement)?.querySelector?.(
      '[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"]'));
    const listboxId = el.getAttribute("aria-controls") || "";
    const listbox = listboxId ? el.getRootNode().getElementById?.(listboxId) : null;
    const toggle = Boolean(el.parentElement?.querySelector?.('button[class*="toggle"], button[aria-label*="oggle"]'));
    const widgetEvidence = {
      selectControl: Boolean(selectShell), selectedDisplay,
      listbox: Boolean(listbox || listboxId), toggle,
      nativeMultiple: tag === "select" && el.multiple,
      // Only stable attributes/classes identify the control type. Existing
      // selection chips appear AFTER filling and must not change its fingerprint.
      multiSelect: el.getAttribute("aria-multiselectable") === "true"
        || listbox?.getAttribute("aria-multiselectable") === "true"
        || /(?:^|\s)(?:is-multi|multi-select)(?:\s|$)/i.test(String(selectShell?.className || "")),
    };
    let options = [];
    let groupQuestion = "";
    if (tag === "select") options = [...el.options].map(o => clean(o.textContent)).filter(Boolean);
    else if (type === "radio" && name) {
      const group = controls.filter(c => c.type === "radio" && c.name === name);
      options = group.map(optionLabel).filter(Boolean);
      const selected = group.find(c => c.checked);
      value = selected ? (optionLabel(selected) || "[checked]") : "[unchecked]";
      groupQuestion = questionOf(el);
    } else if (type === "checkbox") {
      options = [optionLabel(el)].filter(Boolean);
      groupQuestion = questionOf(el);
    }
    // help/description text inside the question wrapper — pay ranges often live here,
    // which is what the compensation rule needs
    let help = "";
    if (wrap) {
      help = clean([...wrap.querySelectorAll("p, span, small, div")]
        .filter(n => !n.querySelector("input,textarea,select,[role=combobox],[role=listbox]"))
        .map(n => n.textContent).join(" ")).slice(0, 400);
      if (help && label && help.startsWith(label.slice(0, 40))) help = help.slice(label.length).trim();
    }
    out.push({
      ref, key, tag, type, role, react_select: reactSelect,
      label: label.slice(0, 110),
      help,
      // REQUIRED IS NOT ALWAYS AN ATTRIBUTE. On a Greenhouse embed it is an asterisk in the label and nothing
      // else - no `required`, no `aria-required` - so a required question was reported as optional, left blank,
      // and never listed for review. Recorded in driving-widgets-cases-3 (2026-10-04); the fixture's
      // `siblingLabelControl` is that shape, and its label's trailing `*` is what the test asserts on.
      //
      // The two mistakes are not equally costly, which is why the asterisk is read loosely: calling an optional
      // field required puts it in front of a human, while calling a required field optional sends a blank one
      // to a server that refuses it.
      required: el.required || el.getAttribute("aria-required") === "true" || label.includes("*"),
      value: value.slice(0, 80),
      option_group: name || id || "",
      group_label: groupQuestion.slice(0, 160),
      widget_evidence: widgetEvidence,
      options,
    });
  }
  return out;
}

/**
 * Every frame the page embeds, with the URL that leads to the form.
 *
 * A company-hosted posting often keeps the real form one frame down. Asana's Greenhouse posting at
 * `job-boards.greenhouse.io/asana/jobs/8227390` redirects to `asana.com/jobs/apply/8227390`, which
 * embeds `job-boards.greenhouse.io/embed/job_app?for=asana&validityToken=...`; the scanners read the
 * top document, so the inventory came back `fields: 0` on a form that was visibly asking for a name.
 * Roblox cost a round on the same shape on 2026-10-06, and the working answer there was to open the
 * embed URL rather than to reach into the frame.
 *
 * The `src` is what makes a zero recoverable, so it is what is reported. A frame with no src, or one
 * pointing at `about:blank`, carries no such information and is left out.
 *
 * @returns {Array<{id: string, src: string, title: string}>}
 */
export function collectEmbeddedForms() {
  // Analytics and consent frames are on nearly every careers page and carry no form. Reporting them
  // buries the one frame that matters, and on Workable (2026-10-08) the ONLY frame was Google Tag
  // Manager - so the lead pointed away from the real cause instead of at it.
  const NOISE = /googletagmanager|google-analytics|gstatic|google\.com\/recaptcha|recaptcha\.net|optimizely|doubleclick|hotjar|segment\.(io|com)|facebook\.com\/tr|bat\.bing\.com|criteo/i;
  const out = [];
  for (const frame of document.querySelectorAll("iframe")) {
    const src = frame.getAttribute("src") || "";
    if (!src || src === "about:blank") continue;
    if (NOISE.test(src)) continue;
    out.push({ id: frame.id || "", src, title: frame.getAttribute("title") || "" });
  }
  return out;
}

/**
 * Visible controls that OPEN the application form, with their text and href.
 *
 * The third way a page reports zero fields: the form is neither missing nor in a frame, it simply has
 * not been opened yet. Workable's `/j/<id>` renders the job description with an "Apply for this job"
 * button and no controls at all - the same posting under `/j/<id>/apply` reads six fields with no
 * unknowns. Naming the button and the href is what turns a blank inventory into a next step; it is a
 * report of what is on the page, not a guess about what to click.
 *
 * @returns {Array<{tag: string, text: string, href: string}>}
 */
export function collectApplyAffordances() {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const visible = el => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('a, button, [role="button"], input[type="submit"]')) {
    if (!visible(el)) continue;
    const text = clean(el.textContent) || clean(el.value);
    if (!/apply for|apply now|apply to|start (your )?application|begin application|^apply$/i.test(text)) continue;
    const key = `${el.tagName}:${text}:${el.getAttribute("href") || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tag: el.tagName.toLowerCase(), text: text.slice(0, 60), href: el.getAttribute("href") || "" });
  }
  return out;
}

/**
 * Find controls the input/select inventory cannot see: button-only Yes/No pairs, and a bare div that
 * reads SELECT... .
 *
 * These are reported separately so `draft_form_spec.py`'s existing `fields` contract stays unchanged,
 * while a control the fillers cannot drive becomes visible instead of silently missing.
 *
 * @returns {Array<object>} button pairs and div dropdowns, in the same shape as `collectFields` entries.
 */
export function collectExtraWidgets() {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const visible = el => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const all = (root, selector) => {
    const found = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) found.push(...all(el.shadowRoot, selector));
    return found;
  };
  const out = [];
  const seen = new Set();
  const pairSelector = 'button, [role="button"], [role="radio"]';
  for (const btn of all(document, pairSelector)) {
    if (!visible(btn)) continue;
    if (clean(btn.textContent).toLowerCase() !== "yes") continue;
    let group = btn.parentElement;
    for (let i = 0; i < 3 && group; i++, group = group.parentElement) {
      const buttons = [...group.querySelectorAll(pairSelector)]
        .filter(b => visible(b) && /^(yes|no)$/i.test(clean(b.textContent)));
      if (buttons.length !== 2 || !buttons.some(b => /^no$/i.test(clean(b.textContent)))) continue;
      if (seen.has(buttons[0])) break;
      seen.add(buttons[0]);
      const holder = group.parentElement || group;
      const companion = [...holder.querySelectorAll('input[type="checkbox"]')].find(input => {
        const rect = input.getBoundingClientRect();
        return rect.width < 2 || rect.height < 2 || getComputedStyle(input).opacity === "0";
      });
      const ariaPressed = buttons.some(b => b.hasAttribute("aria-pressed") || b.hasAttribute("aria-checked"));
      const label = clean(holder.innerText).replace(/\bYes\s+No\s*$/i, "").slice(0, 500);
      out.push({
        key: `button-pair:${out.length}`, ref: holder.id ? `id:${holder.id}` : "",
        tag: buttons[0].tagName.toLowerCase(), role: buttons[0].getAttribute("role") || "button", type: "button", label,
        options: buttons.map(b => clean(b.textContent)),
        widget_evidence: { buttonPair: true, hiddenCompanion: Boolean(companion), ariaPressed },
      });
      break;
    }
  }
  for (const trigger of all(document, '[role="button"]')) {
    if (!visible(trigger)) continue;
    if (!/^select\s*(?:\.{2,}|one|an option)$/i.test(clean(trigger.textContent))) continue;
    const holder = trigger.parentElement || trigger;
    const options = [...holder.querySelectorAll('[role="option"]')].map(o => clean(o.textContent)).filter(Boolean);
    out.push({
      key: `div-dropdown:${out.length}`, ref: trigger.id ? `id:${trigger.id}` : "",
      tag: trigger.tagName.toLowerCase(), role: "button", type: "", label: clean(holder.innerText).slice(0, 500),
      options, widget_evidence: { divDropdown: true },
    });
  }
  return out;
}
