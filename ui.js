/* fr24-measure/ui.js
 * World: ISOLATED  |  run_at: document_idle
 * Owns: button injection, flyout UI, chrome.storage.sync settings.
 * Communicates with main.js (MAIN world) via window.postMessage.
 */

'use strict';

(function () {

  const NS = 'fr24-measure';

  // ---------------------------------------------------------------------------
  // Default settings
  // ---------------------------------------------------------------------------

  const DEFAULTS = { color: '#facc15', unit: 'nm', lineStyle: 'solid', lineWeight: 3 };
  const SWATCHES = [
    { color: '#facc15', label: 'Yellow' },
    { color: '#ef4444', label: 'Red'    },
    { color: '#22d3ee', label: 'Cyan'   },
    { color: '#22c55e', label: 'Green'  },
    { color: '#ffffff', label: 'White'  },
    { color: '#f97316', label: 'Orange' }
  ];

  let currentSettings = { ...DEFAULTS };
  let measuring = false;
  let mapCaptured = false;

  // ---------------------------------------------------------------------------
  // Ruler SVG icon (inline, fill:currentColor)
  // ---------------------------------------------------------------------------

  const RULER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="size-6" aria-hidden="true">
    <circle cx="12" cy="12" r="7"/>
    <line x1="12" y1="2" x2="12" y2="6"/>
    <line x1="12" y1="18" x2="12" y2="22"/>
    <line x1="2"  y1="12" x2="6"  y2="12"/>
    <line x1="18" y1="12" x2="22" y2="12"/>
  </svg>`;

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------

  function loadSettings(cb) {
    chrome.storage.sync.get(DEFAULTS, (result) => {
      currentSettings = {
        color: result.color,
        unit: result.unit,
        lineStyle: result.lineStyle,
        lineWeight: result.lineWeight
      };
      cb(currentSettings);
    });
  }

  function saveSettings(patch) {
    currentSettings = { ...currentSettings, ...patch };
    chrome.storage.sync.set(currentSettings);
    sendSettings();
    if (!measuring) sendMessage({ type: 'toggle' });
    updateFlyoutState();
  }

  // ---------------------------------------------------------------------------
  // postMessage bridge
  // ---------------------------------------------------------------------------

  function sendMessage(msg) {
    window.postMessage({ source: NS, ...msg }, '*');
  }

  function sendSettings() {
    sendMessage({ type: 'settings', settings: currentSettings });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.source !== NS) return;
    if (msg.type === 'status') {
      mapCaptured = !!msg.mapCaptured;
      measuring   = !!msg.measuring;
      updateButtonState();
    }
  });

  // ---------------------------------------------------------------------------
  // Button injection
  // ---------------------------------------------------------------------------

  // DOM assumption: the location button has id="location-button" and is a
  // sibling of where we want our button. If FR24 renames this id, update here.
  function findAnchor() {
    return document.getElementById('location-button');
  }

  function buildButton() {
    const btn = document.createElement('button');
    btn.id = 'fr24-measure-button';
    btn.title = 'Measure distance';
    // DOM assumption: these Tailwind utility classes are used by #location-button.
    // If FR24 changes its button classes, update this className list.
    btn.className =
      'group relative flex size-10 items-center justify-center rounded-full ' +
      'shadow-default bg-gray-1300/90 text-white ' +
      'hover:text-yellow-500 hover:focus:text-yellow-500 ' +
      'focus:text-white hover:disabled:text-white';
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = RULER_SVG;

    btn.addEventListener('click', onButtonClick);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onButtonClick(); }
    });

    return btn;
  }

  function onButtonClick() {
    sendMessage({ type: 'toggle' });
  }

  function updateButtonState() {
    const btn = document.getElementById('fr24-measure-button');
    if (!btn) return;
    if (measuring) {
      btn.style.color = '#facc15'; // yellow-500
      btn.setAttribute('aria-pressed', 'true');
    } else {
      btn.style.color = '';
      btn.setAttribute('aria-pressed', 'false');
    }
  }

  function injectButton() {
    if (document.getElementById('fr24-measure-button')) return; // already present
    const anchor = findAnchor();
    if (!anchor) return;
    const btn = buildButton();
    anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    injectFlyout(btn);
    updateButtonState();
    updateFlyoutState();
  }

  // ---------------------------------------------------------------------------
  // Flyout
  // ---------------------------------------------------------------------------

  function buildFlyout() {
    const flyout = document.createElement('div');
    flyout.id = 'fr24m-flyout';
    flyout.setAttribute('role', 'dialog');
    flyout.setAttribute('aria-label', 'Measurement settings');

    // Colour row
    const colorRow = document.createElement('div');
    colorRow.className = 'fr24m-row';

    SWATCHES.forEach(({ color, label }) => {
      const swatch = document.createElement('button');
      swatch.className = 'fr24m-swatch';
      swatch.style.background = color;
      swatch.title = label;
      swatch.setAttribute('aria-label', label);
      swatch.dataset.color = color;
      swatch.addEventListener('click', () => saveSettings({ color }));
      colorRow.appendChild(swatch);
    });

    // Custom colour picker
    const customWrap = document.createElement('label');
    customWrap.className = 'fr24m-swatch fr24m-custom-wrap';
    customWrap.title = 'Custom colour';
    const customInput = document.createElement('input');
    customInput.type = 'color';
    customInput.id = 'fr24m-color-input';
    customInput.addEventListener('input', (e) => saveSettings({ color: e.target.value }));
    // "+" label inside the swatch
    customWrap.textContent = '+';
    customWrap.appendChild(customInput);
    colorRow.appendChild(customWrap);

    // Unit row
    const unitRow = document.createElement('div');
    unitRow.className = 'fr24m-row';
    ['km', 'mi', 'nm'].forEach((u) => {
      const seg = document.createElement('button');
      seg.className = 'fr24m-unit-seg';
      seg.dataset.unit = u;
      seg.textContent = u;
      seg.addEventListener('click', () => saveSettings({ unit: u }));
      unitRow.appendChild(seg);
    });

    // Line style row
    const styleRow = document.createElement('div');
    styleRow.className = 'fr24m-row';
    const LINE_STYLES = [
      {
        value: 'solid',
        label: 'Solid',
        svg: '<svg viewBox="0 0 32 10" xmlns="http://www.w3.org/2000/svg"><line x1="1" y1="5" x2="31" y2="5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>'
      },
      {
        value: 'dashed',
        label: 'Dashed',
        svg: '<svg viewBox="0 0 32 10" xmlns="http://www.w3.org/2000/svg"><line x1="1" y1="5" x2="31" y2="5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="7,5"/></svg>'
      },
      {
        value: 'dotted',
        label: 'Dotted',
        svg: '<svg viewBox="0 0 32 10" xmlns="http://www.w3.org/2000/svg"><line x1="1" y1="5" x2="31" y2="5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="1,6"/></svg>'
      }
    ];
    LINE_STYLES.forEach(({ value, label, svg }) => {
      const btn = document.createElement('button');
      btn.className = 'fr24m-style-seg';
      btn.dataset.lineStyle = value;
      btn.title = label;
      btn.innerHTML = svg;
      btn.addEventListener('click', () => saveSettings({ lineStyle: value }));
      styleRow.appendChild(btn);
    });

    // Thickness row — stepper control (no slider CSS headaches)
    const thickRow = document.createElement('div');
    thickRow.className = 'fr24m-row fr24m-thick-row';

    const thickLabel = document.createElement('span');
    thickLabel.className = 'fr24m-thick-label';
    thickLabel.textContent = 'Width';

    const btnMinus = document.createElement('button');
    btnMinus.className = 'fr24m-step-btn';
    btnMinus.textContent = '−';
    btnMinus.setAttribute('aria-label', 'Decrease width');

    const thickVal = document.createElement('span');
    thickVal.id = 'fr24m-weight-val';
    thickVal.className = 'fr24m-thick-val';
    thickVal.textContent = String(currentSettings.lineWeight);

    const btnPlus = document.createElement('button');
    btnPlus.className = 'fr24m-step-btn';
    btnPlus.textContent = '+';
    btnPlus.setAttribute('aria-label', 'Increase width');

    function updateWeight(delta) {
      const next = Math.min(8, Math.max(1, currentSettings.lineWeight + delta));
      if (next === currentSettings.lineWeight) return;
      thickVal.textContent = String(next);
      btnMinus.disabled = next <= 1;
      btnPlus.disabled  = next >= 8;
      saveSettings({ lineWeight: next });
    }

    btnMinus.addEventListener('click', () => updateWeight(-1));
    btnPlus.addEventListener('click',  () => updateWeight(+1));
    btnMinus.disabled = currentSettings.lineWeight <= 1;
    btnPlus.disabled  = currentSettings.lineWeight >= 8;

    thickRow.appendChild(thickLabel);
    thickRow.appendChild(btnMinus);
    thickRow.appendChild(thickVal);
    thickRow.appendChild(btnPlus);

    flyout.appendChild(colorRow);
    flyout.appendChild(unitRow);
    flyout.appendChild(styleRow);
    flyout.appendChild(thickRow);
    return flyout;
  }

  let flyoutEl = null;
  let flyoutCloseTimer = null;

  function injectFlyout(btn) {
    flyoutEl = buildFlyout();
    document.body.appendChild(flyoutEl);

    // Position: to the left of the button.
    // Use `right` (distance from viewport right edge) so we don't need the
    // flyout's own width — which is 0 while display:none.
    function repositionFlyout() {
      const rect = btn.getBoundingClientRect();
      flyoutEl.style.top   = `${rect.top + window.scrollY + rect.height / 2}px`;
      flyoutEl.style.left  = 'auto';
      flyoutEl.style.right = `${window.innerWidth - rect.left + 8}px`;
      flyoutEl.style.transform = 'translateY(-50%)';
    }

    function showFlyout() {
      clearTimeout(flyoutCloseTimer);
      repositionFlyout();
      flyoutEl.classList.add('fr24m-visible');
    }

    function hideFlyout() {
      flyoutCloseTimer = setTimeout(() => flyoutEl.classList.remove('fr24m-visible'), 200);
    }

    btn.addEventListener('mouseenter', showFlyout);
    btn.addEventListener('mouseleave', hideFlyout);
    btn.addEventListener('focus', showFlyout);
    btn.addEventListener('blur', (e) => {
      if (!flyoutEl.contains(e.relatedTarget)) hideFlyout();
    });

    flyoutEl.addEventListener('mouseenter', () => clearTimeout(flyoutCloseTimer));
    flyoutEl.addEventListener('mouseleave', hideFlyout);
    flyoutEl.addEventListener('focusin',   () => clearTimeout(flyoutCloseTimer));
    flyoutEl.addEventListener('focusout',  (e) => {
      if (!flyoutEl.contains(e.relatedTarget) && e.relatedTarget !== btn) hideFlyout();
    });
  }

  function updateFlyoutState() {
    if (!flyoutEl) return;

    // Highlight active swatch
    flyoutEl.querySelectorAll('.fr24m-swatch[data-color]').forEach((el) => {
      const active = el.dataset.color.toLowerCase() === currentSettings.color.toLowerCase();
      el.classList.toggle('fr24m-active', active);
    });

    // Update custom colour input value
    const ci = flyoutEl.querySelector('#fr24m-color-input');
    if (ci) ci.value = currentSettings.color;

    // Highlight active unit segment
    flyoutEl.querySelectorAll('.fr24m-unit-seg').forEach((el) => {
      el.classList.toggle('fr24m-active', el.dataset.unit === currentSettings.unit);
    });

    // Highlight active line style
    flyoutEl.querySelectorAll('.fr24m-style-seg').forEach((el) => {
      el.classList.toggle('fr24m-active', el.dataset.lineStyle === currentSettings.lineStyle);
    });

    // Sync thickness stepper
    const val = flyoutEl.querySelector('#fr24m-weight-val');
    if (val) val.textContent = String(currentSettings.lineWeight);
    flyoutEl.querySelectorAll('.fr24m-step-btn').forEach((btn) => {
      if (btn.textContent === '−') btn.disabled = currentSettings.lineWeight <= 1;
      if (btn.textContent === '+') btn.disabled = currentSettings.lineWeight >= 8;
    });
  }

  // ---------------------------------------------------------------------------
  // MutationObserver — re-inject if button removed (SPA navigation)
  // ---------------------------------------------------------------------------

  const observer = new MutationObserver(() => {
    if (!document.getElementById('fr24-measure-button')) {
      injectButton();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  loadSettings((s) => {
    currentSettings = s;
    injectButton();
    // Tell main.js we're alive and send initial settings
    sendMessage({ type: 'ready' });
    sendSettings();
  });

})();
