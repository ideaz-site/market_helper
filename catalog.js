// Item catalog: the things the user sells. Loaded before panel.js and shares
// its helpers (el, render, setStatus, removeControls). Item details live in
// chrome.storage.local; photos and videos are too big for that and go in IndexedDB.
const ITEMS_KEY = 'items';
const ACTIVE_ITEM_KEY = 'activeItem';
const CONDITIONS = ['New', 'Like new', 'Good', 'Fair', 'For parts'];
// Item details a saved page field can take its text from.
const ITEM_SOURCES = { title: 'Title', price: 'Price', quantity: 'Quantity', condition: 'Condition', description: 'Description' };

// { id, title, price, quantity, condition, description, media: [{ id, kind, name }] }
let items = [];
let editingItemId = null;
let activeItemId = null; // the item that catalog-linked fields paste from
let mediaDb = null;
let draggingMedia = null; // { itemId, id } of the photo or video tile being dragged
const mediaUrls = new Map(); // media id -> object URL for its file

function saveItems() {
  return chrome.storage.local.set({ [ITEMS_KEY]: items });
}

async function loadItems() {
  const stored = await chrome.storage.local.get([ITEMS_KEY, ACTIVE_ITEM_KEY]);
  items = stored[ITEMS_KEY] || [];
  activeItemId = stored[ACTIVE_ITEM_KEY] || null;
}

function itemName(item) {
  return item.title || 'Item with no name';
}

function activeItem() {
  return items.find((item) => item.id === activeItemId) || items[0] || null;
}

// Chooses the item that catalog-linked fields paste from.
function itemSelect() {
  const select = el('select');
  for (const item of items) select.append(el('option', { value: item.id }, itemName(item)));
  select.value = activeItem().id;
  select.addEventListener('change', async () => {
    activeItemId = select.value;
    await chrome.storage.local.set({ [ACTIVE_ITEM_KEY]: activeItemId });
    render();
  });
  return el('label', { className: 'field pick' }, el('span', {}, 'Fill in using this item'), select);
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
    media: [],
  };
}

async function addItem() {
  const item = blankItem();
  items.push(item);
  await saveItems();
  editItem(item.id);
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
    [...CSV_COLUMNS, 'media'],
    ...items.map((item) => [...CSV_COLUMNS.map((key) => item[key]), item.media.map((m) => m.name).join('; ')]),
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
  const rows = parseCsv((await file.text()).replace(/^﻿/, ''));
  const header = (rows.shift() || []).map((name) => name.trim().toLowerCase());
  const columns = CSV_COLUMNS.filter((key) => header.includes(key));
  if (!columns.some((key) => key !== 'id')) {
    return setStatus(
      "That file doesn't look like a Market Helper spreadsheet. It needs columns named title, price, quantity, condition or description.",
      'error',
    );
  }

  let added = 0;
  let updated = 0;
  for (const row of rows) {
    const values = Object.fromEntries(columns.map((key) => [key, (row[header.indexOf(key)] ?? '').trim()]));
    if (!columns.some((key) => key !== 'id' && values[key])) continue;
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
  }
  await saveItems();
  render();
  setStatus(`Loaded the file: ${added} new, ${updated} updated`, 'ok');
}

async function removeItem(item) {
  try {
    for (const media of item.media) await deleteMedia(media.id);
  } catch {
    // The item still goes; an orphaned file only costs disk space.
  }
  items = items.filter((other) => other !== item);
  await saveItems();
  editItem(null);
}

async function addMedia(item, files) {
  let failure = null;
  try {
    for (const file of files) {
      const id = crypto.randomUUID();
      await settled((await mediaStore('readwrite')).put(file, id));
      item.media.push({ id, kind: file.type.startsWith('video/') ? 'video' : 'image', name: file.name });
    }
  } catch (error) {
    failure = error;
  }
  await saveItems();
  render();
  if (failure) setStatus(`Couldn't add that photo or video: ${failure.message}`, 'error');
}

