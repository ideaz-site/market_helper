// Item catalog: the things the user sells. Loaded before panel.js and shares
// its helpers (el, render, setStatus, removeControls). Item details live in
// chrome.storage.local; photos and videos are too big for that and go in IndexedDB.
const ITEMS_KEY = 'items';
const CONDITIONS = ['New', 'Like new', 'Good', 'Fair', 'For parts'];

// { id, title, price, quantity, condition, description, media: [{ id, kind, name }] }
let items = [];
let editingItemId = null;
let mediaDb = null;
let draggingMedia = null; // { itemId, id } of the photo or video tile being dragged
const mediaUrls = new Map(); // media id -> object URL for its file

function saveItems() {
  return chrome.storage.local.set({ [ITEMS_KEY]: items });
}

async function loadItems() {
  items = (await chrome.storage.local.get(ITEMS_KEY))[ITEMS_KEY] || [];
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
  setStatus(`Exported ${items.length} item${items.length === 1 ? '' : 's'}`);
}

// Rows whose id matches an item update it; other rows become new items. Items
// missing from the file are left alone, and only columns in the file are touched.
async function importCsv(file) {
  const rows = parseCsv((await file.text()).replace(/^﻿/, ''));
  const header = (rows.shift() || []).map((name) => name.trim().toLowerCase());
  const columns = CSV_COLUMNS.filter((key) => header.includes(key));
  if (!columns.some((key) => key !== 'id')) {
    return setStatus('No columns recognised. Expected title, price, quantity, condition or description.');
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
  setStatus(`Imported: ${updated} updated, ${added} added`);
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
  if (failure) setStatus(`Couldn't save that file: ${failure.message}`);
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
  editingItemId = id;
  pendingRemove = null;
  render();
}

function mediaThumb(media) {
  if (!media) return el('div', { className: 'thumb' });
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
  const tile = el(
    'div',
    { className: 'tile', draggable: true, title: `${entry.name} (drag to reorder)` },
    frame,
    el('div', { className: 'row' }, ...removeControls(`media:${entry.id}`, () => removeMedia(item, entry), true)),
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
  return [item.price && `$${item.price}`, `Qty ${item.quantity || 0}`, item.condition].filter(Boolean).join(' · ');
}

function renderItemList() {
  app.append(
    el(
      'div',
      { className: 'row' },
      el('h2', { className: 'grow' }, 'Items'),
      el('button', { className: 'primary', onclick: addItem }, 'Add item'),
    ),
  );
  const csvPicker = el('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
  csvPicker.addEventListener('change', () => {
    if (csvPicker.files[0]) importCsv(csvPicker.files[0]).catch((error) => setStatus(`Couldn't import: ${error.message}`));
  });
  app.append(
    csvPicker,
    el(
      'div',
      { className: 'row csv' },
      el(
        'button',
        { title: 'Add or update items from a CSV file', onclick: () => csvPicker.click() },
        'Import CSV',
      ),
      el(
        'button',
        { title: 'Download all items as a CSV file', disabled: !items.length, onclick: exportCsv },
        'Export CSV',
      ),
    ),
  );
  if (!items.length) app.append(el('p', { className: 'muted' }, 'No items yet.'));
  for (const item of items) {
    app.append(
      el(
        'div',
        { className: 'card' },
        el(
          'div',
          { className: 'row' },
          mediaThumb(item.media[0]),
          el(
            'div',
            { className: 'grow' },
            el('strong', { className: 'line' }, item.title || 'Untitled item'),
            el('span', { className: 'line muted' }, itemSummary(item)),
          ),
          el('button', { onclick: () => editItem(item.id) }, 'Edit'),
          ...removeControls(`item:${item.id}`, () => removeItem(item), true),
        ),
      ),
    );
  }
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
    el('h2', {}, 'Item'),
    el(
      'div',
      { className: 'stack' },
      itemField(item, 'title', 'Title', el('input', { placeholder: 'What is it?' })),
      el(
        'div',
        { className: 'columns' },
        itemField(item, 'price', 'Price', el('input', { type: 'number', min: '0', step: '0.01', placeholder: '0.00' })),
        itemField(item, 'quantity', 'Quantity', el('input', { type: 'number', min: '0', step: '1' })),
        itemField(item, 'condition', 'Condition', condition),
      ),
      itemField(item, 'description', 'Description', el('textarea', { className: 'tall' })),
    ),
    el('h2', {}, 'Photos and videos'),
  );
  if (!item.media.length) app.append(el('p', { className: 'muted' }, 'None yet.'));
  app.append(
    media,
    picker,
    el(
      'div',
      { className: 'row' },
      el('button', { onclick: () => picker.click() }, 'Add photos or videos'),
      el('span', { className: 'grow' }),
      ...removeControls(`item:${item.id}`, () => removeItem(item)),
    ),
  );
}

function renderCatalog() {
  const item = items.find((other) => other.id === editingItemId);
  if (item) renderItemEditor(item);
  else renderItemList();
}
