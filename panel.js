const SITES_KEY = 'sites';
// Earlier builds kept profiles globally, each with its own sites. Migrated on load.
const OLD_PROFILES_KEY = 'profiles';
const OLD_ACTIVE_KEY = 'activeProfile';

const app = document.getElementById('app');
const statusEl = document.getElementById('status');

// host -> { host, addedAt, collapsed, activeProfile, order: [profile id],
//           profiles: { id -> { id, name, fields } } }
// A field is { id, selector, label, text, source }: source names the catalog
// item detail it pastes (see ITEM_SOURCES); without one it pastes its own text.
let sites = {};
let view = 'sites'; // 'sites' | 'catalog' (catalog.js)
let dragging = null; // { host, id } of the profile row being dragged
let tab = null;
let tabHost = null; // null when the active tab isn't a normal web page
let editingHost = null;
let found = {}; // field id -> whether its element is on the current page
let profileMode = null; // null | 'new' | 'rename' | 'delete'
let pendingRemove = null; // key of the site or field awaiting remove confirmation
// Name of the profile the user last chose. A site that has a profile with the
// same name opens on it; any other site just shows its own profile.
let stickyName = null;

function save() {
  return chrome.storage.local.set({ [SITES_KEY]: sites });
}

function activeProfile(site) {
  return site.profiles[site.activeProfile];
}

async function loadSites() {
  const data = await chrome.storage.local.get([SITES_KEY, OLD_PROFILES_KEY, OLD_ACTIVE_KEY]);
  sites = data[SITES_KEY] || {};
  let migrated = false;

  // First build: fields sat directly on the site.
  for (const site of Object.values(sites)) {
    if (site.profiles) continue;
    const id = crypto.randomUUID();
    site.profiles = { [id]: { id, name: 'Default', fields: site.fields || [] } };
    site.activeProfile = id;
    delete site.fields;
    delete site.name;
    migrated = true;
  }

  // Second build: global profiles. Each becomes a same-named profile on its sites.
  for (const old of Object.values(data[OLD_PROFILES_KEY] || {})) {
    for (const oldSite of Object.values(old.sites || {})) {
      const { host } = oldSite;
      const site = sites[host] || (sites[host] = { host, addedAt: oldSite.addedAt, activeProfile: null, profiles: {} });
      const id = crypto.randomUUID();
      site.profiles[id] = { id, name: old.name, fields: oldSite.fields || [] };
      if (!site.activeProfile || old.id === data[OLD_ACTIVE_KEY]) site.activeProfile = id;
    }
    migrated = true;
  }

  // Storage doesn't keep object key order, so profile order lives in its own list.
  for (const site of Object.values(sites)) {
    const known = (site.order || []).filter((id) => site.profiles[id]);
    const missing = Object.keys(site.profiles).filter((id) => !known.includes(id));
    site.order = [...known, ...missing];
  }

  if (migrated) {
    await save();
    await chrome.storage.local.remove([OLD_PROFILES_KEY, OLD_ACTIVE_KEY]);
  }
}

function profilesOf(site) {
  return site.order.map((id) => site.profiles[id]);
}

