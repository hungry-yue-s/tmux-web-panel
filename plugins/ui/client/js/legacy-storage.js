// Anymux was called tmux-web-panel, and this browser may still hold its
// settings under the old twp_ prefix. Each moves to the anymux_ name once (a
// value already saved under the new name wins) before any other script reads
// it, which is why this loads first.
(function () {
  var storage;
  try { storage = window.localStorage; } catch (_e) { return; }
  if (!storage) return;
  try {
    var keys = [];
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (key && key.indexOf('twp_') === 0) keys.push(key);
    }
    keys.forEach(function (key) {
      var next = 'anymux_' + key.slice('twp_'.length);
      if (storage.getItem(next) === null) storage.setItem(next, storage.getItem(key));
      storage.removeItem(key);
    });
  } catch (_e) { /* full or blocked storage: the old values stay where they are */ }
})();
