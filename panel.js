const SITES_KEY = 'sites';
// Earlier builds kept profiles globally, each with its own sites. Migrated on load.
const OLD_PROFILES_KEY = 'profiles';
const OLD_ACTIVE_KEY = 'activeProfile';

const app = document.getElementById('app');
const statusEl = document.getElementById('status');

// host -> { host, addedAt, collapsed, activeProfile, order: [profile id],
//           profiles: { id -> { id, name, fields, media } } }
// media: filling in the page also adds the chosen item's photos and videos.
// A field is { id, selector, label, name, text, source }. label is what the page
// calls the box and is how it's found again, so it never changes; name is the
// user's own name for it, when they gave one. source names the catalog item
// detail it pastes (see itemSources in catalog.js); without one it pastes its own text.
let sites = {};
let view = 'sites'; // 'sites' | 'catalog' (catalog.js)
let dragging = null; // { host, id } of the profile row being dragged
let tab = null;
let tabHost = null; // null when the active tab isn't a normal web page
let editingHost = null;
let found = {}; // field id -> whether its element is on the current page
let profileMode = null; // null | 'menu' | 'new' | 'rename' | 'delete'
let pendingRemove = null; // key of the site or field awaiting remove confirmation
let openField = null; // id of the box whose settings are showing
let renamingField = null; // id of the box being renamed
let fillIssues = {}; // field id -> why the last fill left it out
let fillingKey = null; // website + template id while a fill is running
let newFields = []; // ids of the boxes chosen in the last round of choosing
let offsiteTab = null; // an open tab on the website being edited, when the current tab isn't on it
let focusNext = null; // data-focus key to put focus on after the next render
let nextScroll = null; // where the next render scrolls to; null keeps the place
let statusText = '';
let statusKind = '';
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

// kind 'ok' or 'error' marks an outcome and 'busy' something under way;
// anything else is a plain hint.
function setStatus(message, kind = '') {
  statusText = message;
  statusKind = kind;
  drawStatus();
}

// The bar carries its own way to put it away, or to end choosing boxes.
function drawStatus() {
  statusEl.className = statusKind;
  statusEl.hidden = !statusText;
  if (!statusText) return statusEl.replaceChildren();
  const mark = { ok: '✓ ', error: '⚠ ' }[statusKind] || '';
  const parts = [el('span', { className: 'message' }, mark + statusText)];
  if (pickerPort) {
    const done = el('button', { className: 'primary', onclick: () => finishPicking(true) }, 'Done choosing');
    done.dataset.picks = '';
    parts.push(done);
  } else if (statusKind !== 'busy') {
    parts.push(el('button', { onclick: () => setStatus('') }, 'OK'));
  }
  statusEl.replaceChildren(...parts);
}

