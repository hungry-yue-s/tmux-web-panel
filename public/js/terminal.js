/* global Terminal, FitAddon, WebLinksAddon, WebglAddon, Theme, Auth, api, state, navigate, escapeHtml, renderPaneLayout, renderPanePills */

// === Clipboard Helper ===

function _copyToClipboard(text) {
  // Method 1: Clipboard API (works in secure contexts)
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(function () {});
    return;
  }
  // Method 2: execCommand fallback (works in HTTP)
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); } catch (_e) { /* ignore */ }
  document.body.removeChild(ta);
}

// === Toast Notification ===

function _showToast(message, duration) {
  duration = duration || 2000;
  var existing = document.querySelector('.upload-toast');
  if (existing) existing.remove();

  var toast = document.createElement('div');
  toast.className = 'upload-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(function () {
    toast.classList.add('show');
  });

  setTimeout(function () {
    toast.classList.remove('show');
    setTimeout(function () { toast.remove(); }, 300);
  }, duration);
}

// === FAB Tool Panel ===

var _fabDefaultKeys = [
  { label: 'Esc',    send: '\x1b' },
  { label: 'C-c',    send: '\x03' },
  { label: 'y',      send: 'y\r', color: 'green' },
  { label: 'n',      send: 'n\r', color: 'red' },
  { label: '\u7ee7\u7eed', send: '\u7ee7\u7eed\r', accent: true },
  { label: '\u21b5',  send: '\r' },
  { label: 'S-Tab',  send: '\x1b[Z' },
  { label: '\ud83c\udf99', send: '__voice__', accent: true },
  { label: '\u22ef \u66f4\u591a', send: '__drawer__', accent: true, wide: true },
];

var _fabPresets = [
  { label: 'Tab',  send: '\x09' },
  { label: 'Esc',  send: '\x1b' },
  { label: 'C-c',  send: '\x03' },
  { label: 'C-d',  send: '\x04' },
  { label: 'C-z',  send: '\x1a' },
  { label: 'C-l',  send: '\x0c' },
  { label: 'C-a',  send: '\x01' },
  { label: 'C-e',  send: '\x05' },
  { label: 'C-r',  send: '\x12' },
  { label: 'C-w',  send: '\x17' },
  { label: '\u2191', send: '\x1b[A' },
  { label: '\u2193', send: '\x1b[B' },
  { label: '\u2190', send: '\x1b[D' },
  { label: '\u2192', send: '\x1b[C' },
  { label: '~',    send: '~' },
  { label: '|',    send: '|' },
  { label: '/',    send: '/' },
  { label: '\u7ee7\u7eed', send: '\u7ee7\u7eed\r' },
];

var _drawerDefaultQuickKeys = [
  { label: 'claude', send: 'claude --allow-dangerously-skip-permissions\r', cls: 'accent-blue' },
  { label: '\ud83d\udcce \u4e0a\u4f20', send: '__upload__' },
  { label: 'Tab', send: '\x09' },
  { label: 'C-d', send: '\x04' },
];

var _drawerDefaultCommands = [
  { label: '/compact', send: '/compact\r' },
  { label: '/clear', send: '/clear\r' },
  { label: '/help', send: '/help\r' },
  { label: '/commit', send: '/commit\r' },
  { label: '/review-pr', send: '/review-pr\r' },
  { label: '/work-log', send: '/work-log\r' },
  { label: '/deploy-android-container', send: '/deploy-android-container\r' },
];

var _drawerDefaultTemplates = [
  { label: '\u8bf7\u68c0\u67e5\u5e76\u4fee\u590d\u5f53\u524d\u7684\u9519\u8bef', send: '\u8bf7\u68c0\u67e5\u5e76\u4fee\u590d\u5f53\u524d\u7684\u9519\u8bef\r' },
  { label: '\u8bf7\u89e3\u91ca\u8fd9\u6bb5\u4ee3\u7801\u7684\u4f5c\u7528', send: '\u8bf7\u89e3\u91ca\u8fd9\u6bb5\u4ee3\u7801\u7684\u4f5c\u7528\r' },
  { label: '\u8bb0\u5f55\u5de5\u4f5c\u65e5\u5fd7', send: '\u8bb0\u5f55\u5de5\u4f5c\u65e5\u5fd7\r' },
];

function _loadDrawerQuickKeys() {
  try {
    var s = localStorage.getItem('fab-drawer-quickkeys');
    if (s) return JSON.parse(s);
  } catch (_e) { /* ignore */ }
  return _drawerDefaultQuickKeys.map(function (k) { return Object.assign({}, k); });
}

function _saveDrawerQuickKeys(keys) {
  localStorage.setItem('fab-drawer-quickkeys', JSON.stringify(keys));
}

function _loadDrawerCommands() {
  try {
    var s = localStorage.getItem('fab-drawer-commands');
    if (s) return JSON.parse(s);
  } catch (_e) { /* ignore */ }
  return _drawerDefaultCommands.map(function (c) { return Object.assign({}, c); });
}

function _saveDrawerCommands(cmds) {
  localStorage.setItem('fab-drawer-commands', JSON.stringify(cmds));
}

function _loadDrawerTemplates() {
  try {
    var s = localStorage.getItem('fab-drawer-templates');
    if (s) return JSON.parse(s);
  } catch (_e) { /* ignore */ }
  return _drawerDefaultTemplates.map(function (t) { return Object.assign({}, t); });
}

function _saveDrawerTemplates(tpls) {
  localStorage.setItem('fab-drawer-templates', JSON.stringify(tpls));
}

function _loadFabKeys() {
  try {
    var s = localStorage.getItem('fab-keys');
    if (s) return JSON.parse(s);
  } catch (_e) { /* ignore */ }
  return _fabDefaultKeys.map(function (k) { return Object.assign({}, k); });
}

function _saveFabKeys(keys) {
  localStorage.setItem('fab-keys', JSON.stringify(keys));
}

