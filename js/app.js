/* Run All Around – UI, map and state. */
window.RAA = window.RAA || {};
(function (RAA) {
  'use strict';

  const SNAP_M = 30;
  const C = {
    street: '#4a6fa5', blocked: '#c0504d', avoid: '#b9852a', mine: '#7b5ea7', muted: '#9aa0aa',
    route: '#e2583e', area: '#3d4a5c',
  };
  const BARRIER_M = 25;
  const STORE_KEY = 'raa:state:v1';

  const state = {
    area: null,            // ring [{lat,lng}]
    elements: null,        // raw Overpass elements (cached, re-filtered client side)
    graph: { edges: [], nodePos: new Map() },
    customPaths: [],       // [{id, latlngs:[{lat,lng}]}]
    excludedKeys: new Set(), // blocked streets: never run
    avoidKeys: new Set(),    // avoided streets: run once if needed, never repeated as a connector
    barriers: [],            // [{id, lat, lng}] spots where a street is impassable
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
  const light = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: osmAttr, maxZoom: 19, className: 'soft-tiles' });
  const dark = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: osmAttr, maxZoom: 19, className: 'night-tiles' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri', maxZoom: 19,
  });
  light.addTo(map);
  L.control.layers({ 'Light': light, 'Dark': dark, 'Satellite': sat }, null, { position: 'bottomright' }).addTo(map);

  const canvas = L.canvas({ padding: 0.5 });
  const svg = L.svg({ padding: 0.5 });
  const areaLayer = L.layerGroup().addTo(map);
  const edgeLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const barrierLayer = L.layerGroup().addTo(map);
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
        ? { color: C.mine, weight: 4, dashArray: '6 6' }
        : { color: C.area, weight: 2, dashArray: '6 6', fillColor: C.area, fillOpacity: 0.06 };
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
        avoidKeys: [...state.avoidKeys], barriers: state.barriers,
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
      state.avoidKeys = new Set(s.avoidKeys || []);
      state.barriers = s.barriers || [];
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
      L.polygon(ring, { color: C.area, weight: 1.5, dashArray: '6 6', fillColor: C.area, fillOpacity: 0.04, interactive: false }).addTo(areaLayer);
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
    g.joins = [];
    for (const b of state.barriers) {
      const pair = RAA.osm.cutAt(g, b, BARRIER_M, b.id);
      b.missed = !pair;
      if (pair) g.joins.push(pair);
    }
    const has = (set, e) => set.has(e.key) || (e.origKey != null && set.has(e.origKey));
    for (const e of g.edges) { e.excluded = has(state.excludedKeys, e); e.avoid = !e.excluded && has(state.avoidKeys, e); }
    drawBarriers();
    refresh();
  }

  function refresh() {
    const { edges } = state.graph;
    RAA.graph.markDeadEnds(edges);
    const comp = RAA.graph.markComponents(edges, state.includeDeadEnds, state.graph.joins);
    clearRoute();
    drawEdges();
    updateNetworkStats(comp);
    save();
  }

  function styleFor(e) {
    if (e.excluded) return { color: C.blocked, weight: 3, opacity: 0.85, dashArray: '5 6' };
    if (e.cutOff) return { color: C.blocked, weight: 2, opacity: 0.35, dashArray: '2 6' };
    if (e.deadEnd && !state.includeDeadEnds) return { color: C.muted, weight: 2.5, opacity: 0.7, dashArray: '2 7' };
    if (e.isolated) return { color: C.muted, weight: 2, opacity: 0.5, dashArray: '1 6' };
    if (e.avoid) return { color: C.avoid, weight: 3.5, opacity: 0.9, dashArray: '10 4 2 4' };
    if (e.custom) return { color: C.mine, weight: 3.5, opacity: 0.9 };
    if (e.deadEnd) return { color: C.street, weight: 3, opacity: 0.75, dashArray: '8 5' };
    return { color: C.street, weight: 3, opacity: 0.75 };
  }

  function edgeLabel(e) {
    const tags = [];
    if (e.custom) tags.push('my path');
    if (e.excluded) tags.push('blocked');
    else if (e.cutOff) tags.push('cut off by a block');
    else if (e.isolated) tags.push('disconnected');
    if (e.avoid) tags.push('avoid repeats');
    if (e.deadEnd) tags.push('dead end');
    return `${escapeHtml(e.name)} · ${fmtM(e.len)}${tags.length ? ' · ' + tags.join(' · ') : ''}`;
  }

  function drawEdges() {
    edgeLayer.clearLayers();
    for (const e of state.graph.edges) {
      const line = L.polyline(e.coords, Object.assign({ renderer: canvas, interactive: true }, styleFor(e)));
      line.bindTooltip(() => edgeLabel(e), { sticky: true, className: 'edge-tip' });
      line.on('mouseover', () => line.setStyle({ weight: styleFor(e).weight + 3 }));
      line.on('mouseout', () => line.setStyle({ weight: styleFor(e).weight }));
      line.on('click', ev => { if (drawer.busy) return; L.DomEvent.stop(ev); onEdgeClick(e, ev.latlng, ev.originalEvent); });
      e.layer = line;
      line.addTo(edgeLayer);
    }
  }

  const stateOf = e => e.excluded ? 'block' : e.avoid ? 'avoid' : 'run';

  /** Set a street piece to 'run' | 'avoid' | 'block', keeping pieces of split streets consistent. */
  function setEdgeState(e, st) {
    for (const set of [state.excludedKeys, state.avoidKeys]) {
      set.delete(e.key);
      // the whole unsplit street had this state: keep it on the other pieces, change only this one
      if (e.origKey != null && set.delete(e.origKey)) {
        for (const o of state.graph.edges) if (o !== e && (o.origKey === e.origKey || o.key === e.origKey)) set.add(o.key);
      }
    }
    if (st === 'block') state.excludedKeys.add(e.key);
    if (st === 'avoid') state.avoidKeys.add(e.key);
    e.excluded = st === 'block';
    e.avoid = st === 'avoid';
  }

  function onEdgeClick(e, latlng, domEvent) {
    if (drawer.busy) return;
    if (state.mode === 'start') { setStart(latlng || e.coords[0]); return; }
    if (state.mode === 'cut') { addBarrier(latlng); return; }
    if (domEvent && (domEvent.shiftKey || domEvent.altKey)) {   // quick toggle, old one-click behaviour
      setEdgeState(e, e.excluded ? 'run' : 'block');
      toast(e.excluded ? `Blocked ${e.name}` : `Back in: ${e.name}`);
      refresh();
      return;
    }
    openEdgeMenu(e, latlng || L.latLng(e.coords[0]));
  }

  function openEdgeMenu(e, latlng) {
    const cur = stateOf(e);
    const el = document.createElement('div');
    el.className = 'edge-menu';
    const deadNote = e.deadEnd && !e.excluded ? '<p class="menu-note">Blocking a dead end drops everything beyond it too.</p>' : '';
    el.innerHTML = `<div class="menu-title">${edgeLabel(e)}</div>
      <div class="menu-row">
        <button data-st="run" class="${cur === 'run' ? 'on' : ''}" title="Cover it normally">Run it</button>
        <button data-st="avoid" class="${cur === 'avoid' ? 'on' : ''}" title="Cover it once if needed, but never run it twice">Avoid</button>
        <button data-st="block" class="${cur === 'block' ? 'on' : ''}" title="Never run it">Block</button>
      </div>
      <div class="menu-row">
        <button data-act="cut" title="Make the street impassable at the spot you clicked">Cut here</button>
        ${e.custom ? '<button data-act="remove" title="Delete this custom path">Remove path</button>' : ''}
      </div>${deadNote}`;
    const popup = L.popup({ className: 'menu-popup', closeButton: true, autoPan: true, maxWidth: 300 }).setLatLng(latlng).setContent(el).openOn(map);
    el.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      map.closePopup(popup);
      if (b.dataset.st) {
        if (b.dataset.st === cur) return;
        setEdgeState(e, b.dataset.st);
        toast({ run: `Back in: ${e.name}`, avoid: `Avoiding repeats on ${e.name}`, block: `Blocked ${e.name}` }[b.dataset.st]);
        refresh();
      } else if (b.dataset.act === 'cut') addBarrier(latlng);
      else if (b.dataset.act === 'remove') {
        state.customPaths = state.customPaths.filter(cp => cp.id !== e.customId);
        toast('Custom path removed');
        rebuild();
      }
    });
  }

  // ---------- Barriers ----------
  function addBarrier(latlng) {
    if (!state.elements) { toast('Load the streets first', 'warn'); return; }
    const b = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), lat: latlng.lat, lng: latlng.lng };
    state.barriers.push(b);
    setMode('exclude');
    rebuild();
    if (b.missed) {
      state.barriers = state.barriers.filter(x => x !== b);
      rebuild();
      toast('No street close enough to cut there', 'warn');
      return;
    }
    toast('Passage cut. Click either side to block it, or click the red marker to remove the cut.', 'ok');
  }

  function removeBarrier(id) {
    state.barriers = state.barriers.filter(b => b.id !== id);
    rebuild();
    toast('Cut removed');
  }

  function drawBarriers() {
    barrierLayer.clearLayers();
    for (const b of state.barriers) {
      if (b.missed) continue;
      const m = L.marker([b.lat, b.lng], {
        icon: L.divIcon({ className: 'barrier-pin', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        zIndexOffset: 500,
      });
      m.bindTooltip('Impassable here · click to remove', { direction: 'top', offset: [0, -10] });
      m.on('click', ev => { L.DomEvent.stop(ev); if (!drawer.busy) removeBarrier(b.id); });
      m.addTo(barrierLayer);
    }
  }

  function updateNetworkStats(comp) {
    const edges = state.graph.edges;
    const active = edges.filter(e => RAA.graph.isActive(e, state.includeDeadEnds) && !e.isolated);
    const total = active.reduce((s, e) => s + e.len, 0);
    const deadEnds = edges.filter(e => e.deadEnd && !e.excluded);
    const deadLen = deadEnds.reduce((s, e) => s + e.len, 0);
    $('net-streets').textContent = active.length;
    $('net-km').textContent = fmtKm(total);
    $('net-dead').textContent = fmtKm(deadLen);
    $('net-dead-k').textContent = `Dead ends (${deadEnds.length})`;
    $('net-excluded').textContent = edges.filter(e => e.excluded).length;
    $('net-avoid').textContent = edges.filter(e => e.avoid && !e.excluded).length;
    $('net-custom').textContent = state.customPaths.length;
    const warn = $('net-warn');
    if (comp && comp.components > 1) {
      warn.textContent = `${comp.components - 1} disconnected piece(s) (${fmtKm(comp.droppedLen)}) are greyed out and will be skipped. Connect them with a custom path or extend the area.`;
      warn.hidden = false;
    } else warn.hidden = true;
    const cut = $('net-cut');
    if (comp && comp.cutLen > 0) {
      cut.textContent = `${fmtKm(comp.cutLen)} of streets is cut off by your blocks and cuts (faded red) and will be skipped.`;
      cut.hidden = false;
    } else cut.hidden = true;
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
        icon: L.divIcon({ className: 'start-pin', html: '<span></span>', iconSize: [30, 34], iconAnchor: [15, 33] }),
      }).addTo(map);
      startMarker.on('dragend', () => { state.start = startMarker.getLatLng(); clearRoute(); save(); });
      startMarker.bindTooltip('Start / finish — drag me', { direction: 'top', offset: [0, -30] });
    }
    setMode('exclude');
    clearRoute();
    save();
  }

  function setMode(mode) {
    state.mode = mode;
    document.body.dataset.mode = mode;
    $('btn-start').classList.toggle('active', mode === 'start');
    $('btn-cut').classList.toggle('active', mode === 'cut');
    map.getContainer().classList.toggle('pick', mode === 'start' || mode === 'cut');
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
    for (const s of res.sequence) if (s.dup) L.polyline(s.e.coords, { renderer: canvas, color: C.route, weight: 14, opacity: 0.32, lineCap: 'round', interactive: false }).addTo(routeLayer);
    L.polyline(coords, { renderer: svg, color: '#ffffff', weight: 7, opacity: 0.9, lineJoin: 'round', interactive: false }).addTo(routeLayer);
    L.polyline(coords, { renderer: svg, color: C.route, weight: 3.5, opacity: 1, lineJoin: 'round', interactive: false }).addTo(routeLayer);
    if (!state.start && res.start != null) setStartMarkerOnly(nodePos.get(res.start));

    $('rs-streets').textContent = fmtKm(res.streetLength);
    $('rs-route').textContent = fmtKm(res.routeLength);
    const pct = res.streetLength ? (100 * res.extra / res.streetLength) : 0;
    $('rs-extra').textContent = fmtKm(res.extra);
    $('rs-extra-k').textContent = `Repeated (+${pct.toFixed(0)}%)`;
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
      icon: L.divIcon({ className: 'start-pin', html: '<span></span>', iconSize: [30, 34], iconAnchor: [15, 33] }),
    }).addTo(map);
    startMarker.on('dragend', () => { state.start = startMarker.getLatLng(); clearRoute(); save(); });
    startMarker.bindTooltip('Start / finish — drag me', { direction: 'top', offset: [0, -30] });
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
    $('btn-clear-area').onclick = () => { drawer.cancel(); state.customPaths = []; state.excludedKeys.clear(); state.avoidKeys.clear(); state.barriers = []; barrierLayer.clearLayers(); setStart(null); setArea(null); state.elements = null; state.graph = { edges: [], nodePos: new Map() }; edgeLayer.clearLayers(); clearRoute(); $('fetch-status').textContent = ''; updateNetworkStats(null); };
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
    $('btn-reset-excl').onclick = () => {
      state.excludedKeys.clear(); state.avoidKeys.clear(); state.barriers = [];
      if (state.elements) rebuild(); else { barrierLayer.clearLayers(); save(); }
      toast('All blocks, avoids and cuts removed');
    };
    $('btn-cut').onclick = () => {
      if (state.mode === 'cut') { setMode('exclude'); return; }
      if (!state.elements) { toast('Load the streets first', 'warn'); return; }
      setMode('cut');
      toast('Click the exact spot on a street where it can\'t be passed');
    };
    $('btn-start').onclick = () => { if (state.mode === 'start') setMode('exclude'); else { setMode('start'); toast('Click on the map where you want to start'); } };
    map.on('click', e => {
      if (drawer.busy) return;
      if (state.mode === 'start') setStart(e.latlng);
      else if (state.mode === 'cut') addBarrier(e.latlng);
    });
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
    drawBarriers();
    updateNetworkStats(null);
  }

  RAA.app = { state, map, computeRoute, rebuild, setArea, fetchStreets };
  init();
})(window.RAA);
