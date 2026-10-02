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

    // Original placeholder art, different for every seed: a graded backdrop with a projector beam, soft glows, film-edge
    // sprocket holes and a vignette (which also keeps button text readable). Labelled, so nobody mistakes it for the menu's real look.
    function seeded(seed) {
        var a = C.hash(seed) || 1;
        return function () {
            a = (a + 0x6D2B79F5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function art(seed, kind) {
        var key = kind + '|' + seed;
        if (cache[key]) {
            return cache[key];
        }

        var big = kind === 'background';
        var w = big ? 960 : 480, h = big ? 540 : 270;
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var g = canvas.getContext('2d');
        var rnd = seeded(seed);
        var hue = Math.floor(rnd() * 360), hue2 = (hue + 35 + Math.floor(rnd() * 60)) % 360;

        var base = g.createLinearGradient(0, 0, 0, h);
        base.addColorStop(0, 'hsl(' + hue + ',48%,20%)');
        base.addColorStop(1, 'hsl(' + hue2 + ',55%,7%)');
        g.fillStyle = base;
        g.fillRect(0, 0, w, h);

        for (var i = 0; i < 2; i++) {
            var cx = rnd() * w, cy = (0.35 + rnd() * 0.5) * h, r = (0.35 + rnd() * 0.3) * w;
            var glow = g.createRadialGradient(cx, cy, 0, cx, cy, r);
            glow.addColorStop(0, 'hsla(' + (i ? hue2 : hue) + ',75%,58%,0.30)');
            glow.addColorStop(1, 'hsla(' + (i ? hue2 : hue) + ',75%,58%,0)');
            g.fillStyle = glow;
            g.fillRect(0, 0, w, h);
        }

        // the projector beam: a cone of light from above, widening to the floor
        var bx = w * (0.3 + rnd() * 0.4), spread = w * (0.28 + rnd() * 0.2);
        var beam = g.createLinearGradient(0, 0, 0, h);
        beam.addColorStop(0, 'rgba(255,255,255,0.28)');
        beam.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = beam;
        g.beginPath();
        g.moveTo(bx - w * 0.015, 0);
        g.lineTo(bx + w * 0.015, 0);
        g.lineTo(bx + spread, h);
        g.lineTo(bx - spread, h);
        g.closePath();
        g.fill();

        if (big) {
            // film edges with sprocket holes
            var band = h * 0.075, hole = band * 0.42, gap = hole * 2.3;
            g.fillStyle = 'rgba(0,0,0,0.45)';
            g.fillRect(0, 0, w, band);
            g.fillRect(0, h - band, w, band);
            g.fillStyle = 'rgba(255,255,255,0.16)';
            for (var x = gap / 2; x < w; x += gap) {
                g.fillRect(x, (band - hole) / 2, hole * 1.3, hole);
                g.fillRect(x, h - band + (band - hole) / 2, hole * 1.3, hole);
            }
        }

        var vig = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
        vig.addColorStop(0, 'rgba(0,0,0,0)');
        vig.addColorStop(1, 'rgba(0,0,0,0.6)');
        g.fillStyle = vig;
        g.fillRect(0, 0, w, h);

        if (big) {
            g.fillStyle = 'rgba(255,255,255,0.32)';
            g.font = '13px system-ui,sans-serif';
            g.textAlign = 'right';
            g.fillText('placeholder art', w - 14, h - h * 0.075 - 8);
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