function _displayEscape(s) {
  return s
    .replace(/\x1b/g, '\\x1b')
    .replace(/\x09/g, '\\x09')
    .replace(/[\x01-\x1a]/g, function (c) {
      return '\\x' + ('0' + c.charCodeAt(0).toString(16)).slice(-2);
    })
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function _parseEscape(s) {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n');
}

function _sendTermData(data) {
  if (terminalState.ws && terminalState.ws.readyState === WebSocket.OPEN) {
    terminalState.ws.send(JSON.stringify({ type: 'input', data: data }));
  }
}

function _createFabPanel(container) {
  var keys = _loadFabKeys();
  var isOpen = false;
  var editingIdx = -1;
  var longPressTimer = null;
  var longPressed = false;
  var repeatTimer = null;

  // -- File input for upload --
  var fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.style.display = 'none';
  container.appendChild(fileInput);

  fileInput.addEventListener('change', function () {
    if (!fileInput.files || !fileInput.files[0]) return;
    var file = fileInput.files[0];
    var formData = new FormData();
    formData.append('file', file);
    fabEl.classList.add('uploading');
    fetch('/api/upload', {
      method: 'POST',
      headers: Auth.headers(),
      body: formData,
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (j) { throw new Error(j.error || 'Upload failed'); });
        return res.json();
      })
      .then(function (result) {
        _copyToClipboard(result.data.path);
        _showToast('\u8def\u5f84\u5df2\u590d\u5236: ' + result.data.path);
      })
      .catch(function (err) {
        _showToast('\u4e0a\u4f20\u5931\u8d25: ' + err.message, 3000);
      })
      .finally(function () {
        fabEl.classList.remove('uploading');
      });
  });

  // -- Voice input (Web Speech API) --
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var voiceRecognition = null;
  var voiceActive = false;

  function _startVoice() {
    if (!SpeechRecognition) {
      _showToast('浏览器不支持语音输入', 2000);
      return;
    }
    if (voiceActive) {
      _stopVoice();
      return;
    }
    voiceRecognition = new SpeechRecognition();
    voiceRecognition.lang = 'en-US';
    voiceRecognition.continuous = true;
    voiceRecognition.interimResults = true;

    var voiceBtn = panelEl.querySelector('.voice-btn');

    voiceRecognition.onstart = function () {
      voiceActive = true;
      if (voiceBtn) voiceBtn.classList.add('recording');
      if (navigator.vibrate) navigator.vibrate(30);
    };

    voiceRecognition.onresult = function (event) {
      var last = event.results[event.results.length - 1];
      if (last.isFinal) {
        var text = last[0].transcript.trim();
        if (text) {
          _sendTermData(text);
          _showToast('语音: ' + text, 1500);
        }
      }
    };

    voiceRecognition.onerror = function (event) {
      console.error('SpeechRecognition error:', event.error, event);
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        _showToast('语音错误: ' + event.error, 3000);
      }
      _stopVoice();
    };

    voiceRecognition.onend = function () {
      _stopVoice();
    };

    voiceRecognition.start();
  }

  function _stopVoice() {
    voiceActive = false;
    if (voiceRecognition) {
      try { voiceRecognition.abort(); } catch (_e) { /* ignore */ }
      voiceRecognition = null;
    }
    var voiceBtn = panelEl.querySelector('.voice-btn');
    if (voiceBtn) voiceBtn.classList.remove('recording');
  }

  // -- Panel element --
  var panelEl = document.createElement('div');
  panelEl.className = 'fab-panel';
  container.appendChild(panelEl);

  function renderButtons() {
    panelEl.innerHTML = '';
    keys.forEach(function (k, i) {
      var btn = document.createElement('button');
      btn.textContent = k.label;
      btn.dataset.idx = i;
      if (k.accent) btn.classList.add('accent-btn');
      if (k.wide) btn.classList.add('wide');
      if (k.send === '__voice__') btn.classList.add('voice-btn');
      if (k.color) btn.classList.add('color-' + k.color);
      panelEl.appendChild(btn);
    });
  }
  renderButtons();

  // -- FAB button --
  var fabEl = document.createElement('div');
  fabEl.className = 'fab-tool';
  fabEl.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
  container.appendChild(fabEl);

  // -- Modal for customization --
  var modalEl = document.createElement('div');
  modalEl.className = 'fab-modal-overlay';
  modalEl.innerHTML =
    '<div class="fab-modal">' +
    '<h3>\u81ea\u5b9a\u4e49\u6309\u952e</h3>' +
    '<div class="fab-presets"><label>\u5feb\u901f\u9009\u62e9</label><div class="fab-presets-grid"></div></div>' +
    '<label>\u663e\u793a\u540d\u79f0</label>' +
    '<input type="text" class="fab-edit-label" placeholder="\u6309\u94ae\u4e0a\u663e\u793a\u7684\u6587\u5b57">' +
    '<label>\u53d1\u9001\u5185\u5bb9</label>' +
    '<input type="text" class="fab-edit-send" placeholder="\u53d1\u9001\u7684\u6587\u672c\u6216\u8f6c\u4e49\u5e8f\u5217">' +
    '<div class="fab-edit-hint">\\x03=C-c, \\x1b=Esc, \\r=\u56de\u8f66, \u6216\u4efb\u610f\u6587\u672c</div>' +
    '<div class="fab-modal-actions">' +
    '<button class="fab-btn-cancel">\u53d6\u6d88</button>' +
    '<button class="fab-btn-save">\u4fdd\u5b58</button>' +
    '</div>' +
    '<div class="fab-modal-reset"><button class="fab-btn-reset">\u6062\u590d\u9ed8\u8ba4</button></div>' +
    '</div>';
  container.appendChild(modalEl);

  var editLabel = modalEl.querySelector('.fab-edit-label');
  var editSend = modalEl.querySelector('.fab-edit-send');
  var presetsGrid = modalEl.querySelector('.fab-presets-grid');

  _fabPresets.forEach(function (p) {
    var btn = document.createElement('button');
    btn.textContent = p.label;
    btn.addEventListener('click', function () {
      editLabel.value = p.label;
      editSend.value = _displayEscape(p.send);
    });
    presetsGrid.appendChild(btn);
  });

  function openEditor(idx) {
    editingIdx = idx;
    editLabel.value = keys[idx].label;
    editSend.value = _displayEscape(keys[idx].send);
    modalEl.classList.add('show');
  }

  modalEl.querySelector('.fab-btn-cancel').addEventListener('click', function () {
    modalEl.classList.remove('show');
  });

  modalEl.querySelector('.fab-btn-save').addEventListener('click', function () {
    if (editingIdx < 0) return;
    keys[editingIdx].label = editLabel.value || '?';
    keys[editingIdx].send = _parseEscape(editSend.value);
    _saveFabKeys(keys);
    renderButtons();
    modalEl.classList.remove('show');
  });

  modalEl.querySelector('.fab-btn-reset').addEventListener('click', function () {
    if (editingIdx >= 0 && _fabDefaultKeys[editingIdx]) {
      keys[editingIdx] = Object.assign({}, _fabDefaultKeys[editingIdx]);
      _saveFabKeys(keys);
      renderButtons();
    }
    modalEl.classList.remove('show');
  });

  modalEl.addEventListener('click', function (e) {
    if (e.target === modalEl) modalEl.classList.remove('show');
  });

  // -- Drawer --
  var drawerQuickKeys = _loadDrawerQuickKeys();
  var drawerCommands = _loadDrawerCommands();
  var drawerTemplates = _loadDrawerTemplates();
  var g1grid = null;
  var drawerOpen = false;

  var backdropEl = document.createElement('div');
  backdropEl.className = 'fab-drawer-backdrop';
  container.appendChild(backdropEl);

  var drawerEl = document.createElement('div');
  drawerEl.className = 'fab-drawer';
  container.appendChild(drawerEl);

  // -- Drawer edit modal --
  var drawerModalEl = document.createElement('div');
  drawerModalEl.className = 'fab-drawer-modal-overlay';
  drawerModalEl.innerHTML =
    '<div class="fab-drawer-modal">' +
    '<h3 class="drawer-modal-title"></h3>' +
    '<label class="drawer-modal-label-1">\u663e\u793a\u540d\u79f0</label>' +
    '<input type="text" class="drawer-modal-input-1">' +
    '<label class="drawer-modal-label-2">\u53d1\u9001\u5185\u5bb9</label>' +
    '<input type="text" class="drawer-modal-input-2">' +
    '<div class="fab-drawer-modal-actions">' +
    '<button class="fab-btn-cancel">\u53d6\u6d88</button>' +
    '<button class="fab-btn-save">\u4fdd\u5b58</button>' +
    '</div>' +
    '</div>';
  container.appendChild(drawerModalEl);

  var dModalTitle = drawerModalEl.querySelector('.drawer-modal-title');
  var dModalInput1 = drawerModalEl.querySelector('.drawer-modal-input-1');
  var dModalLabel1 = drawerModalEl.querySelector('.drawer-modal-label-1');
  var dModalInput2 = drawerModalEl.querySelector('.drawer-modal-input-2');
  var dModalLabel2 = drawerModalEl.querySelector('.drawer-modal-label-2');
  var dModalSaveFn = null;

  drawerModalEl.querySelector('.fab-btn-cancel').addEventListener('click', function () {
    drawerModalEl.classList.remove('show');
  });

  drawerModalEl.querySelector('.fab-btn-save').addEventListener('click', function () {
    if (dModalSaveFn) dModalSaveFn();
    drawerModalEl.classList.remove('show');
  });

  drawerModalEl.addEventListener('click', function (e) {
    if (e.target === drawerModalEl) drawerModalEl.classList.remove('show');
  });

  function _showDrawerModal(title, label1, val1, label2, val2, saveFn) {
    dModalTitle.textContent = title;
    dModalLabel1.textContent = label1;
    dModalInput1.value = val1 || '';
    dModalLabel2.textContent = label2;
    dModalInput2.value = val2 || '';
    dModalSaveFn = saveFn;
    drawerModalEl.classList.add('show');
    setTimeout(function () { dModalInput1.focus(); }, 100);
  }

  function _handleDrawerBtn(send) {
    if (send === '__upload__') {
      fileInput.value = '';
      fileInput.click();
    } else {
      _sendTermData(send);
    }
    if (navigator.vibrate) navigator.vibrate(10);
    toggleDrawer(false);
  }

  function _attachRepeat(btn, send) {
    var rTimer = null;
    var rInterval = null;
    btn.addEventListener('touchstart', function (e) {
      e.stopPropagation();
      rTimer = setTimeout(function () {
        rInterval = setInterval(function () {
          _sendTermData(send);
          if (navigator.vibrate) navigator.vibrate(5);
        }, 80);
      }, 300);
    }, { passive: true });
    btn.addEventListener('touchend', function () {
      clearTimeout(rTimer);
      clearInterval(rInterval);
      rTimer = null;
      rInterval = null;
      _sendTermData(send);
      if (navigator.vibrate) navigator.vibrate(10);
    });
    btn.addEventListener('click', function () {
      if (!('ontouchstart' in window)) {
        _sendTermData(send);
        toggleDrawer(false);
      }
    });
  }

  function _attachLongPress(el, fn) {
    var lpTimer = null;
    var lpFired = false;
    el.addEventListener('touchstart', function () {
      lpFired = false;
      lpTimer = setTimeout(function () {
        lpFired = true;
        if (navigator.vibrate) navigator.vibrate(30);
        fn();
      }, 500);
    }, { passive: true });
    el.addEventListener('touchend', function (e) {
      clearTimeout(lpTimer);
      if (lpFired) { e.preventDefault(); e.stopPropagation(); }
    });
  }

  function _createDrawerGroup(parent, label, editFn) {
    var group = document.createElement('div');
    group.className = 'fab-drawer-group';
    var headerDiv = document.createElement('div');
    headerDiv.className = 'fab-drawer-group-header';
    var labelEl = document.createElement('span');
    labelEl.className = 'fab-drawer-group-label';
    labelEl.textContent = label;
    headerDiv.appendChild(labelEl);
    if (editFn) {
      var editBtn = document.createElement('button');
      editBtn.className = 'fab-drawer-group-edit';
      editBtn.textContent = '\u270e \u7f16\u8f91';
      editBtn.addEventListener('click', function (e) { e.stopPropagation(); editFn(); });
      headerDiv.appendChild(editBtn);
    }
    group.appendChild(headerDiv);
    parent.appendChild(group);
    return group;
  }

  // -- Quick key customization --
  function _addQuickKey() {
    _showDrawerModal(
      '\u6dfb\u52a0\u5feb\u6377\u952e',
      '\u663e\u793a\u540d\u79f0', '',
      '\u53d1\u9001\u5185\u5bb9', '',
      function () {
        var label = dModalInput1.value.trim();
        var send = dModalInput2.value.trim();
        if (!label) return;
        if (!send) send = label + '\r';
        drawerQuickKeys.push({ label: label, send: _parseEscape(send) });
        _saveDrawerQuickKeys(drawerQuickKeys);
        renderDrawer();
      }
    );
  }

  function _editQuickKeys() {
    var btns = g1grid.querySelectorAll('.fab-drawer-btn:not(.add-chip)');
    var isEditing = btns.length > 0 && btns[0].querySelector('.chip-delete');
    if (isEditing) {
      renderDrawer();
      return;
    }
    btns.forEach(function (btn) {
      var idx = +btn.dataset.idx;
      if (isNaN(idx)) return;
      var del = document.createElement('span');
      del.className = 'chip-delete';
      del.textContent = '\u00d7';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        drawerQuickKeys.splice(idx, 1);
        _saveDrawerQuickKeys(drawerQuickKeys);
        renderDrawer();
      });
      btn.appendChild(del);
      btn.classList.add('editing');
      btn.onclick = function (e) {
        e.stopPropagation();
        var k = drawerQuickKeys[idx];
        _showDrawerModal(
          '\u7f16\u8f91\u5feb\u6377\u952e',
          '\u663e\u793a\u540d\u79f0', k.label,
          '\u53d1\u9001\u5185\u5bb9', _displayEscape(k.send),
          function () {
            k.label = dModalInput1.value.trim() || k.label;
            k.send = _parseEscape(dModalInput2.value.trim()) || k.send;
            _saveDrawerQuickKeys(drawerQuickKeys);
            renderDrawer();
          }
        );
      };
    });
  }

  // -- Slash command customization --
  function _addSlashCommand() {
    _showDrawerModal(
      '\u6dfb\u52a0 Slash Command',
      '\u547d\u4ee4\u540d\u79f0', '',
      '\u53d1\u9001\u5185\u5bb9', '',
      function () {
        var label = dModalInput1.value.trim();
        var send = dModalInput2.value.trim();
        if (!label) return;
        if (!send) send = label + '\r';
        drawerCommands.push({ label: label, send: _parseEscape(send) });
        _saveDrawerCommands(drawerCommands);
        renderDrawer();
      }
    );
  }

  function _editSlashCommands() {
    var chips = drawerEl.querySelectorAll('.fab-drawer-chip:not(.add-chip)');
    var isEditing = chips.length > 0 && chips[0].querySelector('.chip-delete');
    if (isEditing) {
      renderDrawer();
      return;
    }
    chips.forEach(function (chip) {
      var idx = +chip.dataset.idx;
      var del = document.createElement('span');
      del.className = 'chip-delete';
      del.textContent = '\u00d7';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        drawerCommands.splice(idx, 1);
        _saveDrawerCommands(drawerCommands);
        renderDrawer();
      });
      chip.appendChild(del);
      chip.classList.add('editing');
      chip.onclick = function (e) {
        e.stopPropagation();
        var cmd = drawerCommands[idx];
        _showDrawerModal(
          '\u7f16\u8f91 Slash Command',
          '\u547d\u4ee4\u540d\u79f0', cmd.label,
          '\u53d1\u9001\u5185\u5bb9', _displayEscape(cmd.send),
          function () {
            cmd.label = dModalInput1.value.trim() || cmd.label;
            cmd.send = _parseEscape(dModalInput2.value.trim()) || cmd.send;
            _saveDrawerCommands(drawerCommands);
            renderDrawer();
          }
        );
      };
    });
  }

  // -- Template customization --
  function _addTemplate() {
    _showDrawerModal(
      '\u6dfb\u52a0\u5feb\u6377\u6a21\u677f',
      '\u6a21\u677f\u5185\u5bb9', '',
      '\u53d1\u9001\u5185\u5bb9 (\u7559\u7a7a\u5219\u540c\u4e0a)', '',
      function () {
        var label = dModalInput1.value.trim();
        if (!label) return;
        var send = dModalInput2.value.trim();
        if (!send) send = label + '\r';
        drawerTemplates.push({ label: label, send: _parseEscape(send) });
        _saveDrawerTemplates(drawerTemplates);
        renderDrawer();
      }
    );
  }

  function _editTemplate(idx) {
    var tpl = drawerTemplates[idx];
    if (!tpl) return;
    _showDrawerModal(
      '\u7f16\u8f91\u6a21\u677f',
      '\u6a21\u677f\u5185\u5bb9', tpl.label,
      '\u53d1\u9001\u5185\u5bb9', _displayEscape(tpl.send),
      function () {
        var newLabel = dModalInput1.value.trim();
        if (!newLabel) {
          drawerTemplates.splice(idx, 1);
        } else {
          tpl.label = newLabel;
          tpl.send = _parseEscape(dModalInput2.value.trim()) || tpl.send;
        }
        _saveDrawerTemplates(drawerTemplates);
        renderDrawer();
      }
    );
  }

  // -- Render drawer content --
  function renderDrawer() {
    drawerEl.innerHTML = '';

    // Header
    var header = document.createElement('div');
    header.className = 'fab-drawer-header';
    header.innerHTML = '<span>\u5feb\u6377\u5de5\u5177</span>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'fab-drawer-close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', function () { toggleDrawer(false); });
    header.appendChild(closeBtn);
    drawerEl.appendChild(header);

    var body = document.createElement('div');
    body.className = 'fab-drawer-body';
    drawerEl.appendChild(body);

    // Group 1: Quick Actions
    var g1 = _createDrawerGroup(body, '\u5feb\u901f\u64cd\u4f5c', function () { _editQuickKeys(); });
    g1grid = document.createElement('div');
    g1grid.className = 'fab-drawer-grid';
    drawerQuickKeys.forEach(function (k, i) {
      var btn = document.createElement('button');
      btn.className = 'fab-drawer-btn' + (k.cls ? ' ' + k.cls : '');
      btn.textContent = k.label;
      btn.dataset.idx = i;
      btn.addEventListener('click', function () { _handleDrawerBtn(k.send); });
      g1grid.appendChild(btn);
    });
    var addKeyBtn = document.createElement('button');
    addKeyBtn.className = 'fab-drawer-btn add-chip';
    addKeyBtn.textContent = '+';
    addKeyBtn.addEventListener('click', function () { _addQuickKey(); });
    g1grid.appendChild(addKeyBtn);
    g1.appendChild(g1grid);

    // Group 2: Arrow Keys & Editing
    var g2 = _createDrawerGroup(body, '\u65b9\u5411\u952e & \u7f16\u8f91');
    var g2grid = document.createElement('div');
    g2grid.className = 'fab-drawer-grid';
    var arrowKeys = [
      { label: '\u2191', send: '\x1b[A', repeat: true },
      { label: '\u2193', send: '\x1b[B', repeat: true },
      { label: '\u2190', send: '\x1b[D', repeat: true },
      { label: '\u2192', send: '\x1b[C', repeat: true },
      { label: 'C-a', send: '\x01' },
      { label: 'C-e', send: '\x05' },
      { label: 'C-w', send: '\x17' },
      { label: 'C-l', send: '\x0c' },
    ];
    arrowKeys.forEach(function (k) {
      var btn = document.createElement('button');
      btn.className = 'fab-drawer-btn';
      btn.textContent = k.label;
      if (k.repeat) {
        _attachRepeat(btn, k.send);
      } else {
        btn.addEventListener('click', function () { _handleDrawerBtn(k.send); });
      }
      g2grid.appendChild(btn);
    });
    g2.appendChild(g2grid);

    // Group 3: Claude Code Shortcuts
    var g3 = _createDrawerGroup(body, 'Claude Code \u5feb\u6377\u952e');
    var g3grid = document.createElement('div');
    g3grid.className = 'fab-drawer-grid-2col';
    var ccKeys = [
      { label: 'Alt+T \u601d\u8003', send: '\x1bt' },
      { label: 'Ctrl+O \u8be6\u7ec6', send: '\x0f' },
    ];
    ccKeys.forEach(function (k) {
      var btn = document.createElement('button');
      btn.className = 'fab-drawer-btn accent-orange';
      btn.textContent = k.label;
      btn.addEventListener('click', function () { _handleDrawerBtn(k.send); });
      g3grid.appendChild(btn);
    });
    g3.appendChild(g3grid);

    // Group 4: Slash Commands
    var g4 = _createDrawerGroup(body, 'Slash Commands', function () { _editSlashCommands(); });
    var g4chips = document.createElement('div');
    g4chips.className = 'fab-drawer-chips';
    drawerCommands.forEach(function (cmd, i) {
      var chip = document.createElement('button');
      chip.className = 'fab-drawer-chip';
      chip.textContent = cmd.label;
      chip.dataset.idx = i;
      chip.addEventListener('click', function () { _handleDrawerBtn(cmd.send); });
      g4chips.appendChild(chip);
    });
    var addChip = document.createElement('button');
    addChip.className = 'fab-drawer-chip add-chip';
    addChip.textContent = '+ \u6dfb\u52a0';
    addChip.addEventListener('click', function () { _addSlashCommand(); });
    g4chips.appendChild(addChip);
    g4.appendChild(g4chips);

    // Group 5: Templates
    var g5 = _createDrawerGroup(body, '\u5feb\u6377\u6a21\u677f');
    var g5list = document.createElement('div');
    g5list.className = 'fab-drawer-templates';
    drawerTemplates.forEach(function (tpl, i) {
      var item = document.createElement('div');
      item.className = 'fab-drawer-template';
      item.textContent = tpl.label;
      item.dataset.idx = i;
      item.addEventListener('click', function () { _handleDrawerBtn(tpl.send); });
      _attachLongPress(item, function () { _editTemplate(i); });
      g5list.appendChild(item);
    });
    var addTpl = document.createElement('div');
    addTpl.className = 'fab-drawer-template add-template';
    addTpl.textContent = '+ \u6dfb\u52a0\u81ea\u5b9a\u4e49\u6a21\u677f...';
    addTpl.addEventListener('click', function () { _addTemplate(); });
    g5list.appendChild(addTpl);
    g5.appendChild(g5list);
  }

  function toggleDrawer(open) {
    drawerOpen = typeof open === 'boolean' ? open : !drawerOpen;
    if (drawerOpen) renderDrawer();
    backdropEl.classList.toggle('open', drawerOpen);
    drawerEl.classList.toggle('open', drawerOpen);
  }

  backdropEl.addEventListener('click', function () { toggleDrawer(false); });

  // -- Position panel --
  function positionPanel() {
    var rect = fabEl.getBoundingClientRect();
    var pw = panelEl.offsetWidth || 200;
    var ph = panelEl.offsetHeight || 200;
    var left = rect.left + rect.width / 2 - pw / 2;
    var top = rect.top - ph - 10;
    if (left < 8) left = 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top < 8) top = rect.bottom + 10;
    panelEl.style.left = left + 'px';
    panelEl.style.top = top + 'px';
  }

  function togglePanel() {
    isOpen = !isOpen;
    fabEl.classList.toggle('open', isOpen);
    panelEl.classList.toggle('open', isOpen);
    if (isOpen) positionPanel();
  }

  // -- FAB drag --
  var dragStartX, dragStartY, fabStartX, fabStartY, dragMoved;

  fabEl.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    dragStartX = t.clientX; dragStartY = t.clientY;
    var rect = fabEl.getBoundingClientRect();
    fabStartX = rect.left; fabStartY = rect.top;
    dragMoved = false;
    fabEl.classList.add('dragging');
  }, { passive: true });

  fabEl.addEventListener('touchmove', function (e) {
    var t = e.touches[0];
    var dx = t.clientX - dragStartX, dy = t.clientY - dragStartY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) dragMoved = true;
    if (!dragMoved) return;
    var nx = Math.max(0, Math.min(window.innerWidth - 48, fabStartX + dx));
    var ny = Math.max(0, Math.min(window.innerHeight - 48, fabStartY + dy));
    fabEl.style.left = nx + 'px'; fabEl.style.top = ny + 'px';
    fabEl.style.right = 'auto'; fabEl.style.bottom = 'auto';
    if (isOpen) positionPanel();
  }, { passive: true });

  fabEl.addEventListener('touchend', function () {
    fabEl.classList.remove('dragging');
    if (!dragMoved) togglePanel();
    if (dragMoved) {
      localStorage.setItem('fab-pos', JSON.stringify({ left: fabEl.style.left, top: fabEl.style.top }));
    }
  }, { passive: true });

  fabEl.addEventListener('click', function () {
    if (!('ontouchstart' in window)) togglePanel();
  });

  // Restore position
  try {
    var pos = JSON.parse(localStorage.getItem('fab-pos'));
    if (pos) {
      fabEl.style.left = pos.left; fabEl.style.top = pos.top;
      fabEl.style.right = 'auto'; fabEl.style.bottom = 'auto';
    }
  } catch (_e) { /* ignore */ }

  // -- Panel button tap & long-press --
  panelEl.addEventListener('touchstart', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var idx = +btn.dataset.idx;
    longPressed = false;

    longPressTimer = setTimeout(function () {
      longPressed = true;
      if (navigator.vibrate) navigator.vibrate(30);
      openEditor(idx);
    }, 500);

    var k = keys[idx];
    if (k && k.repeat) {
      repeatTimer = setTimeout(function () {
        repeatTimer = setInterval(function () {
          if (longPressed) return;
          _sendTermData(k.send);
          if (navigator.vibrate) navigator.vibrate(5);
        }, 80);
      }, 300);
    }
  }, { passive: true });

  panelEl.addEventListener('touchend', function (e) {
    clearTimeout(longPressTimer);
    clearTimeout(repeatTimer);
    clearInterval(repeatTimer);
    longPressTimer = null;
    repeatTimer = null;
    if (longPressed) { longPressed = false; return; }

    var btn = e.target.closest('button');
    if (!btn) return;
    var k = keys[+btn.dataset.idx];
    if (!k) return;

    if (k.send === '__upload__') {
      fileInput.value = '';
      fileInput.click();
    } else if (k.send === '__voice__') {
      _startVoice();
    } else if (k.send === '__drawer__') {
      toggleDrawer(true);
    } else {
      _sendTermData(k.send);
    }
    if (navigator.vibrate) navigator.vibrate(10);
    // Prevent the browser from synthesizing a click event after this touchend.
    // Without this, opening the drawer causes the backdrop (z-index 200) to
    // appear over the button — the synthetic click then hits the backdrop,
    // which immediately closes the drawer.
    e.preventDefault();
  });

  // Desktop click
  panelEl.addEventListener('click', function (e) {
    if ('ontouchstart' in window) return;
    var btn = e.target.closest('button');
    if (!btn) return;
    var k = keys[+btn.dataset.idx];
    if (!k) return;
    if (k.send === '__upload__') { fileInput.value = ''; fileInput.click(); }
    else if (k.send === '__voice__') { _startVoice(); }
    else if (k.send === '__drawer__') { toggleDrawer(true); }
    else { _sendTermData(k.send); }
  });

  // Desktop right-click to customize
  panelEl.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var btn = e.target.closest('button');
    if (!btn) return;
    openEditor(+btn.dataset.idx);
  });

  // Close on outside tap
  function onOutsideTap(e) {
    if (isOpen && !fabEl.contains(e.target) && !panelEl.contains(e.target) && !modalEl.contains(e.target) && !drawerEl.contains(e.target) && !drawerModalEl.contains(e.target)) {
      togglePanel();
    }
  }
  document.addEventListener('touchstart', onOutsideTap, { passive: true });
  document.addEventListener('click', onOutsideTap);

  // Return cleanup function
  return function () {
    _stopVoice();
    document.removeEventListener('touchstart', onOutsideTap);
    document.removeEventListener('click', onOutsideTap);
    if (backdropEl.parentNode) backdropEl.parentNode.removeChild(backdropEl);
    if (drawerEl.parentNode) drawerEl.parentNode.removeChild(drawerEl);
    if (drawerModalEl.parentNode) drawerModalEl.parentNode.removeChild(drawerModalEl);
  };
}

