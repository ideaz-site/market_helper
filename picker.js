// Injected into the page by the side panel. Covers the page's text boxes with
// overlays: purple ones can be chosen, green ones already are. Each click saves
// a box under the current site and tells the panel. Choosing goes on until
// Done, Esc, or the panel letting go of its port.
(() => {
  if (window.__marketHelperPicking) return;
  window.__marketHelperPicking = true;
  // A closing message from the last round may still be on the page.
  for (const old of document.querySelectorAll('[data-market-helper]')) old.remove();

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
  const FONT = 'system-ui,-apple-system,"Segoe UI",sans-serif';
  const OVERLAY =
    'position:fixed;box-sizing:border-box;margin:0;padding:0;border-radius:4px;' +
    'outline:2px solid #fff;pointer-events:auto;';
  const LOOKS = {
    idle: 'border:3px solid #7c3aed;background:rgba(124,58,237,.16);cursor:pointer;',
    hover: 'border:4px solid #5b21b6;background:rgba(124,58,237,.24);cursor:pointer;',
    saved: 'border:3px solid #15803d;background:rgba(22,163,74,.12);cursor:default;',
  };
  const CHIP =
    'position:absolute;top:50%;right:6px;transform:translateY(-50%);padding:3px 9px;' +
    `border-radius:6px;font:600 14px/1.3 ${FONT};white-space:nowrap;pointer-events:none;`;
  const BANNER =
    'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);box-sizing:border-box;' +
    'display:flex;align-items:center;gap:14px;width:max-content;max-width:calc(100vw - 24px);' +
    'padding:12px 12px 12px 18px;border:2px solid #fff;border-radius:14px;background:#4c1d95;' +
    `color:#fff;font:600 17px/1.35 ${FONT};box-shadow:0 4px 18px rgba(0,0,0,.45);pointer-events:auto;`;
  const PICK = 'Click each box you want filled in';
  const ALL_CHOSEN = 'Every box on this page is already chosen.';
  const NOTHING = "Market Helper can't find a box to type in here. Some websites keep their boxes where it can't reach.";

  // Everything is drawn inside a shadow root, where the page's styles can't reach.
  const host = document.createElement('div');
  host.dataset.marketHelper = '';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;direction:ltr;';
  const root = host.attachShadow({ mode: 'closed' });
  const layer = document.createElement('div');

  const banner = document.createElement('div');
  banner.setAttribute('role', 'status');
  banner.style.cssText = BANNER;
  const words = document.createElement('div');
  const headline = document.createElement('div');
  const tally = document.createElement('div');
  tally.style.cssText = 'font-weight:400;font-size:15px;';
  words.append(headline, tally);
  // Not everyone knows Esc, so the banner carries its own way out.
  const doneButton = document.createElement('button');
  doneButton.type = 'button';
  doneButton.textContent = 'Done';
  doneButton.style.cssText =
    'flex:none;min-height:40px;padding:0 18px;border:0;border-radius:10px;background:#fff;' +
    `color:#4c1d95;font:600 16px/1 ${FONT};cursor:pointer;`;
  banner.append(words, doneButton);

  root.append(layer, banner);
  document.documentElement.append(host);

  const overlays = new Map(); // text box -> { node, chip, state }
  const boxes = new Map(); // overlay node -> text box
  const picked = new Map(); // text box chosen in this round -> its field id, once saved
  let saved = []; // the template's fields, as last read from storage
  let hovered = null;
  let lastPick = 0;
  let noteUntil = 0;
  let frame = 0;
  let timer = null;
  let queue = Promise.resolve(); // storage writes, one at a time

  // A label's text without what's typed in the box it wraps.
  function labelText(el) {
    if (!el.labels || !el.labels[0]) return '';
    const copy = el.labels[0].cloneNode(true);
    for (const control of copy.querySelectorAll('input, textarea, select, [contenteditable]')) control.remove();
    const text = copy.textContent.trim();
    // Multi-line boxes that grow as you type keep a hidden copy of their text
    // beside them, inside the label.
    const typed = el instanceof HTMLTextAreaElement ? el.value.trim() : '';
    return typed && text.endsWith(typed) ? text.slice(0, -typed.length) : text;
  }

  // Must stay in step with inPage in panel.js, which re-finds boxes by this label.
  function describe(el) {
    const label =
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      labelText(el) ||
      el.getAttribute('name') ||
      el.tagName.toLowerCase();
    return label.trim().replace(/\s+/g, ' ').slice(0, 60);
  }

  // Whether describe() had nothing a person would recognise to go on.
  function isUnnamed(el) {
    return !(el.getAttribute('aria-label') || el.getAttribute('placeholder') || labelText(el).trim());
  }

  function isCandidate(el) {
    if (el.querySelector(TEXT_FIELDS)) return false; // a wrapper and its inner editor both match; keep the inner one
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // The same search inPage uses, so a box the panel can find shows as chosen here.
  function locate(field) {
    const bySelector = () => {
      try {
        return document.querySelector(field.selector);
      } catch {
        return null;
      }
    };
    const byLabel = () => {
      const matches = [...document.querySelectorAll(TEXT_FIELDS)].filter(
        (el) => isCandidate(el) && describe(el) === field.label,
      );
      return matches.length === 1 ? matches[0] : null;
    };
    return field.selector.startsWith('html > ') ? byLabel() || bySelector() : bySelector() || byLabel();
  }

  function draw(box) {
    const entry = overlays.get(box);
    const r = box.getBoundingClientRect();
    const look = entry.state === 'saved' ? 'saved' : box === hovered ? 'hover' : 'idle';
    entry.node.style.cssText =
      OVERLAY + LOOKS[look] + `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
    const roomy = r.width >= 190;
    if (look === 'saved') {
      entry.chip.textContent = roomy ? '✓ Chosen' : '✓';
      entry.chip.style.cssText = CHIP + 'background:#15803d;color:#fff;';
    } else if (look === 'hover' && roomy) {
      entry.chip.textContent = '+ Choose this box';
      entry.chip.style.cssText = CHIP + 'background:#fff;color:#4c1d95;';
    } else {
      entry.chip.style.cssText = 'display:none;';
    }
  }

  function place() {
    for (const box of overlays.keys()) draw(box);
  }

  function describeProgress() {
    tally.textContent = `${picked.size} chosen so far · the page won't respond until you press Done`;
    if (Date.now() < noteUntil) return;
    const open = [...overlays.values()].some((entry) => entry.state === 'idle');
    headline.textContent = open ? PICK : overlays.size ? ALL_CHOSEN : NOTHING;
  }

  function note(message) {
    noteUntil = Date.now() + 4000;
    headline.textContent = message;
  }

  // Keeps one overlay over each visible text box. Runs on a timer, because
  // pages add, remove and move boxes after load.
  function sync() {
    const chosen = new Set(saved.map(locate));
    const current = new Set();
    for (const box of document.querySelectorAll(TEXT_FIELDS)) {
      if (!isCandidate(box)) continue;
      current.add(box);
      if (!overlays.has(box)) {
        const node = document.createElement('div');
        const chip = document.createElement('span');
        node.append(chip);
        layer.append(node);
        overlays.set(box, { node, chip, state: 'idle' });
        boxes.set(node, box);
      }
      overlays.get(box).state = picked.has(box) || chosen.has(box) ? 'saved' : 'idle';
    }
    for (const [box, entry] of overlays) {
      if (current.has(box)) continue;
      if (box === hovered) hovered = null;
      entry.node.remove();
      overlays.delete(box);
      boxes.delete(entry.node);
    }
    place();
    describeProgress();
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

  // Fields go into whichever profile is selected for this site in the panel.
  async function loadProfile() {
    const { [SITES_KEY]: sites = {} } = await chrome.storage.local.get(SITES_KEY);
    const site = sites[location.hostname];
    const profile = site && site.profiles && site.profiles[site.activeProfile];
    if (!profile) throw new Error('Site is not saved');
    return { sites, profile };
  }

  // Rejects when the panel is closed, which is fine.
  function tell(message) {
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  async function saveField(box) {
    if (!picked.has(box)) return; // chosen and un-chosen before its turn came
    const { sites, profile } = await loadProfile();
    const selector = buildSelector(box);
    if (!profile.fields.some((f) => f.selector === selector)) {
      const field = { id: crypto.randomUUID(), selector, label: describe(box), text: '' };
      // A box the page gives no real label gets a name the user can change.
      if (isUnnamed(box)) {
        let n = 1;
        while (profile.fields.some((f) => f.name === `Box ${n}`)) n++;
        field.name = `Box ${n}`;
      }
      profile.fields.push(field);
      await chrome.storage.local.set({ [SITES_KEY]: sites });
      picked.set(box, field.id);
      tell({ type: 'field-picked', id: field.id, label: field.name || field.label });
    }
    saved = profile.fields;
  }

  async function dropField(id) {
    if (!id) return;
    const { sites, profile } = await loadProfile();
    profile.fields = profile.fields.filter((f) => f.id !== id);
    await chrome.storage.local.set({ [SITES_KEY]: sites });
    saved = profile.fields;
    tell({ type: 'field-unpicked', id });
  }

  function pick(box) {
    picked.set(box, null);
    sync();
    queue = queue
      .then(() => saveField(box))
      .catch(() => {
        picked.delete(box);
        note("Market Helper couldn't save that box.");
      })
      .then(sync);
  }

  // A box chosen in this round can be clicked again to take it back.
  function unpick(box) {
    queue = queue
      .then(() => {
        const id = picked.get(box);
        picked.delete(box);
        return dropField(id);
      })
      .catch(() => {})
      .then(sync);
  }

  function stop() {
    window.__marketHelperPicking = false;
    clearInterval(timer);
    cancelAnimationFrame(frame);
    host.remove();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onScroll);
    for (const type of POINTER_EVENTS) document.removeEventListener(type, onPointer, true);
  }

  // A last word on the page, left up long enough to read.
  function farewell(message) {
    const last = document.createElement('div');
    last.dataset.marketHelper = '';
    last.setAttribute('role', 'status');
    last.style.cssText = 'all:initial;z-index:2147483647;direction:ltr;' + BANNER + 'display:block;pointer-events:none;';
    last.textContent = message;
    document.documentElement.append(last);
    setTimeout(() => last.remove(), 8000);
  }

  function finish() {
    if (!window.__marketHelperPicking) return;
    stop();
    const count = picked.size;
    if (count) {
      farewell(
        `✓ ${count} ${count === 1 ? 'box' : 'boxes'} chosen. Now type what goes in each one in the Market Helper panel.`,
      );
    }
  }

  // The panel holds the other end. It lets go when the user does something else
  // there, switches tab or closes it, and choosing ends with it.
  const port = chrome.runtime.connect({ name: 'picker' });
  port.onDisconnect.addListener(finish);

  // Done or Esc on the page. The panel hears of it once the last save is in.
  function done() {
    finish();
    queue.then(() => port.disconnect());
  }

  function under(event) {
    return root.elementFromPoint(event.clientX, event.clientY);
  }

  function onMove(event) {
    const box = boxes.get(under(event)) || null;
    if (box === hovered) return;
    const previous = hovered;
    hovered = box;
    if (previous && overlays.has(previous)) draw(previous);
    if (hovered) draw(hovered);
  }

  // Boxes are only looked for on the timer; scrolling just moves the overlays.
  function onScroll() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    done();
  }

  // Swallow every pointer event so the page doesn't react while choosing.
  function onPointer(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.type !== 'click') return;
    const hit = under(event);
    if (hit === doneButton) return done();
    const box = boxes.get(hit);
    if (!box) return;
    // A double-click's second click must not undo the first.
    if (Date.now() - lastPick < 700) return;
    lastPick = Date.now();
    if (overlays.get(box).state === 'idle') pick(box);
    else if (picked.has(box)) unpick(box);
    else note('Already chosen. To remove it, use the bin in the Market Helper panel.');
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onScroll);
  for (const type of POINTER_EVENTS) document.addEventListener(type, onPointer, true);

  // Wait for the saved fields before drawing, so they never flash purple.
  loadProfile().then(
    ({ profile }) => {
      if (!window.__marketHelperPicking) return;
      saved = profile.fields;
      sync();
      timer = setInterval(sync, 400);
    },
    () => {
      stop();
      port.disconnect();
      farewell('Save this website in the Market Helper panel first.');
    },
  );
})();
