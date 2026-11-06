// Harnais de test sur données réelles — exécuté dans un navigateur (page Candhis, qui autorise
// la lecture des bouées en même origine ; Open-Meteo autorise CORS).
// Usage : await liveRun(SurfEngine, SPOTS, { pastDays: 2 })
async function liveRun(E, SP, opts) {
  opts = opts || {};
  const cfg = E.mergeCfg(E.DEFAULT_CONFIG, opts.cfg || {});
  const pts = E.queryPoints(SP.spots, SP.buoys, cfg);
  const cache = (window.__surfCache = window.__surfCache || {});
  async function getJSON(url) {
    if (cache[url]) return cache[url];
    const r = await fetch(url); const j = await r.json();
    if (j && j.error) throw new Error(j.reason || 'erreur Open-Meteo');
    cache[url] = j; return j;
  }
  const mURL = E.openMeteoMarineURL(pts, { pastDays: opts.pastDays ?? 2, forecastDays: 8 });
  const marineJ = await getJSON(mURL);
  const marine = E.mergeMarine(E.parseOpenMeteoMarine(marineJ, pts.map((p) => p.id)));
  const wURL = E.openMeteoWindURL(SP.spots, { pastDays: 3, forecastDays: 8 });
  const windJ = await getJSON(wURL);
  const wind = E.parseOpenMeteoWind(windJ, SP.spots.map((s) => s.id));
  const buoyObs = {};
  for (const b of SP.buoys) {
    const key = 'candhis_' + b.code;
    if (!cache[key]) {
      const h = await (await fetch('/_public_/campagne.php?' + btoa('camp=' + b.code))).text();
      const doc = new DOMParser().parseFromString(h, 'text/html');
      cache[key] = [...doc.querySelectorAll('table tr')].map((r) => [...r.cells].map((c) => c.innerText.trim()))
        .filter((r) => r.length >= 6 && /\d\d\/\d\d\/\d{4}/.test(r[0]));
    }
    buoyObs[b.code] = E.parseCandhisRows(cache[key]).filter((o) => o.hs != null);
  }
  const now = opts.now || Date.now();
  // en mode "hindcast", on masque les mesures postérieures à now
  if (opts.now) Object.keys(buoyObs).forEach((k) => { buoyObs[k] = buoyObs[k].filter((o) => o.t <= now); });
  const res = E.run({ spots: SP.spots, buoys: SP.buoys, marine, wind, buoyObs, now, cfg: opts.cfg, days: 7 });
  window.__lastRun = res; window.__lastInput = { marine, wind, buoyObs: Object.fromEntries(Object.entries(buoyObs)) };
  return res;
}

// Résumé compact pour le rapport
function summarize(E, res, opts) {
  opts = opts || {};
  const fmtT = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit', hour: '2-digit' });
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  const verif = {};
  Object.entries(res.verification).forEach(([code, v]) => {
    verif[code] = Object.fromEntries(Object.entries(v).map(([m, s]) => [m, { n: s.n, mae: r2(s.mae), bias: r2(s.bias), dirMae: s.dirMae && Math.round(s.dirMae), tmBias: r2(s.tmBias) }]));
  });
  const spots = res.spots.map((s) => {
    const cur = s.rows.find((r) => !r.missing && r.t >= res.now - 1800e3);
    const daily = {};
    s.rows.filter((r) => !r.missing && r.day && r.leadH >= 0).forEach((r) => {
      const d = new Date(r.t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit' });
      if (!daily[d] || r.score > daily[d].score) daily[d] = { score: Math.round(r.score * 10) / 10, hb: r2(r.hb), h: fmtT(r.t) };
    });
    return {
      id: s.spot.id, ref: s.refBuoy, nowRatio: r2(s.nowRatio), nowObs: s.nowObs && { hs: r2(s.nowObs.hs), dir: s.nowObs.dir },
      now: cur && { score: r2(cur.score), hb: r2(cur.hb), hs: r2(cur.hsOff), tp: r2(cur.tp), dir: Math.round(cur.dir), conf: r2(cur.conf), n: cur.nModels, text: cur.text, f: Object.fromEntries(Object.entries(cur.factors).map(([k, v]) => [k, r2(v)])) },
      bestPerDay: daily,
      windows: s.windows.slice(0, opts.maxWin || 3).map((w) => ({ from: fmtT(w.start), to: fmtT(w.end), mean: r2(w.mean), peak: r2(w.peak.score), txt: w.peak.text }))
    };
  });
  return { now: fmtT(res.now), verif, spots, top: res.windows.slice(0, 6).map((w) => w.spot + ' ' + fmtT(w.start) + '→' + fmtT(w.end) + ' ' + r2(w.mean)) };
}