// === Terminal State ===

var terminalState = {
  term: null,
  ws: null,
  fitAddon: null,
  resizeObserver: null,
  isFullscreen: false,
};

// === Cleanup ===

function _cleanupTerminalResources() {
  terminalState.termContainer = null;
  if (terminalState._resizeHandler) {
    window.removeEventListener('resize', terminalState._resizeHandler);
    terminalState._resizeHandler = null;
  }
  if (terminalState._vpHandler && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', terminalState._vpHandler);
    window.visualViewport.removeEventListener('scroll', terminalState._vpHandler);
    terminalState._vpHandler = null;
  }
  if (terminalState.resizeObserver) {
    terminalState.resizeObserver.disconnect();
    terminalState.resizeObserver = null;
  }
  if (terminalState.ws) {
    terminalState.ws.close();
    terminalState.ws = null;
  }
  if (terminalState.term) {
    try { terminalState.term.dispose(); } catch (_e) {}
    terminalState.term = null;
  }
  terminalState.fitAddon = null;
}

function cleanupTerminal() {
  _cleanupTerminalResources();
  document.body.classList.remove('terminal-active');
  exitFullscreen();

}

// === Fullscreen ===

function enterFullscreen() {
  terminalState.isFullscreen = true;
  document.body.classList.add('terminal-fullscreen');
  // Request browser fullscreen
  var el = document.documentElement;
  var rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (rfs) {
    rfs.call(el).catch(function () {});
  }
}

