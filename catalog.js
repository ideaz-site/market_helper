// Item catalog: the things the user sells. Loaded before panel.js and shares
// its helpers (el, render, setStatus, removeControls). Item details live in
// chrome.storage.local; photos and videos are too big for that and go in IndexedDB.
const ITEMS_KEY = 'items';
const ACTIVE_ITEM_KEY = 'activeItem';
const ITEM_FIELDS_KEY = 'itemFields';
const CONDITIONS = ['New', 'Like new', 'Good', 'Fair', 'For parts'];
// Item details a saved page field can take its text from.
const ITEM_SOURCES = { title: 'Title', price: 'Price', quantity: 'Quantity', condition: 'Condition', description: 'Description' };

// { id, title, price, quantity, condition, description, custom: { detail id -> value },
//   media: [{ id, kind, name }] }
let items = [];
// The user's own details, shared by every item: [{ id, name, type: 'text' | 'number' }]
let itemFields = [];
let editingItemId = null;
let activeItemId = null; // the item that catalog-linked fields paste from
let mediaDb = null;
let draggingMedia = null; // { itemId, id } of the photo or video tile being dragged
let selectedMediaId = null; // the photo or video whose actions are showing
let detailsOpen = false; // whether the list of the user's own details is being changed
let itemReturn = null; // website to offer a way back to, when the user came from its boxes
let listScroll = 0; // where the list was scrolled to when an item was opened
let importUndo = null; // the items as they were before the last spreadsheet load, as JSON
const mediaUrls = new Map(); // media id -> object URL for its file

function saveItems() {
  return chrome.storage.local.set({ [ITEMS_KEY]: items });
}

// For saves made as the user types, where nothing else would notice a failure.
function saveTyping() {
  saveItems().catch(() => setStatus("Couldn't save your changes. Check your disk space and try again.", 'error'));
}

async function loadItems() {
  const stored = await chrome.storage.local.get([ITEMS_KEY, ACTIVE_ITEM_KEY, ITEM_FIELDS_KEY]);
  items = stored[ITEMS_KEY] || [];
  itemFields = stored[ITEM_FIELDS_KEY] || [];
  activeItemId = stored[ACTIVE_ITEM_KEY] || null;
}

// A page box's source is a built-in detail's key, or "custom:" and the id of one
// of the user's own.
const CUSTOM = 'custom:';

function customField(source) {
  return source.startsWith(CUSTOM) ? itemFields.find((field) => field.id === source.slice(CUSTOM.length)) : null;
}

// Every detail a page box can be filled from, as [source, name].
function itemSources() {
  return [
    ...Object.entries(ITEM_SOURCES).map(([key, label]) => [key, label.toLowerCase()]),
    ...itemFields.map((field) => [CUSTOM + field.id, field.name]),
  ];
}

// The name of a source, or null when it's a detail that has since been removed.
function sourceName(source) {
  const match = itemSources().find(([key]) => key === source);
  return match ? match[1] : null;
}

function sourceValue(item, source) {
  const field = customField(source);
  if (field) return (item.custom && item.custom[field.id]) || '';
  return source in ITEM_SOURCES ? item[source] : '';
}

function saveItemFields() {
  return chrome.storage.local.set({ [ITEM_FIELDS_KEY]: itemFields });
}

// Names the built-in details and spreadsheet columns already use.
const RESERVED_NAMES = ['id', 'media', 'title', 'price', 'quantity', 'condition', 'description'];

async function addItemField(name, type) {
  if (!name) return false;
  const taken = [...RESERVED_NAMES, ...itemFields.map((field) => field.name.toLowerCase())];
  if (taken.includes(name.toLowerCase())) {
    setStatus(`There's already a detail called "${name}".`, 'error');
    return false;
  }
  itemFields.push({ id: crypto.randomUUID(), name, type });
  await saveItemFields();
  render();
  return true;
}

