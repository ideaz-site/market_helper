# Market Helper

A Chrome extension that saves sites, remembers their text fields, and pastes text into them with one click.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.

## Use

Clicking the extension opens it in Chrome's side panel, which stays open while you use the page.

1. On a site, click the extension and **Add this site**.
2. Click **Pick a field**. Every text field that isn't saved yet gets a purple overlay that turns green on hover; click one to save it. Esc cancels.
3. Type the text for that field in the panel and click **Paste** (or **Paste all**).
   A field with no saved text pastes your clipboard instead.

**Profiles** belong to a site: each one is a separate set of fields and text for that site. Pick one from the site's dropdown, or use **New**, **Rename** and **Delete**. A new profile starts empty. When you move to another site, it opens on the profile with the same name if it has one, otherwise on its own.

**All sites** lists every saved site with its profiles underneath; the arrow collapses or expands the list. Each profile has a paste icon, which fills its fields in the current tab or any open tab on that site. Drag a profile to reorder it, or click its name to edit it.

## Catalog

The **Catalog** tab keeps a list of the items you sell. Each item has a title, price, quantity, condition, description, and any number of photos and videos. Changes save as you type.

## Storage

Sites are keyed by hostname. Sites, profiles and item details are stored locally in `chrome.storage.local`; photos and videos are stored locally in IndexedDB.
The dot beside a field is green when the field is on the current page and red when it isn't.

## Limits

- Fields inside iframes can't be picked.
- A field with no stable attribute (name, aria-label, placeholder, test id, id) is matched by its position in the page, which breaks if the page layout changes.
- Because the panel follows you across tabs, the extension asks for access to all sites.