function exitFullscreen() {
  terminalState.isFullscreen = false;
  document.body.classList.remove('terminal-fullscreen');
  // Exit browser fullscreen
  var efsDoc = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (efsDoc && document.fullscreenElement) {
    efsDoc.call(document).catch(function () {});
  }
}

function toggleFullscreen() {
  if (terminalState.isFullscreen) {
    exitFullscreen();
  } else {
    enterFullscreen();
  }
  // Re-fit after layout change
  if (terminalState.fitAddon) {
    setTimeout(function () { terminalState.fitAddon.fit(); }, 100);
  }
}

// Sync state when user exits browser fullscreen via Escape or browser UI
document.addEventListener('fullscreenchange', function () {
  if (!document.fullscreenElement && terminalState.isFullscreen) {
    terminalState.isFullscreen = false;
    document.body.classList.remove('terminal-fullscreen');
    var btn = document.querySelector('.terminal-exit-fullscreen-btn');
    if (btn) btn.style.display = 'none';
    if (terminalState.fitAddon) {
      setTimeout(function () { terminalState.fitAddon.fit(); }, 100);
    }
  }
});

// === Pane Switching ===

function switchPane(newPaneId) {
  if (newPaneId === state.currentPane) return;
  state.currentPane = newPaneId;

  // Always do full reconnect so the new pane gets zoomed
  var content = document.getElementById('content');
  if (content) {
    cleanupTerminal();
    renderTerminal(content);
  }
}

// Switch to adjacent pane by direction (-1 = prev, +1 = next)
function switchPaneByDirection(direction) {
  if (!state.panes || state.panes.length <= 1) return;
  var currentIndex = -1;
  for (var i = 0; i < state.panes.length; i++) {
    if (state.panes[i].id === state.currentPane) { currentIndex = i; break; }
  }
  if (currentIndex < 0) return;
  var newIndex = currentIndex + direction;
  if (newIndex < 0) newIndex = state.panes.length - 1;
  if (newIndex >= state.panes.length) newIndex = 0;
  switchPane(state.panes[newIndex].id);
}

// === Pane Navigation Bar (with arrows) ===

function renderPaneNavBar(container, panes, activePaneId, onSwitch) {
  container.innerHTML = '';
  if (!panes || panes.length <= 1) {
    // Still render pills for single pane (no arrows needed)
    renderPanePills(container, panes, activePaneId, onSwitch);
    return;
  }

  var nav = document.createElement('div');
  nav.className = 'pane-nav-bar';

  var prevBtn = document.createElement('button');
  prevBtn.className = 'btn pane-nav-arrow';
  prevBtn.textContent = '‹';
  prevBtn.addEventListener('click', function () { switchPaneByDirection(-1); });

  var pillsWrap = document.createElement('div');
  pillsWrap.className = 'pane-nav-pills';
  renderPanePills(pillsWrap, panes, activePaneId, onSwitch);

  var nextBtn = document.createElement('button');
  nextBtn.className = 'btn pane-nav-arrow';
  nextBtn.textContent = '›';
  nextBtn.addEventListener('click', function () { switchPaneByDirection(1); });

  // Current pane indicator
  var currentIdx = 0;
  for (var i = 0; i < panes.length; i++) {
    if (panes[i].id === activePaneId) { currentIdx = i; break; }
  }
  var indicator = document.createElement('div');
  indicator.className = 'pane-nav-indicator';
  indicator.textContent = (currentIdx + 1) + ' / ' + panes.length;

  nav.appendChild(prevBtn);
  nav.appendChild(pillsWrap);
  nav.appendChild(nextBtn);
  container.appendChild(nav);
  container.appendChild(indicator);
}

// === Per-pane/window Font Size Offset ===
//
// In tab mode, font offset is stored per pane (key = pane ID, e.g. "%0").
// In split mode, font offset is stored per window (key = "session:windowIndex").
// All offsets are stored in a single localStorage JSON object under 'tmux_font_offsets'.

var _fontOffsets = (function () {
  try {
    // Remove legacy single-offset key
    localStorage.removeItem('tmux_font_offset');
  } catch (_e) {}
  try {
    return JSON.parse(localStorage.getItem('tmux_font_offsets')) || {};
  } catch (_e) { return {}; }
})();

function _fontOffsetKey() {
  if (_terminalMode === 'split') {
    return (state.currentSession || '') + ':' + (state.currentWindow || '');
  }
  return state.currentPane || '';
}

function _getFontOffset() {
  return _fontOffsets[_fontOffsetKey()] || 0;
}

function _setFontOffset(val) {
  var key = _fontOffsetKey();
  if (val === 0) {
    delete _fontOffsets[key];
  } else {
    _fontOffsets[key] = val;
  }
  _saveFontOffsets();
}

