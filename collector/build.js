#!/usr/bin/env node
/*
 * Calcule la prévision complète et écrit data/forecast.json (lu par l'app web et le widget).
 * Entrées : Open-Meteo (houle multi-modèles + vent AROME/ARPEGE/ECMWF), data/copernicus.json,
 * data/history/buoys.json. Archive aussi un extrait de chaque prévision pour la vérification
 * "vraie" à échéance (data/history/forecasts.json).
 *
 * Usage : node collector/build.js [--offline fixtures.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../engine/surf-engine.js');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const writeJSON = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); };

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'SuperPreviSurf/1.0 (usage personnel)' } });
      const j = await r.json();
      if (j && j.error) throw new Error(j.reason || 'erreur API');
      return j;
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
    }
  }
}

async function main() {
  const spotsDoc = readJSON(path.join(ROOT, 'engine', 'spots.json'));
  const cfgOverride = readJSON(path.join(ROOT, 'engine', 'config.json'), {});
  const cfg = E.mergeCfg(E.DEFAULT_CONFIG, cfgOverride);
  const pts = E.queryPoints(spotsDoc.spots, spotsDoc.buoys, cfg);
  const sources = { openMeteo: {}, copernicus: null, candhis: {} };

  const offline = process.argv.includes('--offline') ? readJSON(process.argv[process.argv.indexOf('--offline') + 1]) : null;
  let marineJ, windJ;
  if (offline) { marineJ = offline.marine; windJ = offline.wind; }
  else {
    marineJ = await getJSON(E.openMeteoMarineURL(pts, { pastDays: 3, forecastDays: 8 }));
    windJ = await getJSON(E.openMeteoWindURL(spotsDoc.spots, { pastDays: 3, forecastDays: 8 }));
  }
  const om = E.parseOpenMeteoMarine(marineJ, pts.map((p) => p.id));
  sources.openMeteo.waveModels = [...new Set(Object.values(om).flatMap((p) => Object.keys(p.models)))];
  const wind = E.parseOpenMeteoWind(windJ, spotsDoc.spots.map((s) => s.id));

  const cop = readJSON(path.join(DATA, 'copernicus.json'), null);
  let copParsed = null;
  if (cop && cop.points) {
    const age = (Date.now() - Date.parse(cop.generated)) / 3600e3;
    if (age < 30) { copParsed = E.parseCopernicus(cop); sources.copernicus = { generated: cop.generated, points: Object.keys(cop.points).length }; }
    else sources.copernicus = { stale: true, generated: cop.generated };
  }
  const marine = E.mergeMarine(om, copParsed);

  const hist = readJSON(path.join(DATA, 'history', 'buoys.json'), {});
  const buoyObs = {};
  Object.keys(hist).forEach((c) => {
    buoyObs[c] = hist[c].filter((o) => o.hs != null);
    const last = buoyObs[c].length ? buoyObs[c][buoyObs[c].length - 1].t : null;
    sources.candhis[c] = last ? { last, n: buoyObs[c].length } : { n: 0 };
  });

  const now = offline && offline.now ? offline.now : Date.now();
  const res = E.run({ spots: spotsDoc.spots, buoys: spotsDoc.buoys, marine, wind, buoyObs, now, cfg: cfgOverride, days: 7 });
  const rejected = {};
  Object.keys(marine).forEach((pid) => { if (marine[pid].rejected && marine[pid].rejected.length) rejected[pid] = marine[pid].rejected; });
  sources.rejected = rejected;
  const out = E.toForecastJSON(res, { sources });
  writeJSON(path.join(DATA, 'forecast.json'), out);

  // archive pour la vérification à échéance : Hs de chaque modèle aux bouées à +0/+6/+12/+24/+48/+72 h
  const archPath = path.join(DATA, 'history', 'forecasts.json');
  const arch = readJSON(archPath, []);
  const leads = [0, 6, 12, 24, 48, 72];
  const snap = { run: Math.floor(now / 3600e3) * 3600e3, buoys: {} };
  spotsDoc.buoys.forEach((b) => {
    const pd = marine['buoy_' + b.code]; if (!pd) return;
    snap.buoys[b.code] = {};
    leads.forEach((L) => {
      E.modelsAt(pd, snap.run + L * 3600e3, res.cfg).forEach((m) => {
        (snap.buoys[b.code][m.name] = snap.buoys[b.code][m.name] || {})[L] = Math.round(m.state.hs * 100) / 100;
      });
    });
  });
  const keep = arch.filter((a) => a.run !== snap.run && a.run > now - 30 * 86400e3);
  keep.push(snap);
  writeJSON(archPath, keep);

  const top = out.windows.slice(0, 3).map((w) => `${w.spot} ${new Date(w.start).toISOString().slice(5, 13)}Z ${w.mean}`).join(' | ');
  console.log(`[build] ${out.spots.length} spots, modèles houle: ${sources.openMeteo.waveModels.join(',')}${copParsed ? ',copernicus' : ''}; meilleurs créneaux: ${top || 'aucun'}`);
}

main().catch((e) => { console.error('[build] échec :', e); process.exit(1); });