// kind 'ok' or 'error' marks an outcome; anything else is a plain hint.
function setStatus(message, kind = '') {
  const mark = { ok: '✓ ', error: '⚠ ' }[kind] || '';
  statusEl.textContent = message && mark + message;
  statusEl.className = kind;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Interface text with **bold** markers, as nodes.
function rich(text) {
  return text.split('**').map((part, i) => (i % 2 ? el('strong', {}, part) : part));
}

function boxes(count) {
  return `${count} ${count === 1 ? 'box' : 'boxes'}`;
}

// Runs in the page, so it can't use anything outside itself. action 'find'
// says which of the boxes are on the page; 'fill' puts text into the first one.
function inPage(action, fields, text) {
  // Same list and labelling as picker.js.
  const TEXT_FIELDS =
    'textarea,input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="url"],' +
    'input[type="tel"],input[type="number"],[contenteditable=""],[contenteditable="true"],' +
    '[contenteditable="plaintext-only"],[role="textbox"]';
  // A label's text without what's typed in the box it wraps.
  const labelText = (el) => {
    if (!el.labels || !el.labels[0]) return '';
    const copy = el.labels[0].cloneNode(true);
    for (const control of copy.querySelectorAll('input, textarea, select, [contenteditable]')) control.remove();
    return copy.textContent;
  };
  const describe = (el) =>
    (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      labelText(el) ||
      el.getAttribute('name') ||
      el.tagName.toLowerCase()
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 60);
  const bySelector = (field) => {
    try {
      return document.querySelector(field.selector);
    } catch {
      return null;
    }
  };
  // The one visible text box carrying the label the box was saved under.
  const byLabel = (field) => {
    const matches = [...document.querySelectorAll(TEXT_FIELDS)].filter((el) => {
      if (el.querySelector(TEXT_FIELDS) || describe(el) !== field.label) return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    return matches.length === 1 ? matches[0] : null;
  };
  // A selector that is only a position in the page ("html > body > div:nth-of-type(3)…")
  // points somewhere else once the site redraws, so the label is trusted first.
  const locate = (field) =>
    field.selector.startsWith('html > ') ? byLabel(field) || bySelector(field) : bySelector(field) || byLabel(field);

  if (action === 'find') return fields.map((field) => locate(field) !== null);

  const target = locate(fields[0]);
  if (!target) return false;
  target.focus();
  // Set the value the way a user edit would, so frameworks that track input
  // state (React etc.) notice the change.
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const proto = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(target, text);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  getSelection().selectAllChildren(target);
  if (!document.execCommand('insertText', false, text)) {
    target.textContent = text;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  return true;
}

// What inPage needs to know about a saved box.
function locator({ selector, label }) {
  return { selector, label };
}

async function runInPage(tabId, func, args) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection.result;
}

async function refreshFound() {
  const next = {};
  const site = sites[tabHost];
  const fields = site ? activeProfile(site).fields : [];
  if (fields.length) {
    try {
      const results = await runInPage(tab.id, inPage, ['find', fields.map(locator)]);
      fields.forEach((field, i) => (next[field.id] = results[i]));
    } catch {
      // Pages like the Chrome Web Store refuse injection; leave the dots neutral.
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(found);
  found = next;
  return changed;
}

// Sites draw their forms after the page loads, and open them in dialogs without
// loading anything, so the page is looked at again while its boxes are on show.
async function watchPage() {
  if (document.hidden || view !== 'sites' || !tabHost || editingHost !== tabHost) return;
  if (!(await refreshFound())) return;
  // Don't redraw under someone who is typing or choosing.
  if (document.activeElement.matches('input, textarea, select')) return;
  render();
}

// The current tab when it's on this site, otherwise any open tab that is.
async function tabFor(host) {
  if (host === tabHost) return tab.id;
  const [match] = await chrome.tabs.query({ url: `*://${host}/*` });
  return match ? match.id : null;
}

// Fills one box and says how it went: 'filled', 'clipboard' (the box has no
// text of its own, so it got the clipboard), 'missing', 'empty' or 'noitem'.
async function pasteField(tabId, field) {
  let text;
  let result = 'filled';
  if (field.source) {
    const item = activeItem();
    if (!item) return 'noitem';
    text = item[field.source];
  } else if (field.text) {
    text = field.text;
  } else {
    text = await navigator.clipboard.readText();
    result = 'clipboard';
  }
  if (!text) return 'empty';
  return (await runInPage(tabId, inPage, ['fill', [locator(field)], text])) ? result : 'missing';
}

async function pasteOne(field) {
  try {
    const result = await pasteField(tab.id, field);
    const messages = {
      filled: `Filled in "${field.label}"`,
      clipboard: `Filled in "${field.label}" with what you last copied`,
      missing: `The "${field.label}" box isn't on this page`,
      empty: field.source
        ? `The chosen item has no ${ITEM_SOURCES[field.source].toLowerCase()} yet`
        : `Nothing to fill in for "${field.label}". Type some text first.`,
      noitem: 'Add an item under My items first',
    };
    setStatus(messages[result], result === 'filled' || result === 'clipboard' ? 'ok' : 'error');
  } catch (error) {
    setStatus(`Couldn't fill in the page: ${error.message}`, 'error');
  }
}

// Fills in every box of one of the site's templates (profiles in the code).
async function pasteProfile(site, profile) {
  const total = profile.fields.length;
  if (!total) return setStatus(`"${profile.name}" has no boxes yet. Open ${site.host} and choose some.`, 'error');
  try {
    const tabId = await tabFor(site.host);
    if (tabId === null) return setStatus(`Open ${site.host} in a tab first, then press Fill in again.`, 'error');
    let filled = 0;
    for (const field of profile.fields) {
      const result = await pasteField(tabId, field);
      if (result === 'filled' || result === 'clipboard') filled++;
    }
    const rest = total - filled;
    setStatus(
      `Filled in ${filled} of ${boxes(total)} on ${site.host}.` +
        (rest ? ` The other ${rest} had nothing to fill in or ${rest === 1 ? "isn't" : "aren't"} on this page.` : ''),
      filled ? 'ok' : 'error',
    );
  } catch (error) {
    setStatus(`Couldn't fill in the page: ${error.message}`, 'error');
  }
}

const PICK_HINT = 'Now click one of the purple boxes on the page. Press Stop or Esc to finish.';
let pickerPort = null; // open while picker.js is choosing a box on a page

// Ends choosing a box on the page; picker.js stops when its port closes.
function stopPicking() {
  if (!pickerPort) return;
  pickerPort.disconnect();
  pickerPort = null;
  if (statusEl.textContent === PICK_HINT) setStatus('');
}

async function startPicking() {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker.js'] });
    setStatus(PICK_HINT);
  } catch (error) {
    setStatus(`Chrome doesn't let Market Helper work on this page. Try an ordinary website. (${error.message})`, 'error');
  }
}

async function addCurrentSite() {
  const id = crypto.randomUUID();
  sites[tabHost] = {
    host: tabHost,
    addedAt: Date.now(),
    activeProfile: id,
    order: [id],
    profiles: { [id]: { id, name: 'Default', fields: [] } },
  };
  await save();
  edit(tabHost);
}

async function removeSite(host) {
  delete sites[host];
  await save();
  edit(editingHost === host ? null : editingHost);
}

async function removeField(profile, field) {
  profile.fields = profile.fields.filter((f) => f !== field);
  await save();
  pendingRemove = null;
  render();
}

async function selectProfile(site, id) {
  setStatus('');
  site.activeProfile = id;
  stickyName = activeProfile(site).name;
  profileMode = null;
  pendingRemove = null;
  await save();
  if (site.host === tabHost) await refreshFound();
  render();
}

// A new profile starts empty: no fields, no text.
function createProfile(site, name) {
  const id = crypto.randomUUID();
  site.profiles[id] = { id, name, fields: [] };
  site.order.push(id);
  return selectProfile(site, id);
}

// Opens a profile for editing from the All sites list.
async function openProfile(site, id) {
  await selectProfile(site, id);
  edit(site.host);
}

async function moveProfile(site, id, targetId, after) {
  const order = site.order.filter((other) => other !== id);
  order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, id);
  site.order = order;
  await save();
  render();
}

async function toggleCollapsed(site) {
  site.collapsed = !site.collapsed;
  await save();
  render();
}

async function renameProfile(site, name) {
  activeProfile(site).name = name;
  stickyName = name;
  profileMode = null;
  await save();
  render();
}

function deleteProfile(site) {
  delete site.profiles[site.activeProfile];
  site.order = site.order.filter((id) => id !== site.activeProfile);
  return selectProfile(site, site.order[0]);
}

function setProfileMode(mode) {
  profileMode = mode;
  render();
}

// Opens the site on the profile the user last chose, when it has one by that name.
function adoptStickyProfile(site) {
  const match = Object.values(site.profiles).find((p) => p.name === stickyName);
  if (!match || match.id === site.activeProfile) return false;
  site.activeProfile = match.id;
  return true;
}

function profileSelect(site) {
  const select = el('select', { className: 'grow', ariaLabel: 'Template' });
  for (const profile of profilesOf(site)) select.append(el('option', { value: profile.id }, profile.name));
  select.value = site.activeProfile;
  select.addEventListener('change', () => selectProfile(site, select.value));
  return select;
}

const ICONS = {
  back: '<path d="M15 6l-6 6 6 6"/>',
  expand: '<path d="M9 6l6 6-6 6"/>',
  collapse: '<path d="M6 9l6 6 6-6"/>',
  remove: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
};

function iconButton(icon, label, props) {
  const button = el('button', { title: label, ariaLabel: label, ...props });
  button.classList.add('icon');
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;
  return button;
}

// A Remove button that asks in words before doing anything. The question takes
// a line of its own, so the row it sits in wraps.
function removeControls(key, onConfirm, { icon = false, label = 'Remove', question = 'Remove this?', yes = 'Yes, remove' } = {}) {
  const ask = () => {
    pendingRemove = key;
    render();
  };
  const cancel = () => {
    pendingRemove = null;
    render();
  };
  if (pendingRemove !== key) {
    return [icon ? iconButton('remove', label, { onclick: ask }) : el('button', { onclick: ask }, label)];
  }
  return [
    el(
      'div',
      { className: 'row confirm' },
      el('span', { className: 'ask' }, question),
      el('button', { onclick: cancel }, 'Keep'),
      el('button', { className: 'danger', onclick: onConfirm }, yes),
    ),
  ];
}

// "Template" is the interface's word for a profile.
function renderProfiles(site) {
  const active = activeProfile(site);
  const several = site.order.length > 1;
  app.append(el('h2', {}, several ? 'Templates for this website' : 'Template'));

  if (profileMode === 'new' || profileMode === 'rename') {
    const renaming = profileMode === 'rename';
    const input = el('input', {
      className: 'grow',
      value: renaming ? active.name : '',
      placeholder: 'Name, for example Bike or Table',
      ariaLabel: 'Template name',
    });
    const submit = () => {
      const name = input.value.trim();
      if (!name) return input.focus();
      const taken = Object.values(site.profiles).some((p) => p.name === name && !(renaming && p === active));
      if (taken) return setStatus(`There's already a template called "${name}" for this website.`, 'error');
      if (renaming) renameProfile(site, name);
      else createProfile(site, name);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') setProfileMode(null);
    });
    app.append(
      el(
        'div',
        { className: 'row' },
        input,
        el('button', { className: 'primary', onclick: submit }, 'Save'),
        el('button', { onclick: () => setProfileMode(null) }, 'Cancel'),
      ),
    );
    queueMicrotask(() => input.focus());
    return;
  }

  if (profileMode === 'delete') {
    app.append(
      el(
        'div',
        { className: 'row confirm' },
        el('span', { className: 'ask' }, `Delete the "${active.name}" template and its ${boxes(active.fields.length)}?`),
        el('button', { onclick: () => setProfileMode(null) }, 'Keep'),
        el('button', { className: 'danger', onclick: () => deleteProfile(site) }, 'Delete'),
      ),
    );
    return;
  }

  if (!several) {
    app.append(
      el(
        'div',
        { className: 'row' },
        el('span', { className: 'grow', title: active.name }, active.name),
        el('button', { className: 'link', onclick: () => setProfileMode('rename') }, 'Rename'),
        el('button', { className: 'link', onclick: () => setProfileMode('new') }, 'Add another'),
      ),
    );
    return;
  }

  app.append(
    el(
      'p',
      { className: 'hint' },
      'A template is one set of boxes and text for this website. Use one for each kind of listing.',
    ),
    el('div', { className: 'row' }, profileSelect(site)),
    el(
      'div',
      { className: 'row equal' },
      el('button', { onclick: () => setProfileMode('new') }, 'New'),
      el('button', { onclick: () => setProfileMode('rename') }, 'Rename'),
      el('button', { onclick: () => setProfileMode('delete') }, 'Delete'),
    ),
  );
}

function howItWorks() {
  return el(
    'div',
    {},
    el(
      'ol',
      { className: 'steps' },
      el('li', {}, ...rich('Go to the website where you post listings, then press **Save this website**.')),
      el('li', {}, ...rich('Press **Choose a box on the page** and click a box on the page, such as Title or Price.')),
      el('li', {}, ...rich("Type what should go in each box. From then on, press **Fill in the page** and it's typed in for you.")),
    ),
    el(
      'p',
      { className: 'hint' },
      ...rich('Optional: under **My items**, save the things you sell, so their title, price and description can fill in boxes on any website.'),
    ),
  );
}

function renderList() {
  app.append(el('h2', {}, 'This website'));
  if (!tabHost) {
    app.append(
      el('p', { className: 'hint' }, 'Market Helper works on ordinary web pages. Go to the website where you post listings.'),
    );
  } else if (sites[tabHost]) {
    app.append(
      el(
        'div',
        { className: 'row' },
        el('span', { className: 'grow', title: tabHost }, `You're on ${tabHost}`),
        el('button', { className: 'primary', onclick: () => edit(tabHost) }, 'Open'),
      ),
    );
  } else {
    app.append(
      el(
        'div',
        { className: 'row' },
        el('span', { className: 'grow', title: tabHost }, tabHost),
        el('button', { className: 'primary', onclick: addCurrentSite }, 'Save this website'),
      ),
    );
  }

  const saved = Object.values(sites).sort((a, b) => a.host.localeCompare(b.host));
  if (!saved.length) {
    app.append(el('h2', {}, 'How it works'), howItWorks());
    return;
  }

  app.append(el('h2', {}, 'All my websites'));
  if (items.length && saved.some((site) => profilesOf(site).some(usesCatalog))) app.append(itemSelect());
  for (const site of saved) {
    const toggle = site.collapsed
      ? iconButton('expand', 'Show templates', { onclick: () => toggleCollapsed(site) })
      : iconButton('collapse', 'Hide templates', { onclick: () => toggleCollapsed(site) });
    const card = el(
      'div',
      { className: 'card' },
      el(
        'div',
        { className: 'row' },
        toggle,
        el('strong', { className: 'grow', title: site.host }, site.host),
        el('button', { onclick: () => edit(site.host) }, 'Open'),
        ...removeControls(`site:${site.host}`, () => removeSite(site.host), {
          icon: true,
          label: `Remove ${site.host}`,
          question: `Remove ${site.host} and its templates?`,
        }),
      ),
    );
    if (!site.collapsed) {
      card.append(...profilesOf(site).map((profile) => renderProfileRow(site, profile)));
      if (site.order.length > 1) card.append(el('p', { className: 'hint' }, 'Drag ⠿ to change the order.'));
    }
    app.append(card);
  }
  app.append(el('details', { className: 'more' }, el('summary', {}, 'How does this work?'), howItWorks()));
}

// One template in the websites list: drag to reorder, click the name to open it.
function renderProfileRow(site, profile) {
  const row = el(
    'div',
    { className: 'row profile', draggable: true },
    el('span', { className: 'grip', title: 'Drag to change the order' }, '⠿'),
    el(
      'button',
      { className: 'link grow', title: `Open ${profile.name}`, onclick: () => openProfile(site, profile.id) },
      profile.name,
    ),
    el('span', { className: 'muted' }, boxes(profile.fields.length)),
    el(
      'button',
      { className: 'primary', title: `Fill in the page using "${profile.name}"`, onclick: () => pasteProfile(site, profile) },
      'Fill in',
    ),
  );

  const isTarget = () => dragging && dragging.host === site.host && dragging.id !== profile.id;
  const dropsAfter = (event) => {
    const box = row.getBoundingClientRect();
    return event.clientY > box.top + box.height / 2;
  };
  const clearMarks = () => row.classList.remove('drop-before', 'drop-after');

  row.addEventListener('dragstart', (event) => {
    dragging = { host: site.host, id: profile.id };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', profile.name);
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    dragging = null;
    row.classList.remove('dragging');
  });
  row.addEventListener('dragover', (event) => {
    if (!isTarget()) return;
    event.preventDefault();
    const after = dropsAfter(event);
    row.classList.toggle('drop-before', !after);
    row.classList.toggle('drop-after', after);
  });
  row.addEventListener('dragleave', clearMarks);
  row.addEventListener('drop', (event) => {
    if (!isTarget()) return;
    event.preventDefault();
    clearMarks();
    moveProfile(site, dragging.id, profile.id, dropsAfter(event));
  });
  return row;
}

function renderField(profile, field, onPage) {
  const dot = el('span', { className: 'dot' });
  const missing = onPage && found[field.id] === false;
  if (onPage && field.id in found) {
    dot.classList.add(missing ? 'missing' : 'found');
    dot.title = missing ? 'Not on this page' : 'On this page';
  }

  const card = el(
    'div',
    { className: 'card' },
    el(
      'div',
      { className: 'row' },
      dot,
      el('strong', { className: 'grow', title: field.label }, field.label),
      el('button', { className: 'primary', disabled: !onPage, onclick: () => pasteOne(field) }, 'Fill in'),
      ...removeControls(`field:${field.id}`, () => removeField(profile, field), {
        icon: true,
        label: 'Remove this box',
        question: 'Remove this box?',
      }),
    ),
  );

  // Choosing a source only means something once there are items to take it from.
  if (items.length || field.source) {
    const source = el('select', {}, el('option', { value: '' }, 'Text I type here'));
    for (const [key, label] of Object.entries(ITEM_SOURCES)) {
      source.append(el('option', { value: key }, `The item's ${label.toLowerCase()}`));
    }
    source.value = field.source || '';
    source.addEventListener('change', async () => {
      field.source = source.value;
      await save();
      render();
    });
    card.append(el('label', { className: 'field' }, el('span', {}, 'Fill this box with'), source));
  }

  if (field.source) {
    const item = activeItem();
    const detail = ITEM_SOURCES[field.source].toLowerCase();
    card.append(
      el(
        'p',
        { className: item && item[field.source] ? 'preview' : 'preview muted' },
        item
          ? item[field.source] || `"${itemName(item)}" has no ${detail} yet. Add one under My items.`
          : 'Add an item under My items first.',
      ),
    );
  } else {
    const text = el('textarea', {
      value: field.text,
      placeholder: 'Type what should go in this box',
      ariaLabel: `Text for ${field.label}`,
    });
    text.addEventListener('input', () => {
      field.text = text.value;
      save();
    });
    card.append(text);
  }

  if (missing) {
    card.append(
      el(
        'p',
        { className: 'warn' },
        "This box isn't on the page right now. Go to the page that has it, or remove it and choose it again if the website changed.",
      ),
    );
  }
  return card;
}

function usesCatalog(profile) {
  return profile.fields.some((field) => field.source);
}

function renderEditor(site) {
  const onPage = site.host === tabHost;
  const profile = activeProfile(site);

  const back = iconButton('back', 'Back to all websites', { className: 'back', onclick: () => edit(null) });
  back.append('All websites');
  app.append(el('div', { className: 'row' }, back), el('h2', { className: 'name', title: site.host }, site.host));
  if (!onPage) {
    app.append(el('p', { className: 'hint' }, ...rich(`Go to **${site.host}** in your browser to choose boxes or fill them in.`)));
  }

  renderProfiles(site);

  app.append(el('h2', {}, 'Boxes to fill in'));
  const pick = el('button', { disabled: !onPage, onclick: startPicking }, 'Choose a box on the page');
  pick.dataset.picks = '';
  if (!profile.fields.length) {
    pick.className = 'primary big';
    app.append(
      el(
        'p',
        { className: 'hint' },
        ...rich('No boxes yet. Press **Choose a box on the page**, then click the box on the page you want filled in, for example the Title box.'),
      ),
      el('div', { className: 'stack' }, pick),
    );
    return;
  }

  if (usesCatalog(profile) && items.length) app.append(itemSelect());
  // The everyday action goes above the boxes, where it's seen without scrolling.
  app.append(
    el(
      'div',
      { className: 'stack fill' },
      el('button', { className: 'primary big', disabled: !onPage, onclick: () => pasteProfile(site, profile) }, 'Fill in the page'),
    ),
  );
  for (const field of profile.fields) app.append(renderField(profile, field, onPage));
  pick.textContent = 'Choose another box on the page';
  app.append(el('div', { className: 'stack' }, pick));
}

async function edit(host) {
  setStatus('');
  editingHost = host;
  pendingRemove = null;
  profileMode = null;
  const site = sites[host];
  if (site && adoptStickyProfile(site)) {
    await save();
    if (host === tabHost) await refreshFound();
  }
  render();
}

function renderTabs() {
  const tabButton = (name, label) =>
    el(
      'button',
      {
        className: view === name ? 'grow primary' : 'grow',
        ariaPressed: String(view === name),
        onclick: () => {
          view = name;
          pendingRemove = null;
          setStatus('');
          render();
        },
      },
      label,
    );
  app.append(el('div', { className: 'row tabs' }, tabButton('sites', 'Websites'), tabButton('catalog', 'My items')));
}

// Chrome adds update_url to the manifest of anything installed from the store.
const FROM_STORE = 'update_url' in chrome.runtime.getManifest();
const VERSION = chrome.runtime.getManifest().version;

// A store install asks the store for a newer version. An unpacked install can
// only reload its own folder, so pull the new files first.
const UPDATE_NOTE_KEY = 'updateNote';
const PULL_HOST = 'site.ideaz.market_helper';

// Loaded unpacked from a git clone: a helper installed by native/install.sh runs
// `git pull` there, then the extension reloads from the folder.
async function pullAndReload() {
  // The store build has no nativeMessaging permission; a plain reload is all it can do.
  if (!chrome.runtime.sendNativeMessage) return chrome.runtime.reload();
  setStatus('Getting the latest files…');
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(PULL_HOST, {});
  } catch (error) {
    return setStatus(
      /not found|forbidden/i.test(error.message)
        ? `The git pull helper isn't set up for this copy. In the extension's folder run: native/install.sh ${chrome.runtime.id}`
        : `Couldn't run git pull: ${error.message}`,
      'error',
    );
  }
  if (!reply.ok) return setStatus(`Couldn't get the latest files, so nothing changed: ${reply.output}`, 'error');
  // Reloading closes the panel, so the result is shown when it next opens.
  const note = /already up to date/i.test(reply.output) ? 'You already have the latest version.' : 'Updated successfully.';
  await chrome.storage.local.set({ [UPDATE_NOTE_KEY]: note });
  chrome.runtime.reload();
}

async function showUpdateNote() {
  const note = (await chrome.storage.local.get(UPDATE_NOTE_KEY))[UPDATE_NOTE_KEY];
  if (!note) return;
  await chrome.storage.local.remove(UPDATE_NOTE_KEY);
  setStatus(note, 'ok');
}

async function updateExtension() {
  if (!FROM_STORE) return pullAndReload();
  setStatus('Checking for updates…');
  try {
    const { status, version } = await chrome.runtime.requestUpdateCheck();
    if (status === 'update_available') {
      setStatus(`Updating to version ${version}…`);
      return chrome.runtime.reload();
    }
    setStatus(
      status === 'throttled'
        ? 'Chrome is limiting update checks. Try again in a few minutes.'
        : `You have the latest version (${VERSION}).`,
    );
  } catch (error) {
    setStatus(`Couldn't check for updates: ${error.message}`, 'error');
  }
}

function renderHeader() {
  return el('div', { className: 'header' }, el('h1', {}, 'Market Helper'));
}

// Version and updates are maintenance, so they sit out of the way at the bottom.
function renderFooter() {
  return el(
    'p',
    { className: 'footer' },
    `Version ${VERSION} · `,
    el(
      'button',
      {
        className: 'link',
        title: FROM_STORE ? 'See if a newer version is available' : 'Get the latest files and reload the extension',
        onclick: updateExtension,
      },
      'Check for updates',
    ),
  );
}

function render() {
  app.replaceChildren(renderHeader());
  renderTabs();
  const site = sites[editingHost];
  if (view === 'catalog') renderCatalog();
  else if (site) renderEditor(site);
  else renderList();
  app.append(renderFooter());
}

async function readTab() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabHost = null;
  try {
    const url = new URL(tab.url);
    if (url.protocol === 'http:' || url.protocol === 'https:') tabHost = url.hostname;
  } catch {
    // No readable URL: leave tabHost null.
  }
}

