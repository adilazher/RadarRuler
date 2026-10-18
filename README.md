# FR24 Distance Measure — Chrome Extension

A Manifest V3 Chrome extension that adds a geodesic distance-measurement tool to [FlightRadar24](https://www.flightradar24.com/).

## Installation (load unpacked)

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle, top-right).
3. Click **Load unpacked** and select the `fr24-measure/` folder.
4. Navigate to `https://www.flightradar24.com/`. A ruler button appears directly below the location button in the map controls (right side of the map).

## Usage

| Action | Effect |
|--------|--------|
| Click ruler button | Toggle measure mode on/off |
| Click on map | Set start point (first click) or end point (second click) |
| Move mouse (while drawing) | Live distance preview |
| Third click (after finishing) | Start a new measurement, replacing the old one |
| `Esc` | Cancel current measurement, keep measure mode on |
| Toggle button off | Clear everything, exit measure mode |
| Hover ruler button | Open settings flyout (colour + unit) |

Settings (colour and unit) are synced via `chrome.storage.sync` and persist across reloads.

---

## Manual Test Checklist

Run through this after any change or after a FR24 update:

- [ ] **Button placement** — ruler button appears immediately below the location button (`#location-button`), same size and style.
- [ ] **Flyout hover** — hovering the button opens the flyout to its left; hovering the flyout keeps it open; moving away closes it after ~200 ms.
- [ ] **Live distance while moving** — after first click, mouse movement shows a live geodesic line and distance label updating in real time.
- [ ] **Second click fixes the line** — clicking again locks the endpoint; line, markers, and label remain on the map.
- [ ] **Pan/zoom after finishing** — pan and zoom; the line, markers, and label stay anchored to the correct geographic positions.
- [ ] **Third click starts new measurement** — clicking anywhere after finishing clears the old measurement and sets a new start point.
- [ ] **Esc cancels** — pressing Esc while drawing or after finishing clears the measurement but measure mode stays on.
- [ ] **Toggle off clears everything** — clicking the button again removes line, markers, label, and restores the default cursor.
- [ ] **Aircraft not selected while measuring** — clicking on an aircraft icon while measure mode is on should NOT open the aircraft sidebar; only the distance point should be placed.
- [ ] **Settings persist after reload** — change colour/unit, reload the page, open FR24 again; settings should be restored.
- [ ] **Colour change mid-measurement** — change the line colour while a measurement is visible; it should update immediately.
- [ ] **Unit change mid-measurement** — switch unit; the label updates immediately with the new unit.
- [ ] **NM default** — on first install (no stored settings) the unit should default to `nm`.

---

## Troubleshooting

### Run the debug helper

Open DevTools on `https://www.flightradar24.com/` (F12), switch to the **Console** tab, and type:

```js
__fr24measure.debug()
```

This logs:
- Whether the map instance has been captured
- Current zoom level and center
- The map container DOM element
- Whether `google.maps.geometry.spherical` is available
- Whether the projection overlay is ready
- Current measure state

### Map not captured ("Map not detected yet" toast)

The extension captures the map by wrapping `google.maps.Map.prototype` methods. If the toast appears:

1. Call `__fr24measure.debug()` — if `map captured: false`, pan or zoom the map once; the wrapper fires on the next API call.
2. If `google.maps.geometry.spherical available: false`, the geometry library hasn't loaded yet. Wait a few seconds and try again.
3. If `projection ready: false` after the map is captured, the `OverlayView` hasn't been added yet — this resolves automatically within one render cycle.

### Aircraft selection still fires while measuring

> **Fragile assumption**: FR24 binds aircraft-click handlers either via `google.maps.event.addListener` or directly on the map container div. The extension suppresses them with a capture-phase `click` listener. If selection still triggers:

- In `main.js`, find the comment `// This is the most fragile part` in `onClickCapture`.
- Try changing the event from `'click'` to `'mousedown'` (update both `attachListeners` and `detachListeners`).
- Alternatively, after a FR24 update, inspect the map container's event listeners in DevTools → Elements → Event Listeners to understand the new binding order.

### Button not appearing (SPA navigation)

> **DOM assumption**: `id="location-button"` is the anchor element; the ruler button is inserted as its next sibling.

If the button doesn't appear:
1. Open DevTools Console and check for errors from `fr24-measure`.
2. Inspect the map controls area and look for the actual location button's id. If FR24 renamed it, update `findAnchor()` in `ui.js`.
3. The `MutationObserver` in `ui.js` watches `document.body` subtree for re-injection on SPA navigations. If it fires too eagerly (performance), narrow the `observe` target to the controls container once its selector is known.

### Classes/styles don't match

> **DOM assumption**: the button uses the Tailwind classes listed in `buildButton()` in `ui.js`.

If the button looks different from the location button, inspect `#location-button` in DevTools and copy its current `class` attribute into `buildButton()`.

### Distance label misplaced after zoom/pan

The label uses `google.maps.OverlayView` and `fromLatLngToDivPixel`, which recomputes on every `draw()` call (triggered by the Maps API on viewport changes). If the label drifts:
- Check that `labelOverlay.setMap(capturedMap)` is called on the same map instance as `polyline`.
- Verify `floatPane` is still the correct pane name — it is the standard pane for floating UI elements above tiles.

### Ruler icon missing

The ruler is an inline SVG in `ui.js` (`RULER_SVG` constant). If it doesn't render, check for CSP errors in the DevTools Console. FR24's CSP policy may block inline SVGs injected via `innerHTML` — in that case, switch to creating the SVG element programmatically with `document.createElementNS`.

---

## Architecture Notes

| File | World | Purpose |
|------|-------|---------|
| `main.js` | `MAIN` | Map capture, drawing, measurement logic |
| `ui.js` | `ISOLATED` | Button, flyout, `chrome.storage.sync` |
| `ui.css` | — | Flyout styles (prefixed `fr24m-`) |

The two worlds cannot share JS objects, so they communicate via `window.postMessage` with `{ source: 'fr24-measure', type: ... }`. Always verify `event.source === window` and the namespace on receive to avoid responding to unrelated messages.
