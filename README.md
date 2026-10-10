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

## Updating

The **Update** button at the top of the panel depends on how the extension was installed:

- **From the Chrome Web Store:** it checks the store for a newer version and restarts into it.
- **Load unpacked from a git clone:** it runs `git pull` in the extension's folder, then reloads the extension. Reopen the panel afterwards; it shows what the pull did. If the pull fails, nothing is reloaded and the panel shows git's message.

The extension can't run `git` itself, so the pull is done by a small helper that you install once on each computer:

    native/install.sh

It registers `native/host.py` with Chrome as a native messaging host that only this extension may call, and all it does is `git pull --ff-only` in this folder. It needs `python3` and `git`. If the Update button says the helper isn't set up, run the command it shows, which includes the extension's id. Moving the folder changes the id, so run the installer again after a move.

The Web Store package is built by `store/build-zip.sh`, which leaves out the helper and the `nativeMessaging` permission.

## Catalog

The **Catalog** tab keeps a list of the items you sell. Each item has a title, price, quantity, condition, description, and any number of photos and videos. Changes save as you type.

Each photo and video is labelled **Photo** or **Video**, and videos also show a play symbol. Drag one to reorder; the first is the item's thumbnail in the list.

### CSV and Google Sheets

**Export CSV** downloads every item as `market-helper-items.csv`. **Import CSV** reads one back.

To edit in Google Sheets: export, then in Sheets use File → Import → Upload. Edit or add rows, then File → Download → Comma-separated values, and import that file here.

- Keep the `id` column. A row with an `id` updates that item and keeps its photos and videos; a row without one becomes a new item.
- Items that aren't in the file are left as they are. Importing never deletes.
- Only the columns in the file are changed. The `media` column lists file names for reference and is ignored on import.
- `condition` must be one of New, Like new, Good, Fair, For parts; anything else is ignored.

## Storage

Sites are keyed by hostname. Sites, profiles and item details are stored locally in `chrome.storage.local`; photos and videos are stored locally in IndexedDB.
The dot beside a field is green when the field is on the current page and red when it isn't.

## Limits

- Fields inside iframes can't be picked.
- A field with no stable attribute (name, aria-label, placeholder, test id, id) is matched by its position in the page, which breaks if the page layout changes.
- Because the panel follows you across tabs, the extension asks for access to all sites.
