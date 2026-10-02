// The controls around a menu's preview: fit the 1920x1080 frame to the page, jump between screens, mute, say what a
// click would do, and (only if the visitor asks) switch to the frame that may show real TMDB backdrops.
(function () {
    'use strict';
    var box = document.getElementById('preview');
    if (!box) {
        return;
    }

    var C = window.PreviewCore;
    var base = document.body.dataset.base;
    var menuPath = box.dataset.menu;
    var frame = document.getElementById('preview-frame');
    var stage = document.getElementById('preview-stage');
    var status = document.getElementById('preview-status');
    var muteBtn = document.getElementById('preview-mute');
    var tmdb = document.getElementById('preview-tmdb');
    var muted = true;
    var extras = {};

    if (!C.validMenuPath(menuPath)) {
        return;
    }

    function api() {
        try { return frame.contentWindow.DiscMenusPreview || null; } catch (e) { return null; }
    }

    function fit() {
        var scale = stage.clientWidth / 1920;
        if (scale > 0) {
            frame.style.transform = 'scale(' + scale + ')';
        }
    }

    function load() {
        var page = tmdb && tmdb.checked ? 'preview/frame-tmdb/' : 'preview/frame/';
        frame.src = base + page + '?menu=' + encodeURIComponent(menuPath);
    }

    function say(text) {
        status.textContent = text;
    }

    frame.addEventListener('load', function () {
        fit();
        muted = true;
        muteBtn.textContent = 'Sound: off';
        muteBtn.setAttribute('aria-pressed', 'false');
    });
    window.addEventListener('resize', fit);
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(fit).observe(stage);
    }

    muteBtn.addEventListener('click', function () {
        var p = api();
        if (!p) {
            return;
        }

        muted = !muted;
        p.setMuted(muted);
        muteBtn.textContent = muted ? 'Sound: off' : 'Sound: on';
        muteBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-screen]'), function (b) {
        b.addEventListener('click', function () {
            var p = api();
            if (p) {
                p.goTo(b.dataset.screen);
            }
        });
    });

    if (tmdb) {
        tmdb.addEventListener('change', load);
    }

    document.getElementById('preview-focus').addEventListener('click', function () {
        frame.focus();
        try { frame.contentWindow.focus(); } catch (e) { /* not ready yet */ }
    });

    window.addEventListener('message', function (e) {
        if (e.origin !== window.location.origin || e.source !== frame.contentWindow) {
            return;
        }

        var m = e.data;
        if (!m || m.source !== 'discmenus-preview') {
            return;
        }

        if (m.type === 'navigate' && typeof m.menu === 'string') {
            say('Screen: ' + m.menu);
        } else if (m.type === 'play') {
            say(C.describePlay(m.itemIds, extras));
        } else if (m.type === 'message' && typeof m.text === 'string') {
            say(m.text);
        }
    });

    // What the stand-in ids mean, so a click can say what it would have played.
    fetch(base + menuPath).then(function (r) { return r.json(); }).then(function (menu) {
        extras = window.MenuToRenderable.fakeExtras(menu);
    }).catch(function () { /* the status line just stays generic */ });

    load();
})();
