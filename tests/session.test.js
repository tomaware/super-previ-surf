// Tests de l'app Session 2 h
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../web/session/session-core.js');

// prévision synthétique : 7 jours, note définie par une fonction de l'heure locale
function fake(now, scoreFn, opts) {
  opts = opts || {};
  const t0 = Math.floor(now / 3600e3) * 3600e3 - 6 * 3600e3;
  const t = Array.from({ length: 24 * 8 }, (_, i) => t0 + i * 3600e3);
  const mk = (id, bonus) => ({
    id, name: id, h: {
      t,
      score: t.map((x) => scoreFn(S.local(x), id) + (bonus || 0)),
      hb: t.map(() => 1), ws: t.map(() => 10), conf: t.map(() => 0.7), tp: t.map(() => 7), dir: t.map(() => 150),
      wd: t.map(() => 320), wk: t.map(() => 'offshore'), bas: t.map(() => 0),
      day: t.map((x) => { const h = S.local(x).h; return h >= 7.5 && h <= 17.5; })
    }
  });
  return { spots: [mk('palavas', opts.palBonus), mk('carnon', 0), mk('sete', 5)] };
}
const NOW = Date.UTC(2026, 10, 9, 5); // lundi 9 novembre 2026, 6 h à Paris

test('heure locale Paris et jour de semaine', () => {
  const l = S.local(Date.UTC(2026, 10, 9, 11, 30));
  assert.equal(l.key, '2026-11-09'); assert.equal(l.wd, 1); assert.equal(l.h, 12.5);
  assert.equal(S.local(Date.UTC(2026, 6, 1, 10)).h, 12, 'heure d\'été');
});

test('les sessions respectent les créneaux, la durée et le jour', () => {
  const c = S.candidates(fake(NOW, () => 6), S.DEFAULT_PREFS, NOW);
  assert.ok(c.length > 0);
  c.forEach((x) => {
    const ranges = S.rangesFor(x.wd, S.DEFAULT_PREFS);
    assert.ok(ranges.some((r) => x.h >= r[0] && x.h + x.len <= r[1] + 1e-9), 'dans un créneau : ' + x.h);
    assert.equal(x.end - x.start, x.len * 3600e3); assert.ok(x.len === 2 || x.short);
    assert.ok(x.spot !== 'sete', 'uniquement les spots choisis');
  });
  // lundi de novembre : jour vers 7 h 05 → session courte 7 h 30 → 9 h ; midi 12 h → 14 h ; nuit à 18 h → pas de soir
  const lundi = c.filter((x) => x.day === '2026-11-09');
  assert.deepEqual([...new Set(lundi.map((x) => x.h))].sort((a, b) => a - b), [7.5, 12]);
  const matin = lundi.find((x) => x.h === 7.5);
  assert.ok(matin.short && matin.len === 1.5);
  assert.ok(!lundi.find((x) => x.h === 12).short);
});

test('le meilleur créneau du jour gagne, et à note égale le plus tôt', () => {
  const f = fake(NOW, (l) => (l.wd === 2 && l.h >= 12 && l.h <= 14 ? 7 : 2));
  const p = S.plan(f, S.DEFAULT_PREFS, NOW);
  assert.equal(p.next.day, '2026-11-10');
  assert.equal(p.next.h, 12);
  const flat = S.plan(fake(NOW, () => 5), Object.assign({}, S.DEFAULT_PREFS, { weekend: { on: true, from: 8, to: 17 } }), NOW);
  const sam = flat.days.find((d) => d.wd === 6);
  assert.equal(sam.h, 8, 'le plus tôt à note égale');
});

test('un pic court suivi d\'un trou perd face à 2 h régulières', () => {
  const f = fake(NOW, (l) => {
    if (l.wd !== 6) return 0;
    if (l.h >= 9 && l.h < 10) return 9;       // pic d'une heure
    if (l.h >= 10 && l.h <= 11) return 1;     // puis trou
    if (l.h >= 14 && l.h <= 16) return 6.5;   // l'après-midi régulier
    return 2;
  });
  const sam = S.plan(f, S.DEFAULT_PREFS, NOW).days.find((d) => d.wd === 6);
  assert.equal(sam.h, 14);
});

test('le spot le meilleur est choisi', () => {
  const p = S.plan(fake(NOW, () => 5, { palBonus: 1 }), S.DEFAULT_PREFS, NOW);
  assert.equal(p.next.spot, 'palavas');
  const onlyCarnon = S.plan(fake(NOW, () => 5, { palBonus: 1 }), Object.assign({}, S.DEFAULT_PREFS, { spots: ['carnon'] }), NOW);
  assert.equal(onlyCarnon.next.spot, 'carnon');
});

test('seuil : rien de surfable → pas de prochaine session, mais un « moins pire »', () => {
  const p = S.plan(fake(NOW, () => 2), S.DEFAULT_PREFS, NOW);
  assert.equal(p.next, null);
  assert.ok(p.top && p.top.score < 4);
  assert.equal(S.verdict(null).code, 'non');
  assert.equal(S.verdict({ score: 7.5 }).code, 'go');
  assert.equal(S.verdict({ score: 4.2 }).code, 'bof');
});

test('créneaux désactivés et durée modifiée', () => {
  const prefs = JSON.parse(JSON.stringify(S.DEFAULT_PREFS));
  prefs.week.forEach((r) => { r.on = false; }); prefs.weekend.on = false;
  assert.equal(S.candidates(fake(NOW, () => 6), prefs, NOW).length, 0);
  prefs.weekend.on = true; prefs.len = 1;
  const c = S.candidates(fake(NOW, () => 6), prefs, NOW);
  assert.ok(c.length && c.every((x) => x.end - x.start === 3600e3 && (x.wd === 0 || x.wd === 6)));
});

test('pas de session dans le passé', () => {
  const now = Date.UTC(2026, 10, 9, 11, 40); // lundi 12 h 40
  const c = S.candidates(fake(now, () => 6), S.DEFAULT_PREFS, now);
  assert.ok(c.every((x) => x.start >= now));
  const lundi = c.filter((x) => x.day === '2026-11-09');
  assert.deepEqual([...new Set(lundi.map((x) => x.h + '/' + x.len))], ['13/1'], 'midi entamé : il reste 1 h ; le soir il fait nuit');
});
