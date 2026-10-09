// The UI lives in the side panel rather than a popup, because a popup closes
// the moment the page is clicked and picking a field needs a click on the page.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
