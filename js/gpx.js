/* Run All Around – GPX / TCX export for Garmin Connect courses.
 * Garmin's importer is picky about third-party files: every point gets a timestamp
 * (derived from your pace) and, when available, an elevation from Open-Meteo.
 */
window.RAA = window.RAA || {};
(function (RAA) {
  'use strict';

  const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

  /** Per-point cumulative distance (m) and timestamp (ISO) from a pace in s/km. */
  function timeline(coords, paceSec, startTime) {
    const t0 = startTime ? startTime.getTime() : Date.now();
    const secPerM = (paceSec || 330) / 1000;
    let dist = 0;
    return coords.map((p, i) => {
      if (i) dist += RAA.graph.haversine(coords[i - 1], p);
      return { dist, time: new Date(t0 + dist * secPerM * 1000).toISOString() };
    });
  }

  /** Elevation for each point via Open-Meteo (free, no key). Resolves to null on failure. */
  async function fetchElevations(coords, onStatus) {
    const out = new Array(coords.length);
    const BATCH = 100;
    try {
      for (let i = 0; i < coords.length; i += BATCH) {
        onStatus && onStatus(`Fetching elevation… ${Math.min(100, Math.round(100 * i / coords.length))}%`);
        const chunk = coords.slice(i, i + BATCH);
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map(p => p.lat.toFixed(6)).join(',')}&longitude=${chunk.map(p => p.lng.toFixed(6)).join(',')}`;
        let res, attempt = 0;
        const waits = [5000, 15000, 30000, 65000];                 // the free tier has a per-minute quota
        for (;;) {
          res = await fetch(url);
          if (res.status !== 429 || attempt >= waits.length) break;
          onStatus && onStatus(`Elevation service busy, retrying in ${waits[attempt] / 1000}s… (${Math.round(100 * i / coords.length)}% done)`);
          await new Promise(r => setTimeout(r, waits[attempt++]));
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        await new Promise(r => setTimeout(r, 120));
        if (!json.elevation || json.elevation.length !== chunk.length) throw new Error('bad elevation answer');
        json.elevation.forEach((e, j) => { out[i + j] = e; });
      }
      return out;
    } catch (err) {
      console.warn('Elevation lookup failed', err);
      return null;
    }
  }

  function buildGpx(coords, name, desc, opts) {
    opts = opts || {};
    const tl = timeline(coords, opts.paceSec, opts.startTime);
    const eles = opts.elevations;
    const pts = coords.map((p, i) => {
      const ele = eles && Number.isFinite(eles[i]) ? `<ele>${eles[i].toFixed(1)}</ele>` : '';
      return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">${ele}<time>${tl[i].time}</time></trkpt>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Run All Around" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${esc(name)}</name>
    <desc>${esc(desc || '')}</desc>
    <time>${tl[0].time}</time>
  </metadata>
  <trk>
    <name>${esc(name)}</name>
    <type>running</type>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
  }

  /** TCX "Course" file: Garmin's native course format. */
  function buildTcx(coords, name, opts) {
    opts = opts || {};
    const tl = timeline(coords, opts.paceSec, opts.startTime);
    const eles = opts.elevations;
    const last = tl[tl.length - 1];
    const secPerM = (opts.paceSec || 330) / 1000;
    const pos = p => `<Position><LatitudeDegrees>${p.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${p.lng.toFixed(7)}</LongitudeDegrees></Position>`;
    const pts = coords.map((p, i) => {
      const alt = eles && Number.isFinite(eles[i]) ? `<AltitudeMeters>${eles[i].toFixed(1)}</AltitudeMeters>` : '';
      return `        <Trackpoint><Time>${tl[i].time}</Time>${pos(p)}${alt}<DistanceMeters>${tl[i].dist.toFixed(1)}</DistanceMeters></Trackpoint>`;
    }).join('\n');
    const shortName = esc(name.slice(0, 15));
    return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Courses>
    <Course>
      <Name>${shortName}</Name>
      <Lap>
        <TotalTimeSeconds>${(last.dist * secPerM).toFixed(0)}</TotalTimeSeconds>
        <DistanceMeters>${last.dist.toFixed(1)}</DistanceMeters>
        <BeginPosition><LatitudeDegrees>${coords[0].lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${coords[0].lng.toFixed(7)}</LongitudeDegrees></BeginPosition>
        <EndPosition><LatitudeDegrees>${coords[coords.length - 1].lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${coords[coords.length - 1].lng.toFixed(7)}</LongitudeDegrees></EndPosition>
        <Intensity>Active</Intensity>
      </Lap>
      <Track>
${pts}
      </Track>
    </Course>
  </Courses>
</TrainingCenterDatabase>
`;
  }

  function download(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  RAA.gpx = { build: buildGpx, buildTcx, fetchElevations, timeline, download };
})(window.RAA);
