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

  /** Keep only the largest connected piece (by length). Sets e.isolated on the rest. */
  function markComponents(edges, includeDeadEnds) {
    const parent = new Map();
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (x, y) => { x = find(x); y = find(y); if (x !== y) parent.set(x, y); };
    const active = edges.filter(e => isActive(e, includeDeadEnds));
    for (const e of active) { if (!parent.has(e.a)) parent.set(e.a, e.a); if (!parent.has(e.b)) parent.set(e.b, e.b); union(e.a, e.b); }
    const lenByRoot = new Map();
    for (const e of active) { const r = find(e.a); lenByRoot.set(r, (lenByRoot.get(r) || 0) + e.len); }
    let best = null, bestLen = -1;
    for (const [r, l] of lenByRoot) if (l > bestLen) { best = r; bestLen = l; }
    let dropped = 0;
    for (const e of edges) {
      e.isolated = false;
      if (isActive(e, includeDeadEnds) && find(e.a) !== best) { e.isolated = true; dropped += e.len; }
    }
    return { components: lenByRoot.size, largestLen: Math.max(0, bestLen), droppedLen: dropped };
  }

  function buildAdjacency(E) {
    const adj = new Map();
    const add = (n, x) => { if (!adj.has(n)) adj.set(n, []); adj.get(n).push(x); };
    for (const e of E) { add(e.a, { e, to: e.b }); if (e.a !== e.b) add(e.b, { e, to: e.a }); }
    return adj;
  }

  function dijkstra(adj, source, targets) {
    const dist = new Map([[source, 0]]);
    const prev = new Map();
    const heap = new MinHeap(); heap.push(0, source);
    const done = new Set();
    let remaining = targets ? targets.size : Infinity;
    while (heap.size) {
      const [d, u] = heap.pop();
      if (done.has(u)) continue;
      done.add(u);
      if (targets && targets.has(u) && --remaining === 0) break;
      for (const { e, to } of adj.get(u) || []) {
        const nd = d + e.len;
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

  RAA.graph = { haversine, pathLength, markDeadEnds, markComponents, solve, routeCoords, nearestNode, isActive };
})(window.RAA);
