// Injected into the page by the side panel. Covers every text field that isn't
// saved yet with a clickable overlay; clicking one saves that field under the
// current site and tells the panel to refresh.
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
  const IDLE = 'border:3px solid #7c3aed;background:rgba(124,58,237,.2);';
  const HOVER = 'border:3px solid #16a34a;background:rgba(22,163,74,.35);';
  const OVERLAY =
    'position:fixed;z-index:2147483646;box-sizing:border-box;margin:0;padding:0;' +
    'border-radius:4px;cursor:pointer;pointer-events:auto;';

  const layer = document.createElement('div');

  const PICK = 'Click the box you want Market Helper to fill in';
  const NOTHING = 'No more boxes to choose on this page';

  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:auto;top:12px;left:50%;' +
    'transform:translateX(-50%);display:flex;align-items:center;gap:12px;' +
    'max-width:calc(100vw - 24px);padding:10px 12px 10px 18px;border-radius:999px;' +
    'background:#7c3aed;color:#fff;font:16px/1.3 system-ui,sans-serif;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.3);';
  const bannerText = document.createElement('span');
  bannerText.textContent = PICK;
  // Not everyone knows Esc, so the banner carries its own way out.
  const stopButton = document.createElement('button');
  stopButton.type = 'button';
  stopButton.textContent = 'Stop';
  stopButton.style.cssText =
    'padding:6px 14px;border:1px solid #fff;border-radius:999px;background:transparent;' +
    'color:#fff;font:inherit;cursor:pointer;';
  banner.append(bannerText, stopButton);

  document.documentElement.append(layer, banner);

  const overlays = new Map(); // field element -> overlay
  const fields = new Map(); // overlay -> field element
  let hovered = null;
  let savedSelectors = [];

  function isSaved(field) {
    return savedSelectors.some((selector) => {
      try {
        return field.matches(selector);
      } catch {
        return false;
      }
    });
  }

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
      if (isSaved(field)) continue;
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
    bannerText.textContent = overlays.size ? PICK : NOTHING;
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

  // A label's text without what's typed in the box it wraps.
  function labelText(el) {
    if (!el.labels || !el.labels[0]) return '';
    const copy = el.labels[0].cloneNode(true);
    for (const control of copy.querySelectorAll('input, textarea, select, [contenteditable]')) control.remove();
    return copy.textContent;
  }

  function describe(el) {
    const label =
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      labelText(el) ||
      el.getAttribute('name') ||
      el.tagName.toLowerCase();
    return label.trim().replace(/\s+/g, ' ').slice(0, 60);
  }

  function toast(message) {
    bannerText.textContent = message;
    stopButton.remove();
    setTimeout(() => banner.remove(), 4000);
  }

  let timer = null;

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

  // Fields go into whichever profile is selected for this site in the panel.
  async function loadProfile() {
    const { [SITES_KEY]: sites = {} } = await chrome.storage.local.get(SITES_KEY);
    const site = sites[location.hostname];
    const profile = site && site.profiles && site.profiles[site.activeProfile];
    if (!profile) throw new Error('Site is not saved');
    return { sites, profile };
  }

  async function saveField(el) {
    const { sites, profile } = await loadProfile();
    const selector = buildSelector(el);
    if (profile.fields.some((f) => f.selector === selector)) return false;
    const label = describe(el);
    profile.fields.push({ id: crypto.randomUUID(), selector, label, text: '' });
    await chrome.storage.local.set({ [SITES_KEY]: sites });
    // Rejects when the panel is closed, which is fine.
    chrome.runtime.sendMessage({ type: 'field-picked', label }).catch(() => {});
    return true;
  }

  function onOver(event) {
    const previous = hovered;
    hovered = fields.has(event.target) ? event.target : null;
    if (previous && previous !== hovered && fields.has(previous)) paint(previous);
    if (hovered) paint(hovered);
  }

  function cancel() {
    stop();
    banner.remove();
    chrome.runtime.sendMessage({ type: 'picking-stopped' }).catch(() => {});
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }

  // Swallow every pointer event so the page doesn't react while picking.
  function onPointer(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.type !== 'click') return;
    if (event.target === stopButton) return cancel();
    const field = fields.get(event.target);
    if (!field) return;
    stop();
    saveField(field).then(
      (added) => toast(added ? 'Saved. Now say what goes in it in the Market Helper panel.' : 'That box is already saved.'),
      () => toast("Market Helper couldn't save that box."),
    );
  }

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('scroll', sync, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', sync);
  for (const type of POINTER_EVENTS) document.addEventListener(type, onPointer, true);

  // Wait for the saved fields before drawing, so they never flash an overlay.
  loadProfile().then(
    ({ profile }) => {
      if (!window.__marketHelperPicking) return;
      savedSelectors = profile.fields.map((f) => f.selector);
      sync();
      timer = setInterval(sync, 400);
    },
    () => {
      stop();
      toast('Save this website in the Market Helper panel first.');
    },
  );
})();
