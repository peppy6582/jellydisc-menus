// Disc Menus web renderer.
//
// Injected into jellyfin-web's index.html by the File Transformation plugin
// (see FileTransformationIntegration.cs). Loads once with the page and never
// reloads on in-app navigation - jellyfin-web is a client-routed, hash-based
// SPA (confirmed: components/router/appRouter.js builds URLs like
// "#/details?id=<guid>"), so this watches the native `hashchange` event to
// know which item's details page is currently showing.
//
// PLAYBACK: playbackManager isn't reachable from an injected script (it's an
// ES module internal to jellyfin-web's bundle), so play actions send a
// PlayNow command to this browser's own session via the Sessions API (see
// playItems). If that fails they fall back to navigating to the item's
// details page. After playback stops the menu reopens where it was left.
//
// KNOWN LIMITATIONS:
// - background.source "fanart" isn't implemented - falls back to a plain dark
//   background. "jellyfin", "tmdb", "image", "trailer" and "color" work.
(function () {
    'use strict';

    var OVERLAY_ID = 'discMenusOverlay';
    var VIDEO_ID = 'discMenusVideo';
    var BUTTON_ID = 'discMenusButton';

    // Preview mode (the editor's live preview, in an iframe): the editor hands this script a menu
    // instead of the script watching jellyfin-web, and nothing here ever touches the real session:
    // no playback, no native alerts, and the menu can't close itself. Starts muted.
    var PREVIEW = window.__discMenusPreview === true;
    var previewMuted = true;

    var currentParentItemId = null;
    var menuDoc = null;
    var menuStack = [];
    var menuPage = {};
    var virtualMenus = {};

    function getItemIdFromHash() {
        var hash = window.location.hash || '';
        var match = /[#&?]id=([0-9a-fA-F-]{32,36})/.exec(hash);
        return match ? match[1] : null;
    }

    function waitForApiClient(callback, attempts) {
        attempts = attempts || 0;
        if (window.ApiClient) {
            callback();
            return;
        }

        if (attempts > 100) {
            return;
        }

        setTimeout(function () {
            waitForApiClient(callback, attempts + 1);
        }, 100);
    }

    function checkForMenu() {
        var itemId = getItemIdFromHash();
        if (itemId === currentParentItemId) {
            return;
        }

        currentParentItemId = itemId;
        removeButton();

        if (!itemId || !window.ApiClient) {
            return;
        }

        ApiClient.getJSON(ApiClient.getUrl('DiscMenus/' + itemId + '/Menu')).then(
            function (doc) {
                if (currentParentItemId !== itemId) {
                    return;
                }

                menuDoc = doc;
                addButton(itemId);
            },
            function () {
                // No disc menu bound to this item (404), or not authenticated
                // yet - either way, just don't show the button.
            }
        );
    }

    function addButton(itemId) {
        var btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.type = 'button';
        btn.textContent = 'Disc Menu';
        btn.style.cssText =
            'position:fixed;bottom:2em;right:2em;z-index:9998;padding:0.75em 1.25em;' +
            'border-radius:2em;border:none;background:#3ddc84;color:#101010;font-weight:600;' +
            'font-size:1em;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
        btn.addEventListener('click', function () {
            openOverlay(itemId);
        });
        document.body.appendChild(btn);
    }

    function removeButton() {
        var existing = document.getElementById(BUTTON_ID);
        if (existing) {
            existing.remove();
        }

        closeOverlay();
    }

    function openOverlay(parentItemId) {
        if (!menuDoc) {
            return;
        }

        menuStack = [menuDoc.Root];
        lastFocusIndex = {};
        menuPage = {};
        preloadBackgrounds(parentItemId);
        renderOverlay(parentItemId, 'intro');
    }

    function closeOverlay() {
        if (PREVIEW && menuDoc) {
            // Esc at the root, or the X: a preview never goes blank, it returns to the main menu.
            menuStack = [menuDoc.Root];
            menuPage = {};
            renderOverlay(currentParentItemId, 'back');
            return;
        }

        removeVideo();
        stopMusic(400);
        currentSounds = null;
        var existing = document.getElementById(OVERLAY_ID);
        if (existing) {
            existing.remove();
            window.removeEventListener('keydown', onKeyDown, true);
        }
    }

    // ---- Remote-style navigation -------------------------------------------
    // Directional focus is geometric (nearest entry in the pressed direction by
    // on-screen position), not list-order based, so it keeps working unchanged
    // when menus get authored layouts instead of a plain column.

    var DIRECTION_KEYS = {
        ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    };
    var SELECT_KEYS = { Enter: true, NumpadEnter: true, ' ': true };
    // Browsers/TV remotes report "back" in many ways: webOS 461, Tizen 10009.
    var BACK_KEYS = { Escape: true, Backspace: true, BrowserBack: true, GoBack: true };
    var BACK_KEYCODES = { 461: true, 10009: true };

    var lastFocusIndex = {};
    var lastMouse = { x: -1, y: -1 };

    function getEntries() {
        var overlay = document.getElementById(OVERLAY_ID);
        return overlay ? Array.prototype.slice.call(overlay.querySelectorAll('.discMenuEntry')) : [];
    }

    // How far candidate rect `r` lies in direction (dx,dy) from `from`, judged by
    // edges rather than centres, or null if it isn't in that direction at all.
    // A button on the same row is not "below" you even if its centre is a few
    // pixels lower, so up/down in a single row of buttons never hops sideways.
    function distanceAlong(from, r, dx, dy) {
        var tol = 0.25 * (dx !== 0 ? from.width : from.height);
        var gap = dx === 1 ? r.left - from.right
            : dx === -1 ? from.left - r.right
            : dy === 1 ? r.top - from.bottom
            : from.top - r.bottom;
        if (gap < -tol) {
            return null;
        }

        var cx = r.left + r.width / 2 - (from.left + from.width / 2);
        var cy = r.top + r.height / 2 - (from.top + from.height / 2);
        return cx * dx + cy * dy;
    }

    function overlapsAcross(from, r, dx) {
        return dx !== 0
            ? from.top < r.bottom && r.top < from.bottom
            : from.left < r.right && r.left < from.right;
    }

    function acrossOffset(from, r, dx) {
        var cx = r.left + r.width / 2 - (from.left + from.width / 2);
        var cy = r.top + r.height / 2 - (from.top + from.height / 2);
        return Math.abs(dx !== 0 ? cy : cx);
    }

    function moveFocus(dx, dy) {
        var entries = getEntries();
        if (entries.length === 0) {
            return;
        }

        var current = entries.indexOf(document.activeElement);
        if (current < 0) {
            entries[0].focus();
            return;
        }

        var from = entries[current].getBoundingClientRect();
        var best = null;
        var bestKey = null;
        var wrap = null;
        var wrapKey = null;

        entries.forEach(function (el, i) {
            if (i === current) {
                return;
            }

            var r = el.getBoundingClientRect();
            var ahead = distanceAlong(from, r, dx, dy);
            var across = acrossOffset(from, r, dx);
            if (ahead !== null) {
                // Same row/column as you first (nearest wins); otherwise the
                // closest diagonal, weighting sideways drift double.
                var key = overlapsAcross(from, r, dx) ? [0, ahead] : [1, ahead + 2 * across];
                if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
                    best = el;
                    bestKey = key;
                }

                return;
            }

            // Not ahead of you. Only buttons genuinely *behind* you are wrap
            // targets; same-row neighbours for an up/down press are ignored.
            var behind = distanceAlong(from, r, -dx, -dy);
            if (behind === null) {
                return;
            }

            // Farthest behind wins (so wrapping reverses the opposite press
            // exactly and every button stays reachable); ties go to the
            // straightest one.
            var far = -behind;
            if (!wrapKey || far < wrapKey[0] - 20 || (far < wrapKey[0] + 20 && across < wrapKey[1])) {
                wrap = el;
                wrapKey = [far, across];
            }
        });

        var target = best || wrap;
        if (target) {
            target.focus();
            playSound('move');
        }
    }

    // fromKey: the Back key / gamepad B steps back through a menu's pages first;
    // an on-screen Back button always goes up to the parent menu.
    function goBack(parentItemId, fromKey) {
        var topKey = menuStack[menuStack.length - 1];
        if (fromKey) {
            playSound('back');
        }

        if (fromKey && (menuPage[topKey] || 0) > 0) {
            menuPage[topKey]--;
            lastFocusIndex[topKey] = 0;
            renderOverlay(parentItemId, 'back');
            return;
        }

        if (menuStack.length > 1) {
            menuStack.pop();
            renderOverlay(parentItemId, 'back');
        } else {
            closeOverlay();
        }
    }

    function selectFocused() {
        if (document.activeElement && document.activeElement.classList.contains('discMenuEntry')) {
            document.activeElement.click();
        }
    }

    function onKeyDown(e) {
        if (!document.getElementById(OVERLAY_ID)) {
            return;
        }

        var dir = DIRECTION_KEYS[e.key];
        var handled = true;
        if (dir) {
            moveFocus(dir[0], dir[1]);
        } else if (SELECT_KEYS[e.key]) {
            selectFocused();
        } else if (BACK_KEYS[e.key] || BACK_KEYCODES[e.keyCode]) {
            goBack(currentParentItemId, true);
        } else {
            handled = false;
        }

        if (handled) {
            // Capture phase + stop: jellyfin-web's own key handlers (Escape,
            // Backspace, arrows) must not also act on the page behind the menu.
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }

    // Gamepad: d-pad / left stick to move, A to select, B to go back. There is
    // no gamepad "event" for buttons, so poll while the overlay is open.
    var gamepadLoop = 0;
    var gamepadHeld = {};

    function pollGamepad() {
        if (!document.getElementById(OVERLAY_ID)) {
            gamepadLoop = 0;
            return;
        }

        var pads = navigator.getGamepads ? navigator.getGamepads() : [];
        var now = Date.now();
        var pressed = {};
        for (var i = 0; i < pads.length; i++) {
            var pad = pads[i];
            if (!pad) {
                continue;
            }

            var b = pad.buttons;
            var ax = pad.axes[0] || 0;
            var ay = pad.axes[1] || 0;
            if ((b[12] && b[12].pressed) || ay < -0.6) { pressed.up = true; }
            if ((b[13] && b[13].pressed) || ay > 0.6) { pressed.down = true; }
            if ((b[14] && b[14].pressed) || ax < -0.6) { pressed.left = true; }
            if ((b[15] && b[15].pressed) || ax > 0.6) { pressed.right = true; }
            if (b[0] && b[0].pressed) { pressed.select = true; }
            if (b[1] && b[1].pressed) { pressed.back = true; }
        }

        Object.keys(pressed).forEach(function (name) {
            var held = gamepadHeld[name];
            // Fire on press, then auto-repeat directions while held (not select/back).
            var repeat = held && (name === 'up' || name === 'down' || name === 'left' || name === 'right') &&
                now - held.last > (held.repeating ? 120 : 400);
            if (held && !repeat) {
                return;
            }

            gamepadHeld[name] = { last: now, repeating: !!held };
            if (name === 'up') { moveFocus(0, -1); }
            else if (name === 'down') { moveFocus(0, 1); }
            else if (name === 'left') { moveFocus(-1, 0); }
            else if (name === 'right') { moveFocus(1, 0); }
            else if (name === 'select') { selectFocused(); }
            else if (name === 'back') { goBack(currentParentItemId, true); }
        });

        Object.keys(gamepadHeld).forEach(function (name) {
            if (!pressed[name]) {
                delete gamepadHeld[name];
            }
        });

        if (document.getElementById(OVERLAY_ID)) {
            gamepadLoop = requestAnimationFrame(pollGamepad);
        } else {
            gamepadLoop = 0;
        }
    }

    // TMDB's image server, addressed by the backdrop's file_path. The path is
    // re-validated here (the server already did) so only /name.jpg or /name.png
    // can ever be appended to the fixed TMDB host.
    var TMDB_PATH = /^\/[A-Za-z0-9_-]+\.(jpg|png)$/;

    function tmdbImageUrl(background) {
        if (typeof background.TmdbFilePath !== 'string' || !TMDB_PATH.test(background.TmdbFilePath)) {
            return null;
        }

        var size = background.TmdbSize === 'w780' || background.TmdbSize === 'original' ? background.TmdbSize : 'w1280';
        return 'https://image.tmdb.org/t/p/' + size + background.TmdbFilePath;
    }

    // Warm the browser cache with every page's picture when the menu opens, so
    // moving between pages with different backgrounds doesn't wait on the network.
    function preloadBackgrounds(parentItemId) {
        var all = [menuDoc.Background];
        Object.keys(menuDoc.Menus).forEach(function (k) {
            all.push(menuDoc.Menus[k].Background);
        });
        var seen = {};
        all.forEach(function (b) {
            var url = !b ? null
                : b.Source === 'tmdb' ? tmdbImageUrl(b)
                : b.Source === 'image' ? safeImage(b.Image)
                : b.Source === 'jellyfin' && window.ApiClient
                    ? ApiClient.getImageUrl(parentItemId, { type: b.ImageType || 'Backdrop', index: b.Index || 0 })
                    : null;
            if (url && !seen[url]) {
                seen[url] = true;
                new Image().src = url;
            }
        });
    }

    function backgroundStyle(background, parentItemId) {
        if (!background) {
            return 'background-color:#101010;';
        }

        var dim = background.Dim != null ? background.Dim : 0.4;

        if (background.Source === 'color' && background.Color) {
            return 'background-color:' + background.Color + ';';
        }

        if (background.Source === 'tmdb') {
            var tmdbUrl = tmdbImageUrl(background);
            if (tmdbUrl) {
                return (
                    'background-image:linear-gradient(rgba(0,0,0,' + dim + '),rgba(0,0,0,' + dim + ')),url(' + tmdbUrl + ');' +
                    'background-size:cover;background-position:center;background-color:#101010;'
                );
            }

            return 'background-color:#101010;';
        }

        if (background.Source === 'trailer') {
            // The video sits in its own layer beneath the overlay (see syncVideo);
            // the overlay itself only dims it for legibility.
            return 'background-color:rgba(0,0,0,' + (background.Dim != null ? background.Dim : 0.25) + ');';
        }

        if (background.Source === 'image') {
            var imageUrl = safeImage(background.Image);
            if (imageUrl) {
                return (
                    'background-image:linear-gradient(rgba(0,0,0,' + dim + '),rgba(0,0,0,' + dim + ')),url(' + imageUrl + ');' +
                    'background-size:cover;background-position:center;background-color:#101010;'
                );
            }

            return 'background-color:#101010;';
        }

        if (background.Source === 'jellyfin' && window.ApiClient) {
            var url = ApiClient.getImageUrl(parentItemId, {
                type: background.ImageType || 'Backdrop',
                index: background.Index || 0,
            });
            return (
                'background-image:linear-gradient(rgba(0,0,0,' + dim + '),rgba(0,0,0,' + dim + ')),url(' + url + ');' +
                'background-size:cover;background-position:center;'
            );
        }

        // tmdb/fanart sources: not implemented yet, see file header.
        return 'background-color:#101010;';
    }

    // ---- Authored layout ---------------------------------------------------

    var ANCHOR_SHIFT = {
        'top-left': [0, 0], top: [-50, 0], 'top-right': [-100, 0],
        left: [0, -50], center: [-50, -50], right: [-100, -50],
        'bottom-left': [0, -100], bottom: [-50, -100], 'bottom-right': [-100, -100],
    };

    // Position an element at percentages of the menu screen; x/y refer to the
    // chosen anchor point of the element (so "bottom" centres it horizontally
    // on x and sits its bottom edge on y).
    function place(el, pos) {
        var shift = ANCHOR_SHIFT[pos.Anchor || 'top-left'] || ANCHOR_SHIFT['top-left'];
        el.style.position = 'absolute';
        el.style.left = pos.X + '%';
        el.style.top = pos.Y + '%';
        if (pos.W != null) {
            el.style.width = pos.W + '%';
        }

        if (pos.H != null) {
            el.style.height = pos.H + '%';
        }

        el.style.transform = 'translate(' + shift[0] + '%,' + shift[1] + '%)';
    }

    // Defense in depth: the server already rejects anything else, but menu JSON
    // can come from anywhere, so never hand the browser a URL we wouldn't vouch for.
    var SAFE_IMAGE = /^(https:\/\/[^\s"'()<>\\]+|data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+|asset:[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3})$/;

    // Returns a URL that is safe to hand to an <img>/CSS url(), or null. An
    // "asset:<folder>/<file>" reference becomes this server's asset endpoint.
    function safeImage(url) {
        if (typeof url !== 'string' || !SAFE_IMAGE.test(url)) {
            return null;
        }

        if (url.indexOf('asset:') === 0) {
            if (!window.ApiClient) {
                return null;
            }

            return ApiClient.getUrl('DiscMenus/Assets/' + url.slice(6).split('/').map(encodeURIComponent).join('/'));
        }

        return url;
    }

    // Built-in font stacks only; the menu JSON picks one by name and never
    // supplies a font-family string of its own.
    var FONT_STACKS = {
        sans: 'system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
        serif: 'Georgia,"Times New Roman",Times,serif',
        condensed: '"Arial Narrow","Roboto Condensed","Helvetica Neue",Arial,sans-serif',
        wide: 'Verdana,"DejaVu Sans","Trebuchet MS",Geneva,sans-serif',
        mono: 'ui-monospace,Menlo,Consolas,"DejaVu Sans Mono",monospace',
    };

    // Typography declared by the theme, as inline CSS. Sizes are in vh so text
    // scales with the screen the same way positions do.
    function typographyCss(theme) {
        var css = '';
        if (theme.Font && FONT_STACKS[theme.Font]) {
            css += 'font-family:' + FONT_STACKS[theme.Font] + ';';
        }

        if (typeof theme.FontSize === 'number') {
            css += 'font-size:' + theme.FontSize + 'vh;';
        }

        if (theme.Uppercase) {
            css += 'text-transform:uppercase;';
        }

        if (theme.Bold) {
            css += 'font-weight:700;';
        }

        if (typeof theme.LetterSpacing === 'number') {
            css += 'letter-spacing:' + theme.LetterSpacing + 'em;';
        }

        return css;
    }

    var HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

    function safeColor(c, fallback) {
        return typeof c === 'string' && HEX_COLOR.test(c) ? c : fallback;
    }

    function num(v, fallback) {
        return typeof v === 'number' && isFinite(v) ? v : fallback;
    }

    // Decorative layers: drawn behind the buttons, never focusable or clickable.
    function renderLayer(layer, overlay) {
        var el;
        if (layer.Type === 'panel') {
            el = document.createElement('div');
            el.style.boxSizing = 'border-box';
            el.style.background = safeColor(layer.Fill, 'transparent');
            if (layer.BorderColor && num(layer.BorderWidth, 0) > 0) {
                el.style.border = num(layer.BorderWidth, 0) + 'vh solid ' + safeColor(layer.BorderColor, 'transparent');
            }

            if (layer.Radius != null) {
                el.style.borderRadius = num(layer.Radius, 0) + 'vh';
            }
        } else if (layer.Type === 'image' && safeImage(layer.Image)) {
            el = document.createElement('img');
            el.src = safeImage(layer.Image);
            el.alt = '';
            el.draggable = false;
            el.style.objectFit = layer.Fit === 'fill' || layer.Fit === 'cover' ? layer.Fit : 'contain';
        } else {
            return;
        }

        if (layer.Opacity != null) {
            el.style.opacity = String(num(layer.Opacity, 1));
        }

        el.style.pointerEvents = 'none';
        el.setAttribute('aria-hidden', 'true');
        place(el, layer.Position);
        overlay.appendChild(el);
    }

    function buildEntryButton(entry, defaultStyle, theme, align) {
        var accent = safeColor(theme.Accent, '#3ddc84');
        var textColor = safeColor(theme.TextColor, '#fff');
        var style = entry.Style || defaultStyle;
        var image = safeImage(entry.Image);
        var imageFocus = safeImage(entry.ImageFocus);
        var sized = !!(entry.Position && (entry.Position.W != null || entry.Position.H != null));

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'discMenuEntry';
        btn.setAttribute('aria-label', entry.Label);
        btn.style.cssText =
            'font-size:1.25em;padding:0.5em 1.25em;color:' + textColor + ';cursor:pointer;background:transparent;' +
            'border:2px solid transparent;border-radius:0.4em;text-align:' + align + ';' +
            'text-shadow:0 2px 6px rgba(0,0,0,0.8);outline:none;' + typographyCss(theme);

        var arrow = null;
        var img = null;
        // Chapter thumbnail URL is built by this script from the server's own
        // chapter-image endpoint (never from menu JSON), so it is trusted here.
        var thumb = typeof entry.ThumbUrl === 'string' ? entry.ThumbUrl : null;

        if (thumb) {
            btn.style.cssText += 'display:flex;flex-direction:column;align-items:stretch;padding:0.3em;gap:0.3em;font-size:1.6vh;';
            btn.style.background = 'rgba(0,0,0,0.35)';
            img = document.createElement('img');
            img.src = thumb;
            img.alt = '';
            img.draggable = false;
            img.style.cssText = 'display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:0.3em;background:#000;';
            btn.appendChild(img);
            var caption = document.createElement('span');
            caption.textContent = entry.Label + (entry.Sub ? ' · ' + entry.Sub : '');
            btn.appendChild(caption);
        } else if (image) {
            // Artwork button: the label is only an accessible name, not drawn.
            btn.title = entry.Label;
            btn.style.padding = '0';
            btn.style.border = 'none';
            img = document.createElement('img');
            img.src = image;
            img.alt = entry.Label;
            img.draggable = false;
            img.style.cssText = sized
                ? 'display:block;width:100%;height:100%;object-fit:contain;'
                : 'display:block;max-width:40vw;max-height:25vh;';
            btn.appendChild(img);
        } else {
            if (style === 'arrow') {
                arrow = document.createElement('span');
                arrow.textContent = '▶';
                arrow.setAttribute('aria-hidden', 'true');
                arrow.style.cssText = 'color:' + accent + ';margin-right:0.5em;visibility:hidden;';
                btn.appendChild(arrow);
            }

            btn.appendChild(document.createTextNode(entry.Label));
            if (entry.Sub) {
                // Secondary line (e.g. a chapter's start time), smaller and dimmer.
                var sub = document.createElement('span');
                sub.textContent = entry.Sub;
                sub.style.cssText = 'display:block;font-size:0.65em;opacity:0.75;letter-spacing:0;';
                btn.appendChild(sub);
            }

            if (style === 'frame') {
                btn.style.background = 'rgba(0,0,0,0.5)';
            }
        }

        function highlight(on) {
            if (thumb) {
                btn.style.borderColor = on ? accent : 'transparent';
                btn.style.background = on ? 'rgba(0,0,0,0.65)' : 'rgba(0,0,0,0.35)';
                return;
            }

            if (img) {
                if (imageFocus) {
                    img.src = on ? imageFocus : image;
                } else {
                    img.style.filter = on ? 'drop-shadow(0 0 10px ' + accent + ') brightness(1.15)' : 'none';
                }

                return;
            }

            switch (style) {
                case 'frame':
                    btn.style.borderColor = on ? accent : 'transparent';
                    btn.style.background = on ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.5)';
                    break;
                case 'glow':
                    btn.style.textShadow = on
                        ? '0 0 10px ' + accent + ',0 0 22px ' + accent
                        : '0 2px 6px rgba(0,0,0,0.8)';
                    break;
                case 'arrow':
                    arrow.style.visibility = on ? 'visible' : 'hidden';
                    break;
                default: // text
                    btn.style.color = on ? accent : textColor;
                    break;
            }
        }

        btn.addEventListener('focus', function () {
            highlight(true);
        });
        btn.addEventListener('blur', function () {
            highlight(false);
        });
        return btn;
    }

    // A menu's layout overrides the document-wide default field by field, so
    // submenus can inherit the main menu's banner/style without repeating it.
    function effectiveLayout(menu) {
        var merged = {};
        [menuDoc.Layout, menu.Layout].forEach(function (src) {
            Object.keys(src || {}).forEach(function (k) {
                if (src[k] !== null && src[k] !== undefined) {
                    merged[k] = src[k];
                }
            });
        });
        return merged;
    }

    // Splits entries into pages for a grid of `slots` cells. 'back' entries are
    // pinned to every page (like a disc's Return button). Navigation buttons
    // take cells too, so a page's capacity shrinks by Back, Previous (after the
    // first page) and More (when more follows). Pure function: easy to test.
    function paginate(entries, slots, maxPerPage) {
        var maxPer = maxPerPage > 0 ? maxPerPage : Infinity;
        // The first 'back' and the first 'home' are pinned, in entry order; any
        // further ones are ordinary entries. That caps the pinned buttons at
        // Back + Home + Previous + More = 4, so a grid of (pinned + 3) cells
        // always leaves room for at least one entry per page (the loader
        // enforces that minimum).
        var firstBack = entries.filter(function (e) { return e.Action === 'back'; })[0];
        var firstHome = entries.filter(function (e) { return e.Action === 'home'; })[0];
        var backs = entries.filter(function (e) { return e === firstBack || e === firstHome; });
        var content = entries.filter(function (e) { return backs.indexOf(e) < 0; });
        var pages = [];
        var taken = 0;
        for (;;) {
            var navBase = backs.length + (pages.length > 0 ? 1 : 0);
            var left = content.length - taken;
            var room = slots - navBase;
            if (left <= Math.min(room, maxPer)) {
                pages.push({ items: content.slice(taken), backs: backs, prev: pages.length > 0, more: false });
                return pages;
            }

            var capacity = Math.min(Math.max(1, room - 1), maxPer);
            pages.push({ items: content.slice(taken, taken + capacity), backs: backs, prev: pages.length > 0, more: true });
            taken += capacity;
        }
    }

    // Centre of grid cell `slot` inside the flow region, as a position the
    // normal place() understands.
    function cellPosition(flow, slot, tall) {
        var r = flow.Region;
        var shift = ANCHOR_SHIFT[r.Anchor || 'top-left'] || ANCHOR_SHIFT['top-left'];
        var left = r.X + (shift[0] / 100) * r.W;
        var top = r.Y + (shift[1] / 100) * r.H;
        var cw = r.W / flow.Columns;
        var ch = r.H / flow.Rows;
        return {
            X: left + ((slot % flow.Columns) + 0.5) * cw,
            Y: top + (Math.floor(slot / flow.Columns) + 0.5) * ch,
            W: cw * 0.94,
            H: tall ? ch * 0.94 : null,
            Anchor: 'center',
        };
    }

    // The entries to draw for this menu right now, each with its on-screen
    // position when the menu is laid out by flow (paged) rather than by hand.
    function entriesForPage(menu, layout, menuKey) {
        var flow = layout.Flow;
        if (!flow) {
            return { entries: menu.Entries, pages: 1, page: 0 };
        }

        var slots = flow.Columns * flow.Rows;
        var pages = paginate(menu.Entries, slots, menu.MaxPerPage);
        var page = Math.min(menuPage[menuKey] || 0, pages.length - 1);
        menuPage[menuKey] = page;
        var p = pages[page];

        var nav = p.backs.slice();
        if (p.prev) {
            nav.push({ Action: 'pagePrev', Label: flow.PreviousLabel || 'Previous' });
        }

        if (p.more) {
            nav.push({ Action: 'pageNext', Label: flow.MoreLabel || 'More' });
        }

        var placed = [];
        p.items.forEach(function (e, i) {
            placed.push(Object.assign({}, e, { Position: cellPosition(flow, i, !!(e.Image || e.ThumbUrl)) }));
        });
        // Navigation sits in the last cells of the grid, in a stable order.
        nav.forEach(function (e, j) {
            placed.push(Object.assign({}, e, { Position: cellPosition(flow, slots - nav.length + j, !!e.Image) }));
        });
        return { entries: placed, pages: pages.length, page: page };
    }

    // ---- Trailer video background ---------------------------------------------
    // The video lives in its own fixed layer *under* the menu overlay, not inside
    // it, because the overlay is rebuilt on every page/submenu change: a video
    // inside would restart each time. Like a disc, it keeps looping across menus
    // and goes away when the menu closes or playback starts.

    var videoKey = null;
    var videoFrame = null;
    var YT_ORIGIN = 'https://www.youtube-nocookie.com';

    function removeVideo() {
        var el = document.getElementById(VIDEO_ID);
        if (el) {
            el.remove();
        }

        videoKey = null;
        videoFrame = null;
    }

    function chooseTrailer(background) {
        var trailers = (menuDoc && menuDoc.Trailers) || [];
        return trailers[background.TrailerIndex || 0] || null;
    }

    // Cover-fit a 16:9 video into any screen shape (an iframe has no object-fit).
    var COVER_CSS =
        'position:absolute;top:50%;left:50%;width:max(100vw,177.78vh);height:max(100vh,56.25vw);' +
        'transform:translate(-50%,-50%);border:0;object-fit:cover;opacity:0;transition:opacity 0.8s;' +
        'pointer-events:none;';

    function buildYouTube(videoId, muted, reveal, giveUp) {
        var frame = document.createElement('iframe');
        var params = [
            'autoplay=1', 'mute=' + (muted ? 1 : 0), 'controls=0', 'loop=1', 'playlist=' + videoId,
            'playsinline=1', 'rel=0', 'cc_load_policy=0', 'modestbranding=1', 'disablekb=1', 'iv_load_policy=3', 'fs=0',
            'enablejsapi=1', 'origin=' + encodeURIComponent(window.location.origin),
        ];
        frame.src = YT_ORIGIN + '/embed/' + videoId + '?' + params.join('&');
        frame.setAttribute('allow', 'autoplay; encrypted-media');
        frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.title = '';
        frame.style.cssText = COVER_CSS;

        // Ask the embedded player to report its state so we can reveal it only
        // once it is really playing, and drop it if embedding is refused.
        function hideCaptions() {
            // 'captions' is the current module name, 'cc' the older one; asking to
            // unload one that isn't present is harmless.
            ['captions', 'cc'].forEach(function (module) {
                try {
                    frame.contentWindow.postMessage(
                        JSON.stringify({ event: 'command', func: 'unloadModule', args: [module] }), YT_ORIGIN);
                } catch (e) {
                    // frame already gone
                }
            });
        }

        frame.addEventListener('load', function () {
            try {
                frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN);
            } catch (e) {
                reveal();
            }

            hideCaptions();
        });
        frame.discMenusOnMessage = function (data) {
            if (data.event === 'onError') {
                console.warn('[Disc Menus] YouTube refused to play this trailer (error ' + data.info + '); keeping the poster');
                giveUp();
            } else if (
                (data.event === 'onStateChange' && data.info === 1) ||
                (data.event === 'infoDelivery' && data.info && data.info.playerState === 1)
            ) {
                reveal();
                // The captions module loads once playback begins, so ask again now.
                hideCaptions();
                setTimeout(hideCaptions, 1000);
            }
        };
        return frame;
    }

    function buildLocalVideo(itemId, muted, reveal, giveUp) {
        var video = document.createElement('video');
        video.muted = muted;
        video.autoplay = true;
        video.loop = true;
        video.playsInline = true;
        video.setAttribute('aria-hidden', 'true');
        video.tabIndex = -1;
        video.style.cssText = COVER_CSS;
        video.src = ApiClient.getUrl('Videos/' + itemId + '/stream', { static: true, api_key: ApiClient.accessToken() });
        // A local trailer file may carry embedded subtitle tracks; keep them all off.
        function hideTracks() {
            var tracks = video.textTracks;
            for (var i = 0; tracks && i < tracks.length; i++) {
                tracks[i].mode = 'disabled';
            }
        }

        if (video.textTracks && video.textTracks.addEventListener) {
            video.textTracks.addEventListener('addtrack', hideTracks);
        }

        video.addEventListener('loadedmetadata', hideTracks);
        video.addEventListener('playing', hideTracks);
        video.addEventListener('playing', reveal);
        video.addEventListener('error', function () {
            console.warn('[Disc Menus] the browser could not play this trailer file directly; keeping the poster');
            giveUp();
        });
        return video;
    }

    // Make the video layer match what the current menu's background wants:
    // keep it untouched if it's the same trailer, replace it if it changed,
    // remove it if the menu has no trailer background.
    function syncVideo(background) {
        if (!background || background.Source !== 'trailer') {
            removeVideo();
            return;
        }

        var trailer = chooseTrailer(background);
        var muted = background.Muted !== false || (PREVIEW && previewMuted);
        var poster = safeImage(background.Poster);
        var key = [trailer ? trailer.Kind + ':' + (trailer.VideoId || trailer.ItemId) : 'none', muted, poster].join('|');
        if (videoKey === key && document.getElementById(VIDEO_ID)) {
            return;
        }

        removeVideo();
        videoKey = key;

        var layer = document.createElement('div');
        layer.id = VIDEO_ID;
        layer.setAttribute('aria-hidden', 'true');
        layer.style.cssText =
            'position:fixed;inset:0;z-index:9998;overflow:hidden;pointer-events:none;background-color:#000;' +
            (poster ? 'background-image:url(' + poster + ');background-size:cover;background-position:center;' : '');
        document.body.appendChild(layer);

        if (!trailer) {
            console.info('[Disc Menus] this item has no usable trailer; showing the poster only');
            return;
        }

        var media = null;
        function reveal() {
            if (media) {
                media.style.opacity = '1';
            }
        }

        function giveUp() {
            if (media) {
                media.remove();
                media = null;
                videoFrame = null;
            }
        }

        if (trailer.Kind === 'youtube' && trailer.VideoId) {
            media = buildYouTube(trailer.VideoId, muted, reveal, giveUp);
            videoFrame = media;
            // If the player never reports anything (messaging blocked), show it
            // anyway after a while rather than leave the poster up forever.
            setTimeout(function () {
                if (media && videoFrame === media && !media.discMenusHeard) {
                    reveal();
                }
            }, 6000);
        } else if (trailer.Kind === 'local' && trailer.ItemId && window.ApiClient) {
            media = buildLocalVideo(trailer.ItemId, muted, reveal, giveUp);
        }

        if (media) {
            layer.appendChild(media);
        }
    }

    // Messages from the YouTube player; only ever trust our own frame's.
    window.addEventListener('message', function (e) {
        if (!videoFrame || e.origin !== YT_ORIGIN || e.source !== videoFrame.contentWindow) {
            return;
        }

        var data;
        try {
            data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        } catch (err) {
            return;
        }

        if (data && typeof data === 'object') {
            videoFrame.discMenusHeard = true;
            videoFrame.discMenusOnMessage(data);
        }
    });

    // ---- Audio -----------------------------------------------------------------
    // Opt-in: nothing plays unless the menu (or the document default) sets
    // audio. Music persists across menus that name the same track, like the
    // trailer video, and everything stops when the menu closes. Browsers only
    // allow audio after a user gesture; the viewer's click on "Disc Menu"
    // counts, so this starts after it.

    var music = { key: null, el: null };
    var currentSounds = null;
    var audioCtx = null;
    var soundBuffers = {};
    var lastMoveSound = 0;

    var SAFE_AUDIO = /^(https:\/\/[^\s"'()<>\\]+|asset:[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}\.(mp3|ogg|opus|m4a|wav))$/;

    function clamp01(v, fallback) {
        return typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
    }

    // Same defence in depth as images: only hand the browser URLs we'd vouch for.
    function safeAudio(ref) {
        if (typeof ref !== 'string' || !SAFE_AUDIO.test(ref)) {
            return null;
        }

        if (ref.indexOf('asset:') === 0) {
            return window.ApiClient
                ? ApiClient.getUrl('DiscMenus/Assets/' + ref.slice(6).split('/').map(encodeURIComponent).join('/'))
                : null;
        }

        return ref;
    }

    // A menu's own audio replaces the document default per part: its music
    // replaces the default music, its sounds replace the default sounds.
    function audioConfigFor(menu) {
        var base = (menuDoc && menuDoc.Audio) || {};
        var own = menu.Audio || {};
        return { Music: own.Music || base.Music || null, Sounds: own.Sounds || base.Sounds || null };
    }

    function resolveMusicUrl(m) {
        if (!m) {
            return null;
        }

        if (m.Source === 'file') {
            return safeAudio(m.File);
        }

        if (m.Source === 'themeSong') {
            var songs = (menuDoc && menuDoc.ThemeSongs) || [];
            return songs.length > 0 && window.ApiClient
                ? ApiClient.getUrl('Audio/' + songs[0] + '/stream', { static: true, api_key: ApiClient.accessToken() })
                : null;
        }

        return null;
    }

    function fadeVolume(el, to, ms, done) {
        if (el.discMenusFade) {
            clearInterval(el.discMenusFade);
        }

        var from = el.volume;
        var steps = Math.max(1, Math.round(ms / 40));
        var i = 0;
        el.discMenusFade = setInterval(function () {
            i++;
            el.volume = Math.min(1, Math.max(0, from + ((to - from) * i) / steps));
            if (i >= steps) {
                clearInterval(el.discMenusFade);
                el.discMenusFade = null;
                if (done) {
                    done();
                }
            }
        }, 40);
    }

    function stopMusic(fadeMs) {
        var el = music.el;
        music = { key: null, el: null };
        if (!el) {
            return;
        }

        fadeVolume(el, 0, fadeMs, function () {
            el.pause();
            el.removeAttribute('src');
        });
    }

    function syncMusic(spec) {
        if (PREVIEW && previewMuted) {
            spec = null;
        }

        var url = spec && spec.Source !== 'none' ? resolveMusicUrl(spec) : null;
        if (!url) {
            stopMusic(600);
            return;
        }

        var volume = clamp01(spec.Volume, 0.5);
        if (music.el && music.key === url) {
            fadeVolume(music.el, volume, 400);
            return;
        }

        stopMusic(600); // the old track fades out while the new one fades in
        var el = new Audio();
        el.loop = true;
        el.preload = 'auto';
        el.volume = 0;
        el.src = url;
        music = { key: url, el: el };
        var started = el.play();
        if (started && started.catch) {
            started.catch(function () {
                console.info('[Disc Menus] the browser blocked music autoplay');
            });
        }

        fadeVolume(el, volume, 800);
    }

    // Built-in button sounds, synthesised in the browser so a menu needs no
    // audio files for basic feedback. Each tone: frequency, wave, length, level, delay.
    var SOUND_PRESETS = {
        click: {
            move: [{ f: 1500, t: 'square', d: 0.025, g: 0.5 }],
            select: [{ f: 1100, t: 'square', d: 0.04, g: 0.6 }, { f: 700, t: 'square', d: 0.05, g: 0.5, at: 0.04 }],
            back: [{ f: 600, t: 'square', d: 0.05, g: 0.6 }],
        },
        chime: {
            move: [{ f: 1320, t: 'sine', d: 0.12, g: 0.4 }],
            select: [{ f: 880, t: 'sine', d: 0.2, g: 0.6 }, { f: 1320, t: 'sine', d: 0.3, g: 0.5, at: 0.08 }],
            back: [{ f: 660, t: 'sine', d: 0.2, g: 0.5 }, { f: 440, t: 'sine', d: 0.25, g: 0.5, at: 0.08 }],
        },
        beep: {
            move: [{ f: 880, t: 'sine', d: 0.04, g: 0.5 }],
            select: [{ f: 1040, t: 'sine', d: 0.09, g: 0.6 }],
            back: [{ f: 520, t: 'sine', d: 0.09, g: 0.6 }],
        },
    };

    function audioContext() {
        if (!audioCtx) {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) {
                return null;
            }

            try {
                audioCtx = new Ctx();
            } catch (e) {
                return null;
            }
        }

        if (audioCtx.state === 'suspended' && audioCtx.resume) {
            audioCtx.resume();
        }

        return audioCtx;
    }

    function playTones(tones, volume) {
        var ctx = audioContext();
        if (!ctx) {
            return;
        }

        var now = ctx.currentTime;
        tones.forEach(function (n) {
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            var start = now + (n.at || 0);
            osc.type = n.t;
            osc.frequency.value = n.f;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume * n.g * 0.3), start + 0.005);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + n.d);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + n.d + 0.02);
        });
    }

    function playElement(url, volume) {
        var a = new Audio(url);
        a.volume = volume;
        var p = a.play();
        if (p && p.catch) {
            p.catch(function () { /* blocked or unsupported: stay silent */ });
        }
    }

    function playBuffer(buffer, volume) {
        var ctx = audioContext();
        if (!ctx) {
            return;
        }

        var src = ctx.createBufferSource();
        var gain = ctx.createGain();
        src.buffer = buffer;
        gain.gain.value = volume;
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start();
    }

    // A sound file is decoded once and replayed from memory so repeated clicks
    // don't re-download it; if decoding fails (e.g. a cross-origin file without
    // CORS) fall back to a plain <audio> element.
    function playFileSound(url, volume) {
        var cached = soundBuffers[url];
        if (cached === 'loading') {
            return;
        }

        if (cached === 'failed' || !window.fetch || !audioContext()) {
            playElement(url, volume);
            return;
        }

        if (cached) {
            playBuffer(cached, volume);
            return;
        }

        soundBuffers[url] = 'loading';
        fetch(url)
            .then(function (r) { return r.arrayBuffer(); })
            .then(function (data) { return audioContext().decodeAudioData(data); })
            .then(function (buffer) {
                soundBuffers[url] = buffer;
                playBuffer(buffer, volume);
            })
            .catch(function () {
                soundBuffers[url] = 'failed';
                playElement(url, volume);
            });
    }

    // kind: 'move' | 'select' | 'back'
    function playSound(kind) {
        var s = currentSounds;
        if (!s || (PREVIEW && previewMuted)) {
            return;
        }

        if (kind === 'move') {
            var t = Date.now();
            if (t - lastMoveSound < 45) {
                return; // key repeat shouldn't machine-gun
            }

            lastMoveSound = t;
        }

        var volume = clamp01(s.Volume, 0.5);
        var file = safeAudio(kind === 'move' ? s.Move : kind === 'back' ? s.Back : s.Select);
        if (file) {
            playFileSound(file, volume);
            return;
        }

        var preset = s.Preset && s.Preset !== 'none' ? SOUND_PRESETS[s.Preset] : null;
        if (preset) {
            playTones(preset[kind], volume);
        }
    }

    function soundKindFor(entry) {
        return entry.Action === 'back' || entry.Action === 'home' || entry.Action === 'pagePrev' ? 'back' : 'select';
    }

    // ---- Transitions -----------------------------------------------------------
    // The buttons and title (the "screen") animate; the background, any trailer
    // video, and layers shared by both menus stay put. Uses the Web Animations
    // API with fixed keyframes chosen by name - menu JSON never supplies CSS.

    function prefersReducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    // dir: 'forward' (into a submenu / next page) or 'back'.
    var TRANSITIONS = {
        fade: function () {
            return { out: [{ opacity: 1 }, { opacity: 0 }], 'in': [{ opacity: 0 }, { opacity: 1 }] };
        },
        slide: function (dir) {
            var s = dir === 'back' ? -1 : 1;
            return {
                out: [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(' + -8 * s + '%)' }],
                'in': [{ opacity: 0, transform: 'translateX(' + 8 * s + '%)' }, { opacity: 1, transform: 'translateX(0)' }],
            };
        },
        rise: function (dir) {
            var s = dir === 'back' ? -1 : 1;
            return {
                out: [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(' + -6 * s + '%)' }],
                'in': [{ opacity: 0, transform: 'translateY(' + 6 * s + '%)' }, { opacity: 1, transform: 'translateY(0)' }],
            };
        },
        zoom: function (dir) {
            var back = dir === 'back';
            return {
                out: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(' + (back ? 0.92 : 1.08) + ')' }],
                'in': [{ opacity: 0, transform: 'scale(' + (back ? 1.08 : 0.92) + ')' }, { opacity: 1, transform: 'scale(1)' }],
            };
        },
        wipe: function (dir) {
            var from = dir === 'back' ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)';
            return {
                out: [{ opacity: 1 }, { opacity: 0 }],
                'in': [{ clipPath: from }, { clipPath: 'inset(0 0 0 0)' }],
            };
        },
    };

    function transitionFor(layout) {
        var t = layout.Transition;
        var style = t && TRANSITIONS[t.Style] ? t.Style : 'none';
        var ms = t && typeof t.DurationMs === 'number' ? t.DurationMs : 300;
        return { style: style, ms: ms };
    }

    // Take the previous screen out of play at once (no focus, no clicks, not
    // announced), then remove it when its exit animation ends.
    function retireScreen(screen, frames, ms) {
        screen.classList.add('leaving');
        screen.setAttribute('aria-hidden', 'true');
        screen.style.pointerEvents = 'none';
        Array.prototype.forEach.call(screen.querySelectorAll('.discMenuEntry'), function (b) {
            b.classList.remove('discMenuEntry');
            b.tabIndex = -1;
            b.disabled = true;
        });
        var done = function () {
            if (screen.parentNode) {
                screen.remove();
            }
        };
        if (frames && screen.animate) {
            var anim = screen.animate(frames, { duration: ms, easing: 'ease-in', fill: 'forwards' });
            anim.onfinish = done;
            setTimeout(done, ms + 150); // safety: never leave a ghost screen behind
        } else {
            done();
        }
    }

    // how: 'intro' (menu opening), 'forward', 'back', or omitted for no animation.
    function renderOverlay(parentItemId, how) {
        var menuKey = menuStack[menuStack.length - 1];
        var menu = menuDoc.Menus[menuKey] || virtualMenus[menuKey];
        if (!menu) {
            return;
        }

        var existing = document.getElementById(OVERLAY_ID);
        var overlay = existing || document.createElement('div');
        overlay.id = OVERLAY_ID;

        // Whatever is still animating out from a previous change goes now; the
        // screen currently showing becomes the one we transition away from.
        Array.prototype.forEach.call(overlay.querySelectorAll('.discMenusScreen.leaving'), function (s) { s.remove(); });
        var previous = existing ? overlay.querySelector('.discMenusScreen') : null;

        var theme = menu.Theme || menuDoc.Theme || {};
        var align = theme.Align || 'left';
        var alignItems = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
        var background = menu.Background || menuDoc.Background;
        var layout = effectiveLayout(menu);
        var defaultStyle = layout.ButtonStyle || 'frame';
        var shown = entriesForPage(menu, layout, menuKey).entries;
        // The server guarantees all-or-none (and flow menus have no hand positions),
        // so one check is enough.
        var positioned = shown.length > 0 && shown.every(function (e) { return !!e.Position; });
        var transition = transitionFor(layout);
        var animate = transition.style !== 'none' && transition.ms > 0 && !prefersReducedMotion() &&
            typeof overlay.animate === 'function';

        var bgCss = backgroundStyle(background, parentItemId);
        var previousBg = overlay.getAttribute('data-bg');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;color:#fff;overflow:hidden;' + bgCss;
        overlay.setAttribute('data-bg', bgCss);
        // Pages can have different backgrounds. The overlay already shows the new
        // one, so lay the old picture over it and fade that away: a crossfade.
        if (existing) {
            // A fade still in flight is stale now; drop it before starting another.
            Array.prototype.forEach.call(overlay.querySelectorAll('.discMenusBgFade'), function (g) { g.remove(); });
        }

        if (existing && previousBg && previousBg !== bgCss && animate) {
            var ghost = document.createElement('div');
            ghost.className = 'discMenusBgFade';
            ghost.setAttribute('aria-hidden', 'true');
            ghost.style.cssText = 'position:absolute;inset:0;pointer-events:none;' + previousBg;
            overlay.insertBefore(ghost, overlay.firstChild);
            var fading = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: transition.ms, easing: 'ease-in', fill: 'forwards' });
            var dropGhost = function () { if (ghost.parentNode) { ghost.remove(); } };
            fading.onfinish = dropGhost;
            setTimeout(dropGhost, transition.ms + 150);
        }

        syncVideo(background);
        var audio = audioConfigFor(menu);
        currentSounds = audio.Sounds;
        syncMusic(audio.Music);

        if (!existing) {
            var closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.textContent = '✕';
            closeBtn.setAttribute('aria-label', 'Close disc menu');
            closeBtn.style.cssText =
                'position:absolute;top:1.5em;right:1.5em;background:none;border:none;color:#fff;' +
                'font-size:1.5em;cursor:pointer;line-height:1;z-index:1;';
            closeBtn.tabIndex = -1;
            closeBtn.addEventListener('click', closeOverlay);
            overlay.appendChild(closeBtn);
        }

        // Layers (e.g. a banner) are shared by menus that declare the same
        // ones, so they only change - and fade - when the set actually differs.
        var layersKey = JSON.stringify(layout.Layers || []);
        if (!existing || overlay.getAttribute('data-layers') !== layersKey) {
            var oldLayers = overlay.querySelector('.discMenusLayers');
            if (oldLayers) {
                oldLayers.remove();
            }

            var layersEl = document.createElement('div');
            layersEl.className = 'discMenusLayers';
            layersEl.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
            (layout.Layers || []).forEach(function (layer) {
                renderLayer(layer, layersEl);
            });
            overlay.insertBefore(layersEl, overlay.querySelector('.discMenusScreen'));
            overlay.setAttribute('data-layers', layersKey);
            if (animate && existing && layersEl.animate) {
                layersEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: transition.ms, easing: 'ease-out' });
            }
        }

        // Everything that belongs to one menu screen lives in one element so it
        // can be animated in and out as a unit.
        var screen = document.createElement('div');
        screen.className = 'discMenusScreen';
        screen.style.cssText =
            'position:absolute;inset:0;' +
            (positioned
                ? ''
                : 'display:flex;flex-direction:column;justify-content:center;align-items:' + alignItems + ';padding:4em;');

        if (!layout.HideTitle) {
            var title = document.createElement('h1');
            title.textContent = menu.Title;
            title.style.cssText =
                'margin:0 0 0.75em;font-size:2em;text-shadow:0 2px 8px rgba(0,0,0,0.8);color:' +
                safeColor(theme.TextColor, '#fff') + ';' + typographyCss(theme);
            if (typeof theme.FontSize === 'number') {
                title.style.fontSize = theme.FontSize * 1.6 + 'vh';
            }
            if (layout.TitlePosition) {
                title.style.margin = '0';
                place(title, layout.TitlePosition);
            }

            screen.appendChild(title);
        }

        var list = positioned ? screen : document.createElement('div');
        if (!positioned) {
            list.style.cssText = 'display:flex;flex-direction:column;gap:0.5em;';
        }

        shown.forEach(function (entry, entryIndex) {
            var btn = buildEntryButton(entry, defaultStyle, theme, align);
            if (positioned) {
                place(btn, entry.Position);
            }

            btn.addEventListener('focus', function () {
                lastFocusIndex[menuKey] = entryIndex;
            });
            // Keep mouse and keyboard/remote highlight in sync.
            // Only on real pointer movement: a menu appearing under a resting
            // cursor fires mouseenter without the user moving, which would
            // steal focus from the keyboard/remote.
            btn.addEventListener('mousemove', function (e) {
                if (e.screenX === lastMouse.x && e.screenY === lastMouse.y) {
                    return;
                }

                lastMouse.x = e.screenX;
                lastMouse.y = e.screenY;
                if (document.activeElement !== btn) {
                    btn.focus();
                    playSound('move');
                }
            });
            btn.addEventListener('click', function () {
                // Remember what was activated even where clicking doesn't focus a
                // button (Safari, touch), so Back returns to it.
                lastFocusIndex[menuKey] = entryIndex;
                playSound(soundKindFor(entry));
                handleEntry(entry, parentItemId);
            });
            list.appendChild(btn);
        });

        if (!positioned) {
            screen.appendChild(list);
        }

        overlay.appendChild(screen);

        if (!existing) {
            document.body.appendChild(overlay);
            window.addEventListener('keydown', onKeyDown, true);
            if (!gamepadLoop) {
                gamepadLoop = requestAnimationFrame(pollGamepad);
            }
        }

        if (previous) {
            // Crossfade-style: the old screen exits while the new one enters.
            var frames = animate && how && how !== 'intro' ? TRANSITIONS[transition.style](how) : null;
            retireScreen(previous, frames ? frames.out : null, transition.ms);
            if (frames) {
                screen.animate(frames['in'], { duration: transition.ms, easing: 'ease-out' });
            }
        } else if (animate && how === 'intro') {
            screen.animate(TRANSITIONS[transition.style]('forward')['in'], { duration: transition.ms, easing: 'ease-out' });
        }

        notifyEditor('navigate', { menu: menuKey });

        // Like a disc remembering its highlighted button: returning to a menu
        // lands on the entry you left it from (e.g. 'Special Features' after Back).
        var entryEls = screen.querySelectorAll('.discMenuEntry');
        var remembered = entryEls[lastFocusIndex[menuKey]] || entryEls[0];
        if (remembered) {
            remembered.focus();
        }
    }

    function navigateToItem(itemId) {
        closeOverlay();
        window.location.hash = '#/details?id=' + itemId;
    }

    // One-click playback via the Sessions API: find this browser's own session
    // (matched by device id) and send it a PlayNow command - no access to
    // jellyfin-web's internal playbackManager needed. Falls back to navigating
    // to the item's details page if anything about that fails.
    var returnPoll = null;

    function stopReturnPoll() {
        if (returnPoll) {
            clearInterval(returnPoll);
            returnPoll = null;
        }
    }

    // Tell the editor around the preview what happened inside it (it can't see our state).
    function notifyEditor(type, data) {
        if (!PREVIEW || window.parent === window) {
            return;
        }

        var message = { source: 'discmenus-preview', type: type };
        Object.keys(data || {}).forEach(function (k) { message[k] = data[k]; });
        try {
            window.parent.postMessage(message, window.location.origin);
        } catch (e) {
            // not embedded
        }
    }

    function playItems(itemIds, parentItemId, startTicks) {
        if (PREVIEW) {
            notifyEditor('play', { itemIds: itemIds, startTicks: startTicks || 0 });
            return;
        }

        var deviceId = ApiClient.deviceId();
        var savedStack = menuStack.slice();

        ApiClient.getJSON(ApiClient.getUrl('Sessions', { DeviceId: deviceId })).then(function (sessions) {
            var session = sessions && sessions[0];
            if (!session) {
                throw new Error('no session for this device');
            }

            return ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('Sessions/' + session.Id + '/Playing', {
                    PlayCommand: 'PlayNow',
                    ItemIds: itemIds.join(','),
                    StartPositionTicks: startTicks > 0 ? Math.floor(startTicks) : undefined,
                }),
            }).then(function () {
                closeOverlay();
                watchForPlaybackEnd(session.Id, parentItemId, savedStack);
            });
        }).catch(function (err) {
            console.warn('[Disc Menus] Sessions API playback failed, falling back to details page', err);
            navigateToItem(itemIds[0]);
        });
    }

    // Reopen the menu where the user left it once playback stops, like a disc
    // returning to its menu. Waits for playback to actually start first so the
    // brief gap before NowPlayingItem appears isn't mistaken for "ended".
    function watchForPlaybackEnd(sessionId, parentItemId, savedStack) {
        stopReturnPoll();
        var started = false;
        var ticks = 0;

        returnPoll = setInterval(function () {
            ticks++;
            ApiClient.getJSON(ApiClient.getUrl('Sessions')).then(function (sessions) {
                var s = (sessions || []).filter(function (x) { return x.Id === sessionId; })[0];
                var playing = !!(s && s.NowPlayingItem);
                if (playing) {
                    started = true;
                } else if (started || ticks > 15) {
                    stopReturnPoll();
                    if (started) {
                        window.location.hash = '#/details?id=' + parentItemId;
                        setTimeout(function () {
                            menuStack = savedStack;
                            renderOverlay(parentItemId, 'intro');
                        }, 600);
                    }
                }
            });
        }, 2000);
    }

    function alertUnavailable(message) {
        if (PREVIEW) {
            notifyEditor('message', { text: message });
            return;
        }

        if (window.Dashboard && Dashboard.alert) {
            Dashboard.alert(message);
        } else {
            window.alert(message);
        }
    }

    function formatTicks(ticks) {
        var total = Math.floor((ticks || 0) / 10000000);
        var h = Math.floor(total / 3600);
        var m = Math.floor((total % 3600) / 60);
        var sec = total % 60;
        return (h > 0 ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    // Build and open a scene-selection screen from the feature's chapters. It is
    // an ordinary flow menu (so it gets paging, Back/Home and remote navigation
    // for free) generated at activation time; an optional styling menu supplies
    // its title/background/theme/layout. Kept in virtualMenus, not the loaded
    // document, because that document is re-fetched after playback.
    function openSceneSelection(entry, parentItemId) {
        var chapters = (menuDoc && menuDoc.Chapters) || [];
        if (chapters.length === 0) {
            alertUnavailable("This title has no chapter markers.");
            return;
        }

        var base = entry.Menu ? menuDoc.Menus[entry.Menu] : null;
        var perPage = entry.PerPage || 6;
        var items = chapters.map(function (c, i) {
            var thumb = null;
            if (c.HasImage && window.ApiClient) {
                thumb = ApiClient.getUrl('Items/' + parentItemId + '/Images/Chapter/' + c.Index, {
                    maxWidth: 480,
                    tag: c.ImageStamp != null ? c.ImageStamp : undefined,
                });
            }

            return {
                Action: 'playChapter',
                Label: c.Name || 'Chapter ' + (i + 1),
                Sub: formatTicks(c.StartTicks),
                StartTicks: c.StartTicks,
                ThumbUrl: thumb,
            };
        });

        var layout = Object.assign({}, base && base.Layout);
        if (!layout.Flow && !(menuDoc.Layout && menuDoc.Layout.Flow)) {
            // Default grid: perPage thumbnails plus a navigation row's worth of cells.
            var slots = perPage + 3;
            var columns = perPage <= 3 ? Math.max(1, perPage) : perPage <= 8 ? 3 : 4;
            layout.Flow = {
                Region: { X: 50, Y: 52, W: 86, H: 68, Anchor: 'center' },
                Columns: columns,
                Rows: Math.ceil(slots / columns),
            };
        }

        var key = '@chapters:' + (entry.Menu || '');
        virtualMenus[key] = Object.assign({}, base || {}, {
            Title: (base && base.Title) || entry.Label,
            Layout: layout,
            Entries: items.concat(base ? base.Entries : [{ Action: 'back', Label: 'Back' }]),
            MaxPerPage: perPage,
        });
        menuStack.push(key);
        menuPage[key] = 0;
        delete lastFocusIndex[key];
        renderOverlay(parentItemId, 'forward');
    }

    function startTicksForChapter(number) {
        var chapters = (menuDoc && menuDoc.Chapters) || [];
        var c = number > 0 ? chapters[number - 1] : null;
        return c ? c.StartTicks : 0;
    }

    function handleEntry(entry, parentItemId) {
        switch (entry.Action) {
            case 'playFeature':
                playItems([parentItemId], parentItemId, startTicksForChapter(entry.StartChapter));
                break;
            case 'playChapter':
                playItems([parentItemId], parentItemId, entry.StartTicks);
                break;
            case 'playExtra':
                if (entry.ItemId) {
                    playItems([entry.ItemId], parentItemId);
                } else {
                    alertUnavailable("This extra isn't linked to a local file yet.");
                }

                break;
            case 'playSequence':
                if (entry.ItemIds && entry.ItemIds.length > 0) {
                    playItems(entry.ItemIds, parentItemId);
                } else {
                    alertUnavailable("None of these extras are linked to a local file yet.");
                }

                break;
            case 'submenu':
                if (entry.Menu && menuDoc.Menus[entry.Menu]) {
                    menuStack.push(entry.Menu);
                    menuPage[entry.Menu] = 0;
                    delete lastFocusIndex[entry.Menu];
                    renderOverlay(parentItemId, 'forward');
                }

                break;
            case 'back':
                goBack(parentItemId, false);
                break;
            case 'home':
                // Straight to the root menu, whatever depth we're at. The root keeps
                // its remembered highlight, so Home lands on the button you left it from.
                menuStack = [menuDoc.Root];
                menuPage = {};
                renderOverlay(parentItemId, 'back');
                break;
            case 'pageNext':
            case 'pagePrev':
                var pageKey = menuStack[menuStack.length - 1];
                menuPage[pageKey] = (menuPage[pageKey] || 0) + (entry.Action === 'pageNext' ? 1 : -1);
                lastFocusIndex[pageKey] = 0;
                renderOverlay(parentItemId, entry.Action === 'pageNext' ? 'forward' : 'back');
                break;
            case 'chapters':
                openSceneSelection(entry, parentItemId);
                break;
            default:
                break;
        }
    }

    // ---- Preview API (used by the editor page) ------------------------------------
    // A document the renderer can't draw (no root menu) is ignored, so a bad message can never blank the preview.
    function previewUsable(doc) {
        return !!(doc && doc.Menus && doc.Root && doc.Menus[doc.Root]);
    }

    function previewShow(doc, parentItemId) {
        if (!previewUsable(doc)) {
            return;
        }

        var existing = document.getElementById(OVERLAY_ID);
        if (existing) {
            existing.remove();
            window.removeEventListener('keydown', onKeyDown, true);
        }

        menuDoc = doc;
        currentParentItemId = parentItemId || 'preview';
        virtualMenus = {};
        menuStack = [doc.Root];
        lastFocusIndex = {};
        menuPage = {};
        preloadBackgrounds(currentParentItemId);
        renderOverlay(currentParentItemId, 'intro');
    }

    // Swap in an edited menu without losing where the author is: same menu, same page, no replay of
    // the intro. If the menu being viewed no longer exists, fall back to the root.
    function previewUpdate(doc, parentItemId) {
        if (!previewUsable(doc)) {
            return;
        }

        if (!document.getElementById(OVERLAY_ID)) {
            previewShow(doc, parentItemId);
            return;
        }

        menuDoc = doc;
        if (parentItemId) {
            currentParentItemId = parentItemId;
        }

        // Generated screens (scene selection) are rebuilt from the menu, so leave them behind.
        menuStack = menuStack.filter(function (k) { return !!doc.Menus[k]; });
        if (menuStack.length === 0 || menuStack[0] !== doc.Root) {
            menuStack = [doc.Root];
        }

        virtualMenus = {};
        preloadBackgrounds(currentParentItemId);
        renderOverlay(currentParentItemId);
    }

    function previewGoTo(key) {
        if (!menuDoc || !menuDoc.Menus[key]) {
            return;
        }

        menuStack = key === menuDoc.Root ? [key] : [menuDoc.Root, key];
        menuPage[key] = 0;
        delete lastFocusIndex[key];
        renderOverlay(currentParentItemId);
    }

    function previewSetMuted(muted) {
        previewMuted = !!muted;
        if (menuDoc && document.getElementById(OVERLAY_ID)) {
            renderOverlay(currentParentItemId);
        }
    }

    if (PREVIEW) {
        window.DiscMenusPreview = { show: previewShow, update: previewUpdate, goTo: previewGoTo, setMuted: previewSetMuted };
        notifyEditor('ready');
    } else {
        window.addEventListener('hashchange', checkForMenu);
        waitForApiClient(checkForMenu);
    }

    console.log('[Disc Menus] renderer script loaded');
})();
