// Rendu de l'interface dans un DOM simulé, avec un forecast.json produit par le vrai pipeline (fausses données)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..');

function makeForecast() {
  // réutilise les générateurs du test de pipeline
  const src = fs.readFileSync(path.join(__dirname, 'pipeline.test.js'), 'utf8');
  const E = require('../engine/surf-engine.js'); const SP = require('../engine/spots.json');
  const m = {}; new Function('E', 'SP', 'm', src.match(/function fakeMarine[\s\S]*?\n}\nfunction fakeWind[\s\S]*?\n}\n/)[0] + 'm.fakeMarine=fakeMarine;m.fakeWind=fakeWind;')(E, SP, m);
  const now = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'));
  const fx = path.join(tmp, 'fx.json');
  fs.writeFileSync(fx, JSON.stringify({ now, marine: m.fakeMarine(E.queryPoints(SP.spots, SP.buoys), now), wind: m.fakeWind(SP.spots, now) }));
  const f = path.join(ROOT, 'data/forecast.json'), a = path.join(ROOT, 'data/history/forecasts.json');
  const bf = fs.existsSync(f) ? fs.readFileSync(f) : null, ba = fs.existsSync(a) ? fs.readFileSync(a) : null;
  execFileSync('node', [path.join(ROOT, 'collector/build.js'), '--offline', fx]);
  const out = fs.readFileSync(f, 'utf8');
  if (bf) fs.writeFileSync(f, bf); else fs.unlinkSync(f);
  if (ba) fs.writeFileSync(a, ba); else fs.unlinkSync(a);
  return JSON.parse(out);
}

function boot(html, forecast) {
  const errors = [];
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.github.io/super-previ-surf/', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.scrollTo = () => {};
  w.fetch = (u) => Promise.resolve(u.includes('forecast.json')
    ? { ok: true, json: () => Promise.resolve(forecast) }
    : { ok: false, json: () => Promise.reject(new Error('no')) });
  w.addEventListener('error', (e) => errors.push(e.message));
  const scripts = [...html.matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)];
  for (const s of scripts) w.eval(s[1] ? fs.readFileSync(path.join(ROOT, 'engine', s[1]), 'utf8') : s[2]);
  return { w, errors };
}

test('interface : accueil puis détail d\'un spot, sans erreur', async () => {
  const fc = makeForecast();
  // ajoute une fausse vérification + mesure pour exercer ces blocs
  fc.verification = { '03404': { meteofrance_wave: { n: 90, mae: 0.3, bias: -0.2, dirMae: 15, w: 12, k: 1.1, off: 0 }, ncep_gfswave025: { n: 90, mae: 1.4, bias: -1.4, dirMae: 120, w: 0.1, k: 0.8, off: 1 } } };
  fc.buoys = { '03404': { name: 'Sète', t: [Date.now() - 1800e3], hs: [1.2], tm: [6], dir: [120] } };
  fc.spots[0].nowObs = { t: Date.now() - 1800e3, hs: 1.2, tm: 6, dir: 120, code: '03404' };
  const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  const { w, errors } = boot(html, fc);
  await new Promise((r) => setTimeout(r, 300));
  const doc = w.document;
  assert.deepEqual(errors, []);
  assert.equal(doc.querySelectorAll('.row').length, 8, '8 spots listés');
  assert.ok(doc.querySelector('.vt'), 'tableau de vérification');
  assert.ok(doc.querySelector('.vt tr.off'), 'modèle aberrant barré');
  assert.match(doc.getElementById('updated').textContent, /calculé/);
  doc.querySelector('.row').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(doc.querySelector('.chart svg'), 'graphique du spot');
  assert.ok(doc.querySelectorAll('table.hours tbody tr').length > 100, 'tableau horaire');
  assert.ok(doc.querySelectorAll('.chart svg g').length > 20, 'flèches de vent');
  assert.ok(!/NaN|undefined/.test(doc.getElementById('app').innerHTML), 'pas de NaN/undefined affiché');
  doc.getElementById('back').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(doc.querySelectorAll('.row').length, 8);
  w.close(); // arrête le rafraîchissement périodique de la page
});

test('version autonome : moteur et spots intégrés, calcul direct si pas de forecast.json', async () => {
  execFileSync('node', [path.join(ROOT, 'tools/build-standalone.js')]);
  const html = fs.readFileSync(path.join(ROOT, 'dist/super-previ-surf.html'), 'utf8');
  assert.ok(html.includes('SPOTS_FALLBACK'));
  assert.ok(!html.includes('src="surf-engine.js"'));
});
