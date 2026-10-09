const SITES_KEY = 'sites';

const app = document.getElementById('app');
const statusEl = document.getElementById('status');

let sites = {};
let tab = null;
let tabHost = null; // null when the active tab isn't a normal web page
let editingHost = null;
let found = {}; // field id -> whether its element is on the current page

function saveSites() {
  return chrome.storage.local.set({ [SITES_KEY]: sites });
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
    window.close();
  } catch (error) {
    setStatus(`Can't pick on this page: ${error.message}`);
  }
}

async function addCurrentSite() {
  sites[tabHost] = { host: tabHost, name: tabHost, addedAt: Date.now(), fields: [] };
  await saveSites();
  editingHost = tabHost;
  render();
}

async function removeSite(host) {
  delete sites[host];
  await saveSites();
  if (editingHost === host) editingHost = null;
  render();
}

function renderList() {
  app.append(el('h1', {}, 'Market Helper'));

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
  const saved = Object.values(sites).sort((a, b) => a.name.localeCompare(b.name));
  if (!saved.length) app.append(el('p', { className: 'muted' }, 'No sites yet.'));
  for (const site of saved) {
    const count = `${site.fields.length} field${site.fields.length === 1 ? '' : 's'}`;
    app.append(
      el(
        'div',
        { className: 'row site' },
        el('span', { className: 'grow', title: site.host }, site.name),
        el('span', { className: 'muted' }, count),
        el('button', { onclick: () => edit(site.host) }, 'Edit'),
        el('button', { onclick: () => removeSite(site.host) }, 'Remove'),
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

  const label = el('input', { className: 'grow', value: field.label, title: field.selector });
  label.addEventListener('input', () => {
    field.label = label.value;
    saveSites();
  });

  const text = el('textarea', { value: field.text, placeholder: 'Text to paste (leave empty to paste your clipboard)' });
  text.addEventListener('input', () => {
    field.text = text.value;
    saveSites();
  });

  const remove = async () => {
    site.fields = site.fields.filter((f) => f !== field);
    await saveSites();
    render();
  };

  return el(
    'div',
    { className: 'card' },
    el('div', { className: 'row' }, dot, label),
    text,
    el(
      'div',
      { className: 'row' },
      el('button', { className: 'primary', disabled: !onPage, onclick: () => pasteOne(field) }, 'Paste'),
      el('span', { className: 'grow' }),
      el('button', { onclick: remove }, 'Remove'),
    ),
  );
}

function renderEditor(site) {
  const onPage = site.host === tabHost;

  const name = el('input', { value: site.name });
  name.addEventListener('input', () => {
    site.name = name.value;
    saveSites();
  });

  app.append(
    el('button', { className: 'link', onclick: () => edit(null) }, '← All sites'),
    el('h2', {}, 'Site name'),
    name,
    el('p', { className: 'muted' }, onPage ? site.host : `${site.host} — open this site to pick or paste`),
    el('h2', {}, 'Fields'),
  );

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
  render();
}

function render() {
  app.replaceChildren();
  setStatus('');
  const site = sites[editingHost];
  if (site) renderEditor(site);
  else renderList();
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab.url);
    if (url.protocol === 'http:' || url.protocol === 'https:') tabHost = url.hostname;
  } catch {
    // No readable URL: leave tabHost null.
  }
  sites = (await chrome.storage.local.get(SITES_KEY))[SITES_KEY] || {};
  await refreshFound();
  // Land on the current site's fields when it's already saved.
  editingHost = sites[tabHost] ? tabHost : null;
  render();
}

init();