// Takes the detail, and what every item has for it, away.
async function removeItemField(field) {
  itemFields = itemFields.filter((other) => other !== field);
  for (const item of items) if (item.custom) delete item.custom[field.id];
  await saveItemFields();
  await saveItems();
  pendingRemove = null;
  render();
}

function itemName(item) {
  return item.title || 'Item with no name';
}

// Whether any template takes something from the chosen item.
function websitesUseItems() {
  return Object.values(sites).some((site) => profilesOf(site).some(usesCatalog));
}

function templatesUsing(source) {
  let count = 0;
  for (const site of Object.values(sites)) {
    for (const profile of profilesOf(site)) {
      if (profile.fields.some((field) => field.source === source)) count++;
    }
  }
  return count;
}

async function useItem(item) {
  activeItemId = item.id;
  fillIssues = {};
  await chrome.storage.local.set({ [ACTIVE_ITEM_KEY]: activeItemId });
  render();
  setStatus(`Websites now use "${itemName(item)}".`, 'ok');
}

function activeItem() {
  return items.find((item) => item.id === activeItemId) || items[0] || null;
}

// Chooses the item that catalog-linked fields paste from.
function itemSelect() {
  const select = el('select', { key: 'item-to-use' });
  for (const item of items) select.append(el('option', { value: item.id }, itemName(item)));
  select.value = activeItem().id;
  select.addEventListener('change', async () => {
    activeItemId = select.value;
    fillIssues = {};
    await chrome.storage.local.set({ [ACTIVE_ITEM_KEY]: activeItemId });
    render();
  });
  return el('label', { className: 'field pick' }, el('span', {}, 'Item to use'), select);
}

