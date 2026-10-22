(function (global) {
  var landscape = global.matchMedia && global.matchMedia('(pointer: coarse) and (max-height: 560px) and (max-width: 1023px)');
  var MobileUI = {
    isMobile: function () { return global.innerWidth < 768 || !!(landscape && landscape.matches); },
    syncViewport: function () {
      var viewport = global.visualViewport;
      var root = global.document.documentElement;
      var mobile = MobileUI.isMobile();
      if (root.classList.contains('mobile-layout') !== mobile) {
        global.document.querySelectorAll('.mobile-server-operations').forEach(function (operations) { operations.open = !mobile; });
      }
      var focused = global.document.activeElement;
      var editing = focused && focused.matches('input,textarea,[contenteditable="true"]');
      root.classList.toggle('mobile-layout', mobile);
      root.classList.toggle('mobile-keyboard-open', !!(mobile && viewport && editing && global.innerHeight - viewport.height > 120));
      root.style.setProperty('--mobile-viewport-height', (viewport ? viewport.height : global.innerHeight) + 'px');
      root.style.setProperty('--mobile-viewport-top', (viewport ? viewport.offsetTop : 0) + 'px');
    },
  };
  global.MobileUI = MobileUI;
  global.addEventListener('resize', MobileUI.syncViewport);
  global.document.addEventListener('focusin', MobileUI.syncViewport);
  global.document.addEventListener('focusout', function () { global.requestAnimationFrame(MobileUI.syncViewport); });
  if (global.visualViewport) {
    global.visualViewport.addEventListener('resize', MobileUI.syncViewport);
    global.visualViewport.addEventListener('scroll', MobileUI.syncViewport);
  }
  MobileUI.syncViewport();
})(window);