function _saveFontOffsets() {
  try { localStorage.setItem('tmux_font_offsets', JSON.stringify(_fontOffsets)); } catch (_e) {}
}

// Clean up offsets for pane IDs that no longer exist
function _cleanupFontOffsets(validPaneIds) {
  var changed = false;
  var keys = Object.keys(_fontOffsets);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    // Pane keys start with '%', window keys contain ':'
    if (k.charAt(0) === '%' && validPaneIds.indexOf(k) === -1) {
      delete _fontOffsets[k];
      changed = true;
    }
  }
  if (changed) _saveFontOffsets();
}

function _adjustFontSize(dir) {
  if (!terminalState.term || !terminalState.fitAddon) return;
  var current = terminalState.term.options.fontSize || 14;
  var next = Math.max(8, Math.min(22, current + dir));
  if (next === current) return;
  var offset = _getFontOffset() + dir;
  _setFontOffset(offset);
  terminalState.term.options.fontSize = next;
  terminalState.fitAddon.fit();
  if (terminalState.ws && terminalState.ws.readyState === WebSocket.OPEN) {
    terminalState.ws.send(JSON.stringify({
      type: 'resize',
      cols: terminalState.term.cols,
      rows: terminalState.term.rows,
    }));
  }
}

// === Terminal View Mode (tab / split) ===

var _terminalMode = (function () {
  try { return localStorage.getItem('tmux_terminal_mode') || 'tab'; } catch (_e) { return 'tab'; }
})();

function _calcTerminalFontSize(paneCols, paneRows, containerEl) {
  var container = containerEl || document.querySelector('.terminal-container');
  var w = container ? container.clientWidth : window.innerWidth;
  var h = container ? container.clientHeight : window.innerHeight;

  // Use tmux pane's actual cols/rows as target
  var cols = paneCols || 80;
  var rows = paneRows || 24;

  // Monospace char width ≈ 0.6 * fontSize, line height ≈ 1.2 * fontSize
  // Subtract small padding (8px total)
  var fromWidth = (w - 8) / (cols * 0.6);
  var fromHeight = (h - 8) / (rows * 1.2);
  var size = Math.min(fromWidth, fromHeight);
  var base = Math.max(10, Math.min(16, Math.round(size)));
  // Apply user's manual offset (from A+/A- buttons), clamped to [8, 22]
  return Math.max(8, Math.min(22, base + _getFontOffset()));
}

// === Create xterm Terminal ===

function createTerminalInstance(paneCols, paneRows) {
  var term = new Terminal({
    theme: Theme.getTerminalTheme(),
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Symbols Nerd Font Mono', monospace",
    fontSize: _calcTerminalFontSize(paneCols, paneRows),
    cursorBlink: true,
    scrollback: 5000,
    overviewRuler: { width: 0 },
    rescaleOverlappingGlyphs: true,
  });
  return term;
}

// === Connect WebSocket ===

function connectTerminalWs(paneId, term, nozoom) {
  var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = wsProtocol + '//' + location.host + '/ws/terminal/' + encodeURIComponent(paneId);
  var queryParts = [];
  if (nozoom) queryParts.push('nozoom=1');
  var tokenParam = Auth.wsTokenParam();
  if (tokenParam) queryParts.push(tokenParam);
  if (queryParts.length > 0) wsUrl += '?' + queryParts.join('&');

  var ws = new WebSocket(wsUrl);

  ws.onopen = function () {
    // Send initial resize
    if (term.cols && term.rows) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };

  ws.onmessage = function (e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'output') {
        term.write(msg.data);
      } else if (msg.type === 'clipboard') {
        _copyToClipboard(msg.data);
      }
    } catch (_err) {
      // Ignore parse errors
    }
  };

  ws.onclose = function () {
    // Auto-reconnect if terminal is still active
    if (terminalState.term === term && state.currentTab === 'terminal') {
      _showReconnectOverlay(term, paneId, nozoom);
    }
  };

  ws.onerror = function () {
    // Will trigger onclose
  };

  // Suppress mouse-move reports after right-click so tmux popup menus stay open.
  // SGR mouse move: \x1b[<35;X;YM (button 35 = no-button movement)
  // SGR mouse drag: \x1b[<32..34;X;YM (button held + movement)
  var _suppressMouseMove = false;
  var _sgrMoveRe = /^\x1b\[<(35|32|33|34);\d+;\d+[Mm]$/;

  term.onData(function (data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (_suppressMouseMove && _sgrMoveRe.test(data)) return;

    // --- IME composition guard ---
    // During active composition, suppress onData — intermediate text is
    // managed by the IME, not meant for the terminal.
    if (term._imeComposing) return;

    // After compositionend, xterm's CompositionHelper fires onData with the
    // final composed text. Allow that first send, suppress duplicates.
    if (term._imeGuardUntil && Date.now() < term._imeGuardUntil) {
      // Enter that confirmed the IME candidate — not a real terminal Enter
      if (data === '\r') return;
      // First onData with composed text: let it through (xterm's legitimate send)
      if (!term._imeSentOnce && term._imeLastComposed && data === term._imeLastComposed) {
        term._imeSentOnce = true;
        // fall through to ws.send
      } else if (term._imeSentOnce && term._imeLastComposed && data === term._imeLastComposed) {
        // Duplicate — suppress
        return;
      }
    }

    ws.send(JSON.stringify({ type: 'input', data: data }));
  });

  // Track right-click on terminal element
  var termEl = term.element;
  if (termEl) {
    termEl.addEventListener('mousedown', function (e) {
      if (e.button === 2) _suppressMouseMove = true;
      if (e.button === 0) _suppressMouseMove = false;
    }, true);
  }

  return ws;
}

// === Render Terminal View ===

function renderTerminal(container) {
  // Cleanup previous terminal resources without removing body class
  _cleanupTerminalResources();

  // Reset scroll position — if #content was scrolled (e.g. long window list),
  // the terminal header would be pushed above the visible area.
  container.scrollTop = 0;

  if (!state.currentSession || !state.currentWindow) {
    container.innerHTML =
      '<div style="padding: 24px; text-align: center; color: var(--text-muted);">' +
      '<p style="font-size: 1.2rem; margin-bottom: 8px;">No terminal selected</p>' +
      '<p>Select a session and window first.</p>' +
      '</div>';
    return;
  }

  // Reset page-level scroll (windows list may have scrolled <body>)
  // and lock body for mobile terminal layout
  window.scrollTo(0, 0);
  document.body.classList.add('terminal-active');

  // Build the terminal view structure
  container.innerHTML =
    '<div class="terminal-view">' +
    '<div class="terminal-header">' +
    '<button class="btn terminal-back-btn">&larr;</button>' +
    '<div class="terminal-header-pills"></div>' +
    '<span class="terminal-header-title"></span>' +
    '<div class="terminal-header-actions">' +
    '<button class="btn terminal-refresh-btn" title="Refresh">&#10227;</button>' +
    '<div class="terminal-mode-toggle">' +
    '<button class="btn terminal-mode-opt' + (_terminalMode === 'tab' ? ' active' : '') + '" data-mode="tab" title="标签页模式">&#9723;</button>' +
    '<button class="btn terminal-mode-opt' + (_terminalMode === 'split' ? ' active' : '') + '" data-mode="split" title="分屏模式 · 再点一次打开布局选择器">&#8862;</button>' +
    '</div>' +
    '<button class="btn terminal-font-btn" data-dir="-1" title="Smaller font">A&#8722;</button>' +
    '<button class="btn terminal-font-btn" data-dir="1" title="Larger font">A&#43;</button>' +
    '<button class="btn terminal-split-btn" title="Split pane">&#10010;</button>' +
    '<button class="btn terminal-open-buf-btn" title="Open file from tmux buffer (Ctrl+Shift+O)">&#128194;</button>' +
    '<button class="btn terminal-popout-btn" title="Pop out">&#8599;</button>' +
    '<button class="btn terminal-fullscreen-btn" title="Fullscreen">&#9634;</button>' +
    '</div>' +
    '</div>' +
    '<div class="terminal-pane-switcher"></div>' +
    '<div class="terminal-container"></div>' +
    '<button class="btn terminal-exit-fullscreen-btn" title="Exit fullscreen" style="display:none;">&times; Exit</button>' +
    '</div>';

  var view = container.querySelector('.terminal-view');
  if (window.innerWidth < 768) _createFabPanel(view);
  var titleEl = view.querySelector('.terminal-header-title');
  var paneSwitcher = view.querySelector('.terminal-pane-switcher');
  var termContainer = view.querySelector('.terminal-container');
  terminalState.termContainer = termContainer;
  var exitFsBtn = view.querySelector('.terminal-exit-fullscreen-btn');

  // Set title
  titleEl.textContent = escapeHtml(state.currentSession) + ' : ' + state.currentWindow;

  // Back button
  view.querySelector('.terminal-back-btn').addEventListener('click', function () {
    _backToWindows();
  });

  // Font size buttons
  view.querySelectorAll('.terminal-font-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var dir = parseInt(btn.getAttribute('data-dir'), 10);
      _adjustFontSize(dir);
    });
  });

  // Swipe-back visual indicator (rendered once, driven by overlay touch handler)
  if (window.innerWidth < 768) {
    var ind = document.createElement('div');
    ind.className = 'swipe-back-indicator';
    view.appendChild(ind);
  }

  // Split button
  function doSplit(direction) {
    api
      .post(
        '/api/sessions/' + encodeURIComponent(state.currentSession) +
        '/windows/' + encodeURIComponent(state.currentWindow) + '/panes',
        { paneId: state.currentPane, direction: direction }
      )
      .then(function () {
        renderTerminal(container);
      })
      .catch(function (err) {
        showAlert({ title: '分割窗格失败', message: err.message });
      });
  }

  view.querySelector('.terminal-refresh-btn').addEventListener('click', function () {
    _sidebarSessionKey = '';
    render();
    updateSidebar();
  });



  view.querySelector('.terminal-split-btn').addEventListener('click', function (e) {
    // Mobile: split directly (direction doesn't matter, each pane gets its own screen)
    if (window.innerWidth < 768) {
      doSplit('vertical');
      return;
    }

    // Desktop: show popup to choose direction
    var existing = view.querySelector('.split-popup');
    if (existing) { existing.remove(); return; }

    var popup = document.createElement('div');
    popup.className = 'split-popup';
    popup.innerHTML =
      '<button class="btn split-popup-btn" data-dir="horizontal">&#x2194; 水平分割</button>' +
      '<button class="btn split-popup-btn" data-dir="vertical">&#x2195; 垂直分割</button>';

    var btn = e.currentTarget;
    btn.parentElement.appendChild(popup);

    popup.querySelectorAll('.split-popup-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        popup.remove();
        doSplit(b.getAttribute('data-dir'));
      });
    });

    function closePopup(ev) {
      if (!popup.contains(ev.target) && ev.target !== btn) {
        popup.remove();
        document.removeEventListener('click', closePopup, true);
      }
    }
    setTimeout(function () {
      document.addEventListener('click', closePopup, true);
    }, 0);
  });

  // Mode toggle: click to switch mode; if already in split mode, open layout picker
  view.querySelectorAll('.terminal-mode-opt').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-mode');
      if (mode === _terminalMode) {
        // Already in this mode — split button opens layout picker
        if (mode === 'split' && typeof LayoutPicker !== 'undefined') {
          LayoutPicker.open();
        }
        return;
      }
      _terminalMode = mode;
      try { localStorage.setItem('tmux_terminal_mode', mode); } catch (_e) {}
      renderTerminal(container);
    });
  });

  // Open file from tmux paste buffer
  view.querySelector('.terminal-open-buf-btn').addEventListener('click', function () {
    if (typeof FilePreview !== 'undefined' && state.currentPane) {
      FilePreview.openFromBuffer(state.currentPane);
    }
  });

  // Pop-out button
  view.querySelector('.terminal-popout-btn').addEventListener('click', function () {
    if (state.currentPane) {
      window.open(
        '/terminal.html?pane=' + encodeURIComponent(state.currentPane),
        '_blank',
        'width=800,height=600'
      );
    }
  });

  // Fullscreen button
  view.querySelector('.terminal-fullscreen-btn').addEventListener('click', function () {
    toggleFullscreen();
    exitFsBtn.style.display = terminalState.isFullscreen ? 'block' : 'none';
  });

  // Exit fullscreen button (floating)
  exitFsBtn.addEventListener('click', function () {
    exitFullscreen();
    exitFsBtn.style.display = 'none';
    if (terminalState.fitAddon) {
      setTimeout(function () { terminalState.fitAddon.fit(); }, 100);
    }
  });

  // Fetch panes and set up terminal
  api
    .get(
      '/api/sessions/' + encodeURIComponent(state.currentSession) +
      '/windows/' + encodeURIComponent(state.currentWindow) + '/panes'
    )
    .then(function (result) {
      var panes = result.data || [];
      state.panes = panes;

      // Clean up font offsets for panes that no longer exist
      _cleanupFontOffsets(panes.map(function (p) { return p.id; }));

      // If no current pane or current pane not in this window, pick first
      if (!state.currentPane || !panes.some(function (p) { return p.id === state.currentPane; })) {
        state.currentPane = panes.length > 0 ? panes[0].id : null;
      }

      var useSplit = _terminalMode === 'split' && panes.length > 1 && window.innerWidth >= 768;

      // Render pane pills only in tab mode — split mode shows all panes natively
      if (panes.length > 1 && !useSplit) {
        var headerPills = view.querySelector('.terminal-header-pills');
        renderPanePills(headerPills, panes, state.currentPane, switchPane);
      }

      // Hide mode toggle when only 1 pane
      if (panes.length <= 1) {
        var toggle = view.querySelector('.terminal-mode-toggle');
        if (toggle) toggle.style.display = 'none';
      }

      // Mount terminal — split mode uses nozoom (tmux renders native splits)
      if (state.currentPane) {
        _mountTerminal(termContainer, useSplit);
      } else {
        termContainer.innerHTML =
          '<div style="padding: 24px; text-align: center; color: var(--text-muted);">No panes available</div>';
      }
    })
    .catch(function (err) {
      termContainer.innerHTML =
        '<div style="padding: 24px; text-align: center; color: var(--accent-red);">' +
        'Failed to load panes: ' + escapeHtml(err.message) +
        '</div>';
    });
}