function settled(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function mediaStore(mode) {
  if (!mediaDb) {
    const opening = indexedDB.open('market-helper', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('media');
    mediaDb = await settled(opening);
  }
  return mediaDb.transaction('media', mode).objectStore('media');
}

async function mediaUrl(id) {
  if (!mediaUrls.has(id)) {
    const file = await settled((await mediaStore('readonly')).get(id));
    if (!file) throw new Error('Missing media file');
    mediaUrls.set(id, URL.createObjectURL(file));
  }
  return mediaUrls.get(id);
}

async function deleteMedia(id) {
  await settled((await mediaStore('readwrite')).delete(id));
  URL.revokeObjectURL(mediaUrls.get(id));
  mediaUrls.delete(id);
}

// Runs in the page, so it can't use anything outside itself. Files can't be
// handed to a page whole, so they arrive as base64 pieces ('piece'), and 'attach'
// then puts them into the page's own file choosers, as if the user had picked them.
function uploadInPage(step, piece) {
  const store = (window.__marketHelperFiles = window.__marketHelperFiles || []);
  if (step === 'begin') {
    store.length = 0;
    return null;
  }
  if (step === 'piece') {
    const file = (store[piece.index] = store[piece.index] || { name: piece.name, type: piece.type, parts: [] });
    file.parts.push(Uint8Array.from(atob(piece.data), (char) => char.charCodeAt(0)));
    return null;
  }

  const files = store.map((file) => new File(file.parts, file.name, { type: file.type }));
  store.length = 0;
  const accepts = (input, file) => {
    const rules = input.accept.split(',').map((rule) => rule.trim().toLowerCase()).filter(Boolean);
    if (!rules.length) return true;
    return rules.some((rule) =>
      rule.startsWith('.')
        ? file.name.toLowerCase().endsWith(rule)
        : rule.endsWith('/*')
          ? file.type.startsWith(rule.slice(0, -1))
          : file.type === rule,
    );
  };
  // File choosers are usually hidden behind a button, so hidden ones count.
  const inputs = [...document.querySelectorAll('input[type="file"]')].filter((input) => !input.disabled);
  const chosen = new Map(); // file chooser -> files for it
  for (const file of files) {
    const input = inputs.find((candidate) => {
      if (!accepts(candidate, file)) return false;
      return candidate.multiple || !chosen.has(candidate);
    });
    if (input) chosen.set(input, [...(chosen.get(input) || []), file]);
  }
  let added = 0;
  for (const [input, batch] of chosen) {
    const transfer = new DataTransfer();
    for (const file of batch) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    added += batch.length;
  }
  return { added, wanted: files.length };
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Adds an item's photos and videos to the page in the tab. Resolves to
// { added, wanted }: how many the page had a place for, out of how many there are.
async function uploadMedia(tabId, item) {
  const PIECE = 3 * 1024 * 1024; // a multiple of 3, so each piece is whole base64
  await runInPage(tabId, uploadInPage, ['begin']);
  let index = 0;
  for (const media of item.media) {
    const file = await settled((await mediaStore('readonly')).get(media.id));
    if (!file) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    for (let start = 0; start < bytes.length || start === 0; start += PIECE) {
      const data = toBase64(bytes.subarray(start, start + PIECE));
      await runInPage(tabId, uploadInPage, ['piece', { index, name: media.name, type: file.type, data }]);
    }
    index++;
  }
  return runInPage(tabId, uploadInPage, ['attach']);
}

function blankItem() {
  return {
    id: crypto.randomUUID(),
    title: '',
    price: '',
    quantity: '1',
    condition: CONDITIONS[0],
    description: '',
    custom: {},
    media: [],
  };
}

async function addItem() {
  const item = blankItem();
  items.push(item);
  await saveItems();
  focusNext = 'item:title';
  editItem(item.id);
}

function isBlank(item) {
  const typed = [item.title, item.price, item.description, ...Object.values(item.custom || {})];
  return !item.media.length && !typed.some((value) => String(value || '').trim());
}

// Leaving an item that was added and never filled in throws it away, so
// pressing Add and changing your mind doesn't leave an empty row behind.
function leaveItem() {
  const item = items.find((other) => other.id === editingItemId);
  if (!item || !isBlank(item)) return;
  items = items.filter((other) => other !== item);
  editingItemId = null;
  saveItems();
}

// CSV round trip, so items can be edited in a spreadsheet. The id column ties
// a row back to its item, which is how photos and videos survive the trip.
const CSV_COLUMNS = ['id', 'title', 'price', 'quantity', 'condition', 'description'];

function toCsv(rows) {
  const cell = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') cell += text[i++];
      else quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function exportCsv() {
  const rows = [
    [...CSV_COLUMNS, ...itemFields.map((field) => field.name), 'media'],
    ...items.map((item) => [
      ...CSV_COLUMNS.map((key) => item[key]),
      ...itemFields.map((field) => sourceValue(item, CUSTOM + field.id)),
      item.media.map((m) => m.name).join('; '),
    ]),
  ];
  // The BOM makes Excel read the file as UTF-8.
  const url = URL.createObjectURL(new Blob(['﻿' + toCsv(rows)], { type: 'text/csv' }));
  el('a', { href: url, download: 'market-helper-items.csv' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Saved ${items.length} item${items.length === 1 ? '' : 's'} to market-helper-items.csv in your Downloads folder`, 'ok');
}

// Rows whose id matches an item update it; other rows become new items. Items
// missing from the file are left alone, and only columns in the file are touched.
async function importCsv(file) {
  setStatus('Loading the file…', 'busy');
  const before = JSON.stringify(items);
  const rows = parseCsv((await file.text()).replace(/^﻿/, ''));
  const header = (rows.shift() || []).map((name) => name.trim().toLowerCase());
  const columns = CSV_COLUMNS.filter((key) => header.includes(key));
  // The user's own details are columns too, under the names they gave them.
  const extras = itemFields.filter((field) => header.includes(field.name.toLowerCase()));
  if (!columns.some((key) => key !== 'id') && !extras.length) {
    return setStatus(
      "That file doesn't look like a Market Helper spreadsheet. It needs columns named title, price, quantity, condition or description.",
      'error',
    );
  }

  let added = 0;
  let updated = 0;
  for (const row of rows) {
    const values = Object.fromEntries(columns.map((key) => [key, (row[header.indexOf(key)] ?? '').trim()]));
    const custom = Object.fromEntries(
      extras.map((field) => [field.id, (row[header.indexOf(field.name.toLowerCase())] ?? '').trim()]),
    );
    if (!columns.some((key) => key !== 'id' && values[key]) && !Object.values(custom).some(Boolean)) continue;
    if ('condition' in values) {
      const known = CONDITIONS.find((name) => name.toLowerCase() === values.condition.toLowerCase());
      if (known) values.condition = known;
      else delete values.condition;
    }
    let item = values.id && items.find((other) => other.id === values.id);
    delete values.id;
    if (item) {
      updated++;
    } else {
      item = blankItem();
      items.push(item);
      added++;
    }
    Object.assign(item, values);
    item.custom = { ...item.custom, ...custom };
  }
  importUndo = before;
  await saveItems();
  render();
  setStatus(`Loaded the file: ${added} new, ${updated} updated.`, 'ok');
}

// Puts the items back as they were before the last spreadsheet load. Rows a
// load adds carry no photos or videos, so there are no files to clean up.
async function undoImport() {
  items = JSON.parse(importUndo);
  importUndo = null;
  await saveItems();
  render();
  setStatus('Put your items back as they were before that load.', 'ok');
}

async function removeItem(item) {
  const name = itemName(item);
  const wasChosen = item === activeItem();
  try {
    for (const media of item.media) await deleteMedia(media.id);
  } catch {
    // The item still goes; an orphaned file only costs disk space.
  }
  items = items.filter((other) => other !== item);
  await saveItems();
  editItem(null);
  // Websites fall back to the first item left; say so, since it changes what gets filled in.
  const next = activeItem();
  setStatus(
    `Deleted "${name}".` + (wasChosen && next && websitesUseItems() ? ` Websites now use "${itemName(next)}".` : ''),
    'ok',
  );
}

const LARGE_FILE = 200 * 1024 * 1024;

// Adds what it can and says which files it couldn't. button shows the progress.
async function addMedia(item, files, button) {
  const failed = [];
  const large = [];
  button.disabled = true;
  for (const [index, file] of files.entries()) {
    button.textContent = `Adding ${index + 1} of ${files.length}…`;
    try {
      const id = crypto.randomUUID();
      await settled((await mediaStore('readwrite')).put(file, id));
      item.media.push({ id, kind: file.type.startsWith('video/') ? 'video' : 'image', name: file.name });
      if (file.size > LARGE_FILE) large.push(file.name);
    } catch {
      failed.push(file.name);
    }
  }
  await saveItems();
  render();
  const named = (names) => names.map((name) => `"${name}"`).join(', ');
  if (failed.length) setStatus(`Couldn't add ${named(failed)}.`, 'error');
  else if (large.length) setStatus(`${named(large)} ${large.length === 1 ? 'is' : 'are'} very large and may not upload to websites.`);
}

async function removeMedia(item, media) {
  item.media = item.media.filter((other) => other !== media);
  selectedMediaId = null;
  await saveItems();
  try {
    await deleteMedia(media.id);
  } catch {
    // Already unlinked from the item.
  }
  pendingRemove = null;
  render();
}

async function moveMedia(item, id, targetId, after) {
  const moved = item.media.find((entry) => entry.id === id);
  const media = item.media.filter((entry) => entry !== moved);
  media.splice(media.findIndex((entry) => entry.id === targetId) + (after ? 1 : 0), 0, moved);
  item.media = media;
  await saveItems();
  render();
}

// Opens an item, or the list with null. focus names a detail to land on.
function editItem(id, focus = null) {
  setStatus('');
  if (id !== editingItemId) leaveItem();
  if (id) {
    if (!editingItemId) listScroll = scrollY;
    nextScroll = 0;
    importUndo = null;
    if (focus) focusNext = `item:${focus}`;
  } else {
    nextScroll = listScroll;
    itemReturn = null;
  }
  editingItemId = id;
  selectedMediaId = null;
  detailsOpen = false;
  pendingRemove = null;
  render();
}

function letterTile(item) {
  // Spread, so an emoji or accented first letter isn't cut in half.
  return el('div', { className: 'thumb letter' }, ([...item.title.trim()][0] || '?').toUpperCase());
}

// fallback takes the picture's place when its file can't be read.
function mediaThumb(media, fallback = null) {
  const node = el(media.kind === 'video' ? 'video' : 'img', { className: 'thumb', draggable: false });
  if (media.kind === 'video') {
    node.muted = true;
    node.preload = 'metadata';
  } else {
    node.alt = '';
  }
  mediaUrl(media.id).then(
    (url) => (node.src = url),
    () => fallback && node.replaceWith(fallback),
  );
  return node;
}

// One photo or video in the item editor. Pressing it shows what can be done
// with it; it can also be dragged to a new place.
function renderMediaTile(item, entry, onSelect) {
  const index = item.media.indexOf(entry);
  const kind = entry.kind === 'video' ? 'Video' : 'Photo';
  const tile = el(
    'button',
    {
      className: entry.id === selectedMediaId ? 'tile selected' : 'tile',
      key: `tile:${entry.id}`,
      draggable: true,
      ariaPressed: String(entry.id === selectedMediaId),
      ariaLabel: `${kind} ${index + 1} of ${item.media.length}, ${entry.name}`,
      title: entry.name,
      onclick: () => onSelect(entry.id),
    },
    mediaThumb(entry),
    el('span', { className: index ? 'chip' : 'chip main' }, index ? String(index + 1) : 'Main'),
    el('span', { className: 'badge' }, kind),
  );
  tile.dataset.id = entry.id;
  if (entry.kind === 'video') tile.append(el('span', { className: 'play' }));

  const isTarget = () => draggingMedia && draggingMedia.itemId === item.id && draggingMedia.id !== entry.id;
  const dropsAfter = (event) => {
    const box = tile.getBoundingClientRect();
    return event.clientX > box.left + box.width / 2;
  };
  const clearMarks = () => tile.classList.remove('drop-before', 'drop-after');

  tile.addEventListener('dragstart', (event) => {
    draggingMedia = { itemId: item.id, id: entry.id };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', entry.name);
    tile.classList.add('dragging');
  });
  tile.addEventListener('dragend', () => {
    draggingMedia = null;
    tile.classList.remove('dragging');
  });
  tile.addEventListener('dragover', (event) => {
    if (!isTarget()) return;
    event.preventDefault();
    const after = dropsAfter(event);
    tile.classList.toggle('drop-before', !after);
    tile.classList.toggle('drop-after', after);
  });
  tile.addEventListener('dragleave', clearMarks);
  tile.addEventListener('drop', (event) => {
    if (!isTarget()) return;
    event.preventDefault();
    clearMarks();
    moveMedia(item, draggingMedia.id, entry.id, dropsAfter(event));
  });
  return tile;
}

// What can be done with the selected photo or video. Filled in place, because
// redrawing the whole panel would reload every picture and video.
function fillMediaBar(bar, item, confirming = false) {
  const index = item.media.findIndex((entry) => entry.id === selectedMediaId);
  if (index < 0) {
    bar.className = '';
    bar.replaceChildren(
      item.media.length ? el('p', { className: 'hint' }, 'Press a photo or video to move or remove it.') : '',
    );
    return;
  }
  const entry = item.media[index];
  const kind = entry.kind === 'video' ? 'video' : 'photo';
  const move = (target, after, key) => {
    focusNext = key;
    moveMedia(item, entry.id, target.id, after);
  };
  bar.className = 'panelbox';
  const title = el('strong', {}, `${kind === 'video' ? 'Video' : 'Photo'} ${index + 1} of ${item.media.length}`);
  if (confirming) {
    const keep = el('button', { onclick: () => fillMediaBar(bar, item) }, 'Keep');
    bar.replaceChildren(
      title,
      el(
        'div',
        { className: 'row confirm' },
        el('span', { className: 'ask' }, `Remove this ${kind}?`),
        keep,
        el('button', { className: 'danger', onclick: () => removeMedia(item, entry) }, 'Yes, remove'),
      ),
    );
    keep.focus();
    return;
  }
  const actions = [];
  if (index) {
    actions.push(
      el('button', { key: 'media:main', onclick: () => move(item.media[0], false, `tile:${entry.id}`) }, 'Make this the main one'),
    );
  }
  actions.push(
    el('button', { key: 'media:earlier', disabled: !index, onclick: () => move(item.media[index - 1], false, 'media:earlier') }, 'Move earlier'),
    el(
      'button',
      { key: 'media:later', disabled: index === item.media.length - 1, onclick: () => move(item.media[index + 1], true, 'media:later') },
      'Move later',
    ),
    el('button', { className: 'warn', onclick: () => fillMediaBar(bar, item, true) }, `Remove this ${kind}`),
  );
  bar.replaceChildren(title, ...actions);
}

function itemSummary(item) {
  const price = String(item.price || '').trim().replace(/^\$/, '');
  const quantity = String(item.quantity || '').trim();
  return [price && `$${price}`, item.condition, quantity && quantity !== '1' && `Quantity ${quantity}`]
    .filter(Boolean)
    .join(' · ');
}

function renderItemList() {
  if (!items.length) {
    app.append(
      el('h2', {}, 'The things you sell'),
      el(
        'p',
        { className: 'hint' },
        "Add an item and type its title, price and description. Any website's boxes can then be filled in from the item you choose.",
      ),
      el('div', { className: 'stack' }, el('button', { className: 'primary big', key: 'add-item', onclick: addItem }, 'Add your first item')),
    );
  } else {
    const add = el('button', { className: 'dashed', key: 'add-item', onclick: addItem }, '+ Add an item');
    const top = el('div', { className: 'stack' }, add);
    top.style.marginTop = '12px';
    app.append(top);

    // Only worth pointing out when it's a real choice that websites act on.
    const chosen = items.length > 1 && websitesUseItems() ? activeItem() : null;
    const list = el('div', { className: 'items' });
    for (const item of items) {
      const summary = el('span', { className: 'meta' }, el('span', {}, itemSummary(item)));
      if (item === chosen) summary.append(el('span', { className: 'pill' }, 'In use on websites'));
      list.append(
        el(
          'div',
          { className: item === chosen ? 'item chosen' : 'item' },
          el(
            'button',
            {
              className: 'open',
              key: `item:${item.id}`,
              ariaLabel: `Open ${itemName(item)}${item === chosen ? ', in use on websites' : ''}`,
              onclick: () => editItem(item.id),
            },
            item.media[0] ? mediaThumb(item.media[0], letterTile(item)) : letterTile(item),
            el('span', { className: 'grow' }, el('span', { className: 'title' }, itemName(item)), summary),
            icon('expand'),
          ),
        ),
      );
    }
    app.append(list);
  }

  const csvPicker = el('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
  csvPicker.addEventListener('change', () => {
    const [file] = csvPicker.files;
    // Cleared so that choosing the same file again still counts as a change.
    csvPicker.value = '';
    if (file) importCsv(file).catch((error) => setStatus(`Couldn't load that file: ${error.message}`, 'error'));
  });
  const tools = el(
    'details',
    { className: 'more', open: Boolean(importUndo) },
    el('summary', {}, 'Spreadsheet (advanced)'),
    el(
      'p',
      { className: 'hint' },
      'Save all items to a file you can open in Excel or Google Sheets, or load a file back in.',
    ),
    el(
      'div',
      { className: 'row equal' },
      el(
        'button',
        { key: 'csv-save', title: 'Save all items as a spreadsheet file (.csv)', disabled: !items.length, onclick: exportCsv },
        'Save to file',
      ),
      el('button', { key: 'csv-load', title: 'Load items from a spreadsheet file (.csv)', onclick: () => csvPicker.click() }, 'Load from file…'),
    ),
  );
  if (importUndo) {
    const undo = el('div', { className: 'stack' }, el('button', { key: 'csv-undo', onclick: undoImport }, 'Undo that load'));
    undo.style.marginTop = '8px';
    tools.append(undo);
  }
  app.append(csvPicker, tools);
}

// A labelled control that writes straight back to the item as the user types.
function itemField(item, key, label, control) {
  control.value = item[key];
  control.dataset.focus = `item:${key}`;
  control.addEventListener('input', () => {
    item[key] = control.value;
    saveTyping();
  });
  return el('label', { className: 'field' }, el('span', {}, label), control);
}

// The list of the user's own details, which every item shares. Changing it is
// kept apart from typing an item's values, because removing one reaches every item.
function renderDetailList() {
  const box = el(
    'div',
    { className: 'panelbox' },
    el('p', { className: 'hint' }, 'Details you add here appear on every item, and boxes on a page can be filled in from them.'),
  );
  for (const field of itemFields) {
    const filled = items.filter((item) => item.custom && item.custom[field.id]).length;
    const used = templatesUsing(CUSTOM + field.id);
    const losses = [
      filled && `${filled} ${filled === 1 ? 'item has' : 'items have'} something written for it`,
      used && `${used} ${used === 1 ? 'template uses' : 'templates use'} it`,
    ].filter(Boolean);
    box.append(
      el(
        'div',
        { className: 'row' },
        el(
          'span',
          { className: 'grow' },
          el('strong', { className: 'line' }, field.name),
          el(
            'span',
            { className: 'line meta' },
            `${field.type === 'number' ? 'Number' : 'Text'} · ${filled ? `filled in on ${filled} ${filled === 1 ? 'item' : 'items'}` : 'not filled in yet'}`,
          ),
        ),
        ...removeControls(`detail:${field.id}`, () => removeItemField(field), {
          label: 'Remove',
          question: `Remove "${field.name}" from all ${items.length} items?`,
          detail: losses.length ? `${losses.join(', and ')}. That will be erased.` : '',
        }),
      ),
    );
  }

  const name = el('input', { key: 'detail:name', placeholder: 'For example: Brand, Size, Colour' });
  const type = el('select', { key: 'detail:type' }, el('option', { value: 'text' }, 'Text'), el('option', { value: 'number' }, 'Number'));
  const add = async () => {
    const added = name.value.trim();
    focusNext = 'detail:name';
    if (await addItemField(added, type.value)) setStatus(`Added "${added}" to every item.`, 'ok');
    else name.focus();
  };
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') add();
  });
  box.append(
    el('label', { className: 'field' }, el('span', {}, 'Name of a new detail'), name),
    el('label', { className: 'field' }, el('span', {}, 'What it holds'), type),
    el(
      'div',
      { className: 'row equal' },
      el('button', { key: 'detail:add', onclick: add }, 'Add detail'),
      el(
        'button',
        {
          key: 'detail:done',
          onclick: () => {
            detailsOpen = false;
            pendingRemove = null;
            focusNext = 'detail:change';
            render();
          },
        },
        'Done',
      ),
    ),
  );
  return box;
}

function renderItemEditor(item) {
  const condition = el('select');
  for (const name of CONDITIONS) condition.append(el('option', { value: name }, name));

  const back = iconButton('back', 'Back to all items', { className: 'back', key: 'back', onclick: () => editItem(null) });
  back.append('All items');
  const top = el('div', { className: 'row wrap' });
  if (itemReturn && sites[itemReturn]) {
    const host = itemReturn;
    const home = iconButton('back', `Back to ${host}`, {
      className: 'back',
      key: 'back-site',
      onclick: () => {
        leaveItem();
        view = 'sites';
        itemReturn = null;
        editingItemId = null;
        nextScroll = 0;
        render();
      },
    });
    home.append(`Back to ${host}`);
    top.append(home);
  }
  top.append(back);

  // The heading follows the title as it's typed.
  const heading = el('h2', { className: 'name' }, item.title || 'New item');
  const title = itemField(item, 'title', 'Title', el('input', { placeholder: 'What is it? For example: Oak dining table' }));
  title.lastChild.addEventListener('input', () => (heading.textContent = item.title || 'New item'));

  app.append(top, heading, el('p', { className: 'hint' }, 'Changes save by themselves.'));

  // Which item websites fill in from only needs saying when there's a choice.
  if (items.length > 1) {
    app.append(
      item === activeItem()
        ? el('p', {}, el('span', { className: 'pill' }, 'In use on websites'))
        : el('div', { className: 'stack' }, el('button', { key: 'use-item', onclick: () => useItem(item) }, 'Use this item on websites')),
    );
  }

  // Plain text inputs: a number input throws away anything it doesn't like,
  // so "$380" would save as nothing.
  const form = el(
    'div',
    { className: 'stack' },
    title,
    el(
      'div',
      { className: 'columns' },
      itemField(item, 'price', 'Price', el('input', { inputMode: 'decimal', placeholder: '0.00' })),
      itemField(item, 'quantity', 'Quantity', el('input', { inputMode: 'numeric' })),
      itemField(item, 'condition', 'Condition', condition),
    ),
    itemField(
      item,
      'description',
      'Description',
      el('textarea', { className: 'tall', placeholder: 'Describe it: size, age, condition, anything a buyer should know' }),
    ),
  );
  form.style.marginTop = '12px';
  for (const field of itemFields) {
    const control = el('input', field.type === 'number' ? { inputMode: 'decimal' } : {});
    control.value = sourceValue(item, CUSTOM + field.id);
    control.dataset.focus = `item:${CUSTOM}${field.id}`;
    control.addEventListener('input', () => {
      item.custom = { ...item.custom, [field.id]: control.value };
      saveTyping();
    });
    form.append(el('label', { className: 'field' }, el('span', {}, field.name), control));
  }
  form.append(
    detailsOpen
      ? renderDetailList()
      : el(
          'button',
          {
            className: 'dashed',
            key: 'detail:change',
            onclick: () => {
              detailsOpen = true;
              focusNext = 'detail:name';
              render();
            },
          },
          itemFields.length ? 'Change the list of details' : '+ Add your own details, such as Brand or Size',
        ),
  );
  app.append(form);

  const count = item.media.length;
  app.append(el('h2', {}, count ? `Photos and videos (${count})` : 'Photos and videos'));
  if (!count) app.append(el('p', { className: 'hint' }, 'No photos or videos yet.'));

  const grid = el('div', { className: 'media' });
  const bar = el('div');
  const select = (id) => {
    selectedMediaId = selectedMediaId === id ? null : id;
    for (const tile of grid.children) {
      const on = tile.dataset.id === selectedMediaId;
      tile.classList.toggle('selected', on);
      tile.ariaPressed = String(on);
    }
    fillMediaBar(bar, item);
  };
  for (const entry of item.media) grid.append(renderMediaTile(item, entry, select));
  fillMediaBar(bar, item);

  const picker = el('input', { type: 'file', multiple: true, accept: 'image/*,video/*', hidden: true });
  const adder = el('button', { key: 'add-media', onclick: () => picker.click() }, 'Add photos or videos');
  picker.addEventListener('change', () => addMedia(item, [...picker.files], adder));

  const parts = [`"${itemName(item)}"`];
  if (count) parts.push(`its ${photos(count)}`);
  const stack = el('div', { className: 'stack' }, adder);
  stack.style.marginTop = '8px';
  app.append(
    grid,
    bar,
    picker,
    stack,
    el(
      'div',
      { className: 'row end' },
      ...removeControls(`item:${item.id}`, () => removeItem(item), {
        label: 'Delete this item',
        className: 'warn',
        question: `Delete ${parts.join(' and ')}?`,
        detail: "This can't be undone.",
        yes: 'Delete item',
      }),
    ),
  );
}

function renderCatalog() {
  const item = items.find((other) => other.id === editingItemId);
  if (item) renderItemEditor(item);
  else renderItemList();
}
