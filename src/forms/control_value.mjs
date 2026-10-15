/**
 * control_value.mjs — THE ONE RULE for "what value does this control actually display?".
 *
 * WHY IT IS A MODULE. Two tools read a value off an already-filled page and then disagree about what they read:
 * the audit (`audit_form_fields.mjs`) reports what the page holds, and the gate (`verify_and_submit.mjs`)
 * refuses to submit until its expectations hold. Until this file existed they read that value by DIFFERENT
 * rules - the audit by a control's own display container, the gate by a walk up to five ancestors looking for a
 * `[class*=single-value]` node - so the gate could pass a field the audit called EMPTY. That is how the two came
 * apart in the first place, and it fails in the direction that reaches an employer: `noEmptyRequired` passing a
 * blank required field and the submission going out with a question the employer required left empty (hard rule 5
 * of this repository's contract: read the RENDERED value, not the presence of one).
 *
 * THE RULE, in one sentence: a control's displayed value is read from ITS OWN display container, and a container
 * may answer for a control only when that control is the ONLY control in it. The rule has two halves, each with a
 * witness on greenhouse's own board (posting 8279799, `Technical Support Specialist`, 2026-10-14, headless Chrome
 * on port 9333), where an audit of a live form printed:
 *
 *     step7_audit.log:6  ok  REQ country  text  Country*  = +1
 *     step7_audit.log:7  ok  REQ phone    tel   Phone*    = +1
 *
 *   1. A WRAPPER MAY NOT ANSWER FOR A CONTROL INSIDE IT. `id:phone` is the `Phone*` tel input of a composite
 *      phone widget - a react-select `Country*` dial-code selector beside it inside one `fieldset.phone-input`.
 *      The tel input has no shell of its own, so a read that fell back to the fieldset found the COUNTRY's value
 *      node in it: the phone reported the neighbouring control's value, and the phone number it actually held
 *      (`+1 416-555-0182`) was never read.
 *   2. A FRAGMENT IS NOT A VALUE. The country's committed option is `Canada +1`, but the control renders the
 *      value node as `<div class="iti__flag iti__ca"></div><span>+1</span>` - textContent `+1`, a dialling code
 *      shared by the United States, Canada and twenty Caribbean nations. Reporting `+1` cannot tell them apart.
 *      The country NAME is on the page: intl-tel-input keeps its whole country list mounted (hidden, never
 *      removed) inside the widget, each row carrying `data-country-code` beside its own country name and dial
 *      code, so the committed option is read back from the page rather than from a country table in this file.
 *
 * HOW THE RULE TRAVELS INTO THE PAGE. `page.evaluate` serialises its callback by SOURCE, so a helper defined in a
 * Node module is simply not defined in the browser - referencing one there throws "`<name>` is not defined". The
 * source below is therefore passed into the page as DATA and evaluated inside it, which is the shape
 * `workday_runner.mjs` already uses for its resolver (see its `RESOLVER_SRC` comment for the same failure). The
 * rule is written once, as a real function, so it is read and syntax-checked as JavaScript; `CONTROL_VALUE_SOURCE`
 * is derived from that function rather than being a second copy of it that can drift.
 *
 * `read()` returns the value AND where it came from. The provenance is not decoration: a value read out of the
 * control's own input and one resolved out of a display node are different evidence, and a report that cannot say
 * which is which cannot be audited (`audit_form_fields.mjs` prints it as `[from]`).
 */

/**
 * The reader, as a FACTORY that returns the rule's own functions.
 *
 * It must not reference anything from this module's scope: its source is what travels to the browser, and a
 * closed-over name would arrive undefined. Everything it needs is either a parameter or a DOM global.
 *
 * The returned `read(el, wrap)` is the rule. `wrap` is optional - omit it and the reader finds the wrapper itself
 * with `wrapOf`, which is the same function a caller uses for the label fallback, so the choice is made once.
 */
