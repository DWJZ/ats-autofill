const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

const delay = (tab, ms = 300) => tab.playwright.waitForTimeout(ms);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const WORK_HISTORY_SECTION_NAMES = ["Work Experience", "Work History", "Work History (Optional)"];
const EDUCATION_SECTION_NAMES = ["Education", "Education (Required)"];
const DEGREE_ALIASES = {
  "M.S.": ["MS", "M.S.", "Master of Science", "Masters"],
  MS: ["MS", "M.S.", "Master of Science", "Masters"],
  "B.S.": ["BS", "B.S.", "Bachelor of Science", "Bachelors"],
  BS: ["BS", "B.S.", "Bachelor of Science", "Bachelors"]
};
// AN EXAMPLE MAP, NOT A SHIPPED ONE. Workday's school lookup spells the same institution several ways, and a
// tenant's list is often narrower than the real one - so this pairs the name that goes in the payload with the
// spellings that list actually renders. The entries below demonstrate the SHAPE with the same neutral school names
// the rest of this repo uses; replace them with the schools in YOUR application_profile.json. An unlisted school
// falls back to `[school]` in schoolAliases, which is the honest default and not an error.
//
// `SCHOOL_SEARCH_TERMS` narrows the search before any alias is tried. It is keyed on the same names, and its entries
// are the broader terms that reach the institution at all.
const SCHOOL_ALIASES = {
  "Lakeside State University, Fairview": [
    "Lakeside State University, Fairview",
    "Lakeside State University-Fairview"
  ],
  "Metropolitan Institute of Technology": [
    "Metropolitan Institute of Technologys",
    "Metropolitan Institute of Technology"
  ]
};
const SCHOOL_SEARCH_TERMS = {
  "Lakeside State University, Fairview": ["Lakeside State University"],
  "Metropolitan Institute of Technology": ["Metropolitan"]
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namesRegex(names) {
  return new RegExp(`^(?:${names.map(escapeRegExp).join("|")})$`);
}

function numberedGroupRegex(names) {
  return new RegExp(`^(?:${names.map(escapeRegExp).join("|")}) \\d+$`);
}

async function getSection(tab, names) {
  const section = tab.playwright.getByRole("group", { name: namesRegex(names) }).first();
  // A tenant may render the block without a role=group carrying that name. Throwing here used to abort the whole
  // experience step, which then refused the plan's own entries (the Degree dropdown) for reasons that looked unrelated.
  const visible = await section.waitFor({ state: "visible", timeoutMs: 10000 }).then(() => true).catch(() => false);
  return visible ? section : null;
}

function parseMonthYear(value) {
  const match = /^(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) {
    throw new Error(`Expected MM/YYYY date, got: ${value}`);
  }
  return {
    month: Number(match[1]),
    year: Number(match[2]),
    display: `${MONTH_NAMES[Number(match[1]) - 1]} ${match[2]}`
  };
}

async function fillTextbox(group, label, value) {
  const box = group.getByRole("textbox", { name: label });
  const current = await box.evaluate(element => element.value || "", undefined, { timeoutMs: 2000 }).catch(() => "");
  if (current === value) {
    return;
  }
  await box.fill(value, { timeoutMs: 10000 });
}

function normalizeUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

async function workExperienceGroups(tab) {
  const section = await getSection(tab, WORK_HISTORY_SECTION_NAMES);
  return section.getByRole("group", { name: numberedGroupRegex(WORK_HISTORY_SECTION_NAMES) }).all();
}

async function ensureWorkExperienceCount(tab, count) {
  const section = await getSection(tab, WORK_HISTORY_SECTION_NAMES);
  let groups = await workExperienceGroups(tab);
  while (groups.length < count) {
    await section.getByRole("button", { name: /^(?:Add|Add Another)$/ }).click({ timeoutMs: 10000 });
    await delay(tab, 700);
    groups = await workExperienceGroups(tab);
  }
  return groups;
}

async function setMonthYearDirect(dateGroup, value) {
  const parsed = parseMonthYear(value);
  const spinbuttons = await dateGroup.getByRole("spinbutton").all();
  if (spinbuttons.length < 2) {
    throw new Error(`Could not find month/year spinbuttons for ${value}`);
  }
  await spinbuttons[0].fill(String(parsed.month).padStart(2, "0"), { timeoutMs: 10000 });
  await spinbuttons[1].fill(String(parsed.year), { timeoutMs: 10000 });
}

async function setMonthYearByCalendar(tab, dateGroup, value) {
  const parsed = parseMonthYear(value);
  await tab.playwright.locator("body").press("Escape", { timeoutMs: 1000 }).catch(() => {});
  await delay(tab, 100);
  await dateGroup.getByRole("button", { name: "Calendar" }).click({ timeoutMs: 10000 });
  await delay(tab, 500);

  for (let i = 0; i < 20; i += 1) {
    const snapshot = await tab.playwright.domSnapshot();
    const yearMatch = snapshot.match(/button "(?:Selected )?January (\d{4})"/)
      || snapshot.match(/button "(?:Selected )?[A-Za-z]+ (\d{4})"/)
      || snapshot.match(/generic: "(\d{4})"\n\s*- button "Next Year"/);
    if (!yearMatch) {
      throw new Error(`Could not read Workday calendar year for ${parsed.display}`);
    }
    const visibleYear = Number(yearMatch[1]);
    if (visibleYear === parsed.year) {
      break;
    }
    const direction = visibleYear > parsed.year ? "Previous Year" : "Next Year";
    const button = tab.playwright.getByRole("button", { name: direction });
    if (await button.count() > 0) {
      await button.click({ timeoutMs: 10000 });
    } else {
      const monthButton = tab.playwright.getByRole("button", { name: new RegExp(parsed.display) });
      if (await monthButton.count() > 0) {
        await monthButton.click({ timeoutMs: 10000 });
        return;
      }
      throw new Error(`Could not navigate Workday calendar to ${parsed.display}`);
    }
    await delay(tab, 200);
  }

  const exact = tab.playwright.getByRole("button", { name: new RegExp(parsed.display) });
  if (await exact.count() > 0) {
    await exact.click({ timeoutMs: 10000 });
  } else {
    await tab.playwright.getByRole("button", { name: MONTH_NAMES[parsed.month - 1] }).click({ timeoutMs: 10000 });
  }
  await delay(tab, 300);
}

export async function setFullDateByMonthCalendar(tab, dateGroup, target) {
  const monthIndexes = new Map(MONTH_NAMES.map((month, index) => [month, index]));
  const targetMonth = typeof target.month === "number" ? target.month - 1 : monthIndexes.get(target.month);
  if (targetMonth === undefined) {
    throw new Error(`Unknown month for full date: ${JSON.stringify(target)}`);
  }

  await tab.playwright.locator("body").press("Escape", { timeoutMs: 1000 }).catch(() => {});
  await delay(tab, 100);
  await dateGroup.getByRole("button", { name: "Calendar" }).click({ timeoutMs: 10000 });
  await delay(tab, 300);

  for (let i = 0; i < 240; i += 1) {
    const snapshot = await tab.playwright.domSnapshot();
    const match = snapshot.match(/generic: ([A-Za-z]+) (\d{4})\n\s*- button "Next month"/);
    if (!match) {
      throw new Error("Could not read Workday full-date calendar month/year");
    }
    const currentMonth = monthIndexes.get(match[1]);
    const currentYear = Number(match[2]);
    const distance = (target.year - currentYear) * 12 + (targetMonth - currentMonth);
    if (distance === 0) {
      break;
    }
    await tab.playwright.getByRole("button", { name: distance > 0 ? "Next month" : "Previous month" }).click({ timeoutMs: 10000 });
    if (i % 12 === 11) {
      await delay(tab, 60);
    }
  }

  const dayPattern = new RegExp(`${target.weekday ? `${escapeRegExp(target.weekday)} ` : ""}${target.day} ${MONTH_NAMES[targetMonth]} ${target.year}$`);
  await tab.playwright.getByRole("button", { name: dayPattern }).click({ timeoutMs: 10000 });
  await delay(tab, 300);
}

async function setMonthYear(tab, group, label, value) {
  const dateGroup = group.getByRole("group", { name: label });
  const parsed = parseMonthYear(value);
  const spinbuttons = await dateGroup.getByRole("spinbutton").all();
  if (spinbuttons.length >= 2) {
    const currentMonth = await spinbuttons[0].evaluate(element => element.value || "", undefined, { timeoutMs: 1000 }).catch(() => "");
    const currentYear = await spinbuttons[1].evaluate(element => element.value || "", undefined, { timeoutMs: 1000 }).catch(() => "");
    if (Number(currentMonth) === parsed.month && Number(currentYear) === parsed.year) {
      return;
    }
  }
  // TRY THE SPINBUTTONS FIRST, AND DO NOT LET THE CALENDAR ABORT THE STEP (fixed 2026-10-07). This call site used to
  // go straight to setMonthYearByCalendar, so a calendar whose year the DOM snapshot cannot be read from threw
  // "Could not read Workday calendar year for January 2025" and left EVERY work row empty on the Workday tenant;
  // the form then refused with From/To/Job Title/Company required for each row. setMonthYearDirect was written for
  // exactly this and was never reached. The direct fill also matches what the reference already records: a
  // zero-padded month written with fill() is what the typeahead actually stores.
  try {
    await setMonthYearDirect(dateGroup, value);
    const after = await dateGroup.getByRole("spinbutton").all();
    if (after.length >= 2) {
      const month = Number(await after[0].evaluate((el) => el.value || "", undefined, { timeoutMs: 1000 }).catch(() => "0"));
      const year = Number(await after[1].evaluate((el) => el.value || "", undefined, { timeoutMs: 1000 }).catch(() => "0"));
      if (month === parsed.month && year === parsed.year) return;
      console.error(`[experience] spinbuttons hold ${month}/${year} after fill, wanted ${parsed.month}/${parsed.year}; falling back to the calendar`);
    }
  } catch (err) {
    console.error(`[experience] direct month/year fill failed for ${parsed.display}: ${String(err).slice(0, 90)}; falling back to the calendar`);
  }
  try {
    await setMonthYearByCalendar(tab, dateGroup, value);
  } catch (err) {
    // A calendar this helper cannot read is a row to verify on Review, not a reason to abandon the other rows.
    console.error(`[experience] calendar fallback failed for ${parsed.display}: ${String(err).slice(0, 120)}`);
  }
}

export async function fillWorkExperience(tab, experiences) {
  const groups = await ensureWorkExperienceCount(tab, experiences.length);
  for (let i = 0; i < experiences.length; i += 1) {
    const group = groups[i];
    const exp = experiences[i];
    await fillTextbox(group, "Job Title", exp.job_title);
    await fillTextbox(group, "Company", exp.company);
    await fillTextbox(group, "Location", exp.location);
    const currentBox = group.getByRole("checkbox", { name: "I currently work here" });
    if (await currentBox.count() > 0) {
      await currentBox.uncheck({ timeoutMs: 10000 }).catch(() => {});
    }
    await setMonthYear(tab, group, "From", exp.from);
    await setMonthYear(tab, group, "To", exp.to);
    await fillTextbox(group, "Role Description", exp.description);
  }
}

async function selectedOptionsForTextbox(group, label) {
  const box = group.getByRole("textbox", { name: label });
  const multiselectId = await box.getAttribute("data-uxi-multiselect-id").catch(() => "");
  if (!multiselectId) {
    return group.locator('[data-automation-id="selectedItemList"] [role="option"]').filter({ hasText: /$a/ });
  }
  return group.locator(
    `[data-automation-id="selectedItemList"][data-uxi-multiselect-id="${multiselectId}"] [role="option"]`
  );
}

async function selectedValuesForTextbox(group, label) {
  const options = await selectedOptionsForTextbox(group, label);
  return options.allTextContents({ timeoutMs: 2000 }).catch(() => []);
}

async function selectedFieldText(eduGroup) {
  return (await selectedValuesForTextbox(eduGroup, "Field of Study")).join("\n");
}

async function clearSelectedField(eduGroup) {
  const selected = await selectedOptionsForTextbox(eduGroup, "Field of Study");
  const count = await selected.count();
  for (let i = 0; i < count; i += 1) {
    await selected.first().press("Delete", { timeoutMs: 2000 }).catch(async () => {
      await selected.first().press("Backspace", { timeoutMs: 2000 }).catch(async () => {
        await selected.first().click({ timeoutMs: 2000 }).catch(() => {});
        await eduGroup.getByRole("textbox", { name: "Field of Study" }).press("Backspace", { timeoutMs: 2000 }).catch(() => {});
      });
    });
    await sleep(100);
  }
}

async function clearFieldSearchText(eduGroup) {
  const box = eduGroup.getByRole("textbox", { name: "Field of Study" });
  // SAME INTERCEPTED-CLICK TRAP AS THE DEGREE BUTTON (2026-10-07). Centring the target in the viewport is what
  // cleared it there, and this is the next control in the same row - the sticky footer covers whatever Playwright's
  // default scroll leaves at the bottom edge.
  await box.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" })).catch(() => {});
  await box.click({ timeoutMs: 10000 });
  await box.press("Meta+A", { timeoutMs: 1000 }).catch(async () => {
    await box.press("Control+A", { timeoutMs: 1000 }).catch(() => {});
  });
  await box.press("Backspace", { timeoutMs: 1000 }).catch(() => {});
}

async function findAndClickFieldOption(tab, field) {
  const exactOption = new RegExp(`^${escapeRegExp(field)}$`);
  for (let y = 0; y <= 12000; y += 220) {
    await tab.playwright.evaluate((scrollY) => {
      document.querySelectorAll('[data-automation-id="activeListContainer"]').forEach(list => {
        if (typeof list.scrollTo === "function") {
          list.scrollTo(0, scrollY);
        }
      });
    }, y);
    await delay(tab, 180);

    const option = tab.playwright
      .locator('[data-automation-id="activeListContainer"] [data-automation-id="menuItem"]')
      .filter({ hasText: exactOption });
    if (await option.count() > 0) {
      const radio = option.first().getByRole("radio");
      if (await radio.count() > 0) {
        await radio.click({ timeoutMs: 10000, force: true });
      } else {
        await option.first().click({ timeoutMs: 10000, force: true });
      }
      await delay(tab, 400);
      return true;
    }
  }
  return false;
}

async function selectVisibleFieldOption(tab, eduGroup, field) {
  await tab.playwright.locator("body").press("Escape", { timeoutMs: 1000 }).catch(() => {});
  await delay(tab, 100);
  await clearFieldSearchText(eduGroup);
  await delay(tab, 300);
  const found = await findAndClickFieldOption(tab, field);
  await tab.playwright.locator("body").press("Escape", { timeoutMs: 1000 }).catch(() => {});
  return found;
}

async function selectDegreeOption(tab, degree) {
  const candidates = DEGREE_ALIASES[degree] || [degree];
  // THE SAME ROW-SELECTOR FIX THE SCHOOL NEEDED (2026-10-07). Workday renders an open prompt's rows as
  // div[data-automation-id="promptOption"] inside div[data-automation-id="activeListContainer"] with NO role=option,
  // so getByRole("option") below finds nothing - exactly why the school was never selected, and the degree is the
  // same widget. Try the attribute rows first, matching a row that CONTAINS the candidate.
  const rows = tab.playwright.locator('[data-automation-id="activeListContainer"] [data-automation-id="promptOption"]');
  const rowCount = await rows.count().catch(() => 0);
  if (rowCount > 0) {
    for (const candidate of candidates) {
      const want = String(candidate).trim().toLowerCase();
      for (let i = 0; i < rowCount; i += 1) {
        const text = ((await rows.nth(i).innerText({ timeoutMs: 1500 }).catch(() => "")) || "").replace(/\s+/g, " ").trim();
        if (!text || !text.toLowerCase().includes(want)) continue;
        await rows.nth(i).click({ timeoutMs: 6000, force: true }).catch(() => {});
        await delay(tab, 400);
        console.error(`[experience] degree row committed from the active list: "${text.slice(0, 60)}"`);
        return true;
      }
    }
    console.error(`[experience] ${rowCount} degree option row(s) but none contained the requested degree`);
  }

  for (const candidate of candidates) {
    const option = tab.playwright.getByRole("option", { name: new RegExp(`^${escapeRegExp(candidate)}\\b`) });
    if (await option.count() > 0) {
      await option.first().click({ timeoutMs: 10000 });
      await delay(tab, 300);
      return true;
    }

    const exactText = tab.playwright.getByText(candidate, { exact: true });
    if (await exactText.count() > 0) {
      await exactText.last().click({ timeoutMs: 10000 });
      await delay(tab, 300);
      return true;
    }
  }

  return false;
}

async function clearSelectedDegreeFallback(eduGroup) {
  const selected = eduGroup.locator('[role="option"]');
  if (await selected.count() > 0) {
    await selected.first().click({ timeoutMs: 2000 }).catch(() => {});
    await selected.first().press("Delete", { timeoutMs: 2000 }).catch(() => {});
  }
}

async function getTextboxValue(group, label) {
  return group.getByRole("textbox", { name: label }).evaluate(element => element.value || "", undefined, { timeoutMs: 2000 }).catch(() => "");
}

function normalizeSchool(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function schoolAliases(school) {
  return SCHOOL_ALIASES[school] || [school];
}

function campusToken(school) {
  // THE WORD THAT ACTUALLY DISAMBIGUATES (added 2026-10-07). Workday's school lookup returns a LIMITED list, and a
  // broad term never reaches the right campus: searching "Lakeside State University" returned fourteen schools from
  // the same state system and NOT the Fairview one. The part after the last comma is the campus; with no comma, the
  // first word is what distinguishes the institution ("Metropolitan Institute of Technology" -> "Metropolitan").
  const s = String(school || "").trim();
  if (s.includes(",")) return s.slice(s.lastIndexOf(",") + 1).trim();
  return s.split(/\s+/)[0] || "";
}

function schoolSearchTerms(school) {
  // The campus token goes FIRST so the list is narrowed before any broader alias is tried.
  return [campusToken(school), ...(SCHOOL_SEARCH_TERMS[school] || []), ...schoolAliases(school)].filter(Boolean);
}

function schoolMatches(selected, school) {
  const normalizedSelected = normalizeSchool(selected);
  return schoolAliases(school).some(alias => {
    const normalizedAlias = normalizeSchool(alias);
    return normalizedSelected.includes(normalizedAlias) || normalizedAlias.includes(normalizedSelected);
  });
}

async function selectedSchoolText(eduGroup) {
  const values = await selectedValuesForTextbox(eduGroup, "School or University");
  if (values[0]) {
    return values[0];
  }
  // Some Workday instances render the school as a plain text input with no
  // multiselect chips; fall back to the raw input value.
  const box = eduGroup.getByRole("textbox", { name: "School or University" });
  if (await box.count().catch(() => 0) > 0) {
    return box.evaluate(element => element.value || "", undefined, { timeoutMs: 1000 }).catch(() => "");
  }
  return "";
}

async function clearSelectedSchool(eduGroup, selected) {
  if (!selected) {
    return;
  }
  const selectedOptions = await selectedOptionsForTextbox(eduGroup, "School or University");
  const option = selectedOptions.filter({ hasText: new RegExp(escapeRegExp(selected)) }).first();
  if (await option.count() > 0) {
    await option.press("Delete", { timeoutMs: 2000 }).catch(() => option.press("Backspace", { timeoutMs: 2000 }));
  }
}

async function selectSchool(tab, eduGroup, school) {
  let selected = await selectedSchoolText(eduGroup);
  if (selected && schoolMatches(selected, school)) {
    return;
  }
  await clearSelectedSchool(eduGroup, selected);

  const box = eduGroup.getByRole("textbox", { name: "School or University" });
  for (const searchTerm of schoolSearchTerms(school)) {
    await box.click({ timeoutMs: 10000 });
    await box.press("Meta+A", { timeoutMs: 1000 }).catch(() => box.press("Control+A", { timeoutMs: 1000 }));
    await box.press("Backspace", { timeoutMs: 1000 }).catch(() => {});
    await box.pressSequentially(searchTerm, { delayMs: 35, timeoutMs: 10000 });
    await box.press("Enter", { timeoutMs: 2000 }).catch(() => {});
    await delay(tab, 1200);

    for (const candidate of schoolAliases(school)) {
      // WORKDAY'S OPTION ROWS ARE PLAIN DIVS, SO getByRole("option") FINDS NOTHING (found 2026-10-07). The open
      // listbox renders `div#promptOption-…` inside `div[data-automation-id="activeListContainer"]` with no
      // role=option on the row, which is why the school was never selected: the listbox stayed open waiting, and the
      // open overlay then intercepted every later click in the row (elementFromPoint at the Degree button returned a
      // promptOption). Address the rows by their own attribute, scoped to the active list, and match on text.
      const rows = tab.playwright.locator('[data-automation-id="activeListContainer"] [data-automation-id="promptOption"]');
      const rowCount = await rows.count().catch(() => 0);
      if (rowCount > 0) {
        const collected = [];
        for (const alias of schoolAliases(school)) {
          const want = alias.trim().toLowerCase();
          for (let i = 0; i < rowCount; i += 1) {
            const text = ((await rows.nth(i).innerText({ timeoutMs: 1500 }).catch(() => "")) || "").replace(/\s+/g, " ").trim();
            if (i === 0) collected.length = 0;
            if (text) collected.push(text.slice(0, 60));
            // CONTAINMENT, NOT PREFIX, AND ON THE CAMPUS TOKEN. The list never offers "Lakeside State University,
            // Fairview"; it offers "Lakeside State University Los Angeles" and its siblings, so a prefix test on the
            // whole name could never match anything. The token is what identifies the campus.
            const token = campusToken(school).toLowerCase();
            if (!text) continue;
            const lower = text.toLowerCase();
            const accepted = token ? lower.includes(token) : lower.startsWith(want);
            if (!accepted) continue;
            await rows.nth(i).click({ timeoutMs: 8000, force: true }).catch(() => {});
            await delay(tab, 500);
            const chosen = await selectedSchoolText(eduGroup);
            if (chosen && schoolMatches(chosen, school)) {
              console.error(`[experience] school row committed from the active list: "${text}"`);
              return;
            }
          }
        }
        console.error(`[experience] ${rowCount} option row(s) in the active list but none matched "${school}"; rows were: ${JSON.stringify(collected)}`);
      }
      const exactOption = tab.playwright.getByRole("option", {
        name: new RegExp(`^${escapeRegExp(candidate)}(?: not checked)?$`)
      }).last();
      if (await exactOption.count() > 0) {
        const radio = exactOption.getByRole("radio");
        if (await radio.count() > 0) {
          await radio.click({ timeoutMs: 10000, force: true });
        } else {
          await exactOption.click({ timeoutMs: 10000, force: true });
        }
        await delay(tab, 400);
        break;
      }
    }

    selected = await selectedSchoolText(eduGroup);
    if (selected && schoolMatches(selected, school)) {
      return;
    }
  }

  // Fallback: some Workday instances render the school as a plain text input
  // (no lookup options ever appear). Accept a plain value in that case.
  try {
    const box = eduGroup.getByRole("textbox", { name: "School or University" });
    if (await box.count() > 0) {
      await box.click({ timeoutMs: 10000 });
      await box.fill(school, { timeoutMs: 10000 });
      await delay(tab, 300);
      const value = await box.evaluate(element => element.value || "", undefined, { timeoutMs: 1000 }).catch(() => "");
      if (schoolMatches(value, school)) {
        return;
      }
    }
  } catch {}

  throw new Error(`Could not select Workday school: ${school}`);
}

async function fillEducationYear(tab, eduGroup, suffix, value) {
  if (!value) {
    return;
  }
  const yearInput = eduGroup.locator(`input[id$="${suffix}-dateSectionYear-input"]`);
  if (await yearInput.count() === 0) {
    return;
  }
  const current = await yearInput.first().evaluate(element => element.value || "", undefined, { timeoutMs: 1000 }).catch(() => "");
  if (String(current) === String(value)) {
    return;
  }
  await yearInput.first().fill(String(value), { timeoutMs: 10000 });
  await delay(tab, 100);
}

async function educationGroups(tab) {
  const section = await getSection(tab, EDUCATION_SECTION_NAMES);
  const all = await section.getByRole("group", { name: numberedGroupRegex(EDUCATION_SECTION_NAMES) }).all();
  // ONLY VISIBLE ROWS (added 2026-10-07, the Workday tenant). A hidden template copy of a repeated block can sit
  // beside the live one - the same trap that made the sign-in form look empty - and driving it does not fail fast:
  // every click inside it waits out its timeout, which is exactly the 30-second locator timeout that left both
  // education rows empty with "School or University is required" and "Degree is required".
  const visible = [];
  for (const group of all) {
    const shown = await group.isVisible().catch(() => false);
    if (shown) visible.push(group);
    else console.error("[experience] skipping a hidden education row");
  }
  return visible;
}

async function ensureEducationCount(tab, count) {
  const section = await getSection(tab, EDUCATION_SECTION_NAMES);
  if (!section) return [];   // no named Education group on this tenant; let the caller (or the plan) handle that step
  let groups = await educationGroups(tab);
  while (groups.length < count) {
    await section.getByRole("button", { name: /Add|Add Another/ }).click({ timeoutMs: 10000 });
    await delay(tab, 700);
    groups = await educationGroups(tab);
  }
  // The mirror operation: a row that exists is a row whose required dropdowns must be answered, and tenants exist whose
  // extra education row cannot be driven at all. Trim to the payload's count, newest-first.
  while (groups.length > count) {
    const row = groups[groups.length - 1];
    const del = row.getByRole("button", { name: /^(Delete|Remove)$/i }).first();
    if (!(await del.count())) {
      const scoped = section.getByRole("button", { name: /^(Delete|Remove)$/i });
      if (!(await scoped.count())) break;
      await scoped.last().click({ timeout: 8000 }).catch(() => {});
    } else {
      await del.click({ timeout: 8000 }).catch(() => {});
    }
    await delay(tab, 900);
    groups = await educationGroups(tab);
  }
  return groups;
}

async function selectDegree(tab, eduGroup, degree) {
  const currentText = await eduGroup.getByRole("button", { name: /Degree/ }).innerText({ timeoutMs: 2000 }).catch(() => "");
  const candidates = DEGREE_ALIASES[degree] || [degree];
  if (candidates.some(candidate => currentText.includes(candidate))) {
    return;
  }
  // DISMISS THE SCHOOL POPUP FIRST (added 2026-10-07, the Workday tenant). The Degree locator RESOLVED to a visible,
  // enabled, stable button - <button id="education-679--degree" aria-haspopup="listbox" aria-label="Degree Select One
  // Required">Select One</button> - and the click still timed out after thirty seconds. That is the signature of a
  // click being INTERCEPTED, not of a missing element: the school typeahead's listbox is still open above the row.
  // Escape closes it, and a forced click covers anything else overlaying the control.
  // CLOSE THE SCHOOL LISTBOX AND PROVE IT IS CLOSED (2026-10-07, and now with evidence rather than a guess).
  // elementFromPoint at the Degree button's centre returned:
  //   div#promptOption-...[promptOption] < div[promptLeafNode] < div[menuItem] < div[activeListContainer]
  // so the SCHOOL typeahead's dropdown was still open and lying across the Degree button - a single Escape did not
  // close it, and centring could not help because the overlay moves with the row. Escape until no active list
  // container remains, then centre.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const open = await tab.playwright.evaluate(() => document.querySelectorAll('[data-automation-id="activeListContainer"]').length).catch(() => 0);
    if (!open) break;
    console.error(`[experience] a dropdown is still open over the education row (${open}); clicking its own toggle icon`);
    // CLOSE IT THE WIDGET'S OWN WAY (2026-10-07). Escape, repeated Escape, blur-then-Escape and clicking a neutral
    // heading all left the list open; it is a Workday multiselect, and the control that opens it is its own prompt
    // icon - `span[data-automation-id="promptIcon"]` inside the row - so that is what gets clicked.
    const icon = tab.playwright.locator('span[data-automation-id="promptIcon"]:visible').first();
    if (await icon.count().catch(() => 0)) {
      await icon.click({ timeoutMs: 4000, force: true }).catch(() => {});
      await delay(tab, 400);
      continue;
    }
    // Escape alone does not close this list: the typeahead keeps focus and the multiselect re-opens on the next
    // render. Blur the focused control first, then Escape, and click a neutral spot - the list is what covers the
    // Degree button, and it survived four Escape presses on its own (measured 2026-10-07).
    await tab.playwright.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }).catch(() => {});
    await tab.playwright.locator("body").press("Escape", { timeoutMs: 1000 }).catch(() => {});
    await delay(tab, 300);
    await tab.playwright.evaluate(() => {
      const heading = document.querySelector("h1,h2,[data-automation-id='stepTitle']");
      if (heading && heading.click) heading.click();
    }).catch(() => {});
    await delay(tab, 300);
  }
  await delay(tab, 250);
  const degreeButton = eduGroup.getByRole("button", { name: /Degree/ });
  // CENTRE THE TARGET IN THE VIEWPORT BEFORE CLICKING (2026-10-07). The Degree locator resolved to a visible,
  // enabled, stable button and the click still timed out; that is an INTERCEPTED click, and this page carries a
  // sticky Back / Save and Continue footer across the bottom of the viewport. Playwright scrolls a target into view
  // but does not guarantee it clears a fixed overlay, so the click lands on the footer. Scrolling to the CENTRE is
  // the difference between "in view" and "not underneath anything".
  await degreeButton.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" })).catch(() => {});
  await delay(tab, 300);
  try {
    await degreeButton.click({ timeoutMs: 10000 });
  } catch {
    console.error("[experience] the normal click on the Degree button timed out; forcing it");
    // NAME THE INTERCEPTOR INSTEAD OF GUESSING AT IT AGAIN (2026-10-07). A locator that resolves to a visible,
    // enabled, stable element and still times out is an intercepted click, and centring cleared it once but not
    // reliably. elementFromPoint at the button's own centre says what is actually on top there.
    const who = await degreeButton.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      const top = document.elementFromPoint(cx, cy);
      const path = [];
      for (let n = top; n && path.length < 5; n = n.parentElement) {
        const auto = n.getAttribute ? n.getAttribute("data-automation-id") : null;
        path.push(`${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${auto ? `[${auto}]` : ""}`);
      }
      return { cx, cy, viewport: [window.innerWidth, window.innerHeight], onTop: path.join(" < "), sameElement: top === el };
    }).catch(() => null);
    console.error("[experience] what is at the Degree button's centre:", JSON.stringify(who));
    await degreeButton.click({ timeoutMs: 10000, force: true }).catch(() => {});
  }
  await delay(tab, 500);
  if (!await selectDegreeOption(tab, degree)) {
    await clearSelectedDegreeFallback(eduGroup);
  }
}

