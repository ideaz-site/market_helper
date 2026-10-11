# Market Helper

A Chrome extension that saves sites, remembers their text fields, and pastes text into them with one click.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.

## Use

Clicking the extension opens it in Chrome's side panel, which stays open while you use the page. The panel uses everyday words; the code calls a "box" a field and a "template" a profile.

1. On a website, click the extension and press **Save this website**.
2. Press **Choose a box on the page**. Every text box that isn't saved yet gets a purple overlay that turns green on hover; click one to save it. **Stop** in the banner, or Esc, cancels. So does doing anything else in the panel, switching tabs, or closing the panel.
3. Type what should go in that box, then press **Fill in** beside it, or **Fill in the page** for all of them.
   A box with no text is filled with whatever you last copied.

Messages about what just happened appear in a bar pinned to the bottom of the panel.

Once you have items under **My items**, each box gets a **Fill this box with** choice: **Text I type here**, or one of the item's details (title, price, quantity, condition or description). Item details come from the item chosen under **Fill in using this item**, so one template can fill a listing form for any of your items.

**Templates** belong to a website: each one is a separate set of boxes and text for it. A website starts with one; **Add another** makes more, and then you can switch between them, rename and delete them. A new template starts empty. When you move to another website, it opens on the template with the same name if it has one, otherwise on its own.

**All my websites** lists every saved website with its templates underneath; the arrow hides or shows them. **Fill in** beside a template fills its boxes in the current tab or any open tab on that website. Drag a template to reorder it, or click its name to open it. Removing anything asks first.

## Updating

**Check for updates** at the bottom of the panel depends on how the extension was installed:

- **From the Chrome Web Store:** it checks the store for a newer version and restarts into it.
- **Load unpacked from a git clone:** it runs `git pull` in the extension's folder, then reloads the extension. Reopen the panel afterwards; it says whether anything was updated. If the pull fails, nothing is reloaded and the panel shows git's message.

The extension can't run `git` itself, so the pull is done by a small helper that you install once on each computer:

    native/install.sh

It registers `native/host.py` with Chrome as a native messaging host that only this extension may call, and all it does is `git pull --ff-only` in this folder. It needs `python3` and `git`. If Check for updates says the helper isn't set up, run the command it shows, which includes the extension's id. Moving the folder changes the id, so run the installer again after a move.

The Web Store package is built by `store/build-zip.sh`, which leaves out the helper and the `nativeMessaging` permission.

## My items

The **My items** tab keeps a list of the items you sell. Each item has a title, price, quantity, condition, description, and any number of photos and videos. Changes save as you type.

Each photo and video is labelled **Photo** or **Video**, and videos also show a play symbol. Drag one to reorder, or press **Make main** under it to move it to the front; the first is the item's thumbnail in the list.

### Spreadsheets and Google Sheets

Under **Spreadsheet (advanced)** at the bottom of My items, **Save to file** downloads every item as `market-helper-items.csv` and **Load from file…** reads one back.

To edit in Google Sheets: save to a file, then in Sheets use File → Import → Upload. Edit or add rows, then File → Download → Comma-separated values, and load that file here.

- Keep the `id` column. A row with an `id` updates that item and keeps its photos and videos; a row without one becomes a new item.
- Items that aren't in the file are left as they are. Loading a file never deletes.
- Only the columns in the file are changed. The `media` column lists file names for reference and is ignored when loading.
- `condition` must be one of New, Like new, Good, Fair, For parts; anything else is ignored.

## Storage

Sites are keyed by hostname. Sites, profiles and item details are stored locally in `chrome.storage.local`; photos and videos are stored locally in IndexedDB.
The dot beside a box is green when the box is on the current page and red when it isn't.

## Limits

- Boxes inside iframes can't be chosen.
- A box with no stable attribute (name, aria-label, placeholder, test id, id) is saved by its position in the page. Positions change when a site redraws, so such a box is found again by its label; if two boxes on the page share that label, it can't be told apart and shows as not on the page.
- Because the panel follows you across tabs, the extension asks for access to all sites.
