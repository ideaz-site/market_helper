# Market Helper

A Chrome extension that saves sites, remembers their text fields, and pastes text into them with one click.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.

## Use

1. On a site, click the extension and **Add this site**.
2. Click **Pick a field**. Every text field on the page gets a purple overlay that turns green on hover; click one to save it. Esc cancels.
3. Reopen the extension, type the text for that field, and click **Paste** (or **Paste all**).
   A field with no saved text pastes your clipboard instead.

Sites are keyed by hostname and everything is stored locally in `chrome.storage.local`.
The dot beside a field is green when the field is on the current page and red when it isn't.

## Limits

- Fields inside iframes can't be picked.
- A field with no stable attribute (name, aria-label, placeholder, test id, id) is matched by its position in the page, which breaks if the page layout changes.
