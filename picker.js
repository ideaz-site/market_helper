// Injected into the page by the popup. Covers every text field with a
// clickable overlay; clicking one saves that field under the current site. The
// popup closes as soon as the page is clicked, so this script writes to storage
// itself.
(() => {
  if (window.__marketHelperPicking) return;
  window.__marketHelperPicking = true;

  const SITES_KEY = 'sites';
  const TEXT_FIELDS = [
    'textarea',
    'input:not([type])',
    'input[type="text"]',
    'input[type="search"]',
    'input[type="email"]',
    'input[type="url"]',
    'input[type="tel"]',
    'input[type="number"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]',
  ].join(',');
  const POINTER_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];
  const IDLE = 'border:2px solid #7c3aed;background:rgba(124,58,237,.2);';
  const HOVER = 'border:2px solid #16a34a;background:rgba(22,163,74,.35);';
  const OVERLAY =
    'position:fixed;z-index:2147483646;box-sizing:border-box;margin:0;padding:0;' +
    'border-radius:4px;cursor:pointer;pointer-events:auto;';

  const layer = document.createElement('div');

  const banner = document.createElement('div');
  banner.textContent = 'Market Helper: click a highlighted field to save it · Esc to cancel';
  banner.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;top:12px;left:50%;' +
    'transform:translateX(-50%);padding:8px 14px;border-radius:999px;' +
    'background:#7c3aed;color:#fff;font:13px/1.3 system-ui,sans-serif;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.3);';

  document.documentElement.append(layer, banner);

  const overlays = new Map(); // field element -> overlay
  const fields = new Map(); // overlay -> field element
  let hovered = null;

  function paint(overlay) {
    const r = fields.get(overlay).getBoundingClientRect();
    overlay.style.cssText =
      OVERLAY +
      (overlay === hovered ? HOVER : IDLE) +
      `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
  }

  // Keeps one overlay over each visible text field. Runs on a timer as well as
  // on scroll, because pages add, remove and move fields after load.
  function sync() {
    const current = new Set();
    for (const field of document.querySelectorAll(TEXT_FIELDS)) {
      // A wrapper and its inner editor can both match; keep the inner one.
      if (field.querySelector(TEXT_FIELDS)) continue;
      const r = field.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      current.add(field);
      if (!overlays.has(field)) {
        const overlay = document.createElement('div');
        overlays.set(field, overlay);
        fields.set(overlay, field);
        layer.append(overlay);
      }
    }
    for (const [field, overlay] of overlays) {
      if (current.has(field)) {
        paint(overlay);
        continue;
      }
      if (overlay === hovered) hovered = null;
      overlay.remove();
      overlays.delete(field);
      fields.delete(overlay);
    }
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  // Prefer attributes that survive a page reload; fall back to a structural path.
  function buildSelector(el) {
    const tag = el.tagName.toLowerCase();
    for (const attr of ['name', 'aria-label', 'placeholder', 'data-testid']) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const selector = `${tag}[${attr}="${CSS.escape(value)}"]`;
      if (isUnique(selector)) return selector;
    }
    // Ids like ":r1:" or "input-48213" are generated per page load.
    if (el.id && !/^:|\d{3,}/.test(el.id)) {
      const selector = `#${CSS.escape(el.id)}`;
      if (isUnique(selector)) return selector;
    }
    const parts = [];
    for (let node = el; node.parentElement; node = node.parentElement) {
      const sameTag = [...node.parentElement.children].filter((c) => c.tagName === node.tagName);
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${sameTag.indexOf(node) + 1})`);
    }
    return `html > ${parts.join(' > ')}`;
  }

  function describe(el) {
    const label =
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      (el.labels && el.labels[0] && el.labels[0].textContent) ||
      el.getAttribute('name') ||
      el.tagName.toLowerCase();
    return label.trim().replace(/\s+/g, ' ').slice(0, 60);
  }

  function toast(message) {
    banner.textContent = message;
    setTimeout(() => banner.remove(), 2500);
  }

  const timer = setInterval(sync, 400);

  function stop() {
    window.__marketHelperPicking = false;
    clearInterval(timer);
    layer.remove();
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('scroll', sync, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', sync);
    for (const type of POINTER_EVENTS) document.removeEventListener(type, onPointer, true);
  }

  async function saveField(el) {
    const host = location.hostname;
    const { [SITES_KEY]: sites = {} } = await chrome.storage.local.get(SITES_KEY);
    const site = sites[host] || (sites[host] = { host, name: host, addedAt: Date.now(), fields: [] });
    const selector = buildSelector(el);
    if (site.fields.some((f) => f.selector === selector)) return false;
    site.fields.push({ id: crypto.randomUUID(), selector, label: describe(el), text: '' });
    await chrome.storage.local.set({ [SITES_KEY]: sites });
    return true;
  }

  function onOver(event) {
    const previous = hovered;
    hovered = fields.has(event.target) ? event.target : null;
    if (previous && previous !== hovered && fields.has(previous)) paint(previous);
    if (hovered) paint(hovered);
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    stop();
    banner.remove();
  }

  // Swallow every pointer event so the page doesn't react while picking.
  function onPointer(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.type !== 'click') return;
    const field = fields.get(event.target);
    if (!field) return;
    stop();
    saveField(field).then(
      (added) => toast(added ? 'Saved — open Market Helper to set its text' : 'That field is already saved'),
      () => toast('Market Helper could not save that field'),
    );
  }

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('scroll', sync, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', sync);
  for (const type of POINTER_EVENTS) document.addEventListener(type, onPointer, true);
  sync();
})();
