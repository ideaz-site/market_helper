const SITES_KEY = 'sites';
// Earlier builds kept profiles globally, each with its own sites. Migrated on load.
const OLD_PROFILES_KEY = 'profiles';
const OLD_ACTIVE_KEY = 'activeProfile';

const app = document.getElementById('app');
const statusEl = document.getElementById('status');

// host -> { host, addedAt, activeProfile, profiles: { id -> { id, name, fields } } }
let sites = {};
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

  if (migrated) {
    await save();
    await chrome.storage.local.remove([OLD_PROFILES_KEY, OLD_ACTIVE_KEY]);
  }
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

async function runInPage(tabId, func, args) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection.result;
}

async function refreshFound() {
  found = {};
  const site = sites[tabHost];
  if (!site) return;
  const { fields } = activeProfile(site);
  if (!fields.length) return;
  try {
    const results = await runInPage(tab.id, findFields, [fields.map((f) => f.selector)]);
    fields.forEach((field, i) => (found[field.id] = results[i]));
  } catch {
    // Pages like the Chrome Web Store refuse injection; leave the dots neutral.
  }
}

// The current tab when it's on this site, otherwise any open tab that is.
async function tabFor(host) {
  if (host === tabHost) return tab.id;
  const [match] = await chrome.tabs.query({ url: `*://${host}/*` });
  return match ? match.id : null;
}

async function pasteField(tabId, field) {
  const text = field.text || (await navigator.clipboard.readText());
  if (!text) return 'nothing to paste';
  return (await runInPage(tabId, fillField, [field.selector, text])) ? 'pasted' : 'not on this page';
}

async function pasteOne(field) {
  try {
    setStatus(`${field.label}: ${await pasteField(tab.id, field)}`);
  } catch (error) {
    setStatus(`Couldn't paste: ${error.message}`);
  }
}

