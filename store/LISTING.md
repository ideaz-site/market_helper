# Chrome Web Store submission

Everything to paste into the Developer Dashboard, tab by tab.

## Package

Upload `market_helper-store-v0.1.0.zip` from the GitHub release. It has `manifest.json` at the top level, which the store requires. (The other zip, `market_helper-v0.1.0.zip`, is for Load unpacked.) Build it with `store/build-zip.sh`: it drops the `nativeMessaging` permission, which is only used by the git-pull helper for unpacked installs and must not be in the store package.

## Store listing

**Name** (from the manifest)

    Market Helper

**Summary** (from the manifest, 132 characters max)

    Save sites, pick their text fields, and paste saved text into them with one click.

**Description**

    Market Helper fills in the forms you fill in over and over, in plain words and big buttons.

    Save a website, click the boxes you want filled in, and type what goes in each one. From then on, one press of "Fill in the page" types everything in for you.

    HOW IT WORKS
    1. Go to the website where you post listings and click the Market Helper icon. It opens in Chrome's side panel and stays open while you use the page.
    2. Press "Save this website".
    3. Press "Choose a box on the page". Every text box on the page is highlighted. Click one to save it.
    4. Type what should go in each box, then press "Fill in the page".

    TEMPLATES
    Each website can have several templates, each with its own boxes and text. Keep one per kind of listing, per message you send, or per form you fill in. Switch between them or fill in from any of them in the "All my websites" list, and drag them into the order you like.

    MY ITEMS
    Keep a list of the items you sell, each with a title, price, quantity, condition, description, photos and videos, all in one place. Tell a box to use the item's title, price, quantity, condition or description, then choose an item and fill its details into the form. It can add the item's photos and videos to the page for you as well.

    GOOD FOR
    - Reposting marketplace and classified listings
    - Repetitive web forms
    - Canned replies and descriptions

    PRIVATE BY DESIGN
    Everything is stored on your device. Market Helper has no server, no account and no analytics, and it only acts on a page when you press "Choose a box on the page" or "Fill in".

**Category:** Workflow & Planning (under Productivity)

**Language:** English

## Graphics

| Asset | File |
| --- | --- |
| Store icon, 128×128 | `icons/icon128.png` |
| Screenshot 1, 1280×800 | `store/screenshot-1-1280x800.png` |
| Screenshot 2, 1280×800 | `store/screenshot-2-1280x800.png` |
| Screenshot 3, 1280×800 | `store/screenshot-3-1280x800.png` |
| Small promo tile, 440×280 | `store/promo-small-440x280.png` |

The screenshots show the real panel with sample data beside a made-up listing page.

## Privacy practices

**Single purpose**

    Market Helper lets you save text fields on websites you choose and paste your own saved text into those fields with one click.

**Permission justifications**

`storage`

    Saves the user's sites, profiles, picked fields, text and catalog items on their own device with chrome.storage.local. Nothing is synced or sent anywhere.

`unlimitedStorage`

    The item catalog stores photos and videos the user adds, on their own device. These files can exceed the default storage quota, and this permission keeps Chrome from evicting them.

`scripting`

    Injects a script into the current page only when the user presses "Choose a box on the page" (to highlight text fields and record the one they click) or "Fill in" (to put their saved text into the saved field and, if they turned that option on, their chosen item's photos and videos into the page's file chooser). It also checks whether saved fields exist on a site the user has saved.

`sidePanel`

    The extension's interface is a side panel. Choosing a box requires clicking on the page, which would close a popup, so the interface has to stay open beside the page.

`clipboardRead`

    When the user presses Fill in on a box they have left empty, the extension pastes the current clipboard text into that field instead. The clipboard is read only at that moment, and its contents are not stored or transmitted.

Host permission (`<all_urls>`)

    Users choose which sites to use the extension on, and those can be any site, so the sites cannot be listed in advance. The side panel stays open as the user switches tabs and must read the tab's address to show the matching saved site and fill its fields. The extension only changes a page when the user presses Choose a box on the page or Fill in.

**Remote code:** No, I am not using remote code. All code is in the package.

**Data usage:** tick nothing. The extension does not collect or use any user data.

Then certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**

    https://github.com/ideaz-site/market_helper/blob/main/PRIVACY.md

## Distribution

- **Payments:** Free
- **Visibility:** Public (or Unlisted to try it with a link first)
- **Regions:** All regions

## Account (done once, outside this repo)

- Register at the Chrome Web Store Developer Dashboard and pay the one-time $5 fee
- Turn on 2-step verification for that Google account
- Set the publisher name and verify the contact email
- Declare trader or non-trader status