async function selectFieldByPreference(tab, eduGroup, preferences) {
  const current = await selectedFieldText(eduGroup);
  if (preferences.length === 0 || current.includes(preferences[0])) {
    return;
  }

  for (const field of preferences) {
    if (current.includes(field)) {
      return;
    }
    const found = await selectVisibleFieldOption(tab, eduGroup, field);
    if (!found) {
      continue;
    }
    const selected = await selectedFieldText(eduGroup);
    if (selected.includes(field)) {
      return;
    }
    await clearSelectedField(eduGroup);
  }

  const currentPreferenceIndex = preferences.findIndex(option => current.includes(option));
  if (currentPreferenceIndex >= 0) {
    return;
  }

  for (const field of preferences) {
    await clearSelectedField(eduGroup);
    if (await selectVisibleFieldOption(tab, eduGroup, field)) {
      return;
    }
  }
}

export async function chooseEducationFields(tab, education) {
  let groups = await ensureEducationCount(tab, education.length);
  for (const edu of education) {
    groups = await educationGroups(tab);
    let group = undefined;
    for (const candidate of groups) {
      const schoolValue = await selectedSchoolText(candidate);
      if (schoolValue && schoolMatches(schoolValue, edu.school)) {
        group = candidate;
        break;
      }
    }
    if (!group) {
      for (const candidate of groups) {
        const schoolValue = await selectedSchoolText(candidate);
        if (!schoolValue) {
          group = candidate;
          break;
        }
      }
      group = group || groups[groups.length - 1];
    }
    try {
      await selectSchool(tab, group, edu.school);
    } catch (error) {
      if (!edu.skip_if_school_unlisted) {
        throw error;
      }
      await group.getByRole("button", { name: "Delete" }).click({ timeoutMs: 10000 });
      await delay(tab, 500);
      continue;
    }
    if (edu.degree) {
      await selectDegree(tab, group, edu.degree);
    }
    // FIELD OF STUDY IS OPTIONAL ON THIS TENANT, SO ITS FAILURE MUST NOT TAKE THE REQUIRED FIELDS WITH IT
    // (2026-10-07). The control carries aria-required="false", and its click is intercepted in a way centring did
    // not clear; because the exception aborted the loop, School and Degree - both REQUIRED, both already set by this
    // point - were reported missing on every submit. A blocked optional field is a blank to record and list, not a
    // reason to lose the two answers that were accepted.
    try {
      await selectFieldByPreference(tab, group, edu.field_preferences || []);
    } catch (error) {
      console.error(`[experience] Field of Study could not be set for ${edu.school}: ${String(error).slice(0, 160)}`);
      console.error("[experience]   it is OPTIONAL on this tenant; leaving it blank and continuing to the required fields");
    }
    await fillEducationYear(tab, group, "firstYearAttended", edu.from_year || edu.start_year);
    await fillEducationYear(tab, group, "lastYearAttended", edu.to_year || edu.end_year);
  }
}

