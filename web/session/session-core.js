/*
 * Session 2 h — logique de choix du créneau
 * ------------------------------------------
 * Lit le forecast.json de Super Prévi Surf (note horaire par spot, déjà calibrée sur les bouées)
 * et répond à une seule question : quand aller 2 h à l'eau, sur un des spots à côté de chez soi,
 * en restant dans ses plages de disponibilité.
 *
 * JS pur (navigateur, Node pour les tests). Heures locales Europe/Paris.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SessionCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TZ = 'Europe/Paris';
  var STEP = 30 * 60e3;

  var DEFAULT_PREFS = {
    spots: ['palavas', 'carnon'],
    len: 2,               // durée de session (h)
    min: 4,               // note mini pour dire « ça vaut le coup »
    // plages de dispo en heures locales décimales ; week-end = samedi et dimanche
    week: [
      { id: 'matin', label: 'Avant le boulot', on: true, from: 7, to: 9 },
      { id: 'midi', label: 'Pause de midi', on: true, from: 12, to: 14 },
      { id: 'soir', label: 'Après le boulot', on: true, from: 17.5, to: 21 }
    ],
    weekend: { on: true, from: 7, to: 20 }
  };

  var fmtParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  /** {key: 'AAAA-MM-JJ', wd: 0..6 (0 = dimanche), h: heure décimale locale} */
  function local(t) {
    var p = {};
    fmtParts.formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
    return {
      key: p.year + '-' + p.month + '-' + p.day,
      wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
      h: (+p.hour) + (+p.minute) / 60
    };
  }

  /** plages autorisées pour un jour de semaine donné */
  function rangesFor(wd, prefs) {
    if (wd === 0 || wd === 6) return prefs.weekend && prefs.weekend.on ? [[prefs.weekend.from, prefs.weekend.to]] : [];
    return (prefs.week || []).filter(function (r) { return r.on; }).map(function (r) { return [r.from, r.to]; });
  }

  /** interpolation linéaire d'une série horaire ; null si trou */
  function sampler(times, vals) {
    return function (t) {
      if (!times.length || t < times[0] || t > times[times.length - 1]) return null;
      var i = Math.min(times.length - 2, Math.max(0, Math.floor((t - times[0]) / 3600e3)));
      while (i > 0 && times[i] > t) i--;
      while (i < times.length - 2 && times[i + 1] <= t) i++;
      var a = vals[i], b = vals[i + 1], f = (t - times[i]) / (times[i + 1] - times[i]);
      if (a == null && b == null) return null;
      if (a == null) return f > 0.5 ? b : null;
      if (b == null) return f < 0.5 ? a : null;
      return a + (b - a) * f;
    };
  }
  function nearest(times, vals, t) {
    var best = -1, bd = Infinity;
    for (var i = 0; i < times.length; i++) { var d = Math.abs(times[i] - t); if (d < bd) { bd = d; best = i; } }
    return best >= 0 && bd <= 3600e3 ? vals[best] : null;
  }

  /**
   * Toutes les sessions possibles (pas de 30 min) sur les spots choisis.
   * Note de session = 0,6 × moyenne + 0,4 × minimum : 2 h régulières valent mieux qu'un pic suivi d'un trou.
   */
  /** élévation du soleil (°) — même formule que le moteur ; jour = au-dessus de −4° (on surfe dès l'aube) */
  function sunElev(t, lat, lon) {
    var rad = Math.PI / 180, n = t / 864e5 + 2440587.5 - 2451545;
    var L = (280.46 + 0.9856474 * n) % 360, g = ((357.528 + 0.9856003 * n) % 360) * rad;
    var lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, eps = (23.439 - 4e-7 * n) * rad;
    var dec = Math.asin(Math.sin(eps) * Math.sin(lam)), ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    var ha = ((280.46061837 + 360.98564736629 * n + lon) * rad) - ra;
    return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
  }
  var DAYLIGHT = -4;

  /**
   * Toutes les sessions possibles (pas de 30 min) sur les spots choisis.
   * Dans chaque plage de dispo, on ne garde que le jour. Si la plage de jour est plus courte que la durée
   * voulue (ex. 7 h → 9 h en hiver, jour à 7 h 30), on propose la session la plus longue possible (≥ 1 h).
   * Note de session = 0,6 × moyenne + 0,4 × minimum : 2 h régulières valent mieux qu'un pic suivi d'un trou.
   */
  function candidates(forecast, prefs, now) {
    prefs = prefs || DEFAULT_PREFS;
    var L = prefs.len * 3600e3, minL = Math.max(3600e3, L / 2), out = [];
    var spots = forecast.spots.filter(function (s) { return prefs.spots.indexOf(s.id) >= 0; });
    spots.forEach(function (sp) {
      var h = sp.h, T = h.t, lat = sp.lat || 43.53, lon = sp.lon || 3.95;
      var sc = sampler(T, h.score), hb = sampler(T, h.hb), ws = sampler(T, h.ws), cf = sampler(T, h.conf);
      // 1) points de 30 min utilisables, regroupés en plages continues (même jour, même plage de dispo)
      var runs = [], cur = null;
      var t0 = Math.ceil(now / STEP) * STEP, tEnd = T[T.length - 1];
      for (var t = t0; t <= tEnd; t += STEP) {
        var lo = local(t);
        var ri = -1;
        rangesFor(lo.wd, prefs).forEach(function (r, i) { if (ri < 0 && lo.h >= r[0] - 1e-9 && lo.h <= r[1] + 1e-9) ri = i; });
        var ok = ri >= 0 && sunElev(t, lat, lon) > DAYLIGHT && sc(t) != null;
        var id = lo.key + '#' + ri;
        if (ok && cur && cur.id === id && t - cur.b === STEP) cur.b = t;
        else { if (cur) runs.push(cur); cur = ok ? { id: id, a: t, b: t, day: lo.key, wd: lo.wd } : null; }
      }
      if (cur) runs.push(cur);
      // 2) fenêtres glissantes dans chaque plage
      runs.forEach(function (run) {
        var avail = run.b - run.a;
        var len = avail >= L ? L : avail >= minL ? avail : 0;
        if (!len) return;
        for (var s0 = run.a; s0 + len <= run.b; s0 += STEP) out.push(session(sp, s0, len, run, len < L));
      });
      function session(sp, t, len, run, short) {
        var vals = [], hbs = [], wss = [], cfs = [];
        for (var s = t; s <= t + len; s += STEP) { vals.push(sc(s)); hbs.push(hb(s)); wss.push(ws(s)); cfs.push(cf(s)); }
        var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        var mn = Math.min.apply(null, vals), mid = t + len / 2;
        return {
          spot: sp.id, name: sp.name, start: t, end: t + len, len: len / 3600e3, short: short,
          day: run.day, wd: run.wd, h: local(t).h,
          score: 0.6 * mean + 0.4 * mn, mean: mean, min: mn,
          hb: avg(hbs), ws: avg(wss), conf: avg(cfs),
          tp: nearest(T, h.tp, mid), dir: nearest(T, h.dir, mid), wd2: nearest(T, h.wd, mid), wk: nearest(T, h.wk, mid),
          bas: !!nearest(T, h.bas, mid)
        };
      }
    });
    return out;
  }
  function avg(a) { var v = a.filter(function (x) { return x != null; }); return v.length ? v.reduce(function (s, x) { return s + x; }, 0) / v.length : null; }

  /** meilleure session par jour (tous spots confondus), dans l'ordre des jours */
  function bestPerDay(cands) {
    var groups = {};
    cands.forEach(function (c) { (groups[c.day] = groups[c.day] || []).push(c); });
    return Object.keys(groups).sort().map(function (k) {
      var g = groups[k];
      var top = Math.max.apply(null, g.map(function (c) { return c.score; }));
      // à note quasi égale (à 0,2 près), on prend le créneau le plus tôt : moins d'attente, moins d'incertitude
      return g.filter(function (c) { return c.score >= top - 0.2; }).sort(function (a, b) { return a.start - b.start || b.score - a.score; })[0];
    });
  }

  /**
   * Réponse principale.
   * next : premier jour qui a une session ≥ seuil (la meilleure de ce jour-là)
   * best : meilleure session de la semaine
   */
  function plan(forecast, prefs, now) {
    prefs = prefs || DEFAULT_PREFS;
    var c = candidates(forecast, prefs, now);
    var days = bestPerDay(c);
    var next = null, best = null;
    days.forEach(function (d) {
      if (!next && d.score >= prefs.min) next = d;
      if (!best || d.score > best.score) best = d;
    });
    return { candidates: c, days: days, next: next, best: best && best.score >= prefs.min ? best : null, top: best };
  }

  function verdict(s, prefs) {
    var m = (prefs || DEFAULT_PREFS).min;
    if (!s) return { code: 'non', label: 'Rien de surfable dans tes créneaux' };
    if (s.score >= 7) return { code: 'go', label: 'Fonce' };
    if (s.score >= m + 1) return { code: 'go', label: 'Ça vaut le coup' };
    if (s.score >= m) return { code: 'bof', label: 'Petit mais jouable' };
    return { code: 'non', label: 'Pas la peine' };
  }

  return { DEFAULT_PREFS: DEFAULT_PREFS, DAYLIGHT: DAYLIGHT, sunElev: sunElev, local: local, rangesFor: rangesFor, sampler: sampler, candidates: candidates, bestPerDay: bestPerDay, plan: plan, verdict: verdict, TZ: TZ };
});