export function makeControlValueReader() {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const vis = el => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  /** A short, greppable name for the element a value was read from: `div.select__single-value#country`. */
  const describeNode = el => {
    if (!el) return "nothing";
    const cls = typeof el.className === "string" ? (el.className.trim().split(/\s+/).find(c => !/^(remix|css)-/.test(c)) || "") : "";
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls ? "." + cls : ""}`;
  };

  /**
   * What ONE display node says, and whether that is a fragment of the option the control committed (case 2 above).
   *
   * The lookup is keyed by the code the VALUE NODE itself carries (`iti__ca`), so it reads the country the control
   * actually committed and not the first row of a list that always starts at Afghanistan.
   *
   * A node whose own text is already the whole option is left exactly as it was - `option !== text` is the test, so
   * a tenant that renders `Canada +1` sees no change at all.
   */
  const readDisplayNode = node => {
    const text = clean(node.textContent);
    const flag = node.querySelector('[class*="iti__flag"]');
    const code = flag ? /(?:^|\s)iti__([a-z]{2})(?=\s|$)/.exec(String(flag.className || "")) : null;
    // SCOPE THE LOOKUP TO THE SMALLEST ANCESTOR THAT CARRIES THE LIST - this widget, not the document. A form with
    // two phone fields carries two of these lists, and a document-wide lookup could read the other widget's row:
    // the "two controls confused for one another" defect in a different disguise.
    let row = null;
    if (code) {
      let scope = null;
      for (let n = node.parentElement; n && !scope; n = n.parentElement) {
        if (n.querySelector(`[data-country-code="${code[1]}"]`)) scope = n;
      }
      row = (scope || node.ownerDocument).querySelector(`[data-country-code="${code[1]}"]`);
    }
    if (row && text) {
      const name = clean(row.querySelector(".iti__country-name")?.textContent);
      const dial = clean(row.querySelector(".iti__dial-code")?.textContent);
      const option = [name, dial].filter(Boolean).join(" ");
      if (name && option && option !== text && option.includes(text)) {
        return { text: option, resolvedFrom: `iti__${code[1]} -> ${option}` };
      }
    }
    return { text, resolvedFrom: "" };
  };

  /**
   * A container may answer for a control only when that control is the ONLY one in it (case 1 above).
   *
   * ONE RULE FOR EVERY CONTAINER, WHETHER IT IS THE CONTROL'S OWN SHELL OR A WRAPPER AROUND IT, because the
   * fieldset case repeats one level further in: react-select mounts a second, ref-less `requiredInput` INSIDE
   * `.select-shell`, next to the real select, so a shell-sized read hands the phantom row the real control's
   * value. The same refusal is made for the label fallback, which is why the two live together.
   */
  const onlyControlIn = (node, el) => {
    if (!node) return false;
    const inside = [...node.querySelectorAll("input,textarea,select,[role=combobox]")]
      .filter(n => vis(n) && (n.getAttribute("type") || "").toLowerCase() !== "hidden");
    return inside.length === 1 && inside[0] === el;
  };

  /** The wrapper the question and the controls of ONE question live in. Used for the label fallback and for `read`. */
  const wrapOf = el => el.closest("[class*=question], fieldset, div[class*=field]")
    || el.parentElement?.parentElement || el.parentElement;

  /** The displayed value of ONE control, and the element it came from. `from` is empty for a value read from the
   * control's own input, which is the case a reader can check by eye. */
  const read = (el, wrap) => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const ownShell = el.closest('[class*="select__control"], [class*="select-shell"]');
    const scope = wrap === undefined ? wrapOf(el) : wrap;
    let holder = null;
    let from = "";
    if (onlyControlIn(ownShell, el)) holder = ownShell;
    else if (onlyControlIn(scope, el)) holder = scope;
    let displayed = "";
    if (holder) {
      const sv = [...holder.querySelectorAll("[class*=singleValue], [class*=multiValue], [class*=single-value]")];
      if (sv.length) {
        const readNodes = sv.map(readDisplayNode);
        displayed = readNodes.map(r => r.text).filter(Boolean).join(" | ");
        const resolved = readNodes.filter(r => r.resolvedFrom);
        const where = sv.length === 1 ? describeNode(sv[0]) : `${sv.length} display nodes in ${describeNode(holder)}`;
        from = resolved.length
          ? `${where}, resolved from ${resolved.map(r => r.resolvedFrom).join(" | ")}`
          : where;
      }
    }
    if (!displayed) {
      if (type === "checkbox" || type === "radio") displayed = el.checked ? "[checked]" : "[unchecked]";
      // A PHONE NUMBER IS READ, NOT MASKED. Email and password stay masked, but `tel` is the one field type whose
      // committed value this rule exists to show: it is the fact the pre-submit review checks, and masking it is
      // how `Phone* = +1` - the NEIGHBOURING country control's dial code - spent a run looking like an answer
      // (greenhouse board 8279799, 2026-10-14). A masked row would have hidden the same defect one layer down.
      else if (["email", "password"].includes(type)) displayed = el.value ? "[masked]" : "";
      else displayed = clean(el.value);
    }
    // Some tenants (Chakra-flavoured Greenhouse: Discord's Location (City) and race fields) render the chosen
    // value as the control container's text with no singleValue node and an empty input value, which made a
    // correctly answered field look blank. Fall back to the control text for those.
    if (!displayed && /select__input|select__value/i.test(el.className || "")) {
      const control = el.closest("[class*=control]");
      displayed = clean(control?.innerText);
      if (displayed) from = `${describeNode(control)} text (no display node)`;
    }
    return { displayed, from };
  };

  return { read, wrapOf, describeNode, onlyControlIn, readDisplayNode, clean, vis };
}

/**
 * The reader as SOURCE, for `page.evaluate` (see "HOW THE RULE TRAVELS INTO THE PAGE" above).
 *
 * A caller passes this to its page callback as an argument and evaluates it there:
 *
 *     await page.evaluate(src => {
 *       const rule = eval(src);
 *       ... rule.read(el) ...
 *     }, CONTROL_VALUE_SOURCE);
 */
export const CONTROL_VALUE_SOURCE = `(${makeControlValueReader.toString()})()`;