// === Mount Terminal Instance ===

function _mountTerminal(termContainer, nozoom) {
  // Get current pane's tmux dimensions (in split/nozoom mode, pass null to auto-fit)
  var currentPane = state.panes ? state.panes.find(function (p) { return p.id === state.currentPane; }) : null;
  var paneCols = nozoom ? null : (currentPane ? currentPane.width : null);
  var paneRows = nozoom ? null : (currentPane ? currentPane.height : null);
  var term = createTerminalInstance(paneCols, paneRows);
  var fitAddon = new FitAddon.FitAddon();
  // Custom URL regex: same as WebLinksAddon default but excludes CJK
  // characters and full-width punctuation, which the default regex
  // incorrectly includes (causing URL highlight to extend into Chinese).
  var _CJK = "\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef\\u2000-\\u206f";
  var _urlRegex = new RegExp(
    "(https?|HTTPS?):[/]{2}[^\\s\"'!*(){}|\\\\\\^<>`" + _CJK + "]*" +
    "[^\\s\"':,.!?{}|\\\\\\^~\\[\\]`()<>" + _CJK + "]"
  );
  var webLinksAddon = new WebLinksAddon.WebLinksAddon(undefined, { urlRegex: _urlRegex });

  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  if (typeof FilePreview !== 'undefined') {
    FilePreview.registerLinkProvider(term, state.currentPane);
  }

  term.open(termContainer);

  // Disable mobile soft keyboard autocorrect/autocomplete to reduce
  // IME composition interference (Enter interpreted as delete, etc.)
  if (term.textarea) {
    term.textarea.setAttribute('autocapitalize', 'off');
    term.textarea.setAttribute('autocomplete', 'off');
    term.textarea.setAttribute('autocorrect', 'off');
    term.textarea.setAttribute('spellcheck', 'false');
    // Hint mobile keyboard that Enter means "send", not "newline"
    term.textarea.setAttribute('enterkeyhint', 'send');

    // --- Mobile CJK IME composition fix ---
    // xterm.js CompositionHelper (xtermjs/xterm.js#3600, #2403, #5108) has
    // known issues with mobile CJK IMEs (WeChat, Sogou, GBoard CJK):
    //   1. Enter confirms candidate but xterm also sends \r
    //   2. Composed text fires onData multiple times (duplicate input events)
    //   3. After compositionend, textarea retains text causing re-send
    //
    // Strategy: let xterm's CompositionHelper handle the first send of
    // composed text via its internal triggerDataEvent. We only add a guard
    // layer in onData to catch mobile-specific duplicates.
    // Ref: CodeMirror uses 200-400ms flush delay for Chrome Android.
    var _isAndroid = /Android/i.test(navigator.userAgent);
    var _imeGuardMs = _isAndroid ? 300 : 150;

    term._imeComposing = false;
    term._imeGuardUntil = 0;
    term._imeSentOnce = false;    // first onData after compositionend allowed
    term._imeLastComposed = null; // text from compositionend for dedup

    term.textarea.addEventListener('compositionstart', function () {
      term._imeComposing = true;
      term._imeSentOnce = false;
      term._imeLastComposed = null;
    });

    term.textarea.addEventListener('compositionend', function (e) {
      term._imeComposing = false;
      term._imeLastComposed = e.data || '';
      term._imeSentOnce = false;
      // Guard window: longer on Android (GBoard fires contradictory events)
      term._imeGuardUntil = Date.now() + _imeGuardMs;
      // Clear textarea AFTER xterm's CompositionHelper reads it.
      // xterm uses setTimeout(0) in _finalizeComposition; we wait longer.
      var ta = term.textarea;
      if (ta) {
        setTimeout(function () { ta.value = ''; }, 120);
      }
    });

    // During composition, block Enter from reaching xterm as \r.
    // Enter is for IME candidate confirmation, not terminal input.
    // Use both stopPropagation (prevent xterm handler) and preventDefault
    // (prevent default \r insertion on some mobile browsers).
    // Backspace: only stopPropagation (IME needs it for candidate editing,
    // but xterm shouldn't process it as terminal backspace).
    term.textarea.addEventListener('keydown', function (e) {
      // Use spec-standard isComposing (more reliable than manual tracking)
      var composing = term._imeComposing || e.isComposing;
      if (!composing) return;
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.stopPropagation();
        e.preventDefault();
      } else if (e.key === 'Backspace' || e.keyCode === 8) {
        e.stopPropagation();
      }
    }, true); // capture phase — before xterm's handler
  }

  // Use WebGL renderer for crisp box-drawing characters (tmux split borders)
  if (typeof WebglAddon !== 'undefined') {
    try {
      var webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(function () {
        webglAddon.dispose();
      });
      term.loadAddon(webglAddon);
    } catch (_e) {
      // WebGL not available — fall back to default canvas renderer
    }
  }



  // Small delay to ensure DOM is ready for fitting
  setTimeout(function () {
    fitAddon.fit();
    // On mobile, don't auto-focus to avoid browser scroll-to-focus pushing header away
    if (window.innerWidth >= 768) {
      term.focus();
    }
    // Reset #content scroll after mount — focus or xterm layout may have caused scroll
    var contentEl = document.getElementById('content');
    if (contentEl) contentEl.scrollTop = 0;
  }, 50);


  // Connect WebSocket (nozoom = split mode, shows full window with native tmux splits)
  var ws = connectTerminalWs(state.currentPane, term, nozoom);

  // Enable touch scrolling on mobile.
  // xterm.js preventDefault()s all touch events on its canvas, and tmux uses
  // the alternate screen buffer so xterm's local scrollback is empty.
  // Solution: overlay intercepts touch gestures and sends mouse wheel escape
  // sequences through the WebSocket so tmux handles the scrolling directly.
  var overlay = document.createElement('div');
  overlay.className = 'terminal-touch-overlay';
  termContainer.appendChild(overlay);

  // Long-press to select text: convert touch coordinates to terminal row/col,
  // use term.select() to highlight word, allow drag to extend selection.
  var longPress = { timer: null, active: false };
  var sel = { anchorRow: 0, anchorCol: 0, dragging: false };
  var LONG_PRESS_MS = 500;
  var LONG_PRESS_MOVE_TOLERANCE = 10; // px

  // Convert touch clientX/Y to terminal col/row
  function _touchToCell(clientX, clientY) {
    var screen = termContainer.querySelector('.xterm-screen');
    if (!screen) return null;
    var rect = screen.getBoundingClientRect();
    var cellW = rect.width / term.cols;
    var cellH = rect.height / term.rows;
    var col = Math.floor((clientX - rect.left) / cellW);
    var row = Math.floor((clientY - rect.top) / cellH);
    col = Math.max(0, Math.min(term.cols - 1, col));
    row = Math.max(0, Math.min(term.rows - 1, row));
    return { col: col, row: row };
  }

  // Get line text from buffer at a viewport row
  function _getLineText(viewportRow) {
    var bufRow = term.buffer.active.viewportY + viewportRow;
    var line = term.buffer.active.getLine(bufRow);
    return line ? line.translateToString() : '';
  }

  // Find word boundaries at col in lineText
  function _wordBounds(lineText, col) {
    if (col >= lineText.length || /\s/.test(lineText[col])) {
      // On whitespace — select single char
      return { start: col, end: col + 1 };
    }
    var start = col, end = col;
    while (start > 0 && /\S/.test(lineText[start - 1])) start--;
    while (end < lineText.length && /\S/.test(lineText[end])) end++;
    return { start: start, end: end };
  }

  function _enterSelectionMode(clientX, clientY) {
    var cell = _touchToCell(clientX, clientY);
    if (!cell) return;
    longPress.active = true;
    if (navigator.vibrate) navigator.vibrate(30);

    // Select word at long-press position
    var lineText = _getLineText(cell.row);
    var bounds = _wordBounds(lineText, cell.col);
    var bufRow = term.buffer.active.viewportY + cell.row;
    term.select(bounds.start, bufRow, bounds.end - bounds.start);

    sel.anchorRow = cell.row;
    sel.anchorCol = cell.col;
    sel.dragging = true;

    _showCopyButton();
    _updatePreview();
  }

  // Extend selection from anchor to current touch position (character-level,
  // works across lines via xterm's select() length wrapping)
  function _extendSelection(clientX, clientY) {
    var cell = _touchToCell(clientX, clientY);
    if (!cell) return;

    // Determine start and end in viewport coordinates
    var startRow, startCol, endRow, endCol;
    if (cell.row < sel.anchorRow || (cell.row === sel.anchorRow && cell.col < sel.anchorCol)) {
      sel.dragDirection = 'up';
      startRow = cell.row; startCol = cell.col;
      endRow = sel.anchorRow; endCol = sel.anchorCol;
    } else {
      sel.dragDirection = 'down';
      startRow = sel.anchorRow; startCol = sel.anchorCol;
      endRow = cell.row; endCol = cell.col;
    }

    // Snap start to word beginning, end to word end
    var startLine = _getLineText(startRow);
    var endLine = _getLineText(endRow);
    var sBounds = _wordBounds(startLine, startCol);
    var eBounds = _wordBounds(endLine, endCol);

    var selCol = sBounds.start;
    var selBufRow = term.buffer.active.viewportY + startRow;
    // Total length = remaining chars on start line + full middle lines + chars on end line
    var length;
    if (startRow === endRow) {
      length = eBounds.end - sBounds.start;
    } else {
      length = (term.cols - sBounds.start); // rest of start line
      for (var r = startRow + 1; r < endRow; r++) length += term.cols;
      length += eBounds.end; // end line
    }
    term.select(selCol, selBufRow, length);
    _showCopyButton();
    _updatePreview();
  }

  function _updatePreview() {
    var text = term.getSelection();
    if (!text) { _hidePreview(); return; }
    var el = termContainer.querySelector('.term-sel-preview');
    if (!el) {
      el = document.createElement('textarea');
      el.className = 'term-sel-preview';
      el.spellcheck = false;
      el.autocomplete = 'off';
      // Stop touch events on preview from propagating to overlay
      el.addEventListener('touchstart', function (ev) { ev.stopPropagation(); });
      el.addEventListener('touchmove', function (ev) { ev.stopPropagation(); });
      el.addEventListener('touchend', function (ev) { ev.stopPropagation(); });
      termContainer.appendChild(el);
    }
    // Only update value while dragging; once user lifts finger they can edit freely
    if (sel.dragging) {
      el.value = text;
      if (sel.dragDirection === 'up') {
        el.scrollTop = 0;
      } else {
        el.scrollTop = el.scrollHeight;
      }
    }
  }

  // Get the current preview text (user may have edited it)
  function _getPreviewText() {
    var el = termContainer.querySelector('.term-sel-preview');
    return el ? el.value : '';
  }

  function _hidePreview() {
    var el = termContainer.querySelector('.term-sel-preview');
    if (el) el.remove();
  }

  function _exitSelectionMode() {
    if (!longPress.active) return;
    longPress.active = false;
    sel.dragging = false;
    _hideCopyButton();
    _hidePreview();
    term.clearSelection();
  }

  function _showCopyButton() {
    if (!term.getSelection()) return;
    var existing = termContainer.querySelector('.term-copy-btn');
    if (existing) return;
    var btn = document.createElement('button');
    btn.className = 'term-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('touchend', function (ev) {
      ev.stopPropagation();
      ev.preventDefault();
      var text = _getPreviewText() || term.getSelection();
      if (text) _copyToClipboard(text);
      term.clearSelection();
      _showToast('Copied');
      longPress.active = false;
      sel.dragging = false;
      _hideCopyButton();
      _hidePreview();
    });
    termContainer.appendChild(btn);
  }

  function _hideCopyButton() {
    var btn = termContainer.querySelector('.term-copy-btn');
    if (btn) btn.remove();
  }

  // Unified touch handler: vertical = tmux scroll, horizontal = swipe back
  var ts = {
    startX: 0, startY: 0, lastY: 0,
    moved: false, scrollAccum: 0,
    direction: null,  // null | 'vertical' | 'horizontal'
    startTime: 0, currentDx: 0,
  };
  var LOCK_DISTANCE = 12;         // px before direction locks
  var swipeIndicator = termContainer.closest('.terminal-view')
    ? termContainer.closest('.terminal-view').querySelector('.swipe-back-indicator')
    : null;
  var sw = window.innerWidth;
  var SWIPE_THRESHOLD = sw * 0.22;
  var VELOCITY_TRIGGER = 0.35;    // px/ms

  // Pinch-to-zoom state
  var pinch = { active: false, startDist: 0, startFontSize: 0 };

  function _pinchDist(e) {
    var t0 = e.touches[0], t1 = e.touches[1];
    var dx = t1.clientX - t0.clientX, dy = t1.clientY - t0.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  overlay.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      // Start pinch-to-zoom
      clearTimeout(longPress.timer);
      pinch.active = true;
      pinch.startDist = _pinchDist(e);
      pinch.startFontSize = term.options.fontSize || 14;
      ts.direction = null;
      e.preventDefault();
      return;
    }
    if (e.touches.length === 1) {
      pinch.active = false;
      var t = e.touches[0];
      ts.startX = t.clientX;
      ts.startY = t.clientY;
      ts.lastY = t.clientY;
      ts.moved = false;
      ts.scrollAccum = 0;
      ts.direction = null;
      ts.startTime = Date.now();
      ts.currentDx = 0;
      if (swipeIndicator) {
        swipeIndicator.style.transition = 'none';
        swipeIndicator.style.opacity = '0';
      }

      // Start long-press timer (only if not already in selection mode)
      if (!longPress.active) {
        var lpX = t.clientX, lpY = t.clientY;
        clearTimeout(longPress.timer);
        longPress.timer = setTimeout(function () {
          if (!ts.moved) {
            _enterSelectionMode(lpX, lpY);
          }
        }, LONG_PRESS_MS);
      }
    }
  });

  overlay.addEventListener('touchmove', function (e) {
    // In selection mode, drag to extend selection
    if (longPress.active && sel.dragging && e.touches.length === 1) {
      var dt = e.touches[0];
      _extendSelection(dt.clientX, dt.clientY);
      e.preventDefault();
      return;
    }

    // Cancel long-press if finger moved too far
    if (longPress.timer && e.touches.length === 1) {
      var lt = e.touches[0];
      var ldx = lt.clientX - ts.startX;
      var ldy = lt.clientY - ts.startY;
      if (Math.abs(ldx) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(ldy) > LONG_PRESS_MOVE_TOLERANCE) {
        clearTimeout(longPress.timer);
        longPress.timer = null;
      }
    }

    // Pinch-to-zoom: adjust font size
    if (e.touches.length === 2 && pinch.active) {
      var dist = _pinchDist(e);
      var scale = dist / pinch.startDist;
      var newSize = Math.round(pinch.startFontSize * scale);
      newSize = Math.max(8, Math.min(22, newSize));
      if (newSize !== term.options.fontSize) {
        var delta = newSize - term.options.fontSize;
        _setFontOffset(_getFontOffset() + delta);
        term.options.fontSize = newSize;
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      }
      e.preventDefault();
      return;
    }
    if (e.touches.length !== 1 || pinch.active) return;
    var t = e.touches[0];
    var dx = t.clientX - ts.startX;
    var dy = t.clientY - ts.startY;
    ts.moved = true;

    // Lock direction after initial movement
    if (!ts.direction) {
      if (Math.abs(dx) >= LOCK_DISTANCE || Math.abs(dy) >= LOCK_DISTANCE) {
        ts.direction = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      } else {
        return; // Not enough movement yet
      }
    }

    if (ts.direction === 'horizontal') {
      ts.currentDx = Math.max(0, dx);
      // Visual feedback
      if (swipeIndicator) {
        var progress = Math.min(ts.currentDx / SWIPE_THRESHOLD, 1);
        swipeIndicator.style.opacity = String(progress * 0.9);
        swipeIndicator.style.transform = 'scaleX(' + (0.3 + progress * 0.7) + ')';
      }
      e.preventDefault();
    } else {
      // Vertical: tmux scroll
      var scrollDy = ts.lastY - t.clientY;
      ts.lastY = t.clientY;
      ts.scrollAccum += scrollDy;

      var lines = Math.trunc(ts.scrollAccum / 16);
      if (lines !== 0 && ws.readyState === WebSocket.OPEN) {
        var seq = lines > 0 ? '\x1b[<65;1;1M' : '\x1b[<64;1;1M';
        var count = Math.abs(lines);
        var batch = '';
        for (var j = 0; j < count; j++) { batch += seq; }
        ws.send(JSON.stringify({ type: 'input', data: batch }));
        ts.scrollAccum -= lines * 16;
      }
      e.preventDefault();
    }
  });

  overlay.addEventListener('touchend', function (e) {
    clearTimeout(longPress.timer);
    longPress.timer = null;

    // In selection mode
    if (longPress.active) {
      if (sel.dragging) {
        // Finger lifted after drag — stop dragging, keep selection visible
        sel.dragging = false;
      } else {
        // Tap while selection is showing — exit selection mode
        _exitSelectionMode();
      }
      return;
    }

    if (pinch.active) {
      pinch.active = false;
      return;
    }
    if (!ts.moved) {
      // Tap: check if tapped on a file path first
      if (typeof FilePreview !== 'undefined') {
        var tapTouch = e.changedTouches[0];
        var tapCell = _touchToCell(tapTouch.clientX, tapTouch.clientY);
        if (tapCell) {
          var tapLine = _getLineText(tapCell.row);
          var tapPath = FilePreview.hitTest(tapLine, tapCell.col, term, tapCell.row);
          if (tapPath) {
            FilePreview.openFile(tapPath, state.currentPane);
            return;
          }
        }
      }
      // No file path hit — pass through to terminal
      overlay.style.pointerEvents = 'none';
      var touch = e.changedTouches[0];
      var el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el) { el.focus(); el.click(); }
      setTimeout(function () { overlay.style.pointerEvents = ''; }, 300);
      return;
    }

    if (ts.direction === 'horizontal') {
      var endX = e.changedTouches[0].clientX;
      var totalDx = endX - ts.startX;
      var dt = Date.now() - ts.startTime;
      var velocity = dt > 0 ? totalDx / dt : 0;

      // Fade out indicator
      if (swipeIndicator) {
        swipeIndicator.style.transition = 'opacity 0.25s, transform 0.25s';
        swipeIndicator.style.opacity = '0';
        swipeIndicator.style.transform = 'scaleX(0.3)';
      }

      if (totalDx >= SWIPE_THRESHOLD || velocity >= VELOCITY_TRIGGER) {
        _backToWindows();
      }
    }
  });

  // ResizeObserver for auto-fit
  var resizeObserver = new ResizeObserver(function () {
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  });
  resizeObserver.observe(termContainer);

  // Ctrl+wheel to zoom font size (desktop).
  // Debounce: a single scroll gesture triggers only one font size step.
  var _wheelZoomTimer = null;
  var _wheelZoomDir = 0;
  termContainer.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    _wheelZoomDir += e.deltaY;
    clearTimeout(_wheelZoomTimer);
    _wheelZoomTimer = setTimeout(function () {
      if (_wheelZoomDir !== 0) {
        _adjustFontSize(_wheelZoomDir < 0 ? 1 : -1);
      }
      _wheelZoomDir = 0;
    }, 150);
  }, { passive: false, capture: true });

  // Handle mobile virtual keyboard: when keyboard opens, visualViewport
  // shrinks but CSS vh doesn't. Resize terminal-container (not the whole view)
  // to keep the header visible.
  var vpHandler = null;
  if (window.visualViewport && window.innerWidth < 768) {
    var initialVpHeight = window.visualViewport.height;
    vpHandler = function () {
      var vvHeight = window.visualViewport.height;
      // Only intervene when keyboard is likely open (viewport shrunk > 100px)
      var fabTool = document.querySelector('.fab-tool');
      var fabPanel = document.querySelector('.fab-panel');
      if (initialVpHeight - vvHeight > 100) {
        var header = termContainer.closest('.terminal-view')
          ? termContainer.closest('.terminal-view').querySelector('.terminal-header')
          : null;
        var headerH = header ? header.offsetHeight : 36;
        var contentPad = 24; // #content padding top+bottom
        var available = vvHeight - headerH - contentPad;
        if (available > 0) {
          termContainer.style.height = available + 'px';
          termContainer.style.maxHeight = available + 'px';
        }
        // Move FAB above the keyboard
        if (fabTool) {
          var visibleBottom = window.visualViewport.offsetTop + vvHeight;
          var fabY = visibleBottom - 48 - 16; // 48=fab height, 16=margin
          fabTool.style.top = fabY + 'px';
          fabTool.style.bottom = 'auto';
          fabTool.style.right = '16px';
          fabTool.style.left = 'auto';
          fabTool._kbOpen = true;
        }
      } else {
        termContainer.style.height = '';
        termContainer.style.maxHeight = '';
        // Reset FAB position
        if (fabTool && fabTool._kbOpen) {
          fabTool._kbOpen = false;
          var savedPos = null;
          try { savedPos = JSON.parse(localStorage.getItem('fab-pos')); } catch(_e) {}
          if (savedPos) {
            fabTool.style.left = savedPos.left;
            fabTool.style.top = savedPos.top;
            fabTool.style.right = 'auto';
            fabTool.style.bottom = 'auto';
          } else {
            fabTool.style.top = '';
            fabTool.style.left = '';
            fabTool.style.right = '';
            fabTool.style.bottom = '';
          }
        }
      }
      // Reposition panel if open
      if (fabPanel && fabPanel.classList.contains('open') && fabTool) {
        var rect = fabTool.getBoundingClientRect();
        var pw = fabPanel.offsetWidth || 200;
        var ph = fabPanel.offsetHeight || 200;
        var left = rect.left + rect.width / 2 - pw / 2;
        var top = rect.top - ph - 10;
        if (left < 8) left = 8;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
        if (top < 8) top = rect.bottom + 10;
        fabPanel.style.left = left + 'px';
        fabPanel.style.top = top + 'px';
      }
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    window.visualViewport.addEventListener('resize', vpHandler);
    window.visualViewport.addEventListener('scroll', vpHandler);
  }

  // Store references for cleanup
  terminalState.term = term;
  terminalState.ws = ws;
  terminalState.fitAddon = fitAddon;
  terminalState.resizeObserver = resizeObserver;
  terminalState._vpHandler = vpHandler;

  // Track viewport width to re-render when crossing mobile/desktop threshold
  var _lastIsDesktop = window.innerWidth >= 768;
  var _resizeHandler = function () {
    var isDesktop = window.innerWidth >= 768;
    if (isDesktop !== _lastIsDesktop) {
      _lastIsDesktop = isDesktop;
      // Viewport crossed 768px threshold — re-render to switch tab/split layout
      if (state.currentTab === 'terminal' && terminalState.term === term) {
        var content = document.getElementById('content');
        if (content) renderTerminal(content);
      }
    }
  };
  window.addEventListener('resize', _resizeHandler);
  // Store for cleanup
  terminalState._resizeHandler = _resizeHandler;
}

