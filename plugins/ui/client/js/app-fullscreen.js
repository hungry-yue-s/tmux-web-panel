var AppFullscreen = (function () {
  var initialized = false;
  var nativeFullscreenActive = false;

  function _buttons() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-app-fullscreen]'));
  }

  function _fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function _requestMethod() {
    var root = document.documentElement;
    return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  }

  function _exitMethod() {
    return document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  }

  function _nativeHandler() {
    try {
      var handlers = window.webkit && window.webkit.messageHandlers;
      var handler = handlers && handlers.tmuxPanelAction;
      return handler && typeof handler.postMessage === 'function' ? handler : null;
    } catch (_err) {
      return null;
    }
  }

  function isActive() {
    if (_nativeHandler()) return nativeFullscreenActive;
    return _fullscreenElement() === document.documentElement;
  }

  function _lockTerminalEscape() {
    if (!navigator.keyboard || typeof navigator.keyboard.lock !== 'function') return;
    try {
      var lock = navigator.keyboard.lock(['Escape']);
      if (lock && lock.catch) lock.catch(function () {});
    } catch (_err) {}
  }

  function _unlockKeyboard() {
    if (!navigator.keyboard || typeof navigator.keyboard.unlock !== 'function') return;
    try { navigator.keyboard.unlock(); } catch (_err) {}
  }

  function sync() {
    var active = isActive();
    var supported = !!_nativeHandler() || !!_requestMethod();
    _buttons().forEach(function (button) {
      button.disabled = !supported;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.setAttribute('aria-label', supported
        ? (active ? '退出全屏显示' : '全屏显示面板')
        : '当前浏览器不支持全屏显示');
      button.title = supported
        ? (active ? '退出全屏显示' : '全屏显示面板')
        : '当前浏览器不支持全屏显示';
    });
    if (!active) _unlockKeyboard();
  }

  function _invoke(method, context) {
    if (!method) return Promise.resolve(false);
    try {
      return Promise.resolve(method.call(context)).then(function () { return true; });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function _showFailure(err) {
    var buttons = _buttons();
    buttons.forEach(function (button) {
      button.classList.add('has-error');
      button.title = '无法切换全屏' + (err && err.message ? '：' + err.message : '');
    });
    setTimeout(function () {
      buttons.forEach(function (button) { button.classList.remove('has-error'); });
      sync();
    }, 2400);
  }

  function toggle() {
    var nativeHandler = _nativeHandler();
    if (nativeHandler) {
      try {
        nativeHandler.postMessage({ action: 'toggleFullscreen' });
        return Promise.resolve(true);
      } catch (err) {
        _showFailure(err);
        return Promise.resolve(false);
      }
    }

    var current = _fullscreenElement();
    var method = current ? _exitMethod() : _requestMethod();
    var context = current ? document : document.documentElement;

    if (!method) {
      _showFailure(new Error('当前浏览器不支持全屏 API'));
      return Promise.resolve(false);
    }

    if (current) _unlockKeyboard();

    return _invoke(method, context)
      .then(function (changed) {
        if (!current && changed) _lockTerminalEscape();
        return changed;
      })
      .catch(function (err) {
        _showFailure(err);
        return false;
      });
  }

  function init() {
    if (initialized) return;
    initialized = true;

    document.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('[data-app-fullscreen]');
      if (!button || button.disabled) return;
      toggle();
    });
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    document.addEventListener('tmux-panel-native-fullscreen', function (event) {
      nativeFullscreenActive = !!(event.detail && event.detail.active);
      sync();
    });
    sync();
  }

  return {
    init: init,
    toggle: toggle,
    sync: sync,
    isActive: isActive,
  };
})();
