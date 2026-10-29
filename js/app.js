/* Run All Around – UI, map and state. */
window.RAA = window.RAA || {};
(function (RAA) {
  'use strict';

  const SNAP_M = 30;
  const STORE_KEY = 'raa:state:v1';

  const state = {
    area: null,            // ring [{lat,lng}]
    elements: null,        // raw Overpass elements (cached, re-filtered client side)
    graph: { edges: [], nodePos: new Map() },
    customPaths: [],       // [{id, latlngs:[{lat,lng}]}]
    excludedKeys: new Set(),
    includeDeadEnds: true,
    filters: { service: true, trails: true, sidewalks: false, steps: false },
    start: null,           // {lat,lng}
    pace: '5:30',
    route: null,
    mode: 'exclude',       // 'exclude' | 'start'
  };

  // ---------- DOM helpers ----------
  const $ = id => document.getElementById(id);
  const fmtKm = m => (m / 1000).toFixed(2) + ' km';
  const fmtM = m => m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km';

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, 4200);
  }

  function parsePace(str) {
    const m = /^(\d{1,2})[:.](\d{1,2})$/.exec((str || '').trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  function fmtDuration(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
  }

  // ---------- Map ----------
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([59.3293, 18.0686], 13);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  // "Night run": plain OSM tiles darkened with a CSS filter (no API key needed)
  const dark = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: osmAttr, maxZoom: 19, className: 'night-tiles' });
  const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: osmAttr, maxZoom: 19 });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri', maxZoom: 19,
  });
  dark.addTo(map);
  L.control.layers({ 'Night run': dark, 'Streets': streets, 'Satellite': sat }, null, { position: 'bottomright' }).addTo(map);

  const canvas = L.canvas({ padding: 0.5 });
  const svg = L.svg({ padding: 0.5 });
  const areaLayer = L.layerGroup().addTo(map);
  const edgeLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  let startMarker = null;

  // ---------- Mouse drawing (rectangle / polygon / polyline) ----------
  class Drawer {
    constructor(map) {
      this.map = map; this.active = null; this.shape = null;
      this.temp = L.layerGroup().addTo(map);
      this._onKey = this._onKey.bind(this);
    }
    get busy() { return !!this.active; }
    start(kind, done) {
      this.cancel();
      this.active = { kind, done, points: [] };
      this.map.getContainer().classList.add('drawing');
      document.addEventListener('keydown', this._onKey);
      if (kind === 'rect') {
        this.map.dragging.disable();
        this.map.on('mousedown', this._rectDown, this);
      } else {
        this.map.doubleClickZoom.disable();
        this.map.on('click', this._vertex, this);
        this.map.on('mousemove', this._move, this);
        this.map.on('dblclick', this._finish, this);
      }
      document.body.dataset.drawing = kind;
    }
    _style() {
      return this.active.kind === 'line'
        ? { color: '#e879f9', weight: 4, dashArray: '6 6' }
        : { color: '#c6ff00', weight: 2, dashArray: '8 6', fillColor: '#c6ff00', fillOpacity: 0.08 };
    }
    _rectDown(e) {
      this.active.points = [e.latlng];
      this.map.on('mousemove', this._rectMove, this);
      this.map.on('mouseup', this._rectUp, this);
    }
    _rectMove(e) {
      const b = L.latLngBounds(this.active.points[0], e.latlng);
      if (!this.shape) this.shape = L.rectangle(b, this._style()).addTo(this.temp); else this.shape.setBounds(b);
    }
    _rectUp(e) {
      const b = L.latLngBounds(this.active.points[0], e.latlng);
      if (b.getNorth() === b.getSouth() || b.getEast() === b.getWest()) { this.cancel(); return; }
      this._complete([b.getNorthWest(), b.getNorthEast(), b.getSouthEast(), b.getSouthWest()]);
    }
    _vertex(e) {
      const pts = this.active.points;
      const last = pts[pts.length - 1];
      if (last && this.map.latLngToContainerPoint(last).distanceTo(this.map.latLngToContainerPoint(e.latlng)) < 4) return;
      pts.push(e.latlng);
      this._redraw(e.latlng);
    }
    _move(e) { this._redraw(e.latlng); }
    _redraw(cursor) {
      const pts = [...this.active.points, cursor];
      if (pts.length < 2) return;
      if (!this.shape) {
        this.shape = (this.active.kind === 'poly' ? L.polygon(pts, this._style()) : L.polyline(pts, this._style())).addTo(this.temp);
      } else this.shape.setLatLngs(pts);
    }
    _finish() {
      const pts = this.active.points;
      const need = this.active.kind === 'poly' ? 3 : 2;
      if (pts.length < need) { toast(`Need at least ${need} points`, 'warn'); return; }
      this._complete(pts.map(p => ({ lat: p.lat, lng: p.lng })));
    }
    _onKey(e) {
      if (e.key === 'Escape') { this.cancel(); toast('Drawing cancelled'); }
      else if (e.key === 'Enter') { if (this.active && this.active.kind !== 'rect') this._finish(); }
      else if (e.key === 'Backspace' && this.active && this.active.kind !== 'rect' && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) {
        this.active.points.pop();
        if (this.shape && this.active.points.length) this.shape.setLatLngs(this.active.points);
        e.preventDefault();
      }
    }
    _complete(points) {
      const a = this.active;
      this.cancel();
      a.done(points);
    }
    cancel() {
      if (!this.active) return;
      this.map.off('mousedown', this._rectDown, this);
      this.map.off('mousemove', this._rectMove, this);
      this.map.off('mouseup', this._rectUp, this);
      this.map.off('click', this._vertex, this);
      this.map.off('mousemove', this._move, this);
      this.map.off('dblclick', this._finish, this);
      document.removeEventListener('keydown', this._onKey);
      this.map.dragging.enable();
      this.map.doubleClickZoom.enable();
      this.map.getContainer().classList.remove('drawing');
      delete document.body.dataset.drawing;
      this.temp.clearLayers();
      this.shape = null;
      this.active = null;
    }
  }
  const drawer = new Drawer(map);

  // ---------- Persistence ----------
  function save() {
    try {
      const c = map.getCenter();
      localStorage.setItem(STORE_KEY, JSON.stringify({
        area: state.area, customPaths: state.customPaths, excludedKeys: [...state.excludedKeys],
        includeDeadEnds: state.includeDeadEnds, filters: state.filters, start: state.start, pace: state.pace,
        view: { lat: c.lat, lng: c.lng, zoom: map.getZoom() },
      }));
    } catch (e) { /* ignore */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      const s = JSON.parse(raw);
      state.area = s.area || null;
      state.customPaths = s.customPaths || [];
      state.excludedKeys = new Set(s.excludedKeys || []);
      state.includeDeadEnds = s.includeDeadEnds !== false;
      Object.assign(state.filters, s.filters || {});
      state.start = s.start || null;
      state.pace = s.pace || '5:30';
      if (s.view) map.setView([s.view.lat, s.view.lng], s.view.zoom);
      return true;
    } catch (e) { return false; }
  }

  // ---------- Area ----------
  function setArea(ring) {
    state.area = ring;
    areaLayer.clearLayers();
    if (ring) {
      L.polygon(ring, { color: '#c6ff00', weight: 2, dashArray: '8 6', fillColor: '#c6ff00', fillOpacity: 0.05, interactive: false }).addTo(areaLayer);
    }
    $('btn-fetch').disabled = !ring;
    $('area-info').textContent = ring ? `${ring.length}-point area marked. Fetch the streets when you're ready.` : 'No area yet.';
    save();
  }

  // ---------- Graph pipeline ----------
  function rebuild() {
    if (!state.elements || !state.area) return;
    const g = RAA.osm.buildGraph(state.elements, state.area, state.filters);
    state.graph = g;
    for (const cp of state.customPaths) RAA.osm.addCustomPath(g, cp, SNAP_M);
    for (const e of g.edges) e.excluded = state.excludedKeys.has(e.key) || (e.origKey != null && state.excludedKeys.has(e.origKey));
    refresh();
  }

  function refresh() {
    const { edges } = state.graph;
    RAA.graph.markDeadEnds(edges);
    const comp = RAA.graph.markComponents(edges, state.includeDeadEnds);
    clearRoute();
    drawEdges();
    updateNetworkStats(comp);
    save();
  }

  function styleFor(e) {
    if (e.custom) return { color: '#e879f9', weight: 4, opacity: 0.95 };
    if (e.excluded) return { color: '#ff3b5c', weight: 3, opacity: 0.9, dashArray: '6 6' };
    if (e.deadEnd && !state.includeDeadEnds) return { color: '#6b7280', weight: 3, opacity: 0.75, dashArray: '2 8' };
    if (e.isolated) return { color: '#64748b', weight: 2, opacity: 0.5, dashArray: '1 6' };
    if (e.deadEnd) return { color: '#38bdf8', weight: 3, opacity: 0.9, dashArray: '10 5' };
    return { color: '#38bdf8', weight: 3, opacity: 0.9 };
  }

  function drawEdges() {
    edgeLayer.clearLayers();
    for (const e of state.graph.edges) {
      const line = L.polyline(e.coords, Object.assign({ renderer: canvas, interactive: true }, styleFor(e)));
      line.bindTooltip(() => `${e.name} · ${fmtM(e.len)}${e.deadEnd ? ' · dead end' : ''}${e.excluded ? ' · excluded' : ''}${e.isolated ? ' · disconnected' : ''}`, { sticky: true, className: 'edge-tip' });
      line.on('mouseover', () => line.setStyle({ weight: styleFor(e).weight + 3 }));
      line.on('mouseout', () => line.setStyle({ weight: styleFor(e).weight }));
      line.on('click', ev => { if (drawer.busy) return; L.DomEvent.stop(ev); onEdgeClick(e, ev.latlng); });
      e.layer = line;
      line.addTo(edgeLayer);
    }
  }

  function onEdgeClick(e, latlng) {
    if (drawer.busy) return;
    if (state.mode === 'start') { setStart(latlng || e.coords[0]); return; }
    if (e.custom) {
      state.customPaths = state.customPaths.filter(cp => cp.id !== e.customId);
      toast('Custom path removed');
      rebuild();
      return;
    }
    e.excluded = !e.excluded;
    if (e.excluded) state.excludedKeys.add(e.key);
    else {
      state.excludedKeys.delete(e.key);
      // piece of a street that was excluded before a custom path split it: drop the parent key, keep the other pieces out
      if (e.origKey != null && state.excludedKeys.delete(e.origKey)) {
        for (const o of state.graph.edges) if (o !== e && o.origKey === e.origKey && o.excluded) state.excludedKeys.add(o.key);
      }
    }
    toast(e.excluded ? `Excluded ${e.name}` : `Back in: ${e.name}`);
    refresh();
  }

  function updateNetworkStats(comp) {
    const edges = state.graph.edges;
    const active = edges.filter(e => RAA.graph.isActive(e, state.includeDeadEnds) && !e.isolated);
    const total = active.reduce((s, e) => s + e.len, 0);
    const deadEnds = edges.filter(e => e.deadEnd && !e.excluded);
    const deadLen = deadEnds.reduce((s, e) => s + e.len, 0);
    $('net-streets').textContent = active.length;
    $('net-km').textContent = fmtKm(total);
    $('net-dead').textContent = `${deadEnds.length} · ${fmtKm(deadLen)}`;
    $('net-excluded').textContent = edges.filter(e => e.excluded).length;
    $('net-custom').textContent = state.customPaths.length;
    const warn = $('net-warn');
    if (comp && comp.components > 1) {
      warn.textContent = `${comp.components - 1} disconnected piece(s) (${fmtKm(comp.droppedLen)}) are greyed out and will be skipped. Connect them with a custom path or extend the area.`;
      warn.hidden = false;
    } else warn.hidden = true;
    $('btn-route').disabled = active.length === 0;
    $('step-tune').classList.toggle('ready', edges.length > 0);
    $('step-route').classList.toggle('ready', edges.length > 0);
  }

  // ---------- Start point ----------
  function setStart(latlng) {
    state.start = latlng ? { lat: latlng.lat, lng: latlng.lng } : null;
    if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
    if (state.start) {
      startMarker = L.marker(state.start, {
        draggable: true,
        icon: L.divIcon({ className: 'start-pin', html: '<span>🏁</span>', iconSize: [34, 34], iconAnchor: [17, 30] }),
      }).addTo(map);
      startMarker.on('dragend', () => { state.start = startMarker.getLatLng(); clearRoute(); save(); });
      startMarker.bindTooltip('Start / finish — drag me', { direction: 'top', offset: [0, -26] });
    }
    setMode('exclude');
    clearRoute();
    save();
  }

  function setMode(mode) {
    state.mode = mode;
    document.body.dataset.mode = mode;
    $('btn-start').classList.toggle('active', mode === 'start');
    map.getContainer().classList.toggle('pick', mode === 'start');
  }

  // ---------- Route ----------
  function clearRoute() {
    state.route = null;
    routeLayer.clearLayers();
    // the auto-placed start marker from the last route is stale now
    if (!state.start && startMarker) { map.removeLayer(startMarker); startMarker = null; }
    $('route-stats').hidden = true;
    $('cue').innerHTML = '';
    $('btn-gpx').disabled = true; $('btn-tcx').disabled = true;
  }

  function computeRoute() {
    const { edges, nodePos } = state.graph;
    let startNode = null;
    if (state.start) startNode = RAA.graph.nearestNode(edges, nodePos, state.start, state.includeDeadEnds);
    let res;
    try {
      const t0 = performance.now();
      res = RAA.graph.solve(edges, state.includeDeadEnds, startNode);
      res.ms = performance.now() - t0;
    } catch (err) {
      toast(err.message, 'warn');
      return;
    }
    state.route = res;
    const coords = RAA.graph.routeCoords(res.sequence);
    res.coords = coords;
    routeLayer.clearLayers();
    // streets run twice, shown underneath in orange
    for (const s of res.sequence) if (s.dup) L.polyline(s.e.coords, { renderer: canvas, color: '#ff8c42', weight: 9, opacity: 0.55, interactive: false }).addTo(routeLayer);
    L.polyline(coords, { renderer: svg, color: '#c6ff00', weight: 12, opacity: 0.16, interactive: false, className: 'route-glow' }).addTo(routeLayer);
    L.polyline(coords, { renderer: svg, color: '#c6ff00', weight: 4, opacity: 1, interactive: false, className: 'route-line', dashArray: '10 12' }).addTo(routeLayer);
    if (!state.start && res.start != null) setStartMarkerOnly(nodePos.get(res.start));

    $('rs-streets').textContent = fmtKm(res.streetLength);
    $('rs-route').textContent = fmtKm(res.routeLength);
    const pct = res.streetLength ? (100 * res.extra / res.streetLength) : 0;
    $('rs-extra').textContent = `${fmtKm(res.extra)} (+${pct.toFixed(0)}%)`;
    $('rs-odd').textContent = res.oddCount;
    updateTime();
    $('route-stats').hidden = false;
    $('btn-gpx').disabled = false; $('btn-tcx').disabled = false;
    buildCueSheet(res);
    toast(`Route ready: ${fmtKm(res.routeLength)} in ${res.ms.toFixed(0)} ms`, 'ok');
  }

  function setStartMarkerOnly(latlng) {
    if (startMarker) map.removeLayer(startMarker);
    startMarker = L.marker(latlng, {
      draggable: true,
      icon: L.divIcon({ className: 'start-pin', html: '<span>🏁</span>', iconSize: [34, 34], iconAnchor: [17, 30] }),
    }).addTo(map);
    startMarker.on('dragend', () => { state.start = startMarker.getLatLng(); clearRoute(); save(); });
    startMarker.bindTooltip('Start / finish — drag me', { direction: 'top', offset: [0, -26] });
  }

  function updateTime() {
    const sec = parsePace(state.pace);
    if (!state.route) return;
    $('rs-time').textContent = sec ? fmtDuration(sec * state.route.routeLength / 1000) : '–';
  }

  function buildCueSheet(res) {
    const groups = [];
    for (const s of res.sequence) {
      const last = groups[groups.length - 1];
      if (last && last.name === s.e.name) { last.len += s.e.len; last.dup = last.dup && s.dup; }
      else groups.push({ name: s.e.name, len: s.e.len, dup: s.dup, custom: s.e.custom });
    }
    const ol = $('cue');
    ol.innerHTML = '';
    let acc = 0;
    for (const g of groups) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="cue-at">${fmtKm(acc)}</span><span class="cue-name">${escapeHtml(g.name)}</span><span class="cue-len">${fmtM(g.len)}</span>`;
      if (g.dup) li.classList.add('dup');
      if (g.custom) li.classList.add('custom');
      ol.appendChild(li);
      acc += g.len;
    }
    $('cue-count').textContent = `${groups.length} legs`;
  }
  const escapeHtml = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  // ---------- Fetch ----------
  async function fetchStreets() {
    if (!state.area) return;
    const btn = $('btn-fetch');
    btn.disabled = true; btn.classList.add('loading');
    const status = $('fetch-status');
    status.textContent = 'Contacting Overpass…';
    try {
      const elements = await RAA.osm.fetchStreets(state.area, m => { status.textContent = m; });
      state.elements = elements;
      status.textContent = `Got ${elements.filter(e => e.type === 'way').length} ways · ${elements.filter(e => e.type === 'node').length} nodes from OpenStreetMap.`;
      rebuild();
      if (state.start) setStart(state.start);
      toast('Streets loaded. Click a street to exclude it.', 'ok');
    } catch (err) {
      status.textContent = 'Fetch failed: ' + err.message;
      toast('Could not fetch streets: ' + err.message, 'warn');
    } finally {
      btn.disabled = false; btn.classList.remove('loading');
    }
  }

  // ---------- Wire up UI ----------
  function wire() {
    $('btn-rect').onclick = () => { setMode('exclude'); toast('Drag a rectangle on the map'); drawer.start('rect', ring => { setArea(ring); }); };
    $('btn-poly').onclick = () => { setMode('exclude'); toast('Click corners, double-click or Enter to finish'); drawer.start('poly', ring => { setArea(ring); }); };
    $('btn-clear-area').onclick = () => { drawer.cancel(); state.customPaths = []; state.excludedKeys.clear(); setStart(null); setArea(null); state.elements = null; state.graph = { edges: [], nodePos: new Map() }; edgeLayer.clearLayers(); clearRoute(); $('fetch-status').textContent = ''; updateNetworkStats(null); };
    $('btn-fetch').onclick = fetchStreets;

    for (const k of Object.keys(state.filters)) {
      const cb = $('f-' + k);
      cb.checked = state.filters[k];
      cb.onchange = () => { state.filters[k] = cb.checked; rebuild(); save(); };
    }
    const de = $('t-deadends');
    de.checked = state.includeDeadEnds;
    de.onchange = () => { state.includeDeadEnds = de.checked; refresh(); };

    $('btn-path').onclick = () => {
      setMode('exclude');
      toast('Click along your path, double-click or Enter to finish. Ends snap to nearby streets.');
      drawer.start('line', pts => {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        state.customPaths.push({ id, latlngs: pts });
        rebuild();
        if (state.elements && !state.graph.edges.some(e => e.customId === id)) {
          state.customPaths = state.customPaths.filter(cp => cp.id !== id);
          rebuild();
          toast('Path too short: both ends snap to the same spot', 'warn');
          return;
        }
        toast('Custom path added', 'ok');
      });
    };
    $('btn-clear-paths').onclick = () => { if (!state.customPaths.length) return; state.customPaths = []; rebuild(); toast('All custom paths removed'); };
    $('btn-reset-excl').onclick = () => { state.excludedKeys.clear(); for (const e of state.graph.edges) e.excluded = false; refresh(); toast('All streets back in'); };
    $('btn-start').onclick = () => { if (state.mode === 'start') setMode('exclude'); else { setMode('start'); toast('Click on the map where you want to start'); } };
    map.on('click', e => { if (state.mode === 'start' && !drawer.busy) setStart(e.latlng); });
    $('btn-clear-start').onclick = () => { setStart(null); };

    $('btn-route').onclick = computeRoute;
    const pace = $('pace');
    pace.value = state.pace;
    pace.onchange = () => { state.pace = pace.value; updateTime(); save(); };

    async function exportCourse(format) {
      if (!state.route) return;
      const name = ($('gpx-name').value || 'Run All Around').trim();
      const desc = `Every street once: ${fmtKm(state.route.streetLength)} of streets, ${fmtKm(state.route.routeLength)} total. Generated by Run All Around.`;
      const btn = $(format === 'tcx' ? 'btn-tcx' : 'btn-gpx');
      btn.disabled = true; btn.classList.add('loading');
      const status = $('export-status');
      try {
        let elevations = null;
        if ($('x-ele').checked) {
          elevations = await RAA.gpx.fetchElevations(state.route.coords, m => { status.textContent = m; });
          if (!elevations) toast('Elevation service unavailable — exporting without elevation', 'warn');
        }
        const opts = { paceSec: parsePace(state.pace) || 330, elevations };
        const file = name.replace(/[^\w\-]+/g, '_');
        if (format === 'tcx') RAA.gpx.download(RAA.gpx.buildTcx(state.route.coords, name, opts), file + '.tcx', 'application/vnd.garmin.tcx+xml');
        else RAA.gpx.download(RAA.gpx.build(state.route.coords, name, desc, opts), file + '.gpx');
        status.textContent = `${format.toUpperCase()} ready: ${state.route.coords.length} points${elevations ? ' with elevation' : ''} and timestamps.`;
        toast(`${format.toUpperCase()} downloaded — import it as a course in Garmin Connect`, 'ok');
      } finally {
        btn.disabled = false; btn.classList.remove('loading');
      }
    }
    $('btn-gpx').onclick = () => exportCourse('gpx');
    $('btn-tcx').onclick = () => exportCourse('tcx');
    $('btn-fit').onclick = () => { if (state.area) map.fitBounds(L.latLngBounds(state.area), { padding: [40, 40] }); };
    $('btn-help').onclick = () => $('help').classList.toggle('open');
    $('help-close').onclick = () => $('help').classList.remove('open');
    $('btn-panel').onclick = () => document.body.classList.toggle('panel-collapsed');
    map.on('moveend', save);
  }

  function init() {
    const restored = load();
    wire();
    setMode('exclude');
    if (state.area) {
      setArea(state.area);
      if (state.start) setStart(state.start);
      $('area-info').textContent += ' (restored from your last visit)';
    } else {
      setArea(null);
      if (!restored && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(p => map.setView([p.coords.latitude, p.coords.longitude], 14), () => {}, { timeout: 4000 });
      }
    }
    updateNetworkStats(null);
  }

  RAA.app = { state, map, computeRoute, rebuild, setArea, fetchStreets };
  init();
})(window.RAA);
