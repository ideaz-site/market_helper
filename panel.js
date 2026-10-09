const PROFILES_KEY = 'profiles';
const ACTIVE_KEY = 'activeProfile';
const LEGACY_SITES_KEY = 'sites'; // pre-profile storage, migrated on first load

const app = document.getElementById('app');
const statusEl = document.getElementById('status');

let profiles = {}; // id -> { id, name, sites }
let activeId = null;
let sites = {}; // the active profile's sites: host -> { host, addedAt, fields }
let tab = null;
let tabHost = null; // null when the active tab isn't a normal web page
let editingHost = null;
let found = {}; // field id -> whether its element is on the current page
let profileMode = null; // null | 'new' | 'rename' | 'delete'
let pendingRemove = null; // key of the site or field awaiting remove confirmation

function save() {
  return chrome.storage.local.set({ [PROFILES_KEY]: profiles, [ACTIVE_KEY]: activeId });
}

async function loadProfiles() {
  const data = await chrome.storage.local.get([PROFILES_KEY, ACTIVE_KEY, LEGACY_SITES_KEY]);
  profiles = data[PROFILES_KEY] || {};
  activeId = data[ACTIVE_KEY];
  if (!Object.keys(profiles).length) {
    const id = crypto.randomUUID();
    profiles[id] = { id, name: 'Default', sites: data[LEGACY_SITES_KEY] || {} };
    activeId = id;
    await save();
    await chrome.storage.local.remove(LEGACY_SITES_KEY);
  }
  if (!profiles[activeId]) activeId = Object.keys(profiles)[0];
  sites = profiles[activeId].sites;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Runs in the page. Sets the value the way a user edit would, so frameworks
// that track input state (React etc.) notice the change.
function fillField(selector, text) {
  const target = document.querySelector(selector);
  if (!target) return false;
  target.focus();
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

// Runs in the page.
function findFields(selectors) {
  return selectors.map((selector) => {
    try {
      return document.querySelector(selector) !== null;
    } catch {
      return false;
    }
  });
}

async function runInPage(func, args) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return injection.result;
}

async function refreshFound() {
  found = {};
  const site = sites[tabHost];
  if (!site || !site.fields.length) return;
  try {
    const results = await runInPage(findFields, [site.fields.map((f) => f.selector)]);
    site.fields.forEach((field, i) => (found[field.id] = results[i]));
  } catch {
    // Pages like the Chrome Web Store refuse injection; leave the dots neutral.
  }
}

async function pasteField(field) {
  const text = field.text || (await navigator.clipboard.readText());
  if (!text) return 'nothing to paste';
  return (await runInPage(fillField, [field.selector, text])) ? 'pasted' : 'not on this page';
}

async function pasteOne(field) {
  try {
    setStatus(`${field.label}: ${await pasteField(field)}`);
  } catch (error) {
    setStatus(`Couldn't paste: ${error.message}`);
  }
}

async function pasteAll(site) {
  let pasted = 0;
  try {
    for (const field of site.fields) {
      if ((await pasteField(field)) === 'pasted') pasted++;
    }
    setStatus(`Pasted ${pasted} of ${site.fields.length} fields`);
  } catch (error) {
    setStatus(`Couldn't paste: ${error.message}`);
  }
}

async function startPicking() {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker.js'] });
    setStatus('Click a highlighted field on the page. Esc cancels.');
  } catch (error) {
    setStatus(`Can't pick on this page: ${error.message}`);
  }
}

async function addCurrentSite() {
  sites[tabHost] = { host: tabHost, addedAt: Date.now(), fields: [] };
  await save();
  edit(tabHost);
}

async function removeSite(host) {
  delete sites[host];
  await save();
  edit(editingHost === host ? null : editingHost);
}

async function removeField(site, field) {
  site.fields = site.fields.filter((f) => f !== field);
  await save();
  pendingRemove = null;
  render();
}

async function switchProfile(id) {
  activeId = id;
  sites = profiles[id].sites;
  profileMode = null;
  await save();
  await refreshFound();
  edit(sites[tabHost] ? tabHost : null);
}

// A new profile starts as a copy of the current one, so its sites and fields
// carry over and only the text needs changing.
async function createProfile(name) {
  const id = crypto.randomUUID();
  const from = profiles[activeId].name;
  profiles[id] = { id, name, sites: structuredClone(sites) };
  await switchProfile(id);
  setStatus(`Created "${name}" as a copy of "${from}"`);
}

async function renameProfile(name) {
  profiles[activeId].name = name;
  profileMode = null;
  await save();
  render();
}

async function deleteProfile() {
  delete profiles[activeId];
  await switchProfile(Object.keys(profiles)[0]);
}

function setProfileMode(mode) {
  profileMode = mode;
  render();
}

// A Remove button that asks for a second click before doing anything.
function removeControls(key, onConfirm) {
  if (pendingRemove !== key) {
    return [
      el(
        'button',
        {
          onclick: () => {
            pendingRemove = key;
            render();
          },
        },
        'Remove',
      ),
    ];
  }
  return [
    el(
      'button',
      {
        onclick: () => {
          pendingRemove = null;
          render();
        },
      },
      'Cancel',
    ),
    el('button', { className: 'danger', onclick: onConfirm }, 'Confirm remove'),
  ];
}

