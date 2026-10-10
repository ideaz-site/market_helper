// Item catalog: the things the user sells. Loaded before panel.js and shares
// its helpers (el, render, setStatus, removeControls). Item details live in
// chrome.storage.local; photos and videos are too big for that and go in IndexedDB.
const ITEMS_KEY = 'items';
const CONDITIONS = ['New', 'Like new', 'Good', 'Fair', 'For parts'];

// { id, title, price, quantity, condition, description, media: [{ id, kind, name }] }
let items = [];
let editingItemId = null;
let mediaDb = null;
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

async function addItem() {
  const item = {
    id: crypto.randomUUID(),
    title: '',
    price: '',
    quantity: '1',
    condition: CONDITIONS[0],
    description: '',
    media: [],
  };
  items.push(item);
  await saveItems();
  editItem(item.id);
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

function editItem(id) {
  editingItemId = id;
  pendingRemove = null;
  render();
}

function mediaThumb(media) {
  if (!media) return el('div', { className: 'thumb' });
  const node = el(media.kind === 'video' ? 'video' : 'img', { className: 'thumb', title: media.name });
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
  for (const entry of item.media) {
    media.append(
      el(
        'div',
        { className: 'tile' },
        mediaThumb(entry),
        el('div', { className: 'row' }, ...removeControls(`media:${entry.id}`, () => removeMedia(item, entry), true)),
      ),
    );
  }

  app.append(
    el(
      'div',
      { className: 'row' },
      el('h2', { className: 'grow' }, 'Item'),
      el('button', { className: 'link', onclick: () => editItem(null) }, 'All items'),
    ),
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
