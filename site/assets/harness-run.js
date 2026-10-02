// Loads one published menu, swaps its pictures for generated placeholders, and hands it to the renderer.
(function () {
    'use strict';
    var C = window.PreviewCore;
    var realTmdb = document.body.dataset.realTmdb === '1';
    var base = document.body.dataset.base;
    var cache = {};

    function fail(text) {
        var p = document.createElement('p');
        p.className = 'frame-error';
        p.textContent = text;
        document.body.appendChild(p);
    }

    // Original placeholder art: a gradient with soft glows, different for every seed. Labelled, so nobody mistakes it
    // for the menu's real look.
    function art(seed, kind) {
        var key = kind + '|' + seed;
        if (cache[key]) {
            return cache[key];
        }

        var w = kind === 'background' ? 960 : 480, h = kind === 'background' ? 540 : 270;
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var g = canvas.getContext('2d');
        var hue = C.hash(seed) % 360;
        var base1 = g.createLinearGradient(0, 0, w, h);
        base1.addColorStop(0, 'hsl(' + hue + ',45%,24%)');
        base1.addColorStop(1, 'hsl(' + ((hue + 55) % 360) + ',55%,9%)');
        g.fillStyle = base1;
        g.fillRect(0, 0, w, h);
        for (var i = 0; i < 3; i++) {
            var n = C.hash(seed + i);
            var cx = (n % 100) / 100 * w, cy = ((n >>> 7) % 100) / 100 * h, r = (0.25 + ((n >>> 14) % 40) / 100) * w;
            var glow = g.createRadialGradient(cx, cy, 0, cx, cy, r);
            glow.addColorStop(0, 'hsla(' + ((hue + 30 * i) % 360) + ',70%,60%,0.28)');
            glow.addColorStop(1, 'hsla(' + ((hue + 30 * i) % 360) + ',70%,60%,0)');
            g.fillStyle = glow;
            g.fillRect(0, 0, w, h);
        }

        if (kind === 'background') {
            g.fillStyle = 'rgba(255,255,255,0.35)';
            g.font = '14px system-ui,sans-serif';
            g.textAlign = 'right';
            g.fillText('placeholder art', w - 12, h - 10);
        }

        cache[key] = canvas.toDataURL('image/png');
        return cache[key];
    }

    var path = new URLSearchParams(window.location.search).get('menu');
    if (!C.validMenuPath(path)) {
        fail('This preview can only show a menu published in the catalogue.');
        return;
    }

    fetch(base + path)
        .then(function (r) {
            if (!r.ok) {
                throw new Error('status ' + r.status);
            }

            return r.json();
        })
        .then(function (menu) {
            var doc = C.placeholderize(window.MenuToRenderable.toRenderable(menu), art, { realTmdb: realTmdb });
            window.DiscMenusPreview.setMuted(true);
            window.DiscMenusPreview.show(doc, 'preview');
            // Escape on the first screen closes the overlay, which in a page of its own would leave a black box:
            // bring the menu back instead, as it returns after playback on a real server.
            new MutationObserver(function () {
                if (!document.getElementById('discMenusOverlay')) {
                    window.setTimeout(function () {
                        if (!document.getElementById('discMenusOverlay')) {
                            window.DiscMenusPreview.show(doc, 'preview');
                        }
                    }, 150);
                }
            }).observe(document.body, { childList: true });
        })
        .catch(function (err) {
            console.error('[preview]', err);
            fail('The preview could not load this menu.');
        });
})();
