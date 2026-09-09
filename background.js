const extensionApi = typeof browser !== "undefined" ? browser : chrome;

// Replaces the old tab-based approach entirely - the MFD now always opens
// as a separate, clean popup window (no URL/tab bar) instead of a browser
// tab, which the person can freely resize and reposition on its own.
//
// NOTE: Firefox intentionally does not let extensions force a window to
// stay "always on top of ALL other applications" (e.g. on top of the War
// Thunder game window itself, not just other Firefox windows) - confirmed
// via Mozilla's own extension developer forum, this is a real WebExtension
// API limitation, not something fixable from here. On the Steam Deck's
// Desktop Mode (KDE Plasma), the equivalent is a one-time manual step:
// right-click this popup window's title bar -> "More Actions" -> "Keep
// Above Others".
//
// Initial size/position: matches the SCREEN's actual aspect ratio (never
// forced square) by scaling both dimensions by the same factor, smaller
// than fullscreen, and centered - not maximized. Still freely resizable
// afterward, and mfd.js's fullscreen button (browser.windows.update) is
// the reliable way to go fullscreen since Firefox popup windows don't
// consistently support the native title-bar maximize button.
const WINDOW_SCREEN_SCALE = 0.65;

extensionApi.action.onClicked.addListener(() => {
    const screenWidth = window.screen.availWidth || window.screen.width || 1920;
    const screenHeight = window.screen.availHeight || window.screen.height || 1080;
    const width = Math.round(screenWidth * WINDOW_SCREEN_SCALE);
    const height = Math.round(screenHeight * WINDOW_SCREEN_SCALE);
    const left = Math.round((screenWidth - width) / 2);
    const top = Math.round((screenHeight - height) / 2);

    extensionApi.windows.create({
        url: extensionApi.runtime.getURL("mfd.html"),
        type: "popup",
        width,
        height,
        left,
        top
    });
});
