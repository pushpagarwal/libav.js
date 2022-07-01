/*
 * Copyright (C) 2019-2021 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

(function() {
    function isWebAssemblySupported() {
        try {
            if (typeof WebAssembly === "object" &&
                    typeof WebAssembly.instantiate === "function") {
                var module = new WebAssembly.Module(
                        new Uint8Array([0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
                if (module instanceof WebAssembly.Module)
                    return new WebAssembly.Instance(module) instanceof WebAssembly.Instance;
            }
        } catch (e) {
        }
        return false;
    }

    var libav;
    var base = ".";
    var nodejs = (typeof process !== "undefined");

    // Make sure LibAV is defined for later loading
    if (typeof LibAV === "undefined")
        LibAV = {};
    libav = LibAV;

    if (libav.base)
        base = libav.base;

    // Now start making our instance generating function
    libav.LibAV = function(opts) {
        opts = opts || {};
        var wasm = !opts.nowasm && isWebAssemblySupported();
        var ret;

        return Promise.all([]).then(function() {
            // Step one: Get LibAV loaded
            if (!libav.LibAVFactory) {
                var toImport = base + "/libav-@VER-@CONFIG." + (wasm?"w":"") + "asm.js";
                if (nodejs) {
                    // Node.js: Load LibAV now
                    libav.LibAVFactory = require(toImport);

                } else if (typeof Worker !== "undefined" && !opts.noworker) {
                    // Worker: Nothing to load now

                } else if (typeof importScripts !== "undefined") {
                    // Worker scope. Import it.
                    importScripts(toImport);
                    libav.LibAVFactory = LibAVFactory;

                } else {
                    // Web: Load the script
                    return new Promise(function(res, rej) {
                        var scr = document.createElement("script");
                        scr.src = toImport;
                        scr.addEventListener("load", res);
                        scr.addEventListener("error", rej);
                        scr.async = true;
                        document.body.appendChild(scr);
                    }).then(function() {
                        libav.LibAVFactory = LibAVFactory;

                    });

                }
            }

        }).then(function() {
            // Step two: Create the underlying instance
            if (!nodejs && typeof Worker !== "undefined" && !opts.noworker) {
                // Worker thread
                ret = {};

                // Load the worker
                ret.worker = new Worker(base + "/libav-@VER-@CONFIG." + (wasm?"w":"") + "asm.js");

                // Report our readiness
                return new Promise(function(res, rej) {
                    var ready = 0;

                    // Our handlers
                    ret.on = 1;
                    ret.handlers = {
                        onready: [function() {
                            res();
                        }, null],
                        onwrite: [function(args) {
                            if (ret.onwrite)
                                ret.onwrite.apply(ret, args);
                        }, null]
                    };

                    // And passthru functions
                    ret.c = function() {
                        var msg = Array.prototype.slice.call(arguments);
                        return new Promise(function(res, rej) {
                            var id = ret.on++;
                            msg = [id].concat(msg);
                            ret.handlers[id] = [res, rej];
                            ret.worker.postMessage(msg);
                        });
                    };
                    function onworkermessage(e) {
                        var id = e.data[0];
                        var h = ret.handlers[id];
                        if (h) {
                            if (e.data[2])
                                h[0](e.data[3]);
                            else
                                h[1](e.data[3]);
                            if (typeof id === "number")
                                delete ret.handlers[id];
                        }
                    };
                    ret.worker.onmessage = onworkermessage;

                    // And termination
                    ret.terminate = function() {
                        ret.worker.terminate();
                    };
                });

            } else { // Not Workers
                // Start with a real instance
                return Promise.all([]).then(function() {
                    // Annoyingly, Emscripten's "Promise" isn't really a Promise
                    return new Promise(function(res) {
                        libav.LibAVFactory().then(function(x) {
                            delete x.then;
                            res(x);
                        });
                    });
                }).then(function(x) {
                    ret = x;
                    ret.worker = false;

                    // Simple wrappers
                    ret.c = function(func) {
                        var args = Array.prototype.slice.call(arguments, 1);
                        return new Promise(function(res, rej) {
                            try {
                                res(ret[func].apply(ret, args));
                            } catch (ex) {
                                rej(ex);
                            }
                        });
                    };

                    // No termination
                    ret.terminate = function() {};
                });

            }

        }).then(function() {
            // Step three: Add wrappers to the instance(s)

            // Our direct function wrappers
            @FUNCS.forEach(function(f) {
                if (ret[f]) {
                    var real = ret[f + "_sync"] = ret[f];
                    ret[f] = function() {
                        var args = arguments;
                        return new Promise(function(res, rej) {
                            try {
                                var p = real.apply(ret, args);
                                if (typeof p === "object" && p !== null && p.then)
                                    p.then(res).catch(rej);
                                else
                                    res(p);
                            } catch (ex) {
                                rej(ex);
                            }
                        });
                    }

                } else {
                    ret[f] = function() {
                        return ret.c.apply(ret, [f].concat(Array.prototype.slice.call(arguments)));
                    };

                }
            });

            // Some enumerations lifted directly from FFmpeg
            function enume(vals, first) {
                if (typeof first === undefined)
                    first = 0;
                var i = first;
                vals.forEach(function(val) {
                    ret[val] = i++;
                });
            }

            // AV_OPT
            ret.AV_OPT_SEARCH_CHILDREN = 1;

            @ENUMS

            // AVIO_FLAGs
            ret.AVIO_FLAG_READ = 1;
            ret.AVIO_FLAG_WRITE = 2;
            ret.AVIO_FLAG_READ_WRITE = 3;
            ret.AVIO_FLAG_NONBLOCK = 8;
            ret.AVIO_FLAG_DIRECT = 0x8000;

            // Errors
            ret.EAGAIN = 6;
            ret.AVERROR_EOF = -0x20464f45;

            return ret;
        });
    }

    if (nodejs)
        module.exports = libav;

})();
