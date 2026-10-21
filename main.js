/* radar-ruler/main.js
 * World: MAIN  |  run_at: document_start
 * Owns all Google Maps interaction: capture, drawing, measurement.
 * Communicates with ui.js (ISOLATED world) via window.postMessage.
 */

'use strict';

(function () {

  // Prevent re-initialization on SPA navigations: if this script has already
  // run in this page context, window.__radarRuler exists — bail out immediately.
  if (window.__radarRuler) return;

  // ---------------------------------------------------------------------------
  // Constants / config
  // ---------------------------------------------------------------------------

  const NS = 'radar-ruler';
  const SHOW_BEARING = false;          // secondary bearing line in label
  const CLICK_MOVE_THRESHOLD = 5;      // px — below this = click, else pan
  const CAPTURE_POLL_MS = 50;
  const CAPTURE_TIMEOUT_MS = 30_000;
  const MIN_MAP_SIZE = 200;            // px — ignore tiny embeds / minimaps

  // Haversine fallback (used if google.maps.geometry.spherical is absent)
  const EARTH_R = 6_371_008.8;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let capturedMap = null;
  let overlay = null;          // OverlayView used for pixel↔LatLng
  let projectionReady = false;

  let settings = { color: '#facc15', unit: 'nm', labelSize: 2 };

  const LABEL_SIZE_MAP = { 1: { fs: '10px', pad: '2px 5px' }, 2: { fs: '12px', pad: '3px 7px' }, 3: { fs: '15px', pad: '4px 10px' } };
  const SEG_LABEL_SIZE_MAP = { 1: { fs: '9px', pad: '1px 4px' }, 2: { fs: '11px', pad: '2px 6px' }, 3: { fs: '14px', pad: '3px 8px' } };

  let measureOn = false;
  let prevCursorOptions = null; // { draggableCursor, draggingCursor }

  // Measurement state machine: 'idle' | 'drawing' | 'finished'
  let state = 'idle';
  let waypoints = [];          // LatLng[] — committed points
  let dotOverlays = [];        // one OverlayView dot per waypoint

  // Map overlays
  let polyline = null;
  let labelOverlay = null;      // total-distance pill (shown when ≥ 3 waypoints)
  let segLabelOverlays = [];    // one pill per completed segment
  let rubberSegLabel = null;    // reused pill for the live rubber-band segment

  // Double-click detection (finish gesture)
  let lastClickTime = 0;
  let lastClickX = 0;
  let lastClickY = 0;
  const DBLCLICK_MS = 350;
  const DBLCLICK_PX = 10;

  // Pointer tracking for click-vs-drag discrimination
  let pointerDownX = 0;
  let pointerDownY = 0;
  let pointerMoved = false;

  // rAF handle for mousemove throttle
  let rafPending = false;
  let pendingLatLng = null;

  // Container-level event listeners (added / removed with measure mode)
  let boundPointerDown = null;
  let boundPointerMove = null;
  let boundPointerUp = null;
  let boundMouseMove = null;
  let boundClick = null;
  let boundKeyDown = null;
  let boundContextMenu = null;

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function haversine(a, b) {
    const toRad = d => d * Math.PI / 180;
    const lat1 = toRad(a.lat()), lat2 = toRad(b.lat());
    const dLat = lat2 - lat1;
    const dLng = toRad(b.lng() - a.lng());
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.sqrt(s));
  }

  function computeDistance(a, b) {
    if (window.google?.maps?.geometry?.spherical) {
      return google.maps.geometry.spherical.computeDistanceBetween(a, b);
    }
    return haversine(a, b);
  }

  function midpoint(a, b) {
    if (window.google?.maps?.geometry?.spherical) {
      return google.maps.geometry.spherical.interpolate(a, b, 0.5);
    }
    // Simple average fallback (fine for label placement)
    return new google.maps.LatLng((a.lat() + b.lat()) / 2, (a.lng() + b.lng()) / 2);
  }

  function formatBearing(a, b) {
    const raw = google.maps.geometry.spherical.computeHeading(a, b);
    const deg = ((raw % 360) + 360) % 360;
    return `${Math.round(deg).toString().padStart(3, '0')}°`;
  }

  function formatDistance(metres) {
    const { unit } = settings;
    if (unit === 'km') {
      return metres < 1000
        ? `${Math.round(metres)} m`
        : `${(metres / 1000).toFixed(1)} km`;
    }
    if (unit === 'mi') {
      const mi = metres / 1609.344;
      return mi < 0.1 ? `${Math.round(metres)} m` : `${mi.toFixed(1)} mi`;
    }
    // nm
    const nm = metres / 1852;
    return nm < 0.1 ? `${Math.round(metres)} m` : `${nm.toFixed(1)} nm`;
  }

  function computeBearing(a, b) {
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;
    const dLng = toRad(b.lng() - a.lng());
    const lat1 = toRad(a.lat()), lat2 = toRad(b.lat());
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // ---------------------------------------------------------------------------
  // Toast (shown when map not yet captured)
  // ---------------------------------------------------------------------------

  function showToast(msg) {
    const existing = document.getElementById('fr24m-toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'fr24m-toast';
    Object.assign(el.style, {
      position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(17,24,39,0.95)', color: '#fff', padding: '8px 16px',
      borderRadius: '8px', fontSize: '13px', zIndex: '999999',
      pointerEvents: 'none', whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
    });
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ---------------------------------------------------------------------------
  // Map capture
  // ---------------------------------------------------------------------------

  function isMainMap(mapInstance) {
    try {
      const div = mapInstance.getDiv();
      if (!div) return false;
      const rect = div.getBoundingClientRect();
      return rect.width >= MIN_MAP_SIZE && rect.height >= MIN_MAP_SIZE;
    } catch {
      return false;
    }
  }

  let _captureInProgress = false;

  function capture(mapInstance) {
    if (capturedMap) return;
    // Re-entrancy guard: isMainMap() calls mapInstance.getDiv(), which is a
    // wrapped method that re-enters capture() before capturedMap is assigned.
    // Without this guard the calls recurse until Chrome throws a RangeError,
    // which isMainMap's try/catch swallows, causing the whole cycle to repeat
    // on every subsequent wrapped-method call — hence the repeated log lines.
    if (_captureInProgress) return;
    _captureInProgress = true;
    try {
      if (!isMainMap(mapInstance)) return;
      capturedMap = mapInstance;
      console.log('[radar-ruler] map captured');
      // Attach the right-click toggle listener once for the lifetime of this map instance.
      boundContextMenu = onContextMenu.bind(null);
      capturedMap.getDiv().addEventListener('contextmenu', boundContextMenu, { capture: true });
      postStatus();
      initOverlay();
    } finally {
      _captureInProgress = false;
    }
  }

  function wrapMapPrototype() {
    const proto = google.maps.Map.prototype;
    // DOM assumption: these methods are on the standard Maps JS API prototype.
    const methods = [
      'getBounds', 'getZoom', 'getCenter', 'getProjection',
      'setCenter', 'panTo', 'panBy', 'fitBounds', 'setZoom',
      'getMapTypeId', 'getDiv'
    ];

    methods.forEach(name => {
      const orig = proto[name];
      if (!orig || orig.__fr24wrapped) return;
      proto[name] = function (...args) {
        capture(this);
        return orig.apply(this, args);
      };
      proto[name].__fr24wrapped = true;
    });
  }

  function wrapMapConstructor() {
    // Secondary path: subclass constructor so we see new instances too.
    const Orig = google.maps.Map;
    if (Orig.__fr24wrapped) return;
    try {
      class WrappedMap extends Orig {
        constructor(...args) {
          super(...args);
          capture(this);
        }
      }
      // Copy statics / prototype chain references
      Object.setPrototypeOf(WrappedMap, Orig);
      WrappedMap.__fr24wrapped = true;
      google.maps.Map = WrappedMap;
    } catch (e) {
      // Non-fatal: prototype wrapping alone is sufficient
      console.warn('[radar-ruler] constructor wrap failed:', e);
    }
  }

  function startCapture() {
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    const timer = setInterval(() => {
      if (capturedMap) { clearInterval(timer); return; }
      if (Date.now() > deadline) { clearInterval(timer); return; }
      if (!window.google?.maps?.Map?.prototype) return;
      clearInterval(timer);
      wrapMapPrototype();
      wrapMapConstructor();
    }, CAPTURE_POLL_MS);
  }

  // ---------------------------------------------------------------------------
  // OverlayView for pixel↔LatLng projection
  // ---------------------------------------------------------------------------

  function initOverlay() {
    if (overlay || !capturedMap) return;
    // DOM assumption: google.maps.OverlayView is available when map is captured.
    overlay = new google.maps.OverlayView();
    overlay.onAdd = function () {
      projectionReady = true;
    };
    overlay.draw = function () { };
    overlay.onRemove = function () {
      projectionReady = false;
    };
    overlay.setMap(capturedMap);
  }

  function pixelToLatLng(x, y) {
    if (!projectionReady) return null;
    const proj = overlay.getProjection();
    if (!proj) return null;
    return proj.fromContainerPixelToLatLng(new google.maps.Point(x, y));
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  // Returns the polyline options object for the given color + lineStyle.
  // Dashed/dotted lines work by setting strokeOpacity:0 and using the icons
  // array — the only way Google Maps supports non-solid polyline patterns.
  function polylineOptions(color, lineStyle, lineWeight) {
    const w = lineWeight ?? 3;
    const base = {
      geodesic: true,
      strokeColor: color,
      strokeWeight: w,
      clickable: false,
      zIndex: 9999
    };
    if (lineStyle === 'dashed') {
      return {
        ...base,
        strokeOpacity: 0,
        icons: [{
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: color, scale: Math.max(2, w * 1.2) },
          offset: '0',
          repeat: `${12 + w * 2}px`
        }]
      };
    }
    if (lineStyle === 'dotted') {
      return {
        ...base,
        strokeOpacity: 0,
        icons: [{
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            fillOpacity: 1,
            fillColor: color,
            strokeOpacity: 0,
            scale: Math.max(2, w * 0.9)
          },
          offset: '0',
          repeat: `${6 + w * 2}px`
        }]
      };
    }
    // solid
    return { ...base, strokeOpacity: 0.95, icons: [] };
  }

  function createPolyline() {
    polyline = new google.maps.Polyline({
      map: capturedMap,
      ...polylineOptions(settings.color, settings.lineStyle, settings.lineWeight)
    });
  }

  // Dot overlay — replaces google.maps.Marker to avoid the deprecation warning.
  // AdvancedMarkerElement requires a mapId on the Map, which FR24 doesn't set,
  // so we use a plain OverlayView + styled div instead.
  function createDotOverlay(ll, isEnd) {
    const lo = new google.maps.OverlayView();
    lo._ll = ll;
    lo._div = null;
    const diameter = isEnd ? 10 : 12;

    lo.onAdd = function () {
      const div = document.createElement('div');
      div.style.cssText =
        `position:absolute;width:${diameter}px;height:${diameter}px;` +
        `border-radius:50%;background:${settings.color};` +
        `border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.5);` +
        `transform:translate(-50%,-50%);pointer-events:none;z-index:10000;`;
      this._div = div;
      this.getPanes().overlayLayer.appendChild(div);
    };

    lo.draw = function () {
      if (!this._div) return;
      const proj = this.getProjection();
      if (!proj) return;
      const pt = proj.fromLatLngToDivPixel(this._ll);
      if (!pt) return;
      this._div.style.left = `${pt.x}px`;
      this._div.style.top  = `${pt.y}px`;
    };

    lo.onRemove = function () {
      if (this._div) { this._div.remove(); this._div = null; }
    };

    lo.updatePosition = function (ll) {
      this._ll = ll;
      this.draw();
    };

    lo.updateColor = function (color) {
      if (this._div) this._div.style.background = color;
    };

    lo.setMap(capturedMap);
    return lo;
  }

  // Small per-segment distance pill, positioned at the segment midpoint.
  function createSegLabelOverlay(a, b) {
    const lo = new google.maps.OverlayView();
    lo._a = a; lo._b = b; lo._div = null;

    lo.onAdd = function () {
      const div = document.createElement('div');
      const s = SEG_LABEL_SIZE_MAP[settings.labelSize] || SEG_LABEL_SIZE_MAP[2];
      div.style.cssText =
        'position:absolute;background:rgba(17,24,39,0.75);color:rgba(255,255,255,0.9);' +
        `font-size:${s.fs};font-family:sans-serif;padding:${s.pad};` +
        'border-radius:5px;pointer-events:none;white-space:nowrap;' +
        'box-shadow:0 1px 3px rgba(0,0,0,0.4);line-height:1.4;';
      this._div = div;
      this.getPanes().floatPane.appendChild(div);
    };

    lo.draw = function () {
      if (!this._div || !this._a || !this._b) return;
      const proj = this.getProjection();
      if (!proj) return;
      const px = proj.fromLatLngToDivPixel(midpoint(this._a, this._b));
      if (!px) return;
      this._div.textContent = `${formatDistance(computeDistance(this._a, this._b))} · ${formatBearing(this._a, this._b)}`;
      const w = this._div.offsetWidth;
      const h = this._div.offsetHeight;
      this._div.style.left = `${px.x - w / 2}px`;
      this._div.style.top  = `${px.y - h / 2 - 14}px`;
    };

    lo.onRemove = function () {
      if (this._div) { this._div.remove(); this._div = null; }
    };

    lo.update = function (a, b) { this._a = a; this._b = b; this.draw(); };
    lo.updateColor = function () { this.draw(); };
    lo.updateSize = function () {
      if (!this._div) return;
      const s = SEG_LABEL_SIZE_MAP[settings.labelSize] || SEG_LABEL_SIZE_MAP[2];
      this._div.style.fontSize = s.fs;
      this._div.style.padding  = s.pad;
      this.draw();
    };

    lo.setMap(capturedMap);
    return lo;
  }

  // Custom OverlayView for the distance label pill.
  // _pts: LatLng[] of committed waypoints; _extra: cursor LatLng or null.
  // Label is anchored to the midpoint of the last segment and shows total
  // cumulative distance across all segments (including rubber-band to cursor).
  function createLabelOverlay() {
    const lo = new google.maps.OverlayView();
    lo._pts   = [];
    lo._extra = null;
    lo._div   = null;

    lo.onAdd = function () {
      const div = document.createElement('div');
      const s = LABEL_SIZE_MAP[settings.labelSize] || LABEL_SIZE_MAP[2];
      div.style.cssText =
        'position:absolute;background:rgba(17,24,39,0.90);color:#fff;' +
        `font-size:${s.fs};font-family:sans-serif;padding:${s.pad};` +
        'border-radius:6px;pointer-events:none;white-space:nowrap;' +
        'box-shadow:0 1px 4px rgba(0,0,0,0.5);line-height:1.4;';
      this._div = div;
      this.getPanes().floatPane.appendChild(div);
    };

    lo.draw = function () {
      if (!this._div) return;
      const all = this._extra ? [...this._pts, this._extra] : this._pts;
      // Only show total when there are 2+ segments (3+ points);
      // for a single segment the per-segment label already covers it.
      if (all.length < 3) { this._div.style.display = 'none'; return; }
      this._div.style.display = '';
      const proj = this.getProjection();
      if (!proj) return;
      const px = proj.fromLatLngToDivPixel(all[all.length - 1]);
      if (!px) return;
      let total = 0;
      for (let i = 1; i < all.length; i++) total += computeDistance(all[i - 1], all[i]);
      this._div.innerHTML = `Total: ${formatDistance(total)}`;
      const w = this._div.offsetWidth;
      const h = this._div.offsetHeight;
      this._div.style.left = `${px.x - w / 2}px`;
      this._div.style.top  = `${px.y - h - 8}px`;
    };

    lo.onRemove = function () {
      if (this._div) { this._div.remove(); this._div = null; }
    };

    lo.update = function (pts, extra) {
      this._pts = pts; this._extra = extra;
      this.draw();
    };

    lo.updateColor = function () { this.draw(); };
    lo.updateSize = function () {
      if (!this._div) return;
      const s = LABEL_SIZE_MAP[settings.labelSize] || LABEL_SIZE_MAP[2];
      this._div.style.fontSize = s.fs;
      this._div.style.padding  = s.pad;
      this.draw();
    };

    lo.setMap(capturedMap);
    return lo;
  }

  // Add a waypoint dot and extend the polyline path.
  function addWaypoint(ll) {
    waypoints.push(ll);
    dotOverlays.push(createDotOverlay(ll, waypoints.length > 1));
    if (!polyline) createPolyline();
    polyline.setPath(waypoints);
    if (waypoints.length >= 2) {
      // Permanent segment label for the newly completed segment
      const a = waypoints[waypoints.length - 2];
      const b = waypoints[waypoints.length - 1];
      segLabelOverlays.push(createSegLabelOverlay(a, b));
      // Total label (only renders when all.length >= 3 — see draw())
      if (!labelOverlay) labelOverlay = createLabelOverlay();
      labelOverlay.update(waypoints, null);
    }
  }

  // Update the rubber-band preview while the cursor moves.
  function updateRubberBand(cursorLL) {
    if (!polyline || waypoints.length === 0) return;
    polyline.setPath([...waypoints, cursorLL]);
    const from = waypoints[waypoints.length - 1];
    // Live per-segment label for the rubber-band segment
    if (!rubberSegLabel) {
      rubberSegLabel = createSegLabelOverlay(from, cursorLL);
    } else {
      rubberSegLabel.update(from, cursorLL);
    }
    // Total label (covers 2+ committed waypoints + cursor)
    if (waypoints.length >= 2) {
      if (!labelOverlay) labelOverlay = createLabelOverlay();
      labelOverlay.update(waypoints, cursorLL);
    }
  }

  function clearMeasurement() {
    if (polyline) { polyline.setMap(null); polyline = null; }
    dotOverlays.forEach(d => d.setMap(null));
    dotOverlays = [];
    waypoints = [];
    segLabelOverlays.forEach(l => l.setMap(null));
    segLabelOverlays = [];
    if (rubberSegLabel) { rubberSegLabel.setMap(null); rubberSegLabel = null; }
    if (labelOverlay) { labelOverlay.setMap(null); labelOverlay = null; }
    state = 'idle';
    pendingLatLng = null;
    rafPending = false;
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function undoLastWaypoint() {
    if (waypoints.length <= 1) { clearMeasurement(); return; }
    waypoints.pop();
    const dot = dotOverlays.pop();
    if (dot) dot.setMap(null);
    const seg = segLabelOverlays.pop();
    if (seg) seg.setMap(null);
    if (rubberSegLabel) { rubberSegLabel.setMap(null); rubberSegLabel = null; }
    polyline.setPath(waypoints);
    if (labelOverlay) labelOverlay.update(waypoints, null);
  }

  function onPointerDown(e) {
    if (e.button === 1) {
      e.preventDefault(); // suppress Chrome auto-scroll cursor
      if (measureOn && state === 'drawing') {
        e.stopImmediatePropagation();
        undoLastWaypoint();
      }
      return;
    }
    pointerDownX = e.clientX;
    pointerDownY = e.clientY;
    pointerMoved = false;
    // Do NOT stopPropagation — Google Maps must receive this for panning
  }

  function onPointerMoveContainer(e) {
    const dx = e.clientX - pointerDownX;
    const dy = e.clientY - pointerDownY;
    if (Math.abs(dx) > CLICK_MOVE_THRESHOLD || Math.abs(dy) > CLICK_MOVE_THRESHOLD) {
      pointerMoved = true;
    }
    // Do NOT stopPropagation — Google Maps must receive this for panning
  }

  function onPointerUp() {
    // Nothing here; we use the click event to register points
  }

  function onMouseMoveContainer(e) {
    if (state !== 'drawing') return;
    const rect = capturedMap.getDiv().getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ll = pixelToLatLng(x, y);
    if (!ll) return;
    pendingLatLng = ll;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (!pendingLatLng || waypoints.length === 0) return;
        updateRubberBand(pendingLatLng);
      });
    }
  }

  // This is the most fragile part: we suppress FR24's own click handling
  // (aircraft selection, popups) while measuring by calling
  // stopImmediatePropagation + preventDefault during capture phase.
  // FR24 may bind its click listeners via Google Maps event system
  // (google.maps.event.addListener) or directly on the container div.
  // If aircraft selection still triggers, the FR24 listener fires before
  // this capture handler — try changing 'click' to 'mousedown' capture here.
  function onClickCapture(e) {
    if (!measureOn) return;
    if (pointerMoved) return; // was a drag/pan — do not intercept

    e.stopImmediatePropagation();
    e.preventDefault();

    const rect = capturedMap.getDiv().getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ll = pixelToLatLng(x, y);
    if (!ll) return;

    // Double-click detection: second click within time + pixel threshold = finish
    const now = Date.now();
    const isDbl = (now - lastClickTime < DBLCLICK_MS) &&
                  Math.abs(e.clientX - lastClickX) < DBLCLICK_PX &&
                  Math.abs(e.clientY - lastClickY) < DBLCLICK_PX;
    lastClickTime = now;
    lastClickX = e.clientX;
    lastClickY = e.clientY;

    if (state === 'idle' || state === 'finished') {
      clearMeasurement();
      addWaypoint(ll);
      state = 'drawing';
      showToast('Click to add points · Double-click to finish · Right-click to clear');
    } else if (state === 'drawing') {
      if (isDbl && waypoints.length >= 2) {
        // Finish without adding the double-click point a second time
        state = 'finished';
        polyline.setPath(waypoints);
        if (rubberSegLabel) { rubberSegLabel.setMap(null); rubberSegLabel = null; }
        if (labelOverlay) labelOverlay.update(waypoints, null);
      } else {
        addWaypoint(ll);
      }
    }
  }

  function onKeyDown(e) {
    if (!measureOn) return;
    if (e.key === 'Escape') {
      clearMeasurement();
    } else if (e.key === 'Backspace' && state === 'drawing') {
      e.preventDefault();
      undoLastWaypoint();
    }
  }

  function onContextMenu(e) {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (!measureOn) {
      enableMeasure();
    } else if (state === 'idle') {
      disableMeasure();
    } else {
      clearMeasurement();
    }
  }

  // ---------------------------------------------------------------------------
  // Measure mode on/off
  // ---------------------------------------------------------------------------

  function attachListeners() {
    const div = capturedMap.getDiv();

    boundPointerDown  = onPointerDown.bind(null);
    boundPointerMove  = onPointerMoveContainer.bind(null);
    boundPointerUp    = onPointerUp.bind(null);
    boundMouseMove    = onMouseMoveContainer.bind(null);
    boundClick        = onClickCapture.bind(null);
    boundKeyDown      = onKeyDown.bind(null);

    div.addEventListener('pointerdown',   boundPointerDown,  { capture: true  });
    div.addEventListener('pointermove',   boundPointerMove,  { capture: false });
    div.addEventListener('pointerup',     boundPointerUp,    { capture: false });
    div.addEventListener('mousemove',     boundMouseMove,    { capture: false });
    // capture: true so we intercept before Google Maps / FR24 handlers
    div.addEventListener('click',         boundClick,        { capture: true  });
    document.addEventListener('keydown',  boundKeyDown,      { capture: true  });
  }

  function detachListeners() {
    if (!capturedMap) return;
    const div = capturedMap.getDiv();
    if (boundPointerDown)  div.removeEventListener('pointerdown', boundPointerDown,  { capture: true  });
    if (boundPointerMove)  div.removeEventListener('pointermove', boundPointerMove,  { capture: false });
    if (boundPointerUp)    div.removeEventListener('pointerup',   boundPointerUp,    { capture: false });
    if (boundMouseMove)    div.removeEventListener('mousemove',   boundMouseMove,    { capture: false });
    if (boundClick)        div.removeEventListener('click',       boundClick,        { capture: true  });
    if (boundKeyDown)      document.removeEventListener('keydown', boundKeyDown,     { capture: true  });
    boundPointerDown = boundPointerMove = boundPointerUp =
      boundMouseMove = boundClick = boundKeyDown = null;
  }

  // Inject a <style> tag that forces crosshair on every element inside the
  // map container while measure mode is on. setOptions({draggableCursor})
  // only affects the base canvas; aircraft markers and FR24 overlays set
  // their own inline cursor styles which win without !important.
  function injectCursorStyle() {
    if (document.getElementById('fr24m-cursor-style')) return;
    const s = document.createElement('style');
    s.id = 'fr24m-cursor-style';
    s.textContent = '.fr24m-measuring, .fr24m-measuring * { cursor: crosshair !important; }';
    document.head.appendChild(s);
  }

  function enableMeasure() {
    if (!capturedMap) {
      showToast('Map not detected yet — pan or zoom the map once');
      return;
    }
    measureOn = true;
    prevCursorOptions = {
      draggableCursor: capturedMap.get('draggableCursor') ?? '',
      draggingCursor:  capturedMap.get('draggingCursor')  ?? ''
    };
    capturedMap.setOptions({ draggableCursor: 'crosshair', draggingCursor: 'grabbing' });
    injectCursorStyle();
    capturedMap.getDiv().classList.add('fr24m-measuring');
    attachListeners();
    postStatus();
  }

  function disableMeasure() {
    measureOn = false;
    clearMeasurement();
    detachListeners();
    if (capturedMap) {
      capturedMap.getDiv().classList.remove('fr24m-measuring');
      if (prevCursorOptions) {
        capturedMap.setOptions(prevCursorOptions);
        prevCursorOptions = null;
      }
    }
    postStatus();
  }

  // ---------------------------------------------------------------------------
  // Settings application
  // ---------------------------------------------------------------------------

  function applySettings(newSettings) {
    settings = { ...settings, ...newSettings };
    if (!polyline) return;
    polyline.setOptions(polylineOptions(settings.color, settings.lineStyle, settings.lineWeight));
    dotOverlays.forEach(d => d.updateColor(settings.color));
    segLabelOverlays.forEach(l => { l.updateColor(); l.updateSize(); });
    if (rubberSegLabel) { rubberSegLabel.updateColor(); rubberSegLabel.updateSize(); }
    if (labelOverlay) { labelOverlay.updateColor(); labelOverlay.updateSize(); }
  }

  // ---------------------------------------------------------------------------
  // postMessage bridge
  // ---------------------------------------------------------------------------

  function postStatus() {
    window.postMessage({
      source: NS,
      type: 'status',
      mapCaptured: !!capturedMap,
      measuring: measureOn
    }, '*');
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.source !== NS) return;

    if (msg.type === 'toggle') {
      if (measureOn) disableMeasure(); else enableMeasure();
    } else if (msg.type === 'settings') {
      applySettings(msg.settings);
    } else if (msg.type === 'ready') {
      // ui.js just loaded — send it our current status and request settings
      postStatus();
    }
  });

  // ---------------------------------------------------------------------------
  // Debug API
  // ---------------------------------------------------------------------------

  window.__radarRuler = {
    getMap() { return capturedMap; },
    debug() {
      console.group('[radar-ruler] debug');
      console.log('map captured:', !!capturedMap);
      if (capturedMap) {
        try { console.log('zoom:', capturedMap.getZoom()); } catch (e) { console.log('zoom error', e); }
        try { console.log('center:', capturedMap.getCenter()?.toString()); } catch (e) { console.log('center error', e); }
        try { console.log('container:', capturedMap.getDiv()); } catch (e) { console.log('container error', e); }
      }
      console.log('geometry.spherical available:', !!window.google?.maps?.geometry?.spherical);
      console.log('projection ready:', projectionReady);
      console.log('measure on:', measureOn);
      console.log('state:', state);
      console.groupEnd();
    }
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  startCapture();

})();
