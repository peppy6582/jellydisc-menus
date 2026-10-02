/*
 * The logic of the menu preview that needs no browser: which menu files may be loaded, how a menu's pictures are
 * swapped for generated placeholder art, the stand-in for Jellyfin's ApiClient, and how a click is described.
 * Works in a browser (global PreviewCore) and in Node (module.exports), so it is tested directly.
 *
 * The preview never fetches anything from outside this site: backgrounds from Jellyfin, TMDB or a trailer, and any
 * art file a menu refers to, become placeholders. The one exception is the visitor's explicit choice to show real
 * TMDB backdrops (realTmdb), which only the separate frame page with a matching content-security policy allows.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.PreviewCore = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Only a published menu file, by the path the index gives: never an arbitrary URL.
    var MENU_PATH = /^v1\/menus\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[1-9][0-9]{0,5}\.menu\.json$/;
    // Keys (as the renderer sees them, PascalCase) whose string value is a picture.
    var PICTURE_KEYS = { Image: 1, ImageFocus: 1, Poster: 1 };
    // Keys whose string value is a sound; an external one becomes silence.
    var SOUND_KEYS = { File: 1, Move: 1, Select: 1, Back: 1 };
    var REPLACED_SOURCES = { jellyfin: 1, trailer: 1, tmdb: 1, fanart: 1 };

    function validMenuPath(p) {
        return typeof p === 'string' && MENU_PATH.test(p);
    }

    function isObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    // Returns a copy of a renderer document in which nothing refers to anything outside the page.
    //   art(seed, kind) -> a data:image/png URL; kind is 'background' or 'panel'
    function placeholderize(doc, art, options) {
        var realTmdb = !!(options && options.realTmdb);

        function walk(node, seed) {
            if (Array.isArray(node)) {
                return node.map(function (v, i) { return walk(v, seed + '/' + i); });
            }

            if (!isObject(node)) {
                return node;
            }

            var out = {};
            Object.keys(node).forEach(function (k) {
                if (k === '__proto__') {
                    return;
                }

                var v = node[k];
                var here = seed + '/' + k;
                if (k === 'Background' && isObject(v)) {
                    out[k] = background(v, here);
                } else if (PICTURE_KEYS[k] && typeof v === 'string' && !/^data:image\//.test(v)) {
                    out[k] = art(here, 'panel');
                } else if (SOUND_KEYS[k] && typeof v === 'string' && /^(https?:)?\/\//i.test(v)) {
                    out[k] = 'asset:silence/none.wav';
                } else {
                    out[k] = walk(v, here);
                }
            });
            return out;
        }

        function background(b, seed) {
            var source = b.Source;
            var keep = source === 'color' || source === 'none' || (source === 'tmdb' && realTmdb)
                || (source === 'image' && typeof b.Image === 'string' && /^data:image\//.test(b.Image));
            if (keep) {
                return walk(b, seed);
            }

            if (source === 'image' || REPLACED_SOURCES[source]) {
                return { Source: 'image', Image: art(seed, 'background'), Dim: typeof b.Dim === 'number' ? b.Dim : 0.4 };
            }

            return { Source: 'color', Color: '#101010' };
        }

        return walk(doc, 'menu');
    }

    var AUDIO_EXT = /\.(wav|mp3|ogg|opus|m4a|aac|flac)$/i;

    // Stands in for Jellyfin's ApiClient. Sounds and music become silence; everything else resolves to nothing.
    function fakeApiClient(silence) {
        return {
            getUrl: function (path) {
                var p = String(path || '');
                if ((p.indexOf('DiscMenus/Assets/') === 0 && AUDIO_EXT.test(p)) || /^Audio\/[^/]+\/stream/.test(p)) {
                    return silence;
                }

                return '';
            },
            getImageUrl: function () { return ''; },
            getJSON: function () { return Promise.resolve([]); },
            ajax: function () { return Promise.resolve(); },
            deviceId: function () { return 'preview'; },
            accessToken: function () { return ''; },
        };
    }

    // A silent mono 8-bit WAV of about a tenth of a second, as a data URL.
    function silentWav() {
        var samples = 800, bytes = [];
        function u32(n) { bytes.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255); }
        function u16(n) { bytes.push(n & 255, (n >> 8) & 255); }
        function text(s) { for (var i = 0; i < s.length; i++) { bytes.push(s.charCodeAt(i)); } }
        text('RIFF'); u32(36 + samples); text('WAVE'); text('fmt '); u32(16); u16(1); u16(1); u32(8000); u32(8000); u16(1); u16(8);
        text('data'); u32(samples);
        for (var i = 0; i < samples; i++) { bytes.push(128); }
        var bin = '';
        bytes.forEach(function (b) { bin += String.fromCharCode(b); });
        return 'data:audio/wav;base64,' + btoa(bin);
    }

    function clock(sec) {
        if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) {
            return '';
        }

        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
        return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    // What a click on "play" would do, in words. `extras` is MenuToRenderable.fakeExtras(menu).
    function describePlay(itemIds, extras) {
        var names = (Array.isArray(itemIds) ? itemIds : []).map(function (id) {
            var x = extras && Object.prototype.hasOwnProperty.call(extras, id) ? extras[id] : null;
            if (!x) {
                return 'the feature';
            }

            var detail = [x.type, clock(x.durationSec)].filter(Boolean).join(', ');
            return String(x.key) + (detail ? ' (' + detail + ')' : '');
        });
        if (names.length === 0) {
            return 'Playback is not available in the preview.';
        }

        return 'Playing would start: ' + names.join(', then ') + '. (Playback is not available in the preview.)';
    }

    // A small stable number from text, for choosing colours.
    function hash(text) {
        var h = 2166136261;
        for (var i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }

        return h >>> 0;
    }

    return {
        validMenuPath: validMenuPath, placeholderize: placeholderize, fakeApiClient: fakeApiClient, silentWav: silentWav,
        describePlay: describePlay, hash: hash, clock: clock,
    };
});
