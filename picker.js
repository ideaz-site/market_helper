// Injected into the page by the popup. Lets the user hover text fields and
// click one to save it under the current site. The popup closes as soon as the
// page is clicked, so this script writes to storage itself.
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

  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;display:none;' +
    'border:2px solid #7c3aed;background:rgba(124,58,237,.15);border-radius:4px;';

  const banner = document.createElement('div');
  banner.textContent = 'Market Helper: click a text field to save it · Esc to cancel';
  banner.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;top:12px;left:50%;' +
    'transform:translateX(-50%);padding:8px 14px;border-radius:999px;' +
    'background:#7c3aed;color:#fff;font:13px/1.3 system-ui,sans-serif;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.3);';

  document.documentElement.append(box, banner);

  let hovered = null;

  function fieldAt(event) {
    return event.target instanceof Element ? event.target.closest(TEXT_FIELDS) : null;
  }

  function highlight(el) {
    hovered = el;
    if (!el) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = `${r.left - 2}px`;
    box.style.top = `${r.top - 2}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
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

  function stop() {
    window.__marketHelperPicking = false;
    box.remove();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('keydown', onKey, true);
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      document.removeEventListener(type, onPointer, true);
    }
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

  function onMove(event) {
    highlight(fieldAt(event));
  }

  function onScroll() {
    if (hovered) highlight(hovered);
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
    const el = fieldAt(event);
    if (!el) return;
    stop();
    saveField(el).then(
      (added) => toast(added ? 'Saved — open Market Helper to set its text' : 'That field is already saved'),
      () => toast('Market Helper could not save that field'),
    );
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('keydown', onKey, true);
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
    document.addEventListener(type, onPointer, true);
  }
})();
