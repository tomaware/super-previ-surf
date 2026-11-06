// Test de bout en bout du collecteur (sans réseau) : fausses réponses Open-Meteo au format réel,
// faux copernicus.json et faux historique de bouées → data/forecast.json valide.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('../engine/surf-engine.js');
const SP = require('../engine/spots.json');

const ROOT = path.resolve(__dirname, '..');

function fakeMarine(points, now) {
  const t0 = Math.floor(now / 3600e3) * 3600e3 - 72 * 3600e3;
  const time = Array.from({ length: 24 * 11 }, (_, i) => new Date(t0 + i * 3600e3).toISOString().slice(0, 16));
  return points.map((p, k) => {
    const h = { time };
    E.OM_WAVE_MODELS.forEach((m, j) => {
      const base = (i) => 0.6 + 0.8 * Math.max(0, Math.sin(i / 20 + k / 3 + j / 10));
      h['wave_height_' + m] = time.map((_, i) => +base(i).toFixed(2));
      h['wave_period_' + m] = time.map(() => 5.8);
      h['wave_peak_period_' + m] = time.map(() => 7);
      h['wave_direction_' + m] = time.map(() => 120);
      h['swell_wave_height_' + m] = time.map((_, i) => +(base(i) * 0.9).toFixed(2));
      h['swell_wave_peak_period_' + m] = time.map(() => 7.5);
      h['swell_wave_direction_' + m] = time.map(() => 125);
      h['wind_wave_height_' + m] = time.map((_, i) => +(base(i) * 0.4).toFixed(2));
      h['wind_wave_peak_period_' + m] = time.map(() => 4);
      h['wind_wave_direction_' + m] = time.map(() => 110);
    });
    // GFS masqué à Canet comme observé le 05/11/2026
    if (p.id === 'canet') h.wave_height_ncep_gfswave025 = time.map(() => 0);
    return { latitude: p.lat, longitude: p.lon, hourly: h };
  });
}
function fakeWind(spots, now) {
  const t0 = Math.floor(now / 3600e3) * 3600e3 - 72 * 3600e3;
  const time = Array.from({ length: 24 * 11 }, (_, i) => new Date(t0 + i * 3600e3).toISOString().slice(0, 16));
  return spots.map(() => {
    const h = { time };
    ['meteofrance_seamless', 'ecmwf_ifs025'].forEach((m) => {
      h['wind_speed_10m_' + m] = time.map((_, i) => (i % 48 < 24 ? 25 : 10));
      h['wind_direction_10m_' + m] = time.map((_, i) => (i % 48 < 24 ? 140 : 320));
      h['wind_gusts_10m_' + m] = time.map((_, i) => (i % 48 < 24 ? 35 : 15));
    });
    return { hourly: h };
  });
}

test('collector/build.js produit un forecast.json complet et cohérent', () => {
  const now = Date.UTC(2026, 10, 6, 9);
  const pts = E.queryPoints(SP.spots, SP.buoys);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-'));
  const fixture = path.join(tmp, 'fx.json');
  fs.writeFileSync(fixture, JSON.stringify({ now, marine: fakeMarine(pts, now), wind: fakeWind(SP.spots, now) }));
  // sauvegarde des données réelles éventuelles
  const files = ['forecast.json', 'history/forecasts.json'].map((f) => path.join(ROOT, 'data', f));
  const backup = files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null));
  try {
    execFileSync('node', [path.join(ROOT, 'collector/build.js'), '--offline', fixture], { stdio: 'pipe' });
    const out = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/forecast.json'), 'utf8'));
    assert.equal(out.spots.length, SP.spots.length);
    const canet = out.spots.find((s) => s.id === 'canet');
    assert.ok(canet.h.t.length > 150);
    const n = canet.h.t.length;
    ['score', 'hb', 'hs', 'tp', 'dir', 'ws', 'wd', 'day', 'conf'].forEach((k) => assert.equal(canet.h[k].length, n, k));
    assert.ok(canet.h.score.every((x) => x === null || (x >= 0 && x <= 10)));
    assert.ok(out.sources.rejected.canet && out.sources.rejected.canet.includes('ncep_gfswave025'), 'GFS masqué rejeté à Canet');
    assert.ok(Array.isArray(out.windows));
    const arch = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/history/forecasts.json'), 'utf8'));
    assert.ok(arch.length >= 1 && arch[arch.length - 1].buoys['03404']);
  } finally {
    files.forEach((f, i) => { if (backup[i]) fs.writeFileSync(f, backup[i]); else if (fs.existsSync(f)) fs.unlinkSync(f); });
  }
});
