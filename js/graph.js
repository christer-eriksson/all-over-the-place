/* Run All Around – graph algorithms
 * Dead-end pruning, connected components and the Chinese Postman Problem
 * (a.k.a. Route Inspection Problem): shortest closed walk covering every edge.
 *
 *   1. find odd-degree intersections
 *   2. shortest paths between them (Dijkstra)
 *   3. pair them up as cheaply as possible (greedy + 2-opt improvement)
 *   4. duplicate the streets along those pairings -> every node has even degree
 *   5. Hierholzer's algorithm -> Euler circuit
 */
window.RAA = window.RAA || {};
(function (RAA) {
  'use strict';

  const R = 6371000;
  const toRad = d => d * Math.PI / 180;

  function haversine(p, q) {
    const dLat = toRad(q.lat - p.lat), dLng = toRad(q.lng - p.lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(p.lat)) * Math.cos(toRad(q.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function pathLength(coords) {
    let s = 0;
    for (let i = 1; i < coords.length; i++) s += haversine(coords[i - 1], coords[i]);
    return s;
  }

  class MinHeap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(k, v) {
      const a = this.a; a.push([k, v]);
      let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
    }
    pop() {
      const a = this.a; const top = a[0]; const last = a.pop();
      if (a.length) {
        a[0] = last; let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]]; i = m;
        }
      }
      return top;
    }
  }

  const isActive = (e, includeDeadEnds) => !e.excluded && (includeDeadEnds || !e.deadEnd);

  /** Iteratively peel off streets that end in a cul-de-sac. Sets e.deadEnd. */
  function markDeadEnds(edges) {
    for (const e of edges) e.deadEnd = false;
    const live = edges.filter(e => !e.excluded);
    const deg = new Map(), adj = new Map();
    const add = (n, e) => { deg.set(n, (deg.get(n) || 0) + 1); if (!adj.has(n)) adj.set(n, []); adj.get(n).push(e); };
    for (const e of live) { add(e.a, e); add(e.b, e); }
    const removed = new Set();
    const queue = [...deg.keys()].filter(n => deg.get(n) === 1);
    while (queue.length) {
      const n = queue.pop();
      if (deg.get(n) !== 1) continue;
      const e = adj.get(n).find(x => !removed.has(x));
      if (!e) continue;
      removed.add(e); e.deadEnd = true;
      deg.set(e.a, deg.get(e.a) - 1); deg.set(e.b, deg.get(e.b) - 1);
      const o = e.a === n ? e.b : e.a;
      if (deg.get(o) === 1) queue.push(o);
    }
  }

  /** Largest connected piece (by length) of the given edges. Returns {find, best, lenByRoot}. */
  function components(list, joins) {
    const parent = new Map();
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const touch = x => { if (!parent.has(x)) parent.set(x, x); };
    const union = (x, y) => { touch(x); touch(y); x = find(x); y = find(y); if (x !== y) parent.set(x, y); };
    for (const e of list) union(e.a, e.b);
    for (const [x, y] of joins || []) if (parent.has(x) && parent.has(y)) union(x, y);
    const lenByRoot = new Map();
    for (const e of list) { const r = find(e.a); lenByRoot.set(r, (lenByRoot.get(r) || 0) + e.len); }
    let best = null, bestLen = -1;
    for (const [r, l] of lenByRoot) if (l > bestLen) { best = r; bestLen = l; }
    return { find, best, bestLen: Math.max(0, bestLen), lenByRoot };
  }

  /**
   * Keep only the largest connected piece (by length). Sets e.isolated on the rest.
   * Pieces that are only disconnected because of the user's blocks or barriers are
   * flagged e.cutOff as well: they are dropped on purpose, not a data problem.
   * `joins` are node pairs a barrier split apart (treated as connected for that test).
   */
  function markComponents(edges, includeDeadEnds, joins) {
    const active = edges.filter(e => isActive(e, includeDeadEnds));
    const now = components(active);
    // the network as it would be without any blocks or barriers
    const natural = components(edges.filter(e => includeDeadEnds || !e.deadEnd), joins);
    let dropped = 0, cutLen = 0;
    const brokenRoots = new Set();
    for (const e of edges) {
      e.isolated = false; e.cutOff = false;
      if (!isActive(e, includeDeadEnds) || now.find(e.a) === now.best) continue;
      e.isolated = true;
      if (natural.find(e.a) === natural.best) { e.cutOff = true; cutLen += e.len; }
      else { dropped += e.len; brokenRoots.add(now.find(e.a)); }
    }
    return { components: brokenRoots.size + 1, largestLen: now.bestLen, droppedLen: dropped, cutLen };
  }

  const AVOID_FACTOR = 12;   // an avoided street must be this much shorter than any detour before it is repeated
  const cost = e => e.avoid ? e.len * AVOID_FACTOR : e.len;

  function buildAdjacency(E) {
    const adj = new Map();
    const add = (n, x) => { if (!adj.has(n)) adj.set(n, []); adj.get(n).push(x); };
    for (const e of E) { add(e.a, { e, to: e.b }); if (e.a !== e.b) add(e.b, { e, to: e.a }); }
    return adj;
  }

  function dijkstra(adj, source, targets, weight = cost) {
    const sources = Array.isArray(source) ? source : [source];
    const dist = new Map(sources.map(s => [s, 0]));
    const prev = new Map();
    const heap = new MinHeap(); for (const s of sources) heap.push(0, s);
    const done = new Set();
    let remaining = targets ? targets.size : Infinity;
    while (heap.size) {
      const [d, u] = heap.pop();
      if (done.has(u)) continue;
      done.add(u);
      if (targets && targets.has(u) && --remaining === 0) break;
      for (const { e, to } of adj.get(u) || []) {
        const nd = d + weight(e);
        if (nd < (dist.has(to) ? dist.get(to) : Infinity)) { dist.set(to, nd); prev.set(to, { node: u, edge: e }); heap.push(nd, to); }
      }
    }
    return { dist, prev };
  }

  /** Approximate minimum-weight perfect matching: greedy, then pair-swap (2-opt) until stable. */
  function matchOdd(odd, D) {
    const n = odd.length;
    const cand = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const d = D(odd[i], odd[j]); if (isFinite(d)) cand.push([d, i, j]); }
    cand.sort((x, y) => x[0] - y[0]);
    const matched = new Array(n).fill(false);
    const pairs = [];
    for (const [, i, j] of cand) if (!matched[i] && !matched[j]) { matched[i] = matched[j] = true; pairs.push([i, j]); }
    let improved = true, guard = 0;
    while (improved && guard++ < 100) {
      improved = false;
      for (let x = 0; x < pairs.length; x++) for (let y = x + 1; y < pairs.length; y++) {
        const [a, b] = pairs[x], [c, d] = pairs[y];
        const cur = D(odd[a], odd[b]) + D(odd[c], odd[d]);
        const alt1 = D(odd[a], odd[c]) + D(odd[b], odd[d]);
        const alt2 = D(odd[a], odd[d]) + D(odd[b], odd[c]);
        if (alt1 < cur - 1e-6 && alt1 <= alt2) { pairs[x] = [a, c]; pairs[y] = [b, d]; improved = true; }
        else if (alt2 < cur - 1e-6) { pairs[x] = [a, d]; pairs[y] = [b, c]; improved = true; }
      }
    }
    return pairs.map(([i, j]) => [odd[i], odd[j]]);
  }

  /** Hierholzer. instances: [{e, dup}]. Returns [{e, dup, forward}] in walking order. */
  function euler(instances, start) {
    const adj = new Map();
    const add = (n, x) => { if (!adj.has(n)) adj.set(n, []); adj.get(n).push(x); };
    for (const inst of instances) {
      inst.used = false;
      add(inst.e.a, { inst, to: inst.e.b });
      if (inst.e.a !== inst.e.b) add(inst.e.b, { inst, to: inst.e.a });
    }
    const ptr = new Map();
    const stack = [{ node: start, via: null }];
    const out = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = adj.get(top.node) || [];
      let i = ptr.get(top.node) || 0;
      while (i < list.length && list[i].inst.used) i++;
      ptr.set(top.node, i);
      if (i < list.length) {
        const h = list[i]; h.inst.used = true;
        stack.push({ node: h.to, via: { inst: h.inst, from: top.node } });
      } else {
        out.push(stack.pop());
      }
    }
    out.reverse();
    return out.slice(1).map(x => ({ e: x.via.inst.e, dup: x.via.inst.dup, forward: x.via.from === x.via.inst.e.a }));
  }

  /** Solve the Chinese Postman Problem on the active, connected part of the graph. */
  function solve(edges, includeDeadEnds, startNode) {
    const E = edges.filter(e => isActive(e, includeDeadEnds) && !e.isolated);
    if (!E.length) throw new Error('No streets left to route.');
    const adj = buildAdjacency(E);
    const deg = new Map();
    for (const e of E) { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); }
    const odd = [...deg].filter(([, d]) => d % 2 === 1).map(([n]) => n);
    const oddSet = new Set(odd);
    const sp = new Map();
    for (const s of odd) sp.set(s, dijkstra(adj, s, oddSet));
    const D = (u, v) => { const r = sp.get(u).dist.get(v); return r === undefined ? Infinity : r; };
    const pairs = matchOdd(odd, D);

    const instances = E.map(e => ({ e, dup: false }));
    let extra = 0;
    for (const [u, v] of pairs) {
      const prev = sp.get(u).prev;
      let cur = v;
      while (cur !== u) {
        const p = prev.get(cur);
        if (!p) break;
        instances.push({ e: p.edge, dup: true });
        extra += p.edge.len;
        cur = p.node;
      }
    }
    let start = startNode;
    if (start == null || !deg.has(start)) start = E[0].a;
    const sequence = euler(instances, start);
    if (sequence.length !== instances.length) console.warn('Euler circuit incomplete', sequence.length, instances.length);
    const streetLength = E.reduce((s, e) => s + e.len, 0);
    return { sequence, streetLength, routeLength: streetLength + extra, extra, oddCount: odd.length, edgeCount: E.length, start };
  }

  // ---------- Longest loop without repeats ----------
  const GAIN_RATIO = 4;       // a repeated connector must open up at least this many times its length in new streets
  const MAX_REPEAT = 600;     // ...and repeat at most this many metres
  const MIN_PIECE = 150;      // pieces shorter than this are not worth a detour

  /**
   * Find a long closed loop that runs each street at most once. Every corner on a loop
   * needs an even number of streets, so the cheapest set of streets to leave out is
   * found the same way the postman route finds what to repeat (pairing odd corners
   * along shortest paths), except those streets are dropped instead of run twice.
   * That can split the network; pieces left behind are joined back with a connector
   * run out and back, but only when the connector is short and the piece is big.
   */
  function solveLoop(edges, includeDeadEnds, startNode, nodePos) {
    const E = edges.filter(e => isActive(e, includeDeadEnds) && !e.isolated);
    if (!E.length) throw new Error('No streets left to route.');
    const adj = buildAdjacency(E);
    const deg = new Map();
    for (const e of E) { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); }
    const odd = [...deg].filter(([, d]) => d % 2 === 1).map(([n]) => n);
    const oddSet = new Set(odd);

    // 1. Streets to drop: an odd-corner pairing along the cheapest-to-lose paths (avoided streets are cheap to lose).
    const lose = e => e.avoid ? e.len * 0.25 : e.len;
    const sp = new Map();
    for (const o of odd) sp.set(o, dijkstra(adj, o, oddSet, lose));
    const D = (u, v) => { const r = sp.get(u).dist.get(v); return r === undefined ? Infinity : r; };
    const dropped = new Set();
    for (const [u, v] of matchOdd(odd, D)) {
      const prev = sp.get(u).prev;
      for (let cur = v; cur !== u;) {
        const p = prev.get(cur);
        if (!p) break;
        if (dropped.has(p.edge)) dropped.delete(p.edge); else dropped.add(p.edge);   // paths that overlap cancel out
        cur = p.node;
      }
    }

    // 2. What's left has only even corners, but may be in pieces.
    const kept = E.filter(e => !dropped.has(e));
    const { find, lenByRoot } = components(kept);
    const pieceEdges = new Map();
    for (const e of kept) { const r = find(e.a); if (!pieceEdges.has(r)) pieceEdges.set(r, []); pieceEdges.get(r).push(e); }
    let seed = null;
    if (startNode != null && kept.some(e => e.a === startNode || e.b === startNode)) seed = find(startNode);
    if (seed == null) seed = [...lenByRoot].sort((x, y) => y[1] - x[1])[0][0];

    const onLoop = new Set(pieceEdges.get(seed));
    const loopNodes = new Set();
    for (const e of onLoop) { loopNodes.add(e.a); loopNodes.add(e.b); }
    const instances = [...onLoop].map(e => ({ e, dup: false }));
    let extra = 0;
    const waiting = new Map([...pieceEdges].filter(([r]) => r !== seed));
    const returnLeg = new Map();  // edge -> the 'back again' instance of a connector over a new street

    // 3. Join big pieces back with short out-and-back connectors, best deal first.
    for (;;) {
      // running a street already on the loop twice more repeats it twice; a new street once
      const w = e => (onLoop.has(e) ? 2 : 1) * cost(e);
      const { dist, prev } = dijkstra(adj, [...loopNodes], null, w);
      let best = null;
      for (const [r, list] of waiting) {
        const gain = lenByRoot.get(r);
        if (gain < MIN_PIECE) continue;
        let at = null, d = Infinity;
        for (const e of list) for (const n of [e.a, e.b]) { const x = dist.get(n); if (x !== undefined && x < d) { d = x; at = n; } }
        if (at == null || d > MAX_REPEAT || gain < GAIN_RATIO * d) continue;
        if (!best || gain / d > best.gain / best.d) best = { r, at, d, gain };
      }
      if (!best) break;
      for (let cur = best.at; !loopNodes.has(cur);) {
        const p = prev.get(cur);
        if (onLoop.has(p.edge)) { instances.push({ e: p.edge, dup: true }, { e: p.edge, dup: true }); extra += 2 * p.edge.len; }
        else {
          const back = { e: p.edge, dup: true };
          instances.push({ e: p.edge, dup: false }, back);
          returnLeg.set(p.edge, back);
          extra += p.edge.len; onLoop.add(p.edge);
        }
        loopNodes.add(cur);
        cur = p.node;
      }
      for (const e of waiting.get(best.r)) {
        if (returnLeg.has(e)) {
          // an earlier connector ran this street out and back; as part of the piece it is run once, so drop the way back
          instances.splice(instances.indexOf(returnLeg.get(e)), 1);
          returnLeg.delete(e); extra -= e.len;
          continue;
        }
        onLoop.add(e); instances.push({ e, dup: false });
        loopNodes.add(e.a); loopNodes.add(e.b);
      }
      waiting.delete(best.r);
    }

    let start = startNode;
    if (start == null || !loopNodes.has(start)) {
      const p = start != null && nodePos.get(start);
      start = [...loopNodes][0];
      if (p) { let bd = Infinity; for (const n of loopNodes) { const d = haversine(nodePos.get(n), p); if (d < bd) { bd = d; start = n; } } }
    }
    const sequence = euler(instances, start);
    if (sequence.length !== instances.length) console.warn('Euler circuit incomplete', sequence.length, instances.length);
    const streetLength = [...onLoop].reduce((s, e) => s + e.len, 0);
    const total = E.reduce((s, e) => s + e.len, 0);
    return {
      sequence, streetLength, routeLength: streetLength + extra, extra, skipped: total - streetLength,
      skippedEdges: E.filter(e => !onLoop.has(e)), oddCount: odd.length, edgeCount: onLoop.size, start, mode: 'loop',
    };
  }

  function routeCoords(sequence) {
    const out = [];
    for (const s of sequence) {
      const c = s.forward ? s.e.coords : [...s.e.coords].reverse();
      for (const p of c) {
        const last = out[out.length - 1];
        if (last && last.lat === p.lat && last.lng === p.lng) continue;
        out.push(p);
      }
    }
    return out;
  }

  /** Nearest graph node (by id) to a point among the active edges. */
  function nearestNode(edges, nodePos, p, includeDeadEnds) {
    let best = null, bd = Infinity;
    for (const e of edges) {
      if (!isActive(e, includeDeadEnds) || e.isolated) continue;
      for (const id of [e.a, e.b]) {
        const d = haversine(nodePos.get(id), p);
        if (d < bd) { bd = d; best = id; }
      }
    }
    return best;
  }

  RAA.graph = { haversine, pathLength, markDeadEnds, markComponents, solve, solveLoop, routeCoords, nearestNode, isActive };
})(window.RAA);
