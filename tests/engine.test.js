// Tests unitaires du moteur — lancer avec : node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine/surf-engine.js');
const SPOTS = require('../engine/spots.json');

const spot = (id) => SPOTS.spots.find((s) => s.id === id);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} attendu ${b} ±${eps}, obtenu ${a}`);

test('angles : norm360 / angDiff avec passage par 0', () => {
  assert.equal(E.norm360(-10), 350);
  assert.equal(E.norm360(370), 10);
  assert.equal(E.angDiff(350, 10), -20);
  assert.equal(E.angDiff(10, 350), 20);
  assert.equal(E.angDiff(180, 0), 180);
});

test('moyenne circulaire autour du nord', () => {
  near(E.norm360(E.circMean([350, 10])), 0, 1e-9, 'N');
  near(E.circMean([90, 90, 180], [1, 1, 0]), 90, 1e-9);
  assert.equal(E.circMean([null, undefined]), null);
});

test('fenêtres d\'arc, y compris à cheval sur le nord', () => {
  assert.ok(E.inArc(100, 75, 185));
  assert.ok(!E.inArc(200, 75, 185));
  assert.ok(E.inArc(10, 330, 30));
  assert.ok(E.inArc(340, 330, 30));
  assert.ok(!E.inArc(100, 330, 30));
  assert.equal(E.distToArc(200, 75, 185), 15);
  assert.equal(E.distToArc(320, 330, 30), 10);
});

test('point modèle : décalé vers le large', () => {
  const canet = spot('canet'); // fait face à l'est
  const p = E.modelPoint(canet);
  assert.ok(p.lon > canet.lon, 'Canet : le point modèle est à l\'est');
  near(p.lat, canet.lat, 0.001);
  const carnon = spot('carnon'); // fait face au SSE
  const q = E.modelPoint(carnon);
  assert.ok(q.lat < carnon.lat && q.lon > carnon.lon);
  // distance ≈ 3 km
  const dkm = Math.hypot((q.lat - carnon.lat) * 111.2, (q.lon - carnon.lon) * 111.2 * Math.cos(carnon.lat * Math.PI / 180));
  near(dkm, 3, 0.05);
});

test('Komar & Gaillard : ordre de grandeur et monotonie', () => {
  // 1 m / 7 s frontal → ≈ 1,34 m au déferlement
  near(E.breakingHeight(1, 7, 0), 1.344, 0.01);
  assert.ok(E.breakingHeight(1, 9, 0) > E.breakingHeight(1, 7, 0), 'plus de période = plus haut');
  assert.ok(E.breakingHeight(1, 7, 45) < E.breakingHeight(1, 7, 0), 'incidence oblique = plus petit');
  assert.equal(E.breakingHeight(1, 7, 95), 0, 'houle qui s\'éloigne de la plage');
  assert.equal(E.breakingHeight(0, 7, 0), 0);
});

test('facteur de fenêtre : 1 dedans, 0 loin, continu', () => {
  const g = spot('gruissan');
  assert.equal(E.windowFactor(130, g), 1);
  assert.equal(E.windowFactor(260, g), 0);
  const edge = E.windowFactor(185 + 12.5, g);
  near(edge, 0.5, 0.01);
});

test('hauteur surfable : houle SE à Gruissan > même houle à Canet ? (orientation)', () => {
  const h = { h: 1.2, t: 7, d: 140 };
  const gr = E.surfHeight([h], spot('gruissan')).hb;
  const ca = E.surfHeight([h], spot('canet')).hb;
  assert.ok(gr > ca, 'Gruissan (normale 110°) mieux exposé au SE que Canet (90°)');
  // houle de NO : rien nulle part
  assert.equal(E.surfHeight([{ h: 1.2, t: 7, d: 315 }], spot('carnon')).hb, 0);
});

test('vent : offshore léger parfait, onshore fort nul, side intermédiaire', () => {
  const pal = spot('palavas'); // normale 150 → offshore = 330 (NNO)
  const off = E.windQuality(15, 330, 22, pal);
  const on = E.windQuality(30, 150, 40, pal);
  const side = E.windQuality(15, 60, 20, pal);
  assert.equal(off.kind, 'offshore'); near(off.q, 1, 1e-9);
  assert.equal(on.kind, 'onshore'); assert.equal(on.q, 0);
  assert.equal(side.kind, 'side'); assert.ok(side.q > 0.3 && side.q < 0.8);
  // pétole : toujours propre
  assert.ok(E.windQuality(3, 150, 5, pal).q >= 0.95);
  // tramontane forte : offshore mais pénalisé
  assert.ok(E.windQuality(55, 315, 75, pal).q < 0.6);
});

test('vent : continuité de la courbe offshore→onshore', () => {
  const pal = spot('palavas');
  let prev = null;
  for (let a = 0; a <= 180; a += 5) {
    const q = E.windQuality(18, E.norm360(330 + a), 20, pal).q;
    if (prev != null) assert.ok(q <= prev + 1e-9, `non monotone à ${a}°`);
    prev = q;
  }
});

test('mélange des vents : moyenne vectorielle correcte autour du nord', () => {
  const b = E.blendWind({ meteofrance: { spd: 20, dir: 350, gust: 30 }, ecmwf: { spd: 20, dir: 10, gust: 30 } }, 6);
  near(E.norm360(b.dir + 180) - 180, 0, 6);
  near(b.spd, 20, 1e-9);
  const late = E.blendWind({ meteofrance: { spd: 10, dir: 90 }, ecmwf: { spd: 30, dir: 270 } }, 150);
  assert.equal(late.src, 'ECMWF');
});

test('période et taille', () => {
  assert.ok(E.periodFactor(4) < E.periodFactor(6));
  near(E.periodFactor(8), 1, 1e-9);
  const c = spot('carnon');
  assert.equal(E.sizeFactor(0.1, c), 0);
  near(E.sizeFactor(c.size.ideal, c), 1, 1e-9);
  assert.ok(E.sizeFactor(3, c) < 0.5, 'trop gros = pénalisé');
});

test('valueAt : interpolation, trous et angles', () => {
  const t0 = Date.UTC(2026, 10, 5, 0);
  const time = [t0, t0 + 3600e3, t0 + 7200e3];
  near(E.valueAt(time, [1, 2, null], t0 + 1800e3), 1.5, 1e-9);
  near(E.valueAt(time, [350, 10, 10], t0 + 1800e3, true), 0, 1e-9);
  assert.equal(E.valueAt(time, [1, 2, 3], t0 + 10 * 3600e3), null);
  assert.equal(E.valueAt(time, [1, null, 3], t0 + 3600e3), null);
});

test('parse Open-Meteo multi-localisation / multi-modèles', () => {
  const loc = (k) => ({ hourly: { time: ['2026-11-05T00:00', '2026-11-05T01:00'],
    wave_height_meteofrance_wave: [k, k], wave_period_meteofrance_wave: [6, 6], wave_direction_meteofrance_wave: [120, 120],
    swell_wave_height_meteofrance_wave: [k * 0.9, k * 0.9], swell_wave_peak_period_meteofrance_wave: [7, 7], swell_wave_direction_meteofrance_wave: [125, 125],
    wind_wave_height_meteofrance_wave: [k * 0.4, k * 0.4], wind_wave_peak_period_meteofrance_wave: [4, 4], wind_wave_direction_meteofrance_wave: [110, 110],
    wave_height_ewam: [null, null] } });
  const p = E.parseOpenMeteoMarine([loc(1), loc(2)], ['a', 'b']);
  assert.deepEqual(Object.keys(p), ['a', 'b']);
  assert.ok(p.a.models.meteofrance_wave);
  assert.ok(!p.a.models.ewam, 'modèle entièrement nul ignoré');
  assert.equal(p.a.time[0], Date.UTC(2026, 10, 5, 0));
  const st = E.seaStateAt(p.b.models.meteofrance_wave, p.b.time, p.b.time[0], { usePartitions: true });
  assert.equal(st.comps.length, 2);
  near(st.tp, 7.2, 1e-9, 'Tp estimé depuis Tm');
});

test('parse Copernicus', () => {
  const j = { points: { carnon: { time: ['2026-11-05T00:00:00Z'], VHM0: [1.5], VTPK: [7], VTM10: [6], VMDR: [150],
    VHM0_SW1: [1.2], VTM01_SW1: [6.5], VMDR_SW1: [155], VHM0_WW: [0.8], VTM01_WW: [4], VMDR_WW: [140] } } };
  const p = E.parseCopernicus(j);
  const st = E.seaStateAt(p.carnon.models.copernicus, p.carnon.time, p.carnon.time[0], { usePartitions: true });
  assert.equal(st.hs, 1.5);
  assert.equal(st.comps.length, 2);
  near(st.comps[0].t, 7.8, 1e-9);
});

test('parse Candhis', () => {
  const o = E.parseCandhisRows([['05/11/2026', '21:00', '2.1', '4.0', '6.8', '119', '21', '17.2'], ['05/11/2026', '20:30', '2.2', '', '', '', '', '']]);
  assert.equal(o.length, 2);
  assert.equal(o[1].t, Date.UTC(2026, 10, 5, 21, 0));
  assert.equal(o[0].hmax, null);
});

test('soleil : jour à midi, nuit à minuit (Montpellier, novembre)', () => {
  assert.ok(E.solarElevation(Date.UTC(2026, 10, 5, 11, 30), 43.5, 3.9) > 25);
  assert.ok(E.solarElevation(Date.UTC(2026, 10, 5, 23, 0), 43.5, 3.9) < -30);
  // lever ~ 06:25 UTC (07:25 heure locale) début novembre
  assert.ok(E.solarElevation(Date.UTC(2026, 10, 5, 6, 0), 43.5, 3.9) < 0);
  assert.ok(E.solarElevation(Date.UTC(2026, 10, 5, 7, 0), 43.5, 3.9) > 0);
});

test('vérification bouée : biais et poids', () => {
  const t0 = Date.UTC(2026, 10, 4, 0);
  const time = Array.from({ length: 30 }, (_, i) => t0 + i * 3600e3);
  const marine = E.mergeMarine({ buoy_X: { time, models: {
    good: { hs: time.map(() => 1.0), tm: time.map(() => 5), dir: time.map(() => 120) },
    high: { hs: time.map(() => 1.5), tm: time.map(() => 5), dir: time.map(() => 120) } } } });
  const obs = time.map((t) => ({ t, hs: 1.0, tm: 5.5, dir: 118 }));
  const cfg = E.mergeCfg(E.DEFAULT_CONFIG, { waveModels: { good: { usePartitions: false, prior: 1 }, high: { usePartitions: false, prior: 1 } } });
  const v = E.verifyAgainstBuoy(obs, marine.buoy_X, cfg);
  near(v.good.mae, 0, 1e-9); near(v.high.bias, 0.5, 1e-9);
  const cal = E.modelCalibration(v, cfg);
  assert.ok(cal.good.weight > cal.high.weight * 5);
  // biais brut 1/1,5 = 0,67 → rétréci par 30 paires / (30+48)
  near(cal.high.bias, 1 - (1 / 3) * 30 / 78, 1e-9, 'biais rétréci');
  assert.ok(cal.good.bias === 1);
});

test('scénario complet : marin puis tramontane légère = créneau avec bascule', () => {
  const now = Date.UTC(2026, 11, 1, 6);
  const time = Array.from({ length: 24 * 5 }, (_, i) => now - 48 * 3600e3 + i * 3600e3);
  const pal = spot('palavas');
  const hs = time.map((t) => (t < now ? 1.6 : Math.max(0.3, 1.4 - (t - now) / 3600e3 * 0.02)));
  const marine = E.mergeMarine({ palavas: { time, models: { meteofrance_wave: {
    hs, tp: time.map(() => 7), tm: time.map(() => 6), dir: time.map(() => 150) } } } });
  // vent : marin SE 30 km/h jusqu'à now, puis NNO 12 km/h
  const spd = time.map((t) => (t < now ? 30 : 12));
  const dir = time.map((t) => (t < now ? 140 : 330));
  const wind = { palavas: { time, models: { meteofrance: { spd, dir, gust: spd.map((s) => s * 1.3) }, ecmwf: { spd, dir, gust: spd } } } };
  const res = E.run({ spots: [pal], buoys: [], marine, wind, buoyObs: {}, now, days: 2 });
  const rows = res.spots[0].rows;
  const before = rows.find((r) => r.t === now - 2 * 3600e3);
  const after = rows.find((r) => r.t === now + 3 * 3600e3); // 09h UTC = jour
  assert.ok(before.wind.kind === 'onshore' && before.score < 2, 'pendant le marin : poubelle');
  assert.ok(after.bascule, 'bascule détectée');
  assert.ok(after.score > 6, 'après bascule : bon, score=' + after.score.toFixed(1));
  assert.ok(res.windows.length >= 1);
  assert.match(after.text, /après coup de marin/);
});

test('scénario : nuit exclue des créneaux', () => {
  const now = Date.UTC(2026, 11, 1, 18); // 19h locale, nuit
  const time = Array.from({ length: 48 }, (_, i) => now - 6 * 3600e3 + i * 3600e3);
  const pal = spot('palavas');
  const marine = E.mergeMarine({ palavas: { time, models: { meteofrance_wave: { hs: time.map(() => 1), tp: time.map(() => 8), dir: time.map(() => 150) } } } });
  const wind = { palavas: { time, models: { meteofrance: { spd: time.map(() => 5), dir: time.map(() => 330), gust: time.map(() => 8) } } } };
  const res = E.run({ spots: [pal], buoys: [], marine, wind, now, days: 1 });
  res.windows.forEach((w) => {
    const hUTC = new Date(w.start).getUTCHours();
    assert.ok(hUTC >= 5 && hUTC <= 17, 'créneau en journée seulement, début ' + hUTC + 'h UTC');
  });
});

test('nowcast : la mesure bouée corrige les premières heures puis s\'estompe', () => {
  const now = Date.UTC(2026, 11, 1, 10);
  const time = Array.from({ length: 72 }, (_, i) => now - 24 * 3600e3 + i * 3600e3);
  const pal = Object.assign({}, spot('palavas'), { buoys: ['03404'] });
  const series = (v) => ({ time, models: { meteofrance_wave: { hs: time.map(() => v), tp: time.map(() => 7), dir: time.map(() => 150) } } });
  const marine = E.mergeMarine({ palavas: series(1.0), buoy_03404: series(1.0) });
  const wind = { palavas: { time, models: { meteofrance: { spd: time.map(() => 5), dir: time.map(() => 330) } } } };
  // 20 h d'historique : le modèle colle aux mesures, puis la mer grossit plus que prévu dans la dernière heure
  const obs = Array.from({ length: 38 }, (_, i) => ({ t: now - 20 * 3600e3 + i * 1800e3, hs: 1.0 }));
  obs.push({ t: now - 3600e3, hs: 1.4 }, { t: now - 1800e3, hs: 1.4 });
  const res = E.run({ spots: [pal], buoys: [{ code: '03404' }], marine, wind, buoyObs: { '03404': obs }, now, days: 2 });
  const s = res.spots[0];
  assert.equal(s.refBuoy, '03404');
  assert.ok(s.nowRatio > 1.25 && s.nowRatio < 1.45, 'nowRatio=' + s.nowRatio);
  const r0 = s.rows.find((r) => r.t === now), r24 = s.rows.find((r) => r.t === now + 24 * 3600e3);
  const r6 = s.rows.find((r) => r.t === now + 6 * 3600e3);
  assert.ok(r0.factors.now > 1.25 && r6.factors.now < 1.1 && r24.factors.now < 1.01);
});

test('bouée côtière : jamais utilisée pour la calibration, affichée à part', () => {
  const now = Date.UTC(2026, 11, 1, 10);
  const time = Array.from({ length: 48 }, (_, i) => now - 30 * 3600e3 + i * 3600e3);
  const g = spot('gruissan');
  const series = (v) => ({ time, models: { meteofrance_wave: { hs: time.map(() => v), tp: time.map(() => 7), dir: time.map(() => 120) } } });
  const marine = E.mergeMarine({ gruissan: series(1.0), buoy_01101: series(1.0), buoy_01102: series(1.0) });
  const wind = { gruissan: { time, models: { meteofrance: { spd: time.map(() => 5), dir: time.map(() => 270) } } } };
  const deep = time.filter((t) => t <= now).map((t) => ({ t, hs: 1.0 }));
  const shallow = time.filter((t) => t <= now).map((t) => ({ t, hs: 1.6 }));
  const res = E.run({ spots: [g], buoys: SPOTS.buoys, marine, wind, buoyObs: { '01101': deep, '01102': shallow }, now, days: 1 });
  const s = res.spots[0];
  assert.equal(s.refBuoy, '01101');
  assert.equal(s.coastObs.code, '01102');
  assert.ok(Math.abs(s.nowRatio - 1) < 0.05);
  assert.ok(!res.calibration['01102']);
});

test('mesures périmées (bouée en panne) ignorées', () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const time = Array.from({ length: 48 }, (_, i) => now - 24 * 3600e3 + i * 3600e3);
  const p = spot('paulilles');
  const series = (v) => ({ time, models: { meteofrance_wave: { hs: time.map(() => v), tp: time.map(() => 7), dir: time.map(() => 70) } } });
  const marine = E.mergeMarine({ paulilles: series(1.0), buoy_06601: series(1.0), buoy_01101: series(1.0) });
  const wind = { paulilles: { time, models: { meteofrance: { spd: time.map(() => 5), dir: time.map(() => 240) } } } };
  const old = Array.from({ length: 30 }, (_, i) => ({ t: now - 16 * 86400e3 + i * 1800e3, hs: 0.8 }));
  const recent = time.filter((t) => t <= now).map((t) => ({ t, hs: 1.1 }));
  const res = E.run({ spots: [p], buoys: SPOTS.buoys, marine, wind, buoyObs: { '06601': old, '01101': recent }, now, days: 1 });
  assert.equal(res.spots[0].refBuoy, '01101');
});

test('modèle aberrant (direction fausse) quasi ignoré', () => {
  const v = { good: { n: 50, mae: 0.3, ratio: 1, dirMae: 15, tmBias: 0.2 }, bad: { n: 50, mae: 0.3, ratio: 1, dirMae: 120, tmBias: -6 } };
  const cfg = E.mergeCfg(E.DEFAULT_CONFIG, { waveModels: { good: { prior: 1 }, bad: { prior: 1 } } });
  const c = E.modelCalibration(v, cfg);
  assert.ok(c.bad.insane && c.bad.weight < c.good.weight / 10);
});

test('score : un 10 reste exceptionnel', () => {
  const now = Date.UTC(2026, 11, 1, 10);
  const time = Array.from({ length: 30 }, (_, i) => now - 6 * 3600e3 + i * 3600e3);
  const c = spot('canet');
  const marine = E.mergeMarine({ canet: { time, models: { meteofrance_wave: { hs: time.map(() => 0.9), tp: time.map(() => 8), dir: time.map(() => 95) } } } });
  const wind = { canet: { time, models: { meteofrance: { spd: time.map(() => 8), dir: time.map(() => 270) } } } };
  const r = E.run({ spots: [c], buoys: [], marine, wind, now, days: 1 }).spots[0].rows.find((x) => x.t === now);
  assert.ok(r.score >= 8.5 && r.score < 9.5, 'conditions idéales 8 s : très bon mais pas 10, score=' + r.score.toFixed(2));
});

test('modèle masqué (Hs = 0 partout) écarté au point concerné', () => {
  const t0 = Date.UTC(2026, 10, 6, 0);
  const time = Array.from({ length: 24 }, (_, i) => t0 + i * 3600e3);
  const pd = E.mergeMarine({ p: { time, models: {
    a: { hs: time.map(() => 1.2), tp: time.map(() => 8), dir: time.map(() => 90) },
    b: { hs: time.map(() => 1.4), tp: time.map(() => 8), dir: time.map(() => 90) },
    land: { hs: time.map(() => 0), tp: time.map(() => 0), dir: time.map(() => 0) } } } }).p;
  const cfg = E.mergeCfg(E.DEFAULT_CONFIG, { waveModels: { a: { prior: 1 }, b: { prior: 1 }, land: { prior: 1 } } });
  const names = E.modelsAt(pd, t0 + 5 * 3600e3, cfg).map((m) => m.name);
  assert.deepEqual(names.sort(), ['a', 'b']);
  assert.deepEqual(pd.rejected, ['land']);
});

test('modèle très sous-estimé à un point (maille abritée) écarté', () => {
  const t0 = Date.UTC(2026, 10, 6, 0);
  const time = Array.from({ length: 24 }, (_, i) => t0 + i * 3600e3);
  const pd = E.mergeMarine({ p: { time, models: {
    a: { hs: time.map(() => 1.2), tp: time.map(() => 8), dir: time.map(() => 90) },
    b: { hs: time.map(() => 1.1), tp: time.map(() => 8), dir: time.map(() => 90) },
    shel: { hs: time.map(() => 0.2), tp: time.map(() => 5), dir: time.map(() => 90) } } } }).p;
  E.sanitizePoint(pd);
  assert.deepEqual(pd.rejected, ['shel']);
});