export async function fillLinkedIn(tab, linkedinUrl) {
  const section = tab.playwright.getByRole("group", { name: "Social Network URLs" });
  if (await section.count() === 0) {
    return false;
  }
  const linkedin = section.getByRole("textbox", {
    name: /^(?:LinkedIn|Please provide the URL to your LinkedIn profile\.)$/
  });
  await linkedin.fill(linkedinUrl, { timeoutMs: 10000 });
  return true;
}

export async function uploadResume(tab, resumePath) {
  const input = tab.playwright.locator('input[type="file"]');
  if (await input.count() === 0) {
    return false;
  }

  const chooserPromise = tab.playwright.waitForEvent("filechooser", { timeoutMs: 10000 });
  await tab.playwright.getByRole("button", { name: "Select files" }).click({ timeoutMs: 10000 });
  const chooser = await chooserPromise;
  await chooser.setFiles(resumePath);
  await delay(tab, 1800);
  return true;
}

export async function removeExcludedWebsites(tab, excludedWebsites = []) {
  const excluded = new Set(excludedWebsites.map(normalizeUrl).filter(Boolean));
  if (excluded.size === 0) {
    return 0;
  }

  const section = tab.playwright.getByRole("group", { name: /^Websites\b/ }).first();
  if (await section.count() === 0) {
    return 0;
  }

  let removed = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const targetIndex = await section.locator("input").evaluateAll((inputs, excludedValues) => {
      const normalized = value => value.trim().replace(/\/+$/, "");
      return inputs.findIndex(input => excludedValues.includes(normalized(input.value || "")));
    }, Array.from(excluded), { timeoutMs: 2000 }).catch(() => -1);

    if (targetIndex < 0) {
      return removed;
    }

    const target = section.locator("input").nth(targetIndex);
    const entry = target.locator('xpath=ancestor::div[.//button[normalize-space()="Delete"]][1]');
    const deleteButton = entry.getByRole("button", { name: "Delete" }).first();
    if (await deleteButton.count() === 0) {
      return removed;
    }
    await deleteButton.click({ timeoutMs: 10000 });
    removed += 1;
    await delay(tab, 500);
  }
  return removed;
}

export async function fillMyExperiencePage(tab, payload) {
  await tab.playwright.getByRole("heading", { name: "My Experience" }).waitFor({ state: "visible", timeoutMs: 10000 });
  await fillWorkExperience(tab, payload.work_experience || []);
  await chooseEducationFields(tab, payload.education || []);
  if (payload.social_networks?.linkedin) {
    await fillLinkedIn(tab, payload.social_networks.linkedin);
  }
  await removeExcludedWebsites(tab, payload.excluded_websites || []);
  return tab.playwright.domSnapshot();
}