// === Reconnect Overlay ===

function _showReconnectOverlay(term, paneId, nozoom) {
  var termContainer = terminalState.termContainer;
  if (!termContainer) return;

  // Create overlay
  var overlay = document.createElement('div');
  overlay.className = 'terminal-reconnect-overlay';
  overlay.innerHTML =
    '<div class="terminal-reconnect-box">' +
    '<div class="terminal-reconnect-spinner"></div>' +
    '<div class="terminal-reconnect-text">连接已断开，正在重连...</div>' +
    '</div>';
  termContainer.appendChild(overlay);

  var attempt = 0;
  var maxAttempts = 10;
  var baseDelay = 1000;
  var textEl = overlay.querySelector('.terminal-reconnect-text');

  function tryReconnect() {
    attempt++;
    if (attempt > maxAttempts || state.currentTab !== 'terminal' || terminalState.term !== term) {
      if (textEl) textEl.textContent = '重连失败，请返回重新进入';
      var spinner = overlay.querySelector('.terminal-reconnect-spinner');
      if (spinner) spinner.style.display = 'none';
      return;
    }

    if (textEl) textEl.textContent = '正在重连... (' + attempt + '/' + maxAttempts + ')';

    var ws = connectTerminalWs(paneId, term, nozoom);

    ws.onopen = function () {
      // Reconnected — remove overlay, update state
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      terminalState.ws = ws;
      // Re-send resize
      if (term.cols && term.rows) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    ws.onclose = function () {
      // Retry with exponential backoff
      if (state.currentTab === 'terminal' && terminalState.term === term) {
        var delay = Math.min(baseDelay * Math.pow(1.5, attempt - 1), 10000);
        setTimeout(tryReconnect, delay);
      }
    };

    ws.onerror = function () {
      // onclose will fire
    };
  }

  setTimeout(tryReconnect, baseDelay);
}

// === Navigate back to windows and scroll to current window ===

function _backToWindows() {
  var windowIndex = state.currentWindow;
  cleanupTerminal();
  navigate('windows', { currentSession: state.currentSession });

  // After render, scroll to the window card that was just open
  if (windowIndex != null) {
    _scrollToWindowCard(windowIndex);
  }
}

function _scrollToWindowCard(windowIndex) {
  // The render is async (fetches sessions then windows), so poll briefly
  var attempts = 0;
  var timer = setInterval(function () {
    var card = document.querySelector('.swipe-container[data-window-index="' + windowIndex + '"]');
    if (card) {
      clearInterval(timer);
      // Scroll only #content container, not the entire page
      // (scrollIntoView scrolls all ancestors including body, pushing topbar out of view)
      var contentEl = document.getElementById('content');
      if (contentEl) {
        var cardRect = card.getBoundingClientRect();
        var contentRect = contentEl.getBoundingClientRect();
        var targetTop = contentEl.scrollTop + (cardRect.top - contentRect.top) - (contentEl.clientHeight - card.offsetHeight) / 2;
        contentEl.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      }
      // Brief highlight
      card.style.outline = '2px solid var(--accent-blue)';
      card.style.outlineOffset = '2px';
      card.style.borderRadius = '10px';
      setTimeout(function () {
        card.style.outline = '';
        card.style.outlineOffset = '';
      }, 1500);
    }
    if (++attempts > 20) clearInterval(timer);
  }, 100);
}