function renderProfiles() {
  const active = profiles[activeId];
  app.append(el('h2', {}, 'Profile'));

  if (profileMode === 'new' || profileMode === 'rename') {
    const renaming = profileMode === 'rename';
    const input = el('input', { className: 'grow', value: renaming ? active.name : '', placeholder: 'Profile name' });
    const submit = () => {
      const name = input.value.trim();
      if (!name) return input.focus();
      if (renaming) renameProfile(name);
      else createProfile(name);
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
        el('button', { className: 'primary', onclick: submit }, renaming ? 'Save' : 'Create'),
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
        { className: 'row' },
        el('span', { className: 'grow', title: active.name }, `Delete "${active.name}" and all its sites?`),
        el('button', { onclick: () => setProfileMode(null) }, 'Cancel'),
        el('button', { className: 'danger', onclick: deleteProfile }, 'Delete'),
      ),
    );
    return;
  }

  const select = el('select', { className: 'grow' });
  for (const profile of Object.values(profiles)) select.append(el('option', { value: profile.id }, profile.name));
  select.value = activeId;
  select.addEventListener('change', () => switchProfile(select.value));
  app.append(
    el(
      'div',
      { className: 'row' },
      select,
      el('button', { onclick: () => setProfileMode('new') }, 'New'),
      el('button', { onclick: () => setProfileMode('rename') }, 'Rename'),
      el(
        'button',
        { disabled: Object.keys(profiles).length < 2, onclick: () => setProfileMode('delete') },
        'Delete',
      ),
    ),
  );
}

function renderList() {
  app.append(el('h2', {}, 'This page'));
  if (!tabHost) {
    app.append(el('p', { className: 'muted' }, "This page can't be saved."));
  } else if (sites[tabHost]) {
    app.append(
      el(
        'div',
        { className: 'row' },
        el('span', { className: 'grow' }, `${tabHost} is saved`),
        el('button', { className: 'primary', onclick: () => edit(tabHost) }, 'Edit'),
      ),
    );
  } else {
    app.append(
      el(
        'div',
        { className: 'row' },
        el('span', { className: 'grow' }, tabHost),
        el('button', { className: 'primary', onclick: addCurrentSite }, 'Add this site'),
      ),
    );
  }

  app.append(el('h2', {}, 'Saved sites'));
  const saved = Object.values(sites).sort((a, b) => a.host.localeCompare(b.host));
  if (!saved.length) app.append(el('p', { className: 'muted' }, 'No sites yet.'));
  for (const site of saved) {
    const count = `${site.fields.length} field${site.fields.length === 1 ? '' : 's'}`;
    app.append(
      el(
        'div',
        { className: 'row site' },
        el('span', { className: 'grow', title: site.host }, site.host),
        el('span', { className: 'muted' }, count),
        el('button', { onclick: () => edit(site.host) }, 'Edit'),
        ...removeControls(`site:${site.host}`, () => removeSite(site.host)),
      ),
    );
  }
}

function renderField(site, field, onPage) {
  const dot = el('span', { className: 'dot' });
  if (onPage && field.id in found) {
    dot.classList.add(found[field.id] ? 'found' : 'missing');
    dot.title = found[field.id] ? 'Found on this page' : 'Not found on this page';
  }

  const text = el('textarea', { value: field.text, placeholder: 'Text to paste (leave empty to paste your clipboard)' });
  text.addEventListener('input', () => {
    field.text = text.value;
    save();
  });

  return el(
    'div',
    { className: 'card' },
    el('div', { className: 'row' }, dot, el('strong', { className: 'grow', title: field.selector }, field.label)),
    text,
    el(
      'div',
      { className: 'row' },
      el('button', { className: 'primary', disabled: !onPage, onclick: () => pasteOne(field) }, 'Paste'),
      el('span', { className: 'grow' }),
      ...removeControls(`field:${field.id}`, () => removeField(site, field)),
    ),
  );
}

function renderEditor(site) {
  const onPage = site.host === tabHost;

  app.append(
    el('h2', {}, 'Site'),
    el(
      'div',
      { className: 'row' },
      el('strong', { className: 'grow', title: site.host }, site.host),
      el('button', { className: 'link', onclick: () => edit(null) }, 'All sites'),
    ),
  );
  if (!onPage) app.append(el('p', { className: 'muted' }, 'Open this site to pick or paste.'));

  app.append(el('h2', {}, 'Fields'));
  if (!site.fields.length) app.append(el('p', { className: 'muted' }, 'No fields yet. Pick one from the page.'));
  for (const field of site.fields) app.append(renderField(site, field, onPage));

  app.append(
    el(
      'div',
      { className: 'row' },
      el('button', { disabled: !onPage, onclick: startPicking }, 'Pick a field'),
      el('span', { className: 'grow' }),
      el(
        'button',
        { className: 'primary', disabled: !onPage || !site.fields.length, onclick: () => pasteAll(site) },
        'Paste all',
      ),
    ),
  );
}

function edit(host) {
  editingHost = host;
  pendingRemove = null;
  render();
}

function render() {
  app.replaceChildren(el('h1', {}, 'Market Helper'));
  setStatus('');
  renderProfiles();
  const site = sites[editingHost];
  if (site) renderEditor(site);
  else renderList();
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
  await refreshFound();
  if (tabHost !== previousHost) {
    // Land on the current site's fields when it's already saved.
    editingHost = sites[tabHost] ? tabHost : null;
    pendingRemove = null;
  } else if (document.activeElement.matches('input, textarea')) {
    // Same site: don't redraw under someone who is typing.
    return;
  }
  render();
}

async function onFieldPicked() {
  await loadProfiles();
  await refreshFound();
  render();
}

async function init() {
  await readTab();
  await loadProfiles();
  await refreshFound();
  editingHost = sites[tabHost] ? tabHost : null;
  render();

  chrome.tabs.onActivated.addListener(onTabChange);
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tab && tabId === tab.id && (change.url || change.status === 'complete')) onTabChange();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'field-picked') onFieldPicked();
  });
}

init();
