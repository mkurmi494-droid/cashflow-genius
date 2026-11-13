// Cashflow Genius service worker — cashflow-genius-sw v1.
//
// What it does, honestly:
//  - makes the app installable (a fetch handler is part of the web
//    installability criteria) and gives it an app-like offline shell;
//  - navigations are NETWORK-FIRST: a new deploy is picked up on the
//    next open, and the cached shell is only a fallback when the
//    network is unreachable;
//  - same-origin static files under assets/ (JS, CSS, the intro video,
//    the PWA icons and this manifest) are stale-while-revalidate;
//  - everything else — above all the /actions API calls that carry the
//    user's live records — is NEVER cached and always goes to the
//    network, so money data can never be served stale from this cache.
var CACHE = "cashflow-genius-sw-v1";
var SHELL = ["./", "./index.html"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        return cache.addAll(SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      })
      .catch(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k !== CACHE;
            })
            .map(function (k) {
              return caches.delete(k);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return; // actions / POSTs: straight to network
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fonts etc.: browser handles

  if (req.mode === "navigate") {
    // Network-first so updates land immediately; cached shell offline.
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put("./index.html", copy);
          });
          return res;
        })
        .catch(function () {
          return caches.match("./index.html").then(function (hit) {
            return hit || caches.match("./");
          });
        }),
    );
    return;
  }

  if (url.pathname.indexOf("/assets/") !== -1) {
    // Static bundle files: serve cache instantly, refresh in background.
    event.respondWith(
      caches.match(req).then(function (hit) {
        var network = fetch(req)
          .then(function (res) {
            if (res && res.status === 200) {
              var copy = res.clone();
              caches.open(CACHE).then(function (cache) {
                cache.put(req, copy);
              });
            }
            return res;
          })
          .catch(function () {
            return hit;
          });
        return hit || network;
      }),
    );
  }
  // All other GETs (including the actions endpoint) pass through.
});