// key names the node so render() can give it back the focus it had.
function el(tag, props = {}, ...children) {
  const { key, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (key) node.dataset.focus = key;
  node.append(...children);
  return node;
}

// Interface text with **bold** markers, as nodes.
function rich(text) {
  return text.split('**').map((part, i) => (i % 2 ? el('strong', {}, part) : part));
}

function photos(count) {
  return `${count} ${count === 1 ? 'photo or video' : 'photos and videos'}`;
}

// What the panel calls a box: the user's name for it, or the page's.
function boxName(field) {
  return field.name || field.label;
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
    const text = copy.textContent.trim();
    // Multi-line boxes that grow as you type keep a hidden copy of their text
    // beside them, inside the label.
    const typed = el instanceof HTMLTextAreaElement ? el.value.trim() : '';
    return typed && text.endsWith(typed) ? text.slice(0, -typed.length) : text;
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
async function tabOn(host) {
  if (host === tabHost) return tab;
  const matches = await chrome.tabs.query({ url: `*://${host}/*` });
  // With several tabs on the website, the one in view is the one meant.
  return matches.find((match) => match.active) || matches[0] || null;
}

async function tabFor(host) {
  const match = await tabOn(host);
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
    text = sourceValue(item, field.source);
  } else if (field.text) {
    text = field.text;
  } else {
    text = await navigator.clipboard.readText();
    result = 'clipboard';
  }
  if (!text) return 'empty';
  return (await runInPage(tabId, inPage, ['fill', [locator(field)], text])) ? result : 'missing';
}

const FILL_ISSUES = {
  missing: "Wasn't on the page",
  empty: 'Had nothing to fill in',
  noitem: 'No items yet',
};

async function pasteOne(field) {
  const name = boxName(field);
  let outcome;
  try {
    const result = await pasteField(tab.id, field);
    const messages = {
      filled: `Filled in "${name}"`,
      clipboard: `Filled in "${name}" with what you last copied`,
      missing: `The "${name}" box isn't on this page`,
      empty: field.source
        ? `The chosen item has no ${sourceName(field.source) || 'value for that'} yet`
        : `Nothing to fill in for "${name}". Type some text first.`,
      noitem: 'Add an item under My items first',
    };
    const ok = result === 'filled' || result === 'clipboard';
    if (ok) delete fillIssues[field.id];
    else fillIssues[field.id] = result;
    outcome = [messages[result], ok ? 'ok' : 'error'];
  } catch (error) {
    outcome = [`Couldn't fill in the page: ${error.message}`, 'error'];
  }
  render();
  setStatus(...outcome);
}

// Fills in every box of one of the site's templates (profiles in the code).
async function pasteProfile(site, profile) {
  if (fillingKey) return;
  const total = profile.fields.length;
  const item = profile.media ? activeItem() : null;
  const wanted = item ? item.media.length : 0;
  if (!total && !wanted) {
    return setStatus(`"${profile.name}" has no boxes yet. Open ${site.host} and choose some.`, 'error');
  }
  fillingKey = site.host + profile.id;
  fillIssues = {};
  render();
  let outcome;
  try {
    const tabId = await tabFor(site.host);
    if (tabId === null) {
      outcome = [`Open ${site.host} in a tab first, then press Fill in again.`, 'error'];
    } else {
      let filled = 0;
      for (const field of profile.fields) {
        const result = await pasteField(tabId, field);
        if (result === 'filled' || result === 'clipboard') filled++;
        else fillIssues[field.id] = result;
      }
      const rest = total - filled;
      let message =
        `Filled in ${filled} of ${boxes(total)} on ${site.host}.` +
        (rest ? ` ${rest} ${rest === 1 ? 'needs' : 'need'} a look.` : '');
      let added = 0;
      if (wanted) {
        setStatus(`Adding ${photos(wanted)}…`, 'busy');
        ({ added } = await uploadMedia(tabId, item));
        message += added ? ` Added ${photos(added)}.` : '';
        if (added < wanted) {
          message += added
            ? ` The page had no place for the other ${wanted - added}.`
            : " Couldn't find where to add photos on this page. Open the part of the page where photos go, then try again.";
        }
      }
      outcome = [message, filled || added ? 'ok' : 'error'];
    }
  } catch (error) {
    outcome = [`Couldn't fill in the page: ${error.message}`, 'error'];
  }
  fillingKey = null;
  render();
  setStatus(...outcome);
}

// A button that fills in a template, and shows while it is doing so.
function fillButton(site, profile, label, props = {}) {
  const busy = fillingKey === site.host + profile.id;
  return el(
    'button',
    {
      className: 'primary',
      key: `fill:${site.host}:${profile.id}`,
      ariaDisabled: String(busy),
      onclick: () => pasteProfile(site, profile),
      ...props,
    },
    busy ? 'Filling…' : label,
  );
}

const PICK_HINT = "Click each purple box you want filled in on the page. Press Done when you've finished.";
let pickerPort = null; // open while picker.js is choosing boxes on a page
let pickedIds = []; // ids of the boxes chosen so far in this round

// The user ending choosing from the panel; picker.js stops when its port closes.
// A click on something else in the panel ends it too, and then the panel is
// left as it is, so the thing clicked is still there to take the click.
function finishPicking(redraw) {
  if (!pickerPort) return;
  pickerPort.disconnect();
  pickerPort = null;
  donePicking(redraw);
}

// Every way choosing ends comes through here, so there is always a last word.
function donePicking(redraw) {
  const count = pickedIds.length;
  if (count) newFields = pickedIds;
  pickedIds = [];
  if (redraw) {
    if (count) {
      openField = newFields[0];
      focusNext = `text:${openField}`;
    }
    render();
  }
  setStatus(count ? `${boxes(count)} chosen. Now type what goes in each one.` : '', count ? 'ok' : '');
}

async function startPicking() {
  try {
    pickedIds = [];
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker.js'] });
    setStatus(PICK_HINT);
  } catch (error) {
    setStatus(`Chrome doesn't let Market Helper work on this page. Try an ordinary website. (${error.message})`, 'error');
  }
}

// Brings the website being edited to the front, or opens it.
async function goToSite(host) {
  const match = await tabOn(host);
  if (!match) return chrome.tabs.create({ url: `https://${host}/` });
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

async function refreshOffsite() {
  offsiteTab = editingHost && editingHost !== tabHost ? await tabOn(editingHost) : null;
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
  openField = null;
  render();
}

async function renameField(field, name) {
  if (name && name !== field.label) field.name = name;
  else delete field.name;
  renamingField = null;
  await save();
  render();
}

async function selectProfile(site, id) {
  setStatus('');
  site.activeProfile = id;
  stickyName = activeProfile(site).name;
  profileMode = null;
  pendingRemove = null;
  openField = null;
  renamingField = null;
  fillIssues = {};
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
  if (mode === 'delete') focusNext = 'keep:template';
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
  grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3"/>',
};

function icon(name) {
  const holder = document.createElement('template');
  holder.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return holder.content.firstChild;
}

function iconButton(name, label, props) {
  const button = el('button', { title: label, ariaLabel: label, ...props }, icon(name));
  button.classList.add('icon');
  return button;
}

// A Remove button that asks in words before doing anything. The question takes
// a line of its own, so the row it sits in wraps, and focus goes to Keep.
function removeControls(
  key,
  onConfirm,
  { icon: asIcon = false, label = 'Remove', question = 'Remove this?', detail = '', yes = 'Yes, remove', className = '' } = {},
) {
  const ask = () => {
    pendingRemove = key;
    focusNext = `keep:${key}`;
    render();
  };
  const cancel = () => {
    pendingRemove = null;
    focusNext = `remove:${key}`;
    render();
  };
  if (pendingRemove !== key) {
    const props = { key: `remove:${key}`, className, onclick: ask };
    return [asIcon ? iconButton('remove', label, props) : el('button', props, label)];
  }
  const parts = [el('span', { className: 'ask' }, question)];
  if (detail) parts.push(el('span', { className: 'detail' }, detail));
  return [
    el(
      'div',
      { className: 'row confirm' },
      ...parts,
      el('button', { key: `keep:${key}`, onclick: cancel }, 'Keep'),
      el('button', { className: 'danger', onclick: onConfirm }, yes),
    ),
  ];
}

// "Template" is the interface's word for a profile.
// "Template" is the interface's word for a profile.
function renderProfiles(site) {
  const active = activeProfile(site);
  const several = site.order.length > 1;
  app.append(el('h2', {}, 'Template'));

  if (profileMode === 'new' || profileMode === 'rename') {
    const renaming = profileMode === 'rename';
    const back = () => setProfileMode(several ? 'menu' : null);
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
      if (event.key === 'Escape') back();
    });
    app.append(
      el(
        'div',
        { className: 'row' },
        input,
        el('button', { className: 'primary', onclick: submit }, 'Save'),
        el('button', { onclick: back }, 'Cancel'),
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
        el('button', { key: 'keep:template', onclick: () => setProfileMode('menu') }, 'Keep'),
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
        el('span', { className: 'grow line', title: active.name }, active.name),
        el('button', { className: 'link', key: 'template:rename', onclick: () => setProfileMode('rename') }, 'Rename'),
        el('button', { className: 'link', key: 'template:new', onclick: () => setProfileMode('new') }, 'Add another'),
      ),
    );
    return;
  }

  const menu = profileMode === 'menu';
  app.append(
    el(
      'div',
      { className: 'row' },
      profileSelect(site),
      el(
        'button',
        { key: 'template:options', ariaExpanded: String(menu), onclick: () => setProfileMode(menu ? null : 'menu') },
        'Options',
      ),
    ),
  );
  if (!menu) return;
  app.append(
    el(
      'div',
      { className: 'panelbox' },
      el('p', { className: 'hint' }, 'A template is one set of boxes and text for this website. Use one for each kind of listing.'),
      el(
        'div',
        { className: 'row equal' },
        el('button', { onclick: () => setProfileMode('new') }, 'New'),
        el('button', { onclick: () => setProfileMode('rename') }, 'Rename'),
        el('button', { onclick: () => setProfileMode('delete') }, 'Delete'),
      ),
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
  const current = sites[tabHost];
  if (!current) {
    app.append(el('h2', {}, 'This website'));
    if (!tabHost) {
      app.append(
        el('p', { className: 'hint' }, 'Market Helper works on ordinary web pages. Go to the website where you post listings.'),
      );
    } else {
      app.append(
        el(
          'div',
          { className: 'here' },
          el('strong', { className: 'host' }, tabHost),
          el('span', { className: 'hint' }, 'Not saved yet'),
          el('button', { className: 'primary big', key: 'save-site', onclick: addCurrentSite }, 'Save this website'),
        ),
      );
    }
  }

  // The website the browser is on comes first.
  const saved = Object.values(sites).sort((a, b) => (b === current) - (a === current) || a.host.localeCompare(b.host));
  if (!saved.length) {
    app.append(el('h2', {}, 'How it works'), howItWorks());
    return;
  }

  app.append(el('h2', {}, 'All my websites'));
  if (items.length && saved.some((site) => profilesOf(site).some(usesCatalog))) app.append(itemSelect());
  for (const site of saved) app.append(renderSiteCard(site, site === current));
  if (saved.some((site) => site.order.length > 1)) {
    app.append(el('p', { className: 'hint' }, 'Tip: drag the dots to change the order.'));
  }
  app.append(el('details', { className: 'more' }, el('summary', {}, 'How does this work?'), howItWorks()));
}

// One saved website and its templates. The one the browser is on stays open.
function renderSiteCard(site, here) {
  const open = here || !site.collapsed;
  const count = site.order.length;
  const head = here
    ? el(
        'div',
        { className: 'grow' },
        el('strong', { className: 'host' }, site.host),
        el('span', { className: 'pill' }, "You're on this website"),
      )
    : el(
        'button',
        {
          className: 'toggle grow',
          key: `toggle:${site.host}`,
          ariaExpanded: String(open),
          title: open ? 'Hide templates' : 'Show templates',
          onclick: () => toggleCollapsed(site),
        },
        icon(open ? 'collapse' : 'expand'),
        el('strong', {}, site.host),
      );
  const card = el(
    'div',
    { className: 'card' },
    el(
      'div',
      { className: 'row' },
      head,
      el('button', { key: `open:${site.host}`, onclick: () => edit(site.host) }, 'Open'),
      ...removeControls(`site:${site.host}`, () => removeSite(site.host), {
        icon: true,
        label: `Remove ${site.host}`,
        question: `Remove ${site.host} and its ${count === 1 ? 'template' : `${count} templates`}?`,
      }),
    ),
  );
  if (open) card.append(...profilesOf(site).map((profile) => renderProfileRow(site, profile)));
  return card;
}

// One template in the websites list: drag or use the arrow keys to reorder,
// press the name to open it.
function renderProfileRow(site, profile) {
  const key = `${site.host}:${profile.id}`;
  const count = profile.fields.length;
  const row = el('div', { className: 'row profile', draggable: true });

  if (site.order.length > 1) {
    const grip = el(
      'button',
      {
        className: 'grip',
        key: `grip:${key}`,
        title: 'Drag to change the order',
        ariaLabel: `Move ${profile.name}. Press the up or down arrow key to change the order.`,
      },
      icon('grip'),
    );
    grip.addEventListener('keydown', async (event) => {
      const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];
      const other = step && site.order[site.order.indexOf(profile.id) + step];
      if (!other) return;
      event.preventDefault();
      await moveProfile(site, profile.id, other, step > 0);
      setStatus(`Moved "${profile.name}" ${step > 0 ? 'down' : 'up'}.`, 'ok');
    });
    row.append(grip);
  }

  row.append(
    el(
      'button',
      { className: 'tname grow', key: `name:${key}`, title: `Open ${profile.name}`, onclick: () => openProfile(site, profile.id) },
      el('span', { className: 'line title' }, profile.name),
      el('span', { className: 'line meta' }, count ? boxes(count) : 'No boxes yet'),
    ),
    // With nothing to fill in, the useful next step is choosing boxes.
    count || profile.media
      ? fillButton(site, profile, 'Fill in', { title: `Fill in the page using "${profile.name}"` })
      : el('button', { key: `fill:${key}`, onclick: () => openProfile(site, profile.id) }, 'Choose boxes'),
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

// What a box's one-line summary says, and whether it needs the user's attention.
function boxSummary(field, missing) {
  if (fillIssues[field.id]) return { text: FILL_ISSUES[fillIssues[field.id]], alert: true };
  if (field.source) {
    const detail = sourceName(field.source);
    const item = activeItem();
    if (!detail) return { text: 'Needs a new choice', alert: true };
    if (!item) return { text: 'No items yet', alert: true };
    const value = sourceValue(item, field.source);
    if (!value) return { text: `No ${detail} for this item yet`, alert: true };
    return { text: missing ? 'Not on this page' : value };
  }
  if (missing) return { text: 'Not on this page' };
  return { text: field.text ? field.text.replace(/\s+/g, ' ') : 'Empty: will use what you last copied' };
}

// One box of a template: a line that opens to show its settings.
function renderField(site, profile, field, onPage) {
  const open = openField === field.id;
  const missing = onPage && found[field.id] === false;
  const summary = boxSummary(field, missing);
  const name = boxName(field);

  const dot = el('span', { className: 'dot' });
  let state = '';
  if (summary.alert) {
    dot.classList.add('alert');
    dot.textContent = '!';
    state = 'Needs a look';
  } else if (onPage && found[field.id]) {
    dot.classList.add('found');
    state = 'On this page';
  } else if (missing) {
    state = 'Not on this page';
  }
  const sub = el('span', { className: summary.alert ? 'sub warn-text' : 'sub' }, summary.text);
  const box = el(
    'div',
    { className: newFields.includes(field.id) ? 'box new' : 'box' },
    el(
      'button',
      {
        className: 'box-head',
        key: `box:${field.id}`,
        ariaExpanded: String(open),
        onclick: () => {
          openField = open ? null : field.id;
          renamingField = null;
          pendingRemove = null;
          render();
        },
      },
      dot,
      el('span', { className: 'grow' }, el('span', { className: 'title' }, name), sub, el('span', { className: 'sr' }, state)),
      icon(open ? 'collapse' : 'expand'),
    ),
  );
  if (!open) return box;

  const body = el('div', { className: 'box-body' });
  box.append(body);

  if (renamingField === field.id) {
    const input = el('input', { className: 'grow', value: name, maxLength: 40, ariaLabel: 'Name for this box' });
    const submit = () => renameField(field, input.value.trim());
    const cancel = () => {
      renamingField = null;
      render();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') cancel();
    });
    body.append(
      el(
        'div',
        { className: 'row' },
        input,
        el('button', { className: 'primary', onclick: submit }, 'Save'),
        el('button', { onclick: cancel }, 'Cancel'),
      ),
    );
    queueMicrotask(() => input.select());
  }

  // Choosing a source only means something once there are items to take it from.
  if (items.length || field.source) {
    const source = el('select', { key: `source:${field.id}` }, el('option', { value: '' }, 'Text I type here'));
    for (const [key, detail] of itemSources()) source.append(el('option', { value: key }, `The item's ${detail}`));
    if (field.source && !sourceName(field.source)) {
      source.append(el('option', { value: field.source, disabled: true }, 'A detail that was removed'));
    }
    source.value = field.source || '';
    source.addEventListener('change', async () => {
      field.source = source.value;
      delete fillIssues[field.id];
      await save();
      render();
    });
    body.append(el('label', { className: 'field' }, el('span', {}, 'Fill this box with'), source));
  }

  if (field.source) {
    const item = activeItem();
    const detail = sourceName(field.source);
    const value = item && detail ? sourceValue(item, field.source) : '';
    // With nothing to show, say why and offer the way to put it right.
    let note = ['That detail was removed. Choose something else above.'];
    if (!item) {
      note = ['You have no items yet. ', el('button', { className: 'link', onclick: () => openItems(addItem) }, 'Add an item')];
    } else if (detail) {
      note = [
        `"${itemName(item)}" has no ${detail} yet. `,
        el(
          'button',
          { className: 'link', onclick: () => openItems(() => editItem(item.id, field.source), site.host) },
          `Add it to "${itemName(item)}"`,
        ),
      ];
    }
    body.append(el('p', { className: value ? 'preview' : 'preview muted' }, ...(value ? [value] : note)));
  } else {
    const text = el('textarea', {
      key: `text:${field.id}`,
      value: field.text,
      placeholder: 'Type what should go in this box',
      ariaLabel: `Text for ${name}`,
    });
    text.addEventListener('input', () => {
      field.text = text.value;
      delete fillIssues[field.id];
      save();
      // Keep the one-line summary above in step without redrawing under the typist.
      const now = boxSummary(field, missing);
      sub.textContent = now.text;
      sub.className = now.alert ? 'sub warn-text' : 'sub';
    });
    body.append(text);
  }

  if (missing) {
    body.append(
      el(
        'p',
        { className: 'hint' },
        "This box isn't on the page right now. That's normal if the website shows it on a later step. If the website has changed, remove the box and choose it again.",
      ),
    );
  }

  body.append(
    el(
      'button',
      { key: `one:${field.id}`, disabled: !onPage, onclick: () => pasteOne(field) },
      'Fill in just this box',
    ),
    el(
      'div',
      { className: 'row equal' },
      el(
        'button',
        {
          key: `rename:${field.id}`,
          onclick: () => {
            renamingField = field.id;
            render();
          },
        },
        'Rename',
      ),
      ...removeControls(`field:${field.id}`, () => removeField(profile, field), {
        label: 'Remove this box',
        question: `Remove the "${name}" box?`,
      }),
    ),
  );
  return box;
}

// Switches to My items and carries on there.
// Switches to My items and carries on there. from is the website to offer a
// way back to.
function openItems(then, from = null) {
  view = 'catalog';
  pendingRemove = null;
  itemReturn = from;
  then();
}

// Whether filling in from this template takes anything from the chosen item.
function usesCatalog(profile) {
  return Boolean(profile.media) || profile.fields.some((field) => field.source);
}

async function setMedia(profile, on) {
  profile.media = on;
  await save();
  render();
}

function renderEditor(site) {
  const onPage = site.host === tabHost;
  const profile = activeProfile(site);
  const count = profile.fields.length;

  const back = iconButton('back', 'Back to all websites', { className: 'back', key: 'back', onclick: () => edit(null) });
  back.append('All websites');
  app.append(el('div', { className: 'row' }, back), el('h2', { className: 'name' }, site.host));
  if (!onPage) {
    app.append(
      el(
        'div',
        { className: 'notice' },
        el('p', {}, ...rich(`You're not on **${site.host}**, so its boxes can't be chosen or filled in from here.`)),
        el(
          'button',
          { className: 'primary', key: 'goto', onclick: () => goToSite(site.host) },
          offsiteTab ? `Go to ${site.host}` : `Open ${site.host}`,
        ),
      ),
    );
  }

  renderProfiles(site);

  const pick = el('button', { key: 'pick', disabled: !onPage, onclick: startPicking }, 'Choose a box on the page');
  pick.dataset.picks = '';
  if (!count) {
    pick.className = 'primary big';
    app.append(
      el('h2', {}, 'Boxes to fill in'),
      el(
        'p',
        { className: 'hint' },
        ...rich('No boxes yet. Press **Choose a box on the page**, then click each box on the page you want filled in, for example the Title box.'),
      ),
      el('div', { className: 'stack' }, pick),
    );
    return;
  }

  // Everything the everyday press needs, together and first.
  const card = el('div', { className: 'fillcard' });
  if (items.length) {
    const item = activeItem();
    const box = el('input', { type: 'checkbox', key: 'media', checked: Boolean(profile.media) });
    box.addEventListener('change', () => setMedia(profile, box.checked));
    card.append(
      itemSelect(),
      el(
        'label',
        { className: 'check' },
        box,
        el(
          'span',
          {},
          'Also add its photos and videos',
          el('span', { className: 'meta' }, item.media.length ? photos(item.media.length) : 'This item has none yet'),
        ),
      ),
    );
  } else {
    card.append(el('p', { className: 'hint' }, 'Add things you sell under My items to fill boxes from them.'));
  }
  card.append(fillButton(site, profile, 'Fill in the page', { className: 'primary big', disabled: !onPage }));
  app.append(card);

  app.append(el('h2', {}, `Boxes to fill in (${count})`));
  const list = el('div', { className: 'boxes' });
  for (const field of profile.fields) list.append(renderField(site, profile, field, onPage));
  pick.className = 'dashed';
  pick.textContent = '+ Choose another box on the page';
  const more = el('div', { className: 'stack' }, pick);
  more.style.marginTop = '10px';
  app.append(list, more);
}

async function edit(host) {
  setStatus('');
  editingHost = host;
  pendingRemove = null;
  profileMode = null;
  openField = null;
  renamingField = null;
  fillIssues = {};
  newFields = [];
  nextScroll = 0;
  const site = sites[host];
  if (site && adoptStickyProfile(site)) {
    await save();
    if (host === tabHost) await refreshFound();
  }
  await refreshOffsite();
  render();
}

function renderTabs() {
  const tabButton = (name, label) =>
    el(
      'button',
      {
        key: `tab:${name}`,
        ariaPressed: String(view === name),
        onclick: () => {
          if (view === name) return;
          leaveItem();
          view = name;
          pendingRemove = null;
          itemReturn = null;
          nextScroll = 0;
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
  setStatus('Getting the latest files…', 'busy');
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
  setStatus('Checking for updates…', 'busy');
  try {
    const { status, version } = await chrome.runtime.requestUpdateCheck();
    if (status === 'update_available') {
      setStatus(`Updating to version ${version}…`, 'busy');
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
    `Version ${VERSION}`,
    el(
      'button',
      {
        className: 'link',
        key: 'update',
        title: FROM_STORE ? 'See if a newer version is available' : 'Get the latest files and reload the extension',
        onclick: updateExtension,
      },
      'Check for updates',
    ),
  );
}

// Rebuilds the panel. The new nodes take over the focus and scroll position of
// the ones they replace, unless the caller asked for somewhere else.
function render() {
  const held = document.activeElement && document.activeElement.dataset.focus;
  const key = focusNext || held;
  const top = nextScroll ?? scrollY;
  const moved = Boolean(focusNext);
  focusNext = null;
  nextScroll = null;

  app.replaceChildren(renderHeader());
  renderTabs();
  const site = sites[editingHost];
  if (view === 'catalog') renderCatalog();
  else if (site) renderEditor(site);
  else renderList();
  app.append(renderFooter());
  drawStatus();

  scrollTo(0, top);
  const target = key && app.querySelector(`[data-focus="${CSS.escape(key)}"]`);
  if (target) target.focus({ preventScroll: !moved });
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
    openField = null;
    renamingField = null;
    fillIssues = {};
    newFields = [];
    nextScroll = 0;
    if (sites[tabHost] && adoptStickyProfile(sites[tabHost])) await save();
    await refreshFound();
  } else {
    await refreshFound();
    await refreshOffsite();
    // Same site: don't redraw under someone who is typing.
    if (document.activeElement.matches('input, textarea')) return;
  }
  await refreshOffsite();
  render();
}

// picker.js saved a box. They are handled one at a time, in the order chosen.
let pickChain = Promise.resolve();

function onFieldPicked({ id, label }) {
  pickChain = pickChain.then(async () => {
    // A save that lands after choosing ended still belongs to that round.
    (pickerPort ? pickedIds : newFields).push(id);
    await loadSites();
    await refreshFound();
    openField = id;
    render();
    if (pickerPort) setStatus(`Saved the "${label}" box. Click another box, or press Done.`, 'ok');
  });
}

// A box chosen in this round was clicked again on the page, which takes it back.
function onFieldUnpicked({ id }) {
  pickChain = pickChain.then(async () => {
    pickedIds = pickedIds.filter((other) => other !== id);
    await loadSites();
    await refreshFound();
    if (openField === id) openField = null;
    render();
    if (pickerPort) setStatus('Took that box back out.', 'ok');
  });
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
    finishPicking(false);
    onTabChange();
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tab && tabId === tab.id && (change.url || change.status === 'complete')) onTabChange();
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'picker') return;
    pickerPort = port;
    drawStatus();
    // The page ended it: Done or Esc there, or the page went away.
    port.onDisconnect.addListener(() => {
      if (pickerPort !== port) return;
      pickerPort = null;
      pickChain.then(() => donePicking(true));
    });
  });
  // Doing anything else in the panel means the user has moved on from choosing boxes.
  document.addEventListener(
    'click',
    (event) => {
      if (!event.target.closest('[data-picks]')) finishPicking(false);
    },
    true,
  );
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (pickerPort) return finishPicking(true);
    if (!pendingRemove) return;
    focusNext = `remove:${pendingRemove}`;
    pendingRemove = null;
    render();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'field-picked') onFieldPicked(message);
    if (message && message.type === 'field-unpicked') onFieldUnpicked(message);
  });
}

init();