// Pastes every field of the site's selected profile.
async function pasteSite(site) {
  const profile = activeProfile(site);
  if (!profile.fields.length) return setStatus(`"${profile.name}" has no fields on ${site.host}`);
  try {
    const tabId = await tabFor(site.host);
    if (tabId === null) return setStatus(`Open ${site.host} in a tab first`);
    let pasted = 0;
    for (const field of profile.fields) {
      if ((await pasteField(tabId, field)) === 'pasted') pasted++;
    }
    setStatus(`Pasted ${pasted} of ${profile.fields.length} fields from "${profile.name}" on ${site.host}`);
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
  const id = crypto.randomUUID();
  sites[tabHost] = {
    host: tabHost,
    addedAt: Date.now(),
    activeProfile: id,
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
  return selectProfile(site, id);
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
  return selectProfile(site, Object.keys(site.profiles)[0]);
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
  const select = el('select', { className: 'grow' });
  for (const profile of Object.values(site.profiles)) select.append(el('option', { value: profile.id }, profile.name));
  select.value = site.activeProfile;
  select.addEventListener('change', () => selectProfile(site, select.value));
  return select;
}

const ICONS = {
  paste: '<path d="M9 5H6v15h12V5h-3"/><path d="M9 3.5h6v3H9z"/>',
  remove: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  confirm: '<path d="M5 12l5 5 9-10"/>',
  cancel: '<path d="M6 6l12 12M18 6L6 18"/>',
};

function iconButton(icon, label, props) {
  const button = el('button', { title: label, ariaLabel: label, ...props });
  button.classList.add('icon');
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;
  return button;
}

// A Remove button that asks for a second click before doing anything.
function removeControls(key, onConfirm, icons = false) {
  const ask = () => {
    pendingRemove = key;
    render();
  };
  const cancel = () => {
    pendingRemove = null;
    render();
  };
  if (pendingRemove !== key) {
    return [icons ? iconButton('remove', 'Remove', { onclick: ask }) : el('button', { onclick: ask }, 'Remove')];
  }
  if (icons) {
    return [
      iconButton('cancel', 'Cancel', { onclick: cancel }),
      iconButton('confirm', 'Confirm remove', { className: 'danger', onclick: onConfirm }),
    ];
  }
  return [
    el('button', { onclick: cancel }, 'Cancel'),
    el('button', { className: 'danger', onclick: onConfirm }, 'Confirm remove'),
  ];
}

function renderProfiles(site) {
  const active = activeProfile(site);
  app.append(el('h2', {}, 'Profile'));

  if (profileMode === 'new' || profileMode === 'rename') {
    const renaming = profileMode === 'rename';
    const input = el('input', { className: 'grow', value: renaming ? active.name : '', placeholder: 'Profile name' });
    const submit = () => {
      const name = input.value.trim();
      if (!name) return input.focus();
      const taken = Object.values(site.profiles).some((p) => p.name === name && !(renaming && p === active));
      if (taken) return setStatus(`This site already has a profile called "${name}"`);
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
        el('span', { className: 'grow', title: active.name }, `Delete "${active.name}" and its fields?`),
        el('button', { onclick: () => setProfileMode(null) }, 'Cancel'),
        el('button', { className: 'danger', onclick: () => deleteProfile(site) }, 'Delete'),
      ),
    );
    return;
  }

  app.append(
    el(
      'div',
      { className: 'row' },
      profileSelect(site),
      el('button', { onclick: () => setProfileMode('new') }, 'New'),
      el('button', { onclick: () => setProfileMode('rename') }, 'Rename'),
      el(
        'button',
        { disabled: Object.keys(site.profiles).length < 2, onclick: () => setProfileMode('delete') },
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

  app.append(el('h2', {}, 'All sites'));
  const saved = Object.values(sites).sort((a, b) => a.host.localeCompare(b.host));
  if (!saved.length) app.append(el('p', { className: 'muted' }, 'No sites yet.'));
  for (const site of saved) {
    app.append(
      el(
        'div',
        { className: 'card' },
        el(
          'div',
          { className: 'row' },
          el('strong', { className: 'grow', title: site.host }, site.host),
          el('button', { onclick: () => edit(site.host) }, 'Edit'),
          ...removeControls(`site:${site.host}`, () => removeSite(site.host)),
        ),
        el(
          'div',
          { className: 'row' },
          profileSelect(site),
          el('button', { className: 'primary', onclick: () => pasteSite(site) }, 'Paste'),
        ),
      ),
    );
  }
}

function renderField(profile, field, onPage) {
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
    el(
      'div',
      { className: 'row' },
      dot,
      el('strong', { className: 'grow', title: field.selector }, field.label),
      iconButton('paste', 'Paste', { className: 'primary', disabled: !onPage, onclick: () => pasteOne(field) }),
      ...removeControls(`field:${field.id}`, () => removeField(profile, field), true),
    ),
    text,
  );
}

function renderEditor(site) {
  const onPage = site.host === tabHost;
  const profile = activeProfile(site);

  app.append(
    el('h2', {}, 'Site'),
    el(
      'div',
      { className: 'row' },
      el('strong', { className: 'grow', title: site.host }, site.host),
      el('button', { className: 'link', onclick: () => edit(null) }, 'All sites'),
    ),
  );
  if (!onPage) app.append(el('p', { className: 'muted' }, 'Open this site to pick fields.'));

  renderProfiles(site);

  app.append(el('h2', {}, 'Fields'));
  if (!profile.fields.length) app.append(el('p', { className: 'muted' }, 'No fields yet. Pick one from the page.'));
  for (const field of profile.fields) app.append(renderField(profile, field, onPage));

  app.append(
    el(
      'div',
      { className: 'row' },
      el('button', { disabled: !onPage, onclick: startPicking }, 'Pick a field'),
      el('span', { className: 'grow' }),
      el(
        'button',
        { className: 'primary', disabled: !onPage || !profile.fields.length, onclick: () => pasteSite(site) },
        'Paste all',
      ),
    ),
  );
}

async function edit(host) {
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

function render() {
  app.replaceChildren(el('h1', {}, 'Market Helper'));
  setStatus('');
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
  if (tabHost !== previousHost) {
    // Land on the current site's fields when it's already saved.
    editingHost = sites[tabHost] ? tabHost : null;
    pendingRemove = null;
    profileMode = null;
    if (sites[tabHost] && adoptStickyProfile(sites[tabHost])) await save();
    await refreshFound();
  } else {
    await refreshFound();
    // Same site: don't redraw under someone who is typing.
    if (document.activeElement.matches('input, textarea')) return;
  }
  render();
}

async function onFieldPicked() {
  await loadSites();
  await refreshFound();
  render();
}

async function init() {
  await readTab();
  await loadSites();
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
