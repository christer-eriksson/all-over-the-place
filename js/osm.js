/* Run All Around – OSM fetching + graph building
 * Fetches highway ways from Overpass inside a polygon, clips them, and turns them
 * into a "street graph": edges run between intersections / way boundaries and
 * carry their full geometry so the final route follows the real street shape.
 */
window.RAA = window.RAA || {};
(function (RAA) {
  'use strict';

  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];

  const ROADS   = new Set(['residential', 'living_street', 'unclassified', 'tertiary', 'secondary', 'primary',
                           'tertiary_link', 'secondary_link', 'primary_link', 'road', 'pedestrian']);
  const TRAILS  = new Set(['footway', 'path', 'cycleway', 'track', 'bridleway']);
  const SERVICE = new Set(['service']);
  const STEPS   = new Set(['steps']);

  const PRETTY = {
    footway: 'Footpath', path: 'Path', cycleway: 'Cycleway', track: 'Track', bridleway: 'Bridleway',
    service: 'Service road', steps: 'Steps', residential: 'Residential street', living_street: 'Living street',
    unclassified: 'Minor road', tertiary: 'Road', secondary: 'Road', primary: 'Main road', pedestrian: 'Pedestrian street',
  };

  function polyString(ring) {
    return ring.map(p => `${p.lat.toFixed(6)} ${p.lng.toFixed(6)}`).join(' ');
  }

  /** Fetch every highway way (plus its nodes) whose geometry touches the polygon. */
  async function fetchStreets(ring, onStatus) {
    const query = `[out:json][timeout:90];way["highway"](poly:"${polyString(ring)}");out body;>;out skel qt;`;
    let lastErr = null;
    for (const url of ENDPOINTS) {
      try {
        onStatus && onStatus(`Asking ${new URL(url).host} for streets…`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
        const json = await res.json();
        if (!json.elements) throw new Error('Unexpected Overpass answer');
        return json.elements;
      } catch (err) {
        lastErr = err;
        console.warn('Overpass endpoint failed', url, err);
      }
    }
    throw lastErr || new Error('All Overpass endpoints failed');
  }

  function wayAllowed(tags, f) {
    const hw = tags.highway;
    if (!hw) return false;
    if (tags.area === 'yes') return false;
    if (tags.foot === 'no') return false;
    const footOk = tags.foot === 'yes' || tags.foot === 'designated' || tags.foot === 'permissive';
    if ((tags.access === 'private' || tags.access === 'no') && !footOk) return false;
    if (ROADS.has(hw)) return true;
    if (SERVICE.has(hw)) {
      if (!f.service) return false;
      const s = tags.service;
      return !(s === 'driveway' || s === 'parking_aisle' || s === 'drive-through' || s === 'emergency_access');
    }
    if (TRAILS.has(hw)) {
      if (!f.trails) return false;
      if (!f.sidewalks && (tags.footway === 'sidewalk' || tags.footway === 'crossing' || tags.footway === 'traffic_island')) return false;
      return true;
    }
    if (STEPS.has(hw)) return !!f.steps;
    return false;
  }

  function pointInPolygon(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i].lat, xi = ring[i].lng, yj = ring[j].lat, xj = ring[j].lng;
      const intersect = ((yi > p.lat) !== (yj > p.lat)) && (p.lng < (xj - xi) * (p.lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  let edgeSeq = 0;
  let customNodeSeq = 0;
  const nextEdgeId = () => ++edgeSeq;

  /**
   * Build the street graph from raw Overpass elements.
   * Returns { edges, nodePos }.
   *   edge: { id, a, b, nodeIds[], coords[], len, name, hw, wayId, key, excluded, deadEnd, isolated, custom }
   */
  function buildGraph(elements, ring, filters) {
    customNodeSeq = 0;
    const nodes = new Map();
    const ways = [];
    for (const el of elements) {
      if (el.type === 'node') nodes.set(el.id, { lat: el.lat, lng: el.lon });
      else if (el.type === 'way' && el.tags && wayAllowed(el.tags, filters)) ways.push(el);
    }
    const insideCache = new Map();
    const isIn = id => {
      if (!insideCache.has(id)) {
        const n = nodes.get(id);
        insideCache.set(id, !!n && pointInPolygon(n, ring));
      }
      return insideCache.get(id);
    };

    // How many clipped segments touch each node -> degree in the raw graph.
    const use = new Map();
    const bump = id => use.set(id, (use.get(id) || 0) + 1);
    for (const w of ways) {
      const nd = w.nodes;
      for (let i = 0; i < nd.length - 1; i++) {
        if (isIn(nd[i]) && isIn(nd[i + 1])) { bump(nd[i]); bump(nd[i + 1]); }
      }
    }

    const edges = [];
    const nodePos = new Map();
    for (const w of ways) {
      const nd = w.nodes;
      const name = w.tags.name || PRETTY[w.tags.highway] || w.tags.highway;
      let chain = null;
      const flush = () => {
        if (chain && chain.length > 1) {
          const coords = chain.map(id => nodes.get(id));
          chain.forEach((id, i) => nodePos.set(id, coords[i]));
          edges.push({
            id: nextEdgeId(), a: chain[0], b: chain[chain.length - 1],
            nodeIds: chain, coords, len: RAA.graph.pathLength(coords),
            name, hw: w.tags.highway, wayId: w.id,
            key: `${w.id}:${chain[0]}:${chain[chain.length - 1]}`,
            excluded: false, deadEnd: false, isolated: false, custom: false,
          });
        }
        chain = null;
      };
      for (let i = 0; i < nd.length - 1; i++) {
        const a = nd[i], b = nd[i + 1];
        if (!(isIn(a) && isIn(b))) { flush(); continue; }
        if (!chain) chain = [a];
        chain.push(b);
        if (use.get(b) !== 2) flush();   // intersection or dead end -> close this street piece
      }
      flush();
    }
    return { edges, nodePos };
  }

  // ---------- Custom paths: snapping + splitting ----------

  const M_PER_DEG = 111320;
  function nearestOnSegment(p, s0, s1) {
    const k = Math.cos(p.lat * Math.PI / 180) * M_PER_DEG;
    const ax = s0.lng * k, ay = s0.lat * M_PER_DEG;
    const bx = s1.lng * k, by = s1.lat * M_PER_DEG;
    const px = p.lng * k, py = p.lat * M_PER_DEG;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    return { t, dist: Math.hypot(px - qx, py - qy), point: { lat: qy / M_PER_DEG, lng: qx / k } };
  }

  /** Nearest spot on the street network within maxM metres: {edge, segIndex, t, point, dist} or null. */
  function nearestGraphPoint(edges, p, maxM) {
    const dLat = maxM / M_PER_DEG * 1.5;
    const dLng = dLat / Math.max(0.2, Math.cos(p.lat * Math.PI / 180));
    let best = null;
    for (const e of edges) {
      const c = e.coords;
      for (let i = 0; i < c.length - 1; i++) {
        const s0 = c[i], s1 = c[i + 1];
        // cheap bbox reject
        if (Math.max(s0.lat, s1.lat) < p.lat - dLat || Math.min(s0.lat, s1.lat) > p.lat + dLat) continue;
        if (Math.max(s0.lng, s1.lng) < p.lng - dLng || Math.min(s0.lng, s1.lng) > p.lng + dLng) continue;
        const r = nearestOnSegment(p, s0, s1);
        if (r.dist <= maxM && (!best || r.dist < best.dist)) best = { edge: e, segIndex: i, t: r.t, point: r.point, dist: r.dist };
      }
    }
    return best;
  }

  function newCustomNode(g, p) {
    const id = 'c' + (++customNodeSeq);
    g.nodePos.set(id, { lat: p.lat, lng: p.lng });
    return id;
  }

  /** Split an edge at vertex `index` (0 < index < last). Returns the node id at the split. */
  function splitEdge(g, edge, index) {
    const mid = edge.nodeIds[index];
    const mk = (nodeIds, coords) => {
      const e = Object.assign({}, edge, {
        id: nextEdgeId(), a: nodeIds[0], b: nodeIds[nodeIds.length - 1], nodeIds, coords,
        len: RAA.graph.pathLength(coords),
      });
      e.key = `${edge.wayId}:${e.a}:${e.b}`;
      e.origKey = edge.origKey || edge.key;   // lets exclusions of the unsplit street carry over
      return e;
    };
    const e1 = mk(edge.nodeIds.slice(0, index + 1), edge.coords.slice(0, index + 1));
    const e2 = mk(edge.nodeIds.slice(index), edge.coords.slice(index));
    const i = g.edges.indexOf(edge);
    g.edges.splice(i, 1, e1, e2);
    return mid;
  }

  /** Snap a point onto the network (splitting streets if needed) or create a free-standing node. */
  function snapOrCreate(g, p, maxM) {
    const hit = nearestGraphPoint(g.edges, p, maxM);
    if (!hit) return newCustomNode(g, p);
    const { edge, segIndex, t } = hit;
    let vertex;
    if (t < 0.02) vertex = segIndex;
    else if (t > 0.98) vertex = segIndex + 1;
    else {
      // insert a brand new vertex in the middle of the segment
      const id = newCustomNode(g, hit.point);
      edge.nodeIds.splice(segIndex + 1, 0, id);
      edge.coords.splice(segIndex + 1, 0, g.nodePos.get(id));
      vertex = segIndex + 1;
    }
    if (vertex === 0) return edge.a;
    if (vertex === edge.nodeIds.length - 1) return edge.b;
    return splitEdge(g, edge, vertex);
  }

  /** Add a user-drawn path { id, latlngs[] } to the graph. Endpoints snap within snapM metres. */
  function addCustomPath(g, cp, snapM) {
    const pts = cp.latlngs;
    if (!pts || pts.length < 2) return null;
    const a = snapOrCreate(g, pts[0], snapM);
    const b = snapOrCreate(g, pts[pts.length - 1], snapM);
    if (a === b && pts.length === 2) return null;   // both ends snapped to one node: zero-length loop
    const nodeIds = [a];
    for (let i = 1; i < pts.length - 1; i++) nodeIds.push(newCustomNode(g, pts[i]));
    nodeIds.push(b);
    const coords = nodeIds.map(id => g.nodePos.get(id));
    const e = {
      id: nextEdgeId(), a, b, nodeIds, coords, len: RAA.graph.pathLength(coords),
      name: cp.name || 'My path', hw: 'custom', wayId: 'custom', key: 'custom:' + cp.id,
      excluded: false, deadEnd: false, isolated: false, custom: true, customId: cp.id,
    };
    g.edges.push(e);
    return e;
  }

  RAA.osm = { fetchStreets, buildGraph, addCustomPath, nearestGraphPoint, pointInPolygon };
})(window.RAA);
