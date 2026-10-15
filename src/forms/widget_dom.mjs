/**
 * Read the option menu owned by ONE control. Self-contained so Playwright can
 * serialize this function into the page; tests pass a small DOM stand-in.
 */
export function readAssociatedOptions(el, dom = globalThis.document) {
  const source = el.getAttribute("aria-controls") ? el : el.querySelector("[aria-controls]");
  const menuId = source?.getAttribute("aria-controls");
  const root = el.getRootNode();
  const linked = menuId && (root.getElementById?.(menuId) || dom.getElementById(menuId));
  const visible = node => node && Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  // A declared link is authoritative. If its menu did not open, another
  // widget's visible menu must not be used as a fallback.
  if (menuId && !visible(linked)) return [];
  let listbox = linked || null;
  if (!listbox) {
    // An unlinked popup is usable only when it is the ONE visible menu.
    // Reading every visible menu would assign another field's options here.
    const menus = [...dom.querySelectorAll('[role="listbox"]')].filter(visible);
    if (menus.length === 1) listbox = menus[0];
  }
  if (!listbox) return [];
  return [...listbox.querySelectorAll('[role="option"]')]
    .filter(visible).map(o => (o.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
}