async function removeMedia(item, media) {
  item.media = item.media.filter((other) => other !== media);
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

function editItem(id) {
  setStatus('');
  editingItemId = id;
  pendingRemove = null;
  render();
}

function mediaThumb(media) {
  const node = el(media.kind === 'video' ? 'video' : 'img', { className: 'thumb', title: media.name, draggable: false });
  if (media.kind === 'video') {
    node.muted = true;
    node.preload = 'metadata';
  }
  mediaUrl(media.id).then(
    (url) => (node.src = url),
    () => node.classList.add('missing'),
  );
  return node;
}

// One photo or video in the item editor: labelled by kind, drag to reorder.
function renderMediaTile(item, entry) {
  const video = entry.kind === 'video';
  const frame = el(
    'div',
    { className: 'frame' },
    mediaThumb(entry),
    el('span', { className: `badge ${entry.kind}` }, video ? 'Video' : 'Photo'),
  );
  if (video) frame.append(el('span', { className: 'play' }));
  const first = item.media[0];
  const tile = el(
    'div',
    { className: 'tile', draggable: true, title: `${entry.name}. Drag to change the order.` },
    frame,
    entry === first
      ? el('span', { className: 'hint' }, 'Main')
      : el(
          'button',
          { className: 'link', title: 'Show this one first', onclick: () => moveMedia(item, entry.id, first.id, false) },
          'Make main',
        ),
    el(
      'div',
      { className: 'row' },
      ...removeControls(`media:${entry.id}`, () => removeMedia(item, entry), {
        icon: true,
        label: `Remove this ${video ? 'video' : 'photo'}`,
        question: 'Remove?',
        yes: 'Remove',
      }),
    ),
  );

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

function itemSummary(item) {
  return [item.price && `$${item.price}`, `Quantity ${item.quantity || 0}`, item.condition].filter(Boolean).join(' · ');
}

function renderItemList() {
  app.append(
    el(
      'div',
      { className: 'row' },
      el('h2', { className: 'grow' }, 'My items'),
      el('button', { className: 'primary', onclick: addItem }, 'Add an item'),
    ),
  );
  if (!items.length) {
    app.append(
      el(
        'p',
        { className: 'hint' },
        ...rich("Your items are the things you sell. Press **Add an item** and type its title, price and description. Any website's boxes can then be filled in from the item you choose."),
      ),
    );
  }
  for (const item of items) {
    app.append(
      el(
        'div',
        { className: 'card' },
        el(
          'div',
          { className: 'row' },
          item.media[0]
            ? mediaThumb(item.media[0])
            : el('div', { className: 'thumb letter' }, (item.title.trim()[0] || '?').toUpperCase()),
          el(
            'div',
            { className: 'grow' },
            el('strong', { className: 'line' }, itemName(item)),
            el('span', { className: 'line muted' }, itemSummary(item)),
          ),
          el('button', { onclick: () => editItem(item.id) }, 'Open'),
          ...removeControls(`item:${item.id}`, () => removeItem(item), {
            icon: true,
            label: `Delete ${itemName(item)}`,
            question: `Delete "${itemName(item)}" and its photos?`,
            yes: 'Delete',
          }),
        ),
      ),
    );
  }

  const csvPicker = el('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
  csvPicker.addEventListener('change', () => {
    if (csvPicker.files[0]) {
      importCsv(csvPicker.files[0]).catch((error) => setStatus(`Couldn't load that file: ${error.message}`, 'error'));
    }
  });
  app.append(
    csvPicker,
    el(
      'details',
      { className: 'more' },
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
          { title: 'Save all items as a spreadsheet file (.csv)', disabled: !items.length, onclick: exportCsv },
          'Save to file',
        ),
        el('button', { title: 'Load items from a spreadsheet file (.csv)', onclick: () => csvPicker.click() }, 'Load from file…'),
      ),
    ),
  );
}

// A labelled control that writes straight back to the item as the user types.
function itemField(item, key, label, control) {
  control.value = item[key];
  control.addEventListener('input', () => {
    item[key] = control.value;
    saveItems();
  });
  return el('label', { className: 'field' }, el('span', {}, label), control);
}

function renderItemEditor(item) {
  const condition = el('select');
  for (const name of CONDITIONS) condition.append(el('option', { value: name }, name));

  const picker = el('input', { type: 'file', multiple: true, accept: 'image/*,video/*', hidden: true });
  picker.addEventListener('change', () => addMedia(item, [...picker.files]));

  const media = el('div', { className: 'media' });
  for (const entry of item.media) media.append(renderMediaTile(item, entry));

  const back = iconButton('back', 'Back to all items', { className: 'back', onclick: () => editItem(null) });
  back.append('All items');

  app.append(
    el('div', { className: 'row' }, back),
    el('h2', {}, 'Item details'),
    el(
      'div',
      { className: 'stack' },
      itemField(item, 'title', 'Title', el('input', { placeholder: 'What is it? For example: Oak dining table' })),
      el(
        'div',
        { className: 'columns' },
        itemField(item, 'price', 'Price', el('input', { type: 'number', min: '0', step: '0.01', placeholder: '0.00' })),
        itemField(item, 'quantity', 'Quantity', el('input', { type: 'number', min: '0', step: '1' })),
        itemField(item, 'condition', 'Condition', condition),
      ),
      itemField(
        item,
        'description',
        'Description',
        el('textarea', { className: 'tall', placeholder: 'Describe it: size, age, condition, anything a buyer should know' }),
      ),
    ),
    el('h2', {}, 'Photos and videos'),
  );
  app.append(
    el(
      'p',
      { className: 'hint' },
      item.media.length ? 'The first one is the main photo. Drag one to change the order.' : 'No photos or videos yet.',
    ),
  );
  app.append(
    media,
    picker,
    el('div', { className: 'stack' }, el('button', { onclick: () => picker.click() }, 'Add photos or videos')),
    el(
      'div',
      { className: 'row end' },
      ...removeControls(`item:${item.id}`, () => removeItem(item), {
        label: 'Delete this item',
        question: `Delete "${itemName(item)}" and its photos?`,
        yes: 'Delete',
      }),
    ),
  );
}

function renderCatalog() {
  const item = items.find((other) => other.id === editingItemId);
  if (item) renderItemEditor(item);
  else renderItemList();
}