// The panel outlives the page, so follow the user as they switch tabs or navigate.
async function onTabChange() {
  const previousHost = tabHost;
  await readTab();
  if (tabHost !== previousHost) {
    // Land on the current site's fields when it's already saved.
    editingHost = sites[tabHost] ? tabHost : null;
    pendingRemove = null;
    profileMode = null;
    setStatus('');
    if (sites[tabHost] && adoptStickyProfile(sites[tabHost])) await save();
    await refreshFound();
  } else {
    await refreshFound();
    // Same site: don't redraw under someone who is typing.
    if (document.activeElement.matches('input, textarea')) return;
  }
  render();
}

async function onFieldPicked(label) {
  await loadSites();
  await refreshFound();
  render();
  setStatus(`Saved the "${label}" box. Now say what goes in it below.`, 'ok');
}

async function init() {
  await readTab();
  await loadSites();
  await loadItems();
  await refreshFound();
  editingHost = sites[tabHost] ? tabHost : null;
  render();
  showUpdateNote();
  setInterval(watchPage, 2000);

  chrome.tabs.onActivated.addListener(() => {
    stopPicking();
    onTabChange();
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tab && tabId === tab.id && (change.url || change.status === 'complete')) onTabChange();
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'picker') return;
    pickerPort = port;
    port.onDisconnect.addListener(() => {
      if (pickerPort === port) pickerPort = null;
    });
  });
  // Doing anything else in the panel means the user has moved on from choosing a box.
  document.addEventListener(
    'click',
    (event) => {
      if (!event.target.closest('[data-picks]')) stopPicking();
    },
    true,
  );
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'field-picked') onFieldPicked(message.label);
    if (message && message.type === 'picking-stopped') setStatus('');
  });
}

init();
