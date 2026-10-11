# Market Helper

A Chrome extension that saves sites, remembers their text fields, and pastes text into them with one click.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.

## Use

Clicking the extension opens it in Chrome's side panel, which stays open while you use the page. The panel uses everyday words; the code calls a "box" a field and a "template" a profile.

1. On a website, click the extension and press **Save this website**.
2. Press **Choose a box on the page**. Every text box on the page gets an overlay: purple ones can be chosen, green ones already are. Click each box you want; choosing carries on until you press **Done** (on the page or in the panel) or Esc. The page itself doesn't respond while you choose. Clicking a box you chose in this round takes it back out. Doing anything else in the panel, switching tabs, or closing the panel also ends choosing.
3. Each box is one line in **Boxes to fill in**. Press a box to open it, type what should go in it, and press **Fill in the page**.
   A box with no text is filled with whatever you last copied.

A box's line shows what it will be filled with, and a red **!** when something needs putting right, such as an item with nothing for that detail. Opening a box also offers **Fill in just this box**, **Rename** (for when the page's own label isn't a helpful name) and **Remove this box**.

**Text size** at the bottom of the panel makes everything in it Normal, Large or Largest. The panel also follows your browser's own font size setting, and your system's light or dark theme and its request for more contrast.

Messages about what just happened appear in a bar pinned to the bottom of the panel; **OK** puts it away. After filling in, any box that was left out is marked with the reason.

Once you have items under **My items**, each box gets a **Fill this box with** choice: **Text I type here**, or one of the item's details (title, price, quantity, condition, description, or any detail you added yourself). Item details come from the item chosen under **Item to use**, so one template can fill a listing form for any of your items.

Tick **Also add its photos and videos** and **Fill in the page** also hands the chosen item's photos and videos to the page's own file chooser, as if you had picked the files yourself; the website then uploads them. Photos go to a chooser that takes images and videos to one that takes video. The part of the page where photos are added has to be open. Pressing Fill in the page twice adds them twice.

**Templates** belong to a website: each one is a separate set of boxes and text for it. A website starts with one; **Add another** makes more, and then a dropdown switches between them and **Options** offers New, Rename and Delete. A new template starts empty. When you move to another website, it opens on the template with the same name if it has one, otherwise on its own.

When the browser isn't on the website you're looking at, the panel says so and offers **Go to** (or **Open**) that website.

**All my websites** lists every saved website with its templates underneath, the one you're on first; the arrow hides or shows the others' templates. **Fill in** beside a template fills its boxes in the tab you're looking at when it's on that website, otherwise in another open tab on it. Drag a template by its dots to reorder it, or focus the dots and press the up or down arrow; press its name to open it. Removing anything asks first, and Esc backs out.

## Updating

**Check for updates** at the bottom of the panel depends on how the extension was installed:

- **From the Chrome Web Store:** it checks the store for a newer version and restarts into it.
- **Load unpacked from a git clone:** it runs `git pull` in the extension's folder, then reloads the extension. Reopen the panel afterwards; it says whether anything was updated. If the pull fails, nothing is reloaded and the panel shows git's message.

The extension can't run `git` itself, so the pull is done by a small helper that you install once on each computer:

    native/install.sh

It registers `native/host.py` with Chrome as a native messaging host that only this extension may call, and all it does is `git pull --ff-only` in this folder. It needs `python3` and `git`. If Check for updates says the helper isn't set up, run the command it shows, which includes the extension's id. Moving the folder changes the id, so run the installer again after a move.

The Web Store package is built by `store/build-zip.sh`, which leaves out the helper and the `nativeMessaging` permission.

## My items

The **My items** tab keeps a list of the items you sell. Press an item to open it. Each has a title, price, quantity, condition, description, and any number of photos and videos. Changes save by themselves. An item you add and leave empty is thrown away.

When websites fill boxes from items and you have more than one, the list marks the one **In use on websites**; open another item and press **Use this item on websites** to switch. Deleting the item in use moves websites on to the next one, and says so.

**Change the list of details** lets you add your own details, such as Brand or Size, as text or a number. A detail you add appears on every item, and in each box's **Fill this box with** choice alongside the built-in ones. Removing a detail removes it from every item, and the question says how many items and templates that touches.

Each photo and video is labelled **Photo** or **Video**, and numbered; the first is the main one and the item's picture in the list. Press one to move it earlier or later, make it the main one, or remove it. You can also drag one to a new place.

To delete an item, open it and press **Delete this item**.

### Spreadsheets and Google Sheets

Under **Spreadsheet (advanced)** at the bottom of My items, **Save to file** downloads every item as `market-helper-items.csv` and **Load from file…** reads one back. **Undo that load** then puts your items back as they were, until you open an item.

To edit in Google Sheets: save to a file, then in Sheets use File → Import → Upload. Edit or add rows, then File → Download → Comma-separated values, and load that file here.

- Keep the `id` column. A row with an `id` updates that item and keeps its photos and videos; a row without one becomes a new item, so a file that lost its `id` column adds everything again.
- Items that aren't in the file are left as they are. Loading a file never deletes.
- Details you added yourself are columns too, named as you named them. A column whose name matches no detail is ignored.
- Only the columns in the file are changed. The `media` column lists file names for reference and is ignored when loading.
- `condition` must be one of New, Like new, Good, Fair, For parts; anything else is ignored.

## Storage

Sites are keyed by hostname. Sites, profiles and item details are stored locally in `chrome.storage.local`; photos and videos are stored locally in IndexedDB.
The dot beside a box is green when the box is on the current page and grey when it isn't.

## Limits

- Boxes inside iframes can't be chosen.
- Photos and videos can only be added where the page has a file chooser (`<input type="file">`). A page that only accepts files dragged onto it, or that creates its chooser only after you press its own add-photo button, has no place for them.
- A box with no stable attribute (name, aria-label, placeholder, test id, id) is saved by its position in the page. Positions change when a site redraws, so such a box is found again by its label; if two boxes on the page share that label, it can't be told apart and shows as not on the page.
- Because the panel follows you across tabs, the extension asks for access to all sites.
