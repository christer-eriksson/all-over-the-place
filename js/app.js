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
    useMyPaths: true,        // apply the saved custom paths
    useMyCuts: true,         // apply the saved cuts
    filters: { service: true, trails: true, sidewalks: false, steps: false },
    start: null,           // {lat,lng}
    pace: '5:30',
    routeMode: 'all',      // 'all': every street, fewest repeats | 'loop': longest loop, no repeats
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
  const savedLayer = L.layerGroup().addTo(map);   // saved paths that aren't part of the street graph right now
  let startMarker = null;

  // ---------- Mouse drawing (rectangle / polygon / polyline) ----------
  class Drawer {
    constructor(map) {
      this.map = map; this.active = null; this.shape = null;
      this.temp = L.layerGroup().addTo(map);
      this.dots = L.layerGroup().addTo(this.temp);   // corner markers
      this.doneAt = 0;
      this._onKey = this._onKey.bind(this);
      // Pointer events, so a rectangle can be dragged with a finger as well as a mouse.
      this._rectDown = this._rectDown.bind(this);
      this._rectMove = this._rectMove.bind(this);
      this._rectUp = this._rectUp.bind(this);
    }
    // also swallow the click that the browser sends right after a shape is finished
    get busy() { return !!this.active || Date.now() - this.doneAt < 400; }
    start(kind, done) {
      this.cancel();
      this.active = { kind, done, points: [] };
      const el = this.map.getContainer();
      el.classList.add('drawing');
      document.addEventListener('keydown', this._onKey);
      if (kind === 'rect') {
        this.map.dragging.disable();
        this.map.touchZoom.disable();
        el.addEventListener('pointerdown', this._rectDown);
      } else {
        this.map.doubleClickZoom.disable();
        this.map.on('click', this._vertex, this);
        this.map.on('mousemove', this._move, this);
        this.map.on('dblclick', this._finish, this);
      }
      document.body.dataset.drawing = kind;
      const verb = matchMedia('(pointer: coarse)').matches ? 'Tap' : 'Click';
      $('drawbar-text').textContent = {
        rect: 'Drag on the map to draw a rectangle',
        poly: `${verb} the corners of your area. Drag or pinch to move the map.`,
        line: `${verb} along your path. Drag or pinch to move the map.`,
      }[kind];
      $('db-undo').hidden = $('db-done').hidden = kind === 'rect';
      $('drawbar').hidden = false;
      document.body.classList.add('sheet-min');
    }
    _style() {
      return this.active.kind === 'line'
        ? { color: C.mine, weight: 4, dashArray: '6 6' }
        : { color: C.area, weight: 2, dashArray: '6 6', fillColor: C.area, fillOpacity: 0.06 };
    }
    _rectDown(ev) {
      if (!ev.isPrimary || ev.button > 0 || ev.target.closest('.drawbar, .leaflet-control')) return;
      ev.preventDefault();
      const el = this.map.getContainer();
      el.setPointerCapture(ev.pointerId);
      this.active.points = [this.map.mouseEventToLatLng(ev)];
      el.addEventListener('pointermove', this._rectMove);
      el.addEventListener('pointerup', this._rectUp);
      el.addEventListener('pointercancel', this._rectUp);
    }
    _rectMove(ev) {
      const b = L.latLngBounds(this.active.points[0], this.map.mouseEventToLatLng(ev));
      if (!this.shape) this.shape = L.rectangle(b, this._style()).addTo(this.temp); else this.shape.setBounds(b);
    }
    _rectUp(ev) {
      const el = this.map.getContainer();
      el.removeEventListener('pointermove', this._rectMove);
      el.removeEventListener('pointerup', this._rectUp);
      el.removeEventListener('pointercancel', this._rectUp);
      if (ev.type === 'pointercancel') { if (this.shape) this.temp.removeLayer(this.shape); this.shape = null; return; }
      const b = L.latLngBounds(this.active.points[0], this.map.mouseEventToLatLng(ev));
      const a = this.map.latLngToContainerPoint(b.getNorthWest()), c = this.map.latLngToContainerPoint(b.getSouthEast());
      // a tap or a tiny drag: keep waiting for a real rectangle
      if (Math.abs(a.x - c.x) < 10 || Math.abs(a.y - c.y) < 10) { if (this.shape) this.temp.removeLayer(this.shape); this.shape = null; return; }
      this._complete([b.getNorthWest(), b.getNorthEast(), b.getSouthEast(), b.getSouthWest()]);
    }
    _vertex(e) {
      const pts = this.active.points;
      const last = pts[pts.length - 1];
      if (last && this.map.latLngToContainerPoint(last).distanceTo(this.map.latLngToContainerPoint(e.latlng)) < 4) return;
      pts.push(e.latlng);
      L.circleMarker(e.latlng, { radius: 5, weight: 2, color: '#fff', fillColor: this._style().color, fillOpacity: 1, interactive: false }).addTo(this.dots);
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
      else if (e.key === 'Enter') this.finish();
      else if (e.key === 'Backspace' && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) { this.undo(); e.preventDefault(); }
    }
    undo() {
      if (!this.active || this.active.kind === 'rect') return;
      this.active.points.pop();
      const dots = this.dots.getLayers();
      if (dots.length) this.dots.removeLayer(dots[dots.length - 1]);
      if (this.shape) this.shape.setLatLngs(this.active.points);
    }
    finish() { if (this.active && this.active.kind !== 'rect') this._finish(); }
    _complete(points) {
      const a = this.active;
      this.cancel();
      this.doneAt = Date.now();
      a.done(points);
    }
    cancel() {
      if (!this.active) return;
      const el = this.map.getContainer();
      el.removeEventListener('pointerdown', this._rectDown);
      el.removeEventListener('pointermove', this._rectMove);
      el.removeEventListener('pointerup', this._rectUp);
      el.removeEventListener('pointercancel', this._rectUp);
      this.map.off('click', this._vertex, this);
      this.map.off('mousemove', this._move, this);
      this.map.off('dblclick', this._finish, this);
      document.removeEventListener('keydown', this._onKey);
      this.map.dragging.enable();
      this.map.touchZoom.enable();
      this.map.doubleClickZoom.enable();
      $('drawbar').hidden = true;
      document.body.classList.remove('sheet-min');
      this.map.getContainer().classList.remove('drawing');
      delete document.body.dataset.drawing;
      this.temp.clearLayers();
      this.dots.clearLayers();
      this.temp.addLayer(this.dots);
      this.shape = null;
      this.active = null;
    }
  }
  const drawer = new Drawer(map);

  // ---------- Steps (phone: one step at a time in a bottom sheet) ----------
  const STEPS = ['step-area', 'step-fetch', 'step-tune', 'step-route', 'step-export'];
  const STEP_NAMES = ['Area', 'Load streets', 'Adjust the course', 'Plan the route', 'Export'];
  const phone = matchMedia('(max-width: 760px)');
  let step = 0;

  function showStep(i) {
    step = i;
    STEPS.forEach((id, k) => $(id).classList.toggle('current', k === i));
    document.body.classList.remove('sheet-min');
    $('panel').scrollTop = 0;
    updateStepper();
  }
  function updateStepper() {
    const done = [!!state.area, !!state.elements, state.graph.edges.length > 0, !!state.route, false];
    document.querySelectorAll('#stepper button').forEach((b, k) => {
      b.classList.toggle('on', k === step);
      b.classList.toggle('done', k !== step && done[k]);
    });
  }
  /** Where to start: the furthest step that has what it needs. */
  function bestStep() { return state.route ? 3 : state.graph.edges.length ? 2 : state.area ? 1 : 0; }

  // Keep the map controls above the sheet on a phone.
  new ResizeObserver(() => {
    const h = phone.matches ? $('panel').offsetHeight : 0;
    document.body.style.setProperty('--sheet-h', h + 'px');
  }).observe($('panel'));

  // ---------- Persistence ----------
  function save() {
    try {
      const c = map.getCenter();
      localStorage.setItem(STORE_KEY, JSON.stringify({
        area: state.area, customPaths: state.customPaths, excludedKeys: [...state.excludedKeys],
        avoidKeys: [...state.avoidKeys], barriers: state.barriers,
        includeDeadEnds: state.includeDeadEnds, useMyPaths: state.useMyPaths, useMyCuts: state.useMyCuts, filters: state.filters, start: state.start, pace: state.pace, routeMode: state.routeMode,
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
      state.useMyPaths = s.useMyPaths !== false;
      state.useMyCuts = s.useMyCuts !== false;
      Object.assign(state.filters, s.filters || {});
      state.start = s.start || null;
      state.pace = s.pace || '5:30';
      state.routeMode = s.routeMode === 'loop' ? 'loop' : 'all';
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
    $('btn-fetch').disabled = !ring; $('btn-refetch').disabled = !ring;
    $('area-info').textContent = ring ? `${ring.length}-point area marked. Load the streets when you're ready.` : 'No area yet.';
    updateStepper();
    save();
  }

  // ---------- Graph pipeline ----------
  const touchesArea = cp => state.area && cp.latlngs.some(p => RAA.osm.pointInPolygon(p, state.area));

  function rebuild() {
    if (!state.elements || !state.area) { drawBarriers(); drawSaved(); save(); return; }
    const g = RAA.osm.buildGraph(state.elements, state.area, state.filters);
    state.graph = g;
    if (state.useMyPaths) for (const cp of state.customPaths) if (touchesArea(cp)) RAA.osm.addCustomPath(g, cp, SNAP_M);
    g.joins = [];
    for (const b of state.barriers) {
      if (!state.useMyCuts) { b.missed = false; continue; }
      const pair = RAA.osm.cutAt(g, b, BARRIER_M, b.id);
      b.missed = !pair;
      if (pair) g.joins.push(pair);
    }
    const has = (set, e) => set.has(e.key) || (e.origKey != null && set.has(e.origKey));
    for (const e of g.edges) { e.excluded = has(state.excludedKeys, e); e.avoid = !e.excluded && has(state.avoidKeys, e); }
    drawBarriers();
    drawSaved();
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
      const off = !state.useMyCuts;
      const m = L.marker([b.lat, b.lng], {
        icon: L.divIcon({ className: 'barrier-pin' + (off ? ' off' : ''), html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        zIndexOffset: 500,
      });
      m.bindTooltip(off ? 'Saved cut, switched off · click to remove' : 'Impassable here · click to remove', { direction: 'top', offset: [0, -10] });
      m.on('click', ev => { L.DomEvent.stop(ev); if (!drawer.busy) removeBarrier(b.id); });
      m.addTo(barrierLayer);
    }
  }

  /** Saved paths that aren't in the street graph (streets not loaded, outside the area, or switched off). */
  function drawSaved() {
    savedLayer.clearLayers();
    const inGraph = new Set(state.graph.edges.filter(e => e.custom).map(e => e.customId));
    for (const cp of state.customPaths) {
      if (inGraph.has(cp.id)) continue;
      const why = !state.useMyPaths ? 'switched off'
        : !state.elements ? 'used once the streets are loaded'
        : touchesArea(cp) ? 'not connected to any street' : 'outside the area';
      const line = L.polyline(cp.latlngs, { renderer: canvas, color: C.mine, weight: 3, opacity: 0.55, dashArray: '6 6' });
      line.bindTooltip(`My path (saved) · ${why}`, { sticky: true, className: 'edge-tip' });
      line.bindPopup(() => {
        const el = L.DomUtil.create('div', 'edge-menu');
        el.innerHTML = `<div class="menu-title">My path (saved) · ${why}</div><div class="menu-row"><button data-act="remove">Remove path</button></div>`;
        el.querySelector('button').onclick = () => {
          map.closePopup();
          state.customPaths = state.customPaths.filter(x => x.id !== cp.id);
          rebuild(); toast('Custom path removed');
        };
        return el;
      }, { className: 'menu-popup', closeButton: false });
      line.addTo(savedLayer);
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
    const used = new Set(edges.filter(e => e.custom).map(e => e.customId)).size;
    $('net-custom').textContent = state.customPaths.length && used < state.customPaths.length ? `${used} of ${state.customPaths.length}` : state.customPaths.length;
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
    updateStepper();
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
    const picking = m => m === 'start' || m === 'cut';
    // on a phone, get the sheet out of the way while picking a spot on the map
    if (picking(mode)) document.body.classList.add('sheet-min');
    else if (picking(state.mode)) document.body.classList.remove('sheet-min');
    state.mode = mode;
    document.body.dataset.mode = mode;
    $('btn-start').classList.toggle('active', mode === 'start');
    $('btn-cut').classList.toggle('active', mode === 'cut');
    map.getContainer().classList.toggle('pick', mode === 'start' || mode === 'cut');
  }

  // ---------- Route ----------
  function clearRoute() {
    state.route = null;
    updateStepper();
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
      res = state.routeMode === 'loop'
        ? RAA.graph.solveLoop(edges, state.includeDeadEnds, startNode, nodePos)
        : RAA.graph.solve(edges, state.includeDeadEnds, startNode);
      res.ms = performance.now() - t0;
    } catch (err) {
      toast(err.message, 'warn');
      return;
    }
    state.route = res;
    const coords = RAA.graph.routeCoords(res.sequence);
    res.coords = coords;
    routeLayer.clearLayers();
    // streets the no-repeat loop leaves out, greyed over the street layer
    for (const e of res.skippedEdges || []) {
      L.polyline(e.coords, { renderer: canvas, color: '#ffffff', weight: 6, opacity: 0.85, interactive: false }).addTo(routeLayer);
      L.polyline(e.coords, { renderer: canvas, color: C.muted, weight: 3, opacity: 1, dashArray: '2 5', interactive: false }).addTo(routeLayer);
    }
    // streets run twice, shown underneath in orange
    for (const s of res.sequence) if (s.dup) L.polyline(s.e.coords, { renderer: canvas, color: C.route, weight: 14, opacity: 0.32, lineCap: 'round', interactive: false }).addTo(routeLayer);
    L.polyline(coords, { renderer: svg, color: '#ffffff', weight: 7, opacity: 0.9, lineJoin: 'round', interactive: false }).addTo(routeLayer);
    L.polyline(coords, { renderer: svg, color: C.route, weight: 3.5, opacity: 1, lineJoin: 'round', interactive: false }).addTo(routeLayer);
    if (!state.start && res.start != null) setStartMarkerOnly(nodePos.get(res.start));
    updateStepper();

    $('rs-streets').textContent = fmtKm(res.streetLength);
    $('rs-route').textContent = fmtKm(res.routeLength);
    const pct = res.streetLength ? (100 * res.extra / res.streetLength) : 0;
    $('rs-extra').textContent = fmtKm(res.extra);
    $('rs-extra-k').textContent = `Repeated (+${pct.toFixed(0)}%)`;
    if (res.mode === 'loop') {
      const total = res.streetLength + res.skipped;
      $('rs-odd-k').textContent = `Skipped (${total ? (100 * res.skipped / total).toFixed(0) : 0}%)`;
      $('rs-odd').textContent = fmtKm(res.skipped);
    } else {
      $('rs-odd-k').textContent = 'Odd corners';
      $('rs-odd').textContent = res.oddCount;
    }
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
  const ago = t => { const d = Math.floor((Date.now() - t) / 86400000); return d < 1 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };

  async function fetchStreets(fresh) {
    if (!state.area) return;
    const btn = $('btn-fetch');
    btn.disabled = true; btn.classList.add('loading'); $('btn-refetch').disabled = true;
    const status = $('fetch-status');
    status.textContent = 'Looking for saved streets…';
    try {
      const r = await RAA.osm.fetchStreets(state.area, m => { status.textContent = m; }, { fresh: fresh === true });
      state.elements = r.elements;
      const ways = r.elements.filter(e => e.type === 'way').length;
      status.textContent = !r.downloaded ? `${ways} ways, saved in this browser ${ago(r.oldest)}.`
        : r.cached ? `${ways} ways: ${r.downloaded} new map tiles downloaded, ${r.cached} already saved.`
        : `${ways} ways downloaded from OpenStreetMap and saved for next time.`;
      rebuild();
      if (state.start) setStart(state.start);
      toast('Streets loaded. Tap or click a street to change it.', 'ok');
      if (step < 2) showStep(2);
    } catch (err) {
      status.textContent = 'Could not load streets: ' + err.message;
      toast('Could not fetch streets: ' + err.message, 'warn');
    } finally {
      btn.disabled = false; btn.classList.remove('loading'); $('btn-refetch').disabled = !state.area;
    }
  }

  // ---------- Wire up UI ----------
  function wire() {
    $('btn-rect').onclick = () => { setMode('exclude'); drawer.start('rect', ring => { setArea(ring); showStep(1); }); };
    $('btn-poly').onclick = () => { setMode('exclude'); drawer.start('poly', ring => { setArea(ring); showStep(1); }); };
    // Clearing the area keeps your own paths, cuts, blocks and avoids for next time.
    $('btn-clear-area').onclick = () => { drawer.cancel(); setStart(null); setArea(null); state.elements = null; state.graph = { edges: [], nodePos: new Map() }; edgeLayer.clearLayers(); clearRoute(); $('fetch-status').textContent = ''; updateNetworkStats(null); rebuild(); };
    $('btn-fetch').onclick = () => fetchStreets();
    $('btn-refetch').onclick = () => fetchStreets(true);

    for (const k of Object.keys(state.filters)) {
      const cb = $('f-' + k);
      cb.checked = state.filters[k];
      cb.onchange = () => { state.filters[k] = cb.checked; rebuild(); save(); };
    }
    const de = $('t-deadends');
    de.checked = state.includeDeadEnds;
    de.onchange = () => { state.includeDeadEnds = de.checked; refresh(); };
    const mp = $('t-mypaths'), mc = $('t-mycuts');
    mp.checked = state.useMyPaths; mc.checked = state.useMyCuts;
    mp.onchange = () => { state.useMyPaths = mp.checked; rebuild(); };
    mc.onchange = () => { state.useMyCuts = mc.checked; rebuild(); };

    $('btn-path').onclick = () => {
      setMode('exclude');
      drawer.start('line', pts => {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        state.customPaths.push({ id, latlngs: pts });
        if (!state.useMyPaths) { state.useMyPaths = true; $('t-mypaths').checked = true; }
        rebuild();
        if (state.elements && touchesArea({ latlngs: pts }) && !state.graph.edges.some(e => e.customId === id)) {
          state.customPaths = state.customPaths.filter(cp => cp.id !== id);
          rebuild();
          toast('Path too short: both ends snap to the same spot', 'warn');
          return;
        }
        toast('Custom path added', 'ok');
      });
    };
    $('btn-clear-paths').onclick = () => {
      if (!state.customPaths.length) return;
      if (!confirm(`Delete all ${state.customPaths.length} of your own paths? This can't be undone.`)) return;
      state.customPaths = []; rebuild(); toast('All custom paths removed');
    };
    $('btn-reset-excl').onclick = () => {
      state.excludedKeys.clear(); state.avoidKeys.clear(); state.barriers = [];
      rebuild();
      toast('All blocks, avoids and cuts removed');
    };
    $('btn-cut').onclick = () => {
      if (state.mode === 'cut') { setMode('exclude'); return; }
      if (!state.elements) { toast('Load the streets first', 'warn'); return; }
      if (!state.useMyCuts) { state.useMyCuts = true; $('t-mycuts').checked = true; rebuild(); }
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
    const modeHint = {
      all: 'Finds the shortest loop that runs every street at least once.',
      loop: 'Finds a long loop that never runs a street twice. Streets that would force a repeat, like dead ends, are skipped. A short stretch may be run both ways if it opens up a much bigger area, like a bridge.',
    };
    const setRouteMode = m => {
      state.routeMode = m;
      document.querySelectorAll('#route-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
      $('route-hint').textContent = modeHint[m];
    };
    document.querySelectorAll('#route-mode button').forEach(b => {
      b.onclick = () => { if (state.routeMode === b.dataset.mode) return; setRouteMode(b.dataset.mode); save(); if (state.route) computeRoute(); };
    });
    setRouteMode(state.routeMode);
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
    $('btn-fit').onclick = () => {
      if (state.area) map.fitBounds(L.latLngBounds(state.area), { paddingTopLeft: [30, 30], paddingBottomRight: [30, 30 + (phone.matches ? $('panel').offsetHeight : 0)] });
    };
    $('btn-help').onclick = () => $('help').classList.toggle('open');
    $('help-close').onclick = () => $('help').classList.remove('open');
    $('btn-panel').onclick = () => document.body.classList.toggle('panel-collapsed');
    $('panel').addEventListener('transitionend', () => map.invalidateSize());

    // drawing bar
    L.DomEvent.disableClickPropagation($('drawbar'));
    $('db-undo').onclick = () => drawer.undo();
    $('db-done').onclick = () => drawer.finish();
    $('db-cancel').onclick = () => drawer.cancel();

    // steps
    document.querySelectorAll('#stepper button').forEach(b => { b.onclick = () => showStep(+b.dataset.step); });
    STEPS.slice(0, -1).forEach((id, k) => {
      const next = document.createElement('button');
      next.className = 'btn next';
      next.textContent = `Next: ${STEP_NAMES[k + 1]} →`;
      next.onclick = () => showStep(k + 1);
      $(id).appendChild(next);
    });
    const toggleSheet = () => { if (phone.matches) document.body.classList.toggle('sheet-min'); };
    $('sheet-handle').onclick = toggleSheet;
    document.querySelectorAll('.step-head').forEach(h => { h.onclick = toggleSheet; });
    phone.addEventListener('change', () => { document.body.classList.remove('sheet-min'); setTimeout(() => map.invalidateSize(), 50); });
    map.on('moveend', save);
  }

  function init() {
    const restored = load();
    wire();
    setMode('exclude');
    if (state.area) {
      setArea(state.area);
      if (state.start) setStart(state.start);
      $('area-info').textContent = 'Area restored from your last visit.';
      fetchStreets();
    } else {
      setArea(null);
      if (!restored && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(p => map.setView([p.coords.latitude, p.coords.longitude], 14), () => {}, { timeout: 4000 });
      }
    }
    drawBarriers();
    drawSaved();
    updateNetworkStats(null);
    showStep(bestStep());
  }

  RAA.app = { state, map, computeRoute, rebuild, setArea, fetchStreets };
  init();
})(window.RAA);
