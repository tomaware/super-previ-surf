/*
 * Super Prévi Surf — moteur de prévision (V1)
 * --------------------------------------------
 * JavaScript pur, sans dépendance : tourne dans le navigateur (app web),
 * dans Node (tests) et dans Scriptable (widget iPhone).
 *
 * Conventions (vérifiées par les tests) :
 *  - toutes les directions sont "d'où ça vient" (0 = du nord, 90 = de l'est), en degrés ;
 *  - les temps sont des millisecondes UTC (Date.getTime()) ;
 *  - hauteurs en m, périodes en s, vent en km/h.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SurfEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ config
  var DEFAULT_CONFIG = {
    offshoreKm: 3,                // distance du point modèle au large, le long de la normale
    g: 9.81,
    breakerCoeff: 1.0,            // calibrage global de la hauteur au déferlement
    angleCutoff: 88,              // au-delà, la houle ne rentre plus sur la plage
    windowTaper: 25,              // ° d'atténuation progressive hors fenêtre de houle
    periodCurve: [[3, 0.15], [4, 0.35], [5, 0.6], [6, 0.78], [7, 0.9], [8, 1.0], [10, 1.08], [12, 1.12]],
    wind: {
      glassy: 6,                  // km/h : en dessous, plan d'eau lisse quelle que soit la direction
      offIdealMax: 22,            // offshore jusqu'à cette vitesse = parfait
      offStrongSlope: 50,         // perte par km/h au-delà
      offFloor: 0.35,
      sideZero: 38,               // vitesse à laquelle le side-shore annule presque tout
      sideFloor: 0.12,
      onZero: 22,                 // vitesse à laquelle l'onshore pur annule tout
      gustRatio: 1.7, gustMin: 35, gustMalus: 0.9
    },
    bascule: {
      lookbackH: 36, onshoreMinKmh: 18, minHours: 5
    },
    flattening: {                 // tramontane / mistral forte et durable : les modèles surestiment souvent la houle résiduelle
      lookbackH: 12, offshoreMinKmh: 40, minHours: 8, malus: 0.85
    },
    windModels: {
      // poids selon l'échéance (h) : AROME→ARPEGE (meteofrance_seamless) vs ECMWF IFS
      meteofrance: [[0, 0.75], [48, 0.75], [72, 0.55], [100, 0.35], [101, 0]],
    },
    waveModels: {
      // usePartitions : partitions houle/mer du vent jugées fiables pour ce modèle en Méditerranée
      // prior : poids a priori avant vérification contre les bouées
      copernicus: { usePartitions: true, prior: 1.4, label: 'Copernicus Med-WAV' },
      meteofrance_wave: { usePartitions: true, prior: 1.2, label: 'Météo-France MFWAM' },
      ewam: { usePartitions: true, prior: 1.0, label: 'DWD EWAM' },
      ecmwf_wam025: { usePartitions: false, prior: 1.0, label: 'ECMWF WAM' },
      gwam: { usePartitions: true, prior: 0.6, label: 'DWD GWAM' },
      ncep_gfswave025: { usePartitions: false, prior: 0.6, label: 'NOAA GFS-Wave' }
    },
    verification: {
      // réglages issus des tests à l'aveugle sur données réelles (cf. CHANGELOG, passe 3)
      minObsHs: 0.25, minPairs: 12, biasClip: [0.8, 1.25], mae0: 0.2,
      biasMinHs: 0.5,             // le biais n'est estimé que sur des mers "surfables"
      biasShrink: 48,             // rétrécissement bayésien : biais × n/(n+48) — prudent tant que l'historique est court
      // un modèle dont la direction ou la période est aberrante à une bouée est mal représenté à cet endroit
      // (maille terre / abritée) : son poids y est quasiment annulé
      sanity: { dirMae: 60, tmBias: 3, factor: 0.05 },
      maxAgeDays: 30,
      nearshoreDepth: 20          // bouées plus côtières que ça : affichage seulement (vagues déjà transformées)
    },
    nowcast: { maxAgeH: 3, decayH: 3.5, ratioClip: [0.6, 1.6] },  // décroissance courte : au-delà de ~6 h la correction dégradait
    score: { base: 9.0, basculeBonus: 0.6, longPeriodBonus: 0.4, longPeriod: 9 },
    daylightElevation: -4,        // ° : on surfe dès l'aube civile
    windowThreshold: 4.0,         // score mini (sur 10) pour un créneau
    windowMinHours: 2
  };

  // ------------------------------------------------------------------ maths d'angles
  function norm360(a) { a = a % 360; return a < 0 ? a + 360 : a; }
  /** différence signée a - b ramenée dans ]-180, 180] */
  function angDiff(a, b) { var d = norm360(a - b); return d > 180 ? d - 360 : d; }
  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }
  /** moyenne circulaire pondérée ; renvoie null si aucune valeur */
  function circMean(dirs, weights) {
    var x = 0, y = 0, n = 0;
    for (var i = 0; i < dirs.length; i++) {
      if (dirs[i] == null || isNaN(dirs[i])) continue;
      var w = weights ? weights[i] : 1; if (!(w > 0)) continue;
      x += w * Math.cos(rad(dirs[i])); y += w * Math.sin(rad(dirs[i])); n++;
    }
    if (!n || (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12)) return null;
    return norm360(deg(Math.atan2(y, x)));
  }
  /** angle est-il dans la fenêtre [min,max] parcourue dans le sens horaire ? */
  function inArc(a, min, max) {
    a = norm360(a); min = norm360(min); max = norm360(max);
    return min <= max ? (a >= min && a <= max) : (a >= min || a <= max);
  }
  /** distance angulaire (°) à la fenêtre ; 0 si dedans */
  function distToArc(a, min, max) {
    if (inArc(a, min, max)) return 0;
    return Math.min(Math.abs(angDiff(a, min)), Math.abs(angDiff(a, max)));
  }
  function interp(curve, x) {
    if (x <= curve[0][0]) return curve[0][1];
    for (var i = 1; i < curve.length; i++) {
      if (x <= curve[i][0]) {
        var a = curve[i - 1], b = curve[i];
        return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      }
    }
    return curve[curve.length - 1][1];
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function mean(a) { var s = 0, n = 0; a.forEach(function (v) { if (isNum(v)) { s += v; n++; } }); return n ? s / n : null; }

  var COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  function compass(d) { return d == null ? '—' : COMPASS[Math.round(norm360(d) / 22.5) % 16]; }

  // ------------------------------------------------------------------ géographie
  /** point décalé de km le long de l'azimut az */
  function offsetPoint(lat, lon, az, km) {
    var dLat = km * Math.cos(rad(az)) / 111.2;
    var dLon = km * Math.sin(rad(az)) / (111.2 * Math.cos(rad(lat)));
    return { lat: +(lat + dLat).toFixed(4), lon: +(lon + dLon).toFixed(4) };
  }
  function modelPoint(spot, cfg) {
    if (spot.modelLat != null) return { lat: spot.modelLat, lon: spot.modelLon };
    return offsetPoint(spot.lat, spot.lon, spot.normal, (cfg || DEFAULT_CONFIG).offshoreKm);
  }

  /** élévation du soleil (°), algorithme NOAA simplifié — précision ~0,5° */
  function solarElevation(t, lat, lon) {
    var d = new Date(t);
    var jd = t / 86400000 + 2440587.5;
    var n = jd - 2451545.0;
    var L = norm360(280.46 + 0.9856474 * n);
    var g = rad(norm360(357.528 + 0.9856003 * n));
    var lambda = rad(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
    var eps = rad(23.439 - 0.0000004 * n);
    var dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
    var ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    var gmst = norm360(280.46061837 + 360.98564736629 * n);
    var ha = rad(norm360(gmst + lon - deg(ra)));
    var el = Math.asin(Math.sin(rad(lat)) * Math.sin(dec) + Math.cos(rad(lat)) * Math.cos(dec) * Math.cos(ha));
    void d;
    return deg(el);
  }

  // ------------------------------------------------------------------ physique des vagues
  /**
   * Hauteur au déferlement (Komar & Gaillard 1973, avec incidence oblique) :
   *   Hb = 0,39 · g^0,2 · (T · H0² · cos θ)^0,4
   * H0 : hauteur au large (m), T : période pic (s), theta : angle à la normale (°).
   */
  function breakingHeight(h0, T, thetaDeg, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    if (!(h0 > 0) || !(T > 0)) return 0;
    var th = Math.abs(thetaDeg || 0);
    if (th >= cfg.angleCutoff) return 0;
    var c = Math.cos(rad(th));
    return cfg.breakerCoeff * 0.39 * Math.pow(cfg.g, 0.2) * Math.pow(T * h0 * h0 * c, 0.4);
  }
  /** facteur directionnel lié à la fenêtre du spot : 1 dans la fenêtre, décroît en cosinus sur windowTaper° */
  function windowFactor(dir, spot, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    var d = distToArc(dir, spot.swell.min, spot.swell.max);
    if (d === 0) return 1;
    if (d >= cfg.windowTaper) return 0;
    return 0.5 * (1 + Math.cos(Math.PI * d / cfg.windowTaper));
  }
  function wavePower(hs, tp) { return (hs > 0 && tp > 0) ? 0.49 * hs * hs * tp : 0; } // kW/m

  /**
   * Hauteur surfable au bord pour un état de mer décomposé en composantes {h,t,d}.
   * Combinaison énergétique : Hb = sqrt(Σ Hb_i²).
   */
  function surfHeight(components, spot, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    var e = 0, eIn = 0, best = null, bestE = 0;
    components.forEach(function (c) {
      if (!(c.h > 0) || !(c.t > 0) || c.d == null) return;
      var theta = angDiff(c.d, spot.normal);
      var hb = breakingHeight(c.h, c.t, theta, cfg) * windowFactor(c.d, spot, cfg) * (spot.shelter || 1);
      e += hb * hb; eIn += c.h * c.h;
      if (hb * hb > bestE) { bestE = hb * hb; best = c; }
    });
    return { hb: Math.sqrt(e), dominant: best };
  }

  // ------------------------------------------------------------------ qualité du vent
  /**
   * Qualité du vent pour un spot (0..1).
   * c = cos(angle entre le vent et la direction offshore) : +1 offshore pur, -1 onshore pur.
   */
  function windQuality(speed, dir, gust, spot, cfg) {
    cfg = cfg || DEFAULT_CONFIG; var w = cfg.wind;
    if (!isNum(speed) || dir == null) return { q: null, rel: null, kind: '—' };
    var offshoreDir = norm360(spot.normal + 180);
    var c = Math.cos(rad(angDiff(dir, offshoreDir)));
    var qOff = speed <= w.offIdealMax ? 1 : Math.max(w.offFloor, 1 - (speed - w.offIdealMax) / w.offStrongSlope);
    var qSide = Math.max(w.sideFloor, 1 - speed / w.sideZero);
    var qOn = Math.max(0, 1 - speed / w.onZero);
    var q = c >= 0 ? c * qOff + (1 - c) * qSide : (-c) * qOn + (1 + c) * qSide;
    if (speed < w.glassy) q = Math.max(q, 0.95);
    if (isNum(gust) && gust > w.gustMin && gust > w.gustRatio * speed) q *= w.gustMalus;
    var kind = speed < w.glassy ? 'pétole' : c > 0.7 ? 'offshore' : c > 0.25 ? 'side-off' : c > -0.25 ? 'side' : c > -0.7 ? 'side-on' : 'onshore';
    return { q: clamp(q, 0, 1), rel: c, kind: kind };
  }

  function periodFactor(tp, cfg) { return interp((cfg || DEFAULT_CONFIG).periodCurve, tp || 0); }

  /** facteur taille : 0 flat → 1 idéal → décroît au-delà du max (ferme, dangereux) */
  function sizeFactor(hb, spot) {
    var s = spot.size;
    if (hb < s.min * 0.6) return 0;
    if (hb < s.min) return 0.25 * (hb - s.min * 0.6) / (s.min * 0.4);
    if (hb < s.ideal) return 0.25 + 0.75 * (hb - s.min) / (s.ideal - s.min);
    if (hb <= s.max) return 1;
    return Math.max(0.25, 1 - 0.75 * (hb - s.max) / (0.6 * s.max));
  }

  // ------------------------------------------------------------------ adaptateurs de données
  var OM_MARINE_VARS = ['wave_height', 'wave_period', 'wave_peak_period', 'wave_direction',
    'swell_wave_height', 'swell_wave_peak_period', 'swell_wave_period', 'swell_wave_direction',
    'secondary_swell_wave_height', 'secondary_swell_wave_period', 'secondary_swell_wave_direction',
    'wind_wave_height', 'wind_wave_peak_period', 'wind_wave_period', 'wind_wave_direction',
    'sea_level_height_msl', 'sea_surface_temperature'];
  var OM_WIND_VARS = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
  var OM_WAVE_MODELS = ['meteofrance_wave', 'ecmwf_wam025', 'ewam', 'gwam', 'ncep_gfswave025'];
  var OM_WIND_MODELS = { meteofrance: 'meteofrance_seamless', ecmwf: 'ecmwf_ifs025' };

  function parseTimeUTC(s) {
    // Open-Meteo avec timezone=GMT : "2026-11-05T10:00"
    return Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
  }

  /** Construit les URLs Open-Meteo pour une liste de points */
  function openMeteoMarineURL(points, opts) {
    opts = opts || {};
    return 'https://marine-api.open-meteo.com/v1/marine?latitude=' + points.map(function (p) { return p.lat; }).join(',') +
      '&longitude=' + points.map(function (p) { return p.lon; }).join(',') +
      '&hourly=' + OM_MARINE_VARS.join(',') + '&models=' + (opts.models || OM_WAVE_MODELS).join(',') +
      '&timezone=GMT&past_days=' + (opts.pastDays == null ? 2 : opts.pastDays) + '&forecast_days=' + (opts.forecastDays || 8) + '&cell_selection=sea';
  }
  function openMeteoWindURL(points, opts) {
    opts = opts || {};
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + points.map(function (p) { return p.lat; }).join(',') +
      '&longitude=' + points.map(function (p) { return p.lon; }).join(',') +
      '&hourly=' + OM_WIND_VARS.join(',') + '&models=' + [OM_WIND_MODELS.meteofrance, OM_WIND_MODELS.ecmwf].join(',') +
      '&wind_speed_unit=kmh&timezone=GMT&past_days=' + (opts.pastDays == null ? 2 : opts.pastDays) + '&forecast_days=' + (opts.forecastDays || 8);
  }

  /**
   * Open-Meteo Marine (une ou plusieurs localisations, plusieurs modèles) →
   * { pointId: { time:[ms], models: { m: {hs,tp,tm,dir,comps:[{h,t,d}], sl, sst} } } }
   */
  function parseOpenMeteoMarine(json, pointIds, models) {
    var arr = Array.isArray(json) ? json : [json];
    models = models || OM_WAVE_MODELS;
    var out = {};
    arr.forEach(function (loc, i) {
      var h = loc.hourly || {}; var time = (h.time || []).map(parseTimeUTC);
      var ms = {};
      models.forEach(function (m) {
        var g = function (v) { return h[v + '_' + m] || (models.length === 1 ? h[v] : null); };
        var hs = g('wave_height'); if (!hs || !hs.some(isNum)) return;
        ms[m] = {
          hs: hs, tm: g('wave_period'), tp: g('wave_peak_period'), dir: g('wave_direction'),
          sw1: { h: g('swell_wave_height'), t: g('swell_wave_peak_period') || g('swell_wave_period'), tm: g('swell_wave_period'), d: g('swell_wave_direction') },
          sw2: { h: g('secondary_swell_wave_height'), t: g('secondary_swell_wave_period'), d: g('secondary_swell_wave_direction') },
          ww: { h: g('wind_wave_height'), t: g('wind_wave_peak_period') || g('wind_wave_period'), tm: g('wind_wave_period'), d: g('wind_wave_direction') },
          sl: g('sea_level_height_msl'), sst: g('sea_surface_temperature')
        };
      });
      out[pointIds[i]] = { time: time, models: ms };
    });
    return out;
  }

  /** Open-Meteo Forecast (vent) → { pointId: { time, models: { meteofrance:{spd,dir,gust}, ecmwf:{...} } } } */
  function parseOpenMeteoWind(json, pointIds) {
    var arr = Array.isArray(json) ? json : [json];
    var out = {};
    arr.forEach(function (loc, i) {
      var h = loc.hourly || {}; var ms = {};
      Object.keys(OM_WIND_MODELS).forEach(function (k) {
        var m = OM_WIND_MODELS[k];
        var spd = h['wind_speed_10m_' + m];
        if (!spd) return;
        ms[k] = { spd: spd, dir: h['wind_direction_10m_' + m], gust: h['wind_gusts_10m_' + m] };
      });
      out[pointIds[i]] = { time: (h.time || []).map(parseTimeUTC), models: ms };
    });
    return out;
  }

  /**
   * Copernicus (JSON produit par collector/copernicus.py) →
   * même structure que parseOpenMeteoMarine, modèle "copernicus".
   * Variables CMEMS : VHM0, VTPK, VTM10, VMDR, VHM0_SW1, VTM01_SW1, VMDR_SW1, VHM0_SW2, VTM01_SW2, VMDR_SW2, VHM0_WW, VTM01_WW, VMDR_WW
   */
  function parseCopernicus(json) {
    var out = {};
    if (!json || !json.points) return out;
    Object.keys(json.points).forEach(function (pid) {
      var p = json.points[pid]; if (!p || !p.time) return;
      var v = function (k) { return p[k] || null; };
      // Tp de la mer du vent / houle : CMEMS donne Tm01 ; Tp ≈ 1,2 · Tm01 pour un spectre de mer du vent
      var scale = function (a, f) { return a ? a.map(function (x) { return isNum(x) ? x * f : null; }) : null; };
      out[pid] = {
        time: p.time.map(function (s) { return typeof s === 'number' ? s : Date.parse(s); }),
        models: {
          copernicus: {
            hs: v('VHM0'), tp: v('VTPK'), tm: v('VTM10') || v('VTM02'), dir: v('VMDR'),
            sw1: { h: v('VHM0_SW1'), t: scale(v('VTM01_SW1'), 1.2), tm: v('VTM01_SW1'), d: v('VMDR_SW1') },
            sw2: { h: v('VHM0_SW2'), t: scale(v('VTM01_SW2'), 1.2), d: v('VMDR_SW2') },
            ww: { h: v('VHM0_WW'), t: scale(v('VTM01_WW'), 1.2), tm: v('VTM01_WW'), d: v('VMDR_WW') },
            sl: null, sst: null
          }
        }
      };
    });
    return out;
  }

  /** fusionne plusieurs sources marines (ré-échantillonnage à l'heure, union des modèles) */
  function mergeMarine() {
    var out = {};
    Array.prototype.slice.call(arguments).forEach(function (src) {
      if (!src) return;
      Object.keys(src).forEach(function (pid) {
        out[pid] = out[pid] || { series: [] };
        out[pid].series.push(src[pid]);
      });
    });
    return out;
  }

  /** valeur d'une série à l'instant t (interpolation linéaire, max 3 h d'écart) */
  function valueAt(time, arr, t, isAngle) {
    if (!arr || !time || !time.length) return null;
    var lo = 0, hi = time.length - 1;
    if (t < time[0] - 3600000 || t > time[hi] + 3600000) return null;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (time[mid] <= t) lo = mid; else hi = mid; }
    var t0 = time[lo], t1 = time[hi], a = arr[lo], b = arr[hi];
    if (t <= t0) return isNum(a) ? a : null;
    if (t >= t1) return isNum(b) ? b : null;
    if (!isNum(a) || !isNum(b)) {
      if (Math.abs(t - t0) <= 5400000 && isNum(a)) return a;
      if (Math.abs(t1 - t) <= 5400000 && isNum(b)) return b;
      return null;
    }
    if (t1 - t0 > 3 * 3600000) return null;
    var f = (t - t0) / (t1 - t0);
    if (isAngle) return norm360(a + f * angDiff(b, a));
    return a + f * (b - a);
  }

  /** état de mer d'un modèle à l'instant t → {hs,tp,dir,comps} ou null */
  function seaStateAt(model, time, t, mcfg) {
    var hs = valueAt(time, model.hs, t);
    // un Hs exactement nul est une maille masquée (terre), pas une mer d'huile : donnée manquante
    if (!isNum(hs) || hs <= 0.01) return null;
    var tp = valueAt(time, model.tp, t);
    var tm = valueAt(time, model.tm, t);
    if (!isNum(tp) && isNum(tm)) tp = tm * 1.2;
    var dir = valueAt(time, model.dir, t, true);
    var comps = [];
    if (mcfg && mcfg.usePartitions) {
      ['sw1', 'sw2', 'ww'].forEach(function (k) {
        var p = model[k]; if (!p || !p.h) return;
        var h = valueAt(time, p.h, t), tt = valueAt(time, p.t, t), d = valueAt(time, p.d, t, true);
        if (!isNum(tt) && p.tm) { var x = valueAt(time, p.tm, t); if (isNum(x)) tt = x * 1.2; }
        if (isNum(h) && h > 0.02 && isNum(tt) && d != null) comps.push({ h: h, t: tt, d: d, kind: k });
      });
      // contrôle de cohérence : la somme d'énergie des partitions doit retrouver Hs (±35 %)
      var e = comps.reduce(function (s, c) { return s + c.h * c.h; }, 0);
      if (!comps.length || Math.abs(Math.sqrt(e) - hs) > 0.35 * hs + 0.05) comps = [];
    }
    if (!comps.length && isNum(tp) && dir != null) comps = [{ h: hs, t: tp, d: dir, kind: 'total' }];
    var wwH = model.ww && model.ww.h ? valueAt(time, model.ww.h, t) : null;
    return { hs: hs, tp: tp, tm: tm, dir: dir, comps: comps, wwFrac: (isNum(wwH) && hs > 0) ? clamp((wwH * wwH) / (hs * hs), 0, 1) : null,
      sl: model.sl ? valueAt(time, model.sl, t) : null, sst: model.sst ? valueAt(time, model.sst, t) : null };
  }

  function median(a) {
    var v = a.filter(isNum).sort(function (x, y) { return x - y; });
    if (!v.length) return null;
    var k = v.length >> 1; return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
  }
  /**
   * Contrôle de cohérence par point : un modèle dont la médiane de Hs est très inférieure à celle
   * des autres (maille côtière masquée, abritée…) est écarté à ce point. Modifie pointData en place
   * et renvoie la liste des modèles écartés.
   */
  function sanitizePoint(pointData, ratio) {
    ratio = ratio || 0.35;
    if (!pointData || pointData.sanitized) return pointData ? pointData.rejected || [] : [];
    var meds = [];
    pointData.series.forEach(function (s) {
      Object.keys(s.models).forEach(function (m) { meds.push({ s: s, m: m, med: median((s.models[m].hs || []).filter(function (x) { return x > 0.01; })), n: (s.models[m].hs || []).filter(function (x) { return x > 0.01; }).length, len: (s.models[m].hs || []).length }); });
    });
    var rejected = [];
    meds.forEach(function (x) {
      var others = meds.filter(function (y) { return y !== x && isNum(y.med); }).map(function (y) { return y.med; });
      var ref = median(others);
      var mostlyZero = x.len > 0 && x.n < 0.5 * x.len;
      if (mostlyZero || (isNum(ref) && ref > 0.2 && (!isNum(x.med) || x.med < ratio * ref))) { rejected.push(x.m); x.s.rejected = x.s.rejected || {}; x.s.rejected[x.m] = true; }
    });
    pointData.sanitized = true; pointData.rejected = rejected;
    return rejected;
  }

  /** liste [{name, state}] de tous les modèles disponibles pour un point à t */
  function modelsAt(pointData, t, cfg) {
    var res = [];
    if (!pointData) return res;
    sanitizePoint(pointData);
    pointData.series.forEach(function (s) {
      Object.keys(s.models).forEach(function (m) {
        if (s.rejected && s.rejected[m]) return;
        var st = seaStateAt(s.models[m], s.time, t, cfg.waveModels[m] || { usePartitions: false });
        if (st) res.push({ name: m, state: st });
      });
    });
    return res;
  }

  // ------------------------------------------------------------------ vérification contre les bouées
  /**
   * Compare chaque modèle aux mesures d'une bouée.
   * obs : [{t, hs, tm, dir}] ; pointData : données marines au point de la bouée.
   * Renvoie { model: { n, mae, bias, ratio, dirMae, tmBias } }
   */
  function verifyAgainstBuoy(obs, pointData, cfg, nowT) {
    cfg = cfg || DEFAULT_CONFIG;
    var stats = {};
    if (!obs || !obs.length || !pointData) return stats;
    obs.forEach(function (o) {
      if (!isNum(o.hs) || o.hs < cfg.verification.minObsHs) return;
      if (nowT && o.t > nowT) return;
      modelsAt(pointData, o.t, cfg).forEach(function (m) {
        var s = stats[m.name] = stats[m.name] || { n: 0, sumAbs: 0, sumErr: 0, sumObs: 0, sumMod: 0, nb: 0, dirAbs: 0, dirN: 0, tmErr: 0, tmN: 0 };
        var err = m.state.hs - o.hs;
        s.n++; s.sumAbs += Math.abs(err); s.sumErr += err;
        if (o.hs >= cfg.verification.biasMinHs) { s.sumObs += o.hs; s.sumMod += m.state.hs; s.nb++; }
        if (o.dir != null && m.state.dir != null && o.hs > 0.5) { s.dirAbs += Math.abs(angDiff(m.state.dir, o.dir)); s.dirN++; }
        if (isNum(o.tm) && isNum(m.state.tm)) { s.tmErr += m.state.tm - o.tm; s.tmN++; }
      });
    });
    var out = {};
    Object.keys(stats).forEach(function (k) {
      var s = stats[k];
      out[k] = {
        n: s.n, mae: s.n ? s.sumAbs / s.n : null, bias: s.n ? s.sumErr / s.n : null,
        ratio: s.sumMod > 0 ? s.sumObs / s.sumMod : null, nb: s.nb,
        dirMae: s.dirN ? s.dirAbs / s.dirN : null, tmBias: s.tmN ? s.tmErr / s.tmN : null
      };
    });
    return out;
  }

  /**
   * Poids et corrections de biais par modèle pour une bouée.
   * poids = prior / (mae² + mae0²) si assez de paires, sinon prior seul.
   */
  function modelCalibration(verif, cfg) {
    cfg = cfg || DEFAULT_CONFIG; var V = cfg.verification;
    var cal = {};
    Object.keys(cfg.waveModels).forEach(function (m) {
      var prior = cfg.waveModels[m].prior;
      var v = verif && verif[m];
      if (v && v.n >= V.minPairs && isNum(v.mae)) {
        var w = prior / (v.mae * v.mae + V.mae0 * V.mae0);
        var insane = (isNum(v.dirMae) && v.dirMae > V.sanity.dirMae) || (isNum(v.tmBias) && Math.abs(v.tmBias) > V.sanity.tmBias);
        if (insane) w *= V.sanity.factor;
        var nb = isNum(v.nb) ? v.nb : v.n;
        var ratio = isNum(v.ratio) ? 1 + (v.ratio - 1) * nb / (nb + V.biasShrink) : 1;
        cal[m] = { weight: w, bias: clamp(ratio, V.biasClip[0], V.biasClip[1]), verified: true, mae: v.mae, n: v.n, insane: insane };
      } else {
        cal[m] = { weight: prior / (0.3 * 0.3 + V.mae0 * V.mae0), bias: 1, verified: false };
      }
    });
    return cal;
  }

  // ------------------------------------------------------------------ vent
  function windAt(windData, t, cfg) {
    if (!windData) return null;
    var ms = windData.models, time = windData.time, res = {};
    Object.keys(ms).forEach(function (k) {
      var s = valueAt(time, ms[k].spd, t), d = valueAt(time, ms[k].dir, t, true), g = valueAt(time, ms[k].gust, t);
      if (isNum(s) && d != null) res[k] = { spd: s, dir: d, gust: g };
    });
    return res;
  }
  function blendWind(models, leadH, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    var wMf = interp(cfg.windModels.meteofrance, Math.max(0, leadH));
    var mf = models.meteofrance, ec = models.ecmwf;
    if (mf && !ec) return { spd: mf.spd, dir: mf.dir, gust: mf.gust, agree: 0.8, src: 'AROME/ARPEGE' };
    if (ec && (!mf || wMf <= 0)) return { spd: ec.spd, dir: ec.dir, gust: ec.gust, agree: 0.75, src: 'ECMWF' };
    if (!mf && !ec) return null;
    var wEc = 1 - wMf;
    var u = wMf * mf.spd * Math.sin(rad(mf.dir)) + wEc * ec.spd * Math.sin(rad(ec.dir));
    var v = wMf * mf.spd * Math.cos(rad(mf.dir)) + wEc * ec.spd * Math.cos(rad(ec.dir));
    var spd = wMf * mf.spd + wEc * ec.spd; // vitesse scalaire (évite d'écraser le vent quand les directions divergent)
    var dir = norm360(deg(Math.atan2(u, v)));
    var gust = (isNum(mf.gust) && isNum(ec.gust)) ? wMf * mf.gust + wEc * ec.gust : (mf.gust || ec.gust);
    var dd = Math.abs(angDiff(mf.dir, ec.dir)) * Math.min(1, Math.max(mf.spd, ec.spd) / 15);
    var agree = clamp(1 - Math.abs(mf.spd - ec.spd) / 30 - dd / 240, 0.2, 1);
    return { spd: spd, dir: dir, gust: gust, agree: agree, src: wMf >= 0.5 ? 'AROME/ARPEGE' : 'ECMWF' };
  }

  // ------------------------------------------------------------------ cœur : prévision d'un spot
  /**
   * @param spot     fiche spot
   * @param ctx      { marine: {pointId: {series}}, wind: {spotId: data}, buoyObs: {code: [obs]}, now, cfg, calib: {code: cal}, hours }
   */
  function forecastSpot(spot, ctx) {
    var cfg = ctx.cfg || DEFAULT_CONFIG;
    var now = ctx.now;
    var pData = ctx.marine[spot.id];
    var wData = ctx.wind[spot.id];
    var hours = ctx.hours;
    // bouée de référence : la première de la liste du spot qui est au large (pas "côtière")
    // et qui a assez de mesures récentes pour avoir été vérifiée
    var usable = (spot.buoys || []).filter(function (c) {
      var b = ctx.buoyMeta && ctx.buoyMeta[c];
      return !(b && b.nearshore) && ctx.calib && ctx.calib[c] && ctx.calib[c]._verifiedAny;
    });
    var refBuoy = usable[0] || null;
    var cal = (refBuoy && ctx.calib[refBuoy]) || (ctx.calib && ctx.calib._global) || modelCalibration(null, cfg);
    // bouée côtière éventuelle pour l'affichage "mesure près du bord"
    var coastBuoy = (spot.buoys || []).filter(function (c) { var b = ctx.buoyMeta && ctx.buoyMeta[c]; return b && b.nearshore; })[0] || null;

    // --- correction nowcast : rapport mesure / ensemble au point de la bouée
    var nowRatio = null, nowObs = null;
    if (refBuoy && ctx.marine['buoy_' + refBuoy]) {
      var obs = (ctx.buoyObs[refBuoy] || []).filter(function (o) { return isNum(o.hs) && o.t <= now && now - o.t <= cfg.nowcast.maxAgeH * 3600000; });
      if (obs.length) {
        var last = obs.reduce(function (a, b) { return a.t > b.t ? a : b; });
        // moyenne des 3 dernières mesures pour lisser le bruit (mesures à 30 min)
        var recent = obs.filter(function (o) { return last.t - o.t < 3600000; });
        var oh = mean(recent.map(function (o) { return o.hs; }));
        var ens = ensembleHs(modelsAt(ctx.marine['buoy_' + refBuoy], last.t, cfg), cal);
        if (isNum(ens) && ens > 0.15 && oh > 0.15) nowRatio = clamp(oh / ens, cfg.nowcast.ratioClip[0], cfg.nowcast.ratioClip[1]);
        nowObs = { t: last.t, hs: oh, dir: last.dir, tm: last.tm, code: refBuoy };
      }
    }

    // --- historique de vent pour la bascule / l'aplatissement
    var windHist = [];
    var t0 = hours[0] - cfg.bascule.lookbackH * 3600000;
    for (var tt = t0; tt <= hours[hours.length - 1]; tt += 3600000) {
      var wm = windAt(wData, tt, cfg) || {};
      var b = blendWind(wm, (tt - now) / 3600000, cfg);
      windHist.push({ t: tt, w: b });
    }
    function windHistAt(t) { var i = Math.round((t - t0) / 3600000); return windHist[i] ? windHist[i].w : null; }

    var rows = hours.map(function (t) {
      var leadH = (t - now) / 3600000;
      var mods = modelsAt(pData, t, cfg);
      // hauteur surfable par modèle, puis ensemble pondéré
      var per = mods.map(function (m) {
        var c = cal[m.name] || { weight: 0.5, bias: 1 };
        var comps = m.state.comps.map(function (k) { return { h: k.h * c.bias, t: k.t, d: k.d, kind: k.kind }; });
        var sh = surfHeight(comps, spot, cfg);
        return { name: m.name, w: c.weight, hb: sh.hb, dom: sh.dominant, st: m.state, bias: c.bias };
      });
      var W = per.reduce(function (s, p) { return s + p.w; }, 0);
      if (!per.length || !(W > 0)) return { t: t, leadH: leadH, missing: true };
      var hb = per.reduce(function (s, p) { return s + p.w * p.hb; }, 0) / W;
      var hsOff = per.reduce(function (s, p) { return s + p.w * p.st.hs * p.bias; }, 0) / W;
      var spread = Math.sqrt(per.reduce(function (s, p) { return s + p.w * Math.pow(p.hb - hb, 2); }, 0) / W);
      var domDir = circMean(per.map(function (p) { return p.dom ? p.dom.d : p.st.dir; }), per.map(function (p) { return p.w * Math.max(0.01, p.hb); }));
      var tpVals = per.filter(function (p) { return p.dom && isNum(p.dom.t); });
      var tp = tpVals.length ? tpVals.reduce(function (s, p) { return s + p.w * p.dom.t; }, 0) / tpVals.reduce(function (s, p) { return s + p.w; }, 0)
        : mean(per.map(function (p) { return p.st.tp; }));
      var wwFracs = per.filter(function (p) { return isNum(p.st.wwFrac); });
      var wwFrac = wwFracs.length ? wwFracs.reduce(function (s, p) { return s + p.w * p.st.wwFrac; }, 0) / wwFracs.reduce(function (s, p) { return s + p.w; }, 0) : null;

      // correction nowcast qui décroît avec l'échéance
      var nowF = 1;
      if (nowRatio != null && leadH >= -1) nowF = 1 + (nowRatio - 1) * Math.exp(-Math.max(0, leadH) / cfg.nowcast.decayH);
      hb *= nowF; hsOff *= nowF; spread *= nowF;

      // vent
      var w = windHistAt(t);
      var wq = w ? windQuality(w.spd, w.dir, w.gust, spot, cfg) : { q: null, kind: '—' };

      // bascule : coup de marin récent puis vent qui tombe / passe offshore
      var onshoreH = 0, strongOffH = 0;
      for (var k = 1; k <= cfg.bascule.lookbackH; k++) {
        var wp = windHistAt(t - k * 3600000); if (!wp) continue;
        var rel = Math.cos(rad(angDiff(wp.dir, norm360(spot.normal + 180))));
        if (rel < -0.4 && wp.spd >= cfg.bascule.onshoreMinKmh) onshoreH++;
        if (k <= cfg.flattening.lookbackH && rel > 0.5 && wp.spd >= cfg.flattening.offshoreMinKmh) strongOffH++;
      }
      var bascule = onshoreH >= cfg.bascule.minHours && wq.q != null && (wq.rel > 0.25 || w.spd < 10);
      var flattening = strongOffH >= cfg.flattening.minHours;

      // facteurs
      var fSize = sizeFactor(hb, spot);
      var fPer = clamp(periodFactor(tp, cfg), 0, 1.15);
      if (isNum(tp) && tp < (spot.periodMin || 0)) fPer *= 0.85;
      var fWind = wq.q == null ? 0.6 : wq.q;
      // mer du vent dominante + vent onshore : le plan d'eau est haché
      var fChop = 1;
      if (isNum(wwFrac) && wq.rel != null && wq.rel < 0 && w.spd > 12) fChop = 1 - 0.25 * wwFrac;
      // score : base 9 × facteurs (période plafonnée à 1), puis bonus additifs réservés aux conditions
      // déjà bonnes — un 10 doit rester exceptionnel
      var S = cfg.score;
      var core = fSize * Math.min(1, fPer) * fWind * fChop;
      var score = S.base * core;
      if (bascule) score += S.basculeBonus * core;
      if (isNum(tp) && tp >= S.longPeriod) score += S.longPeriodBonus * core * clamp((tp - S.longPeriod) / 2, 0, 1);
      if (flattening) { score *= cfg.flattening.malus; hb *= 0.92; }
      score = clamp(score, 0, 10);

      var elev = solarElevation(t, spot.lat, spot.lon);
      var day = elev > cfg.daylightElevation;

      // confiance
      var relSpread = hb > 0.2 ? clamp(spread / hb, 0, 1) : (spread > 0.15 ? 0.6 : 0.1);
      var leadF = Math.exp(-Math.max(0, leadH) / (24 * 6));
      var nModF = Math.min(1, per.length / 3);
      var conf = clamp((1 - 0.8 * relSpread) * (w ? w.agree : 0.6) * leadF * (0.6 + 0.4 * nModF) * (spot.confidence === 'low' ? 0.85 : 1), 0.05, 1);

      return {
        t: t, leadH: leadH, day: day,
        hb: hb, hbLo: Math.max(0, hb - spread), hbHi: hb + spread,
        hsOff: hsOff, tp: tp, dir: domDir, power: wavePower(hsOff, tp), wwFrac: wwFrac,
        wind: w ? { spd: w.spd, dir: w.dir, gust: w.gust, kind: wq.kind, q: wq.q, src: w.src } : null,
        bascule: bascule, flattening: flattening,
        factors: { size: fSize, period: fPer, wind: fWind, chop: fChop, now: nowF },
        score: score, stars: Math.round(score / 2 * 2) / 2, label: label(score, hb, spot),
        conf: conf, nModels: per.length,
        models: per.map(function (p) { return { name: p.name, hb: +p.hb.toFixed(2), hs: +p.st.hs.toFixed(2), w: +(p.w / W).toFixed(3) }; }),
        sl: mean(per.map(function (p) { return p.st.sl; })), sst: mean(per.map(function (p) { return p.st.sst; }))
      };
    });

    rows.forEach(function (r) { if (!r.missing) r.text = explain(r, spot); });
    var coastObs = null;
    if (coastBuoy && ctx.buoyObs[coastBuoy]) {
      var co = ctx.buoyObs[coastBuoy].filter(function (o) { return isNum(o.hs) && o.t <= now && now - o.t <= cfg.nowcast.maxAgeH * 3600000; });
      if (co.length) { var cl = co[co.length - 1]; coastObs = { t: cl.t, hs: cl.hs, tm: cl.tm, dir: cl.dir, code: coastBuoy }; }
    }
    return { spot: spot, rows: rows, nowObs: nowObs, nowRatio: nowRatio, refBuoy: refBuoy, coastObs: coastObs, windows: findWindows(rows, spot, cfg) };
  }

  function ensembleHs(mods, cal) {
    var W = 0, s = 0;
    mods.forEach(function (m) { var c = cal[m.name] || { weight: 0.5, bias: 1 }; W += c.weight; s += c.weight * m.state.hs * c.bias; });
    return W > 0 ? s / W : null;
  }

  function label(score, hb, spot) {
    if (hb < spot.size.min * 0.6) return 'flat';
    if (score < 1.5) return 'pas surfable';
    if (score < 3) return 'petit / médiocre';
    if (score < 5) return 'surfable';
    if (score < 7) return 'bon';
    if (score < 8.5) return 'très bon';
    return 'épique';
  }

  function fmt(x, d) { return (x == null || !isFinite(x)) ? '—' : x.toFixed(d == null ? 1 : d).replace('.', ','); }

  function explain(r, spot) {
    var parts = [fmt(r.hb) + ' m au bord'];
    parts.push('houle ' + compass(r.dir) + ' ' + fmt(r.tp, 0) + ' s');
    if (r.wind) parts.push('vent ' + compass(r.wind.dir) + ' ' + Math.round(r.wind.spd) + ' km/h ' + r.wind.kind);
    if (r.bascule) parts.push('après coup de marin');
    if (r.flattening) parts.push('tramontane/mistral forte depuis plusieurs heures');
    void spot;
    return parts.join(' · ');
  }

  /** regroupe les heures de jour consécutives au-dessus du seuil */
  function findWindows(rows, spot, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    var wins = [], cur = null;
    rows.forEach(function (r) {
      var ok = !r.missing && r.day && r.score >= cfg.windowThreshold && r.leadH > -1;
      if (ok) {
        if (!cur) cur = { spot: spot.id, start: r.t, end: r.t, peak: r, sum: 0, n: 0 };
        cur.end = r.t; cur.sum += r.score; cur.n++;
        if (r.score > cur.peak.score) cur.peak = r;
      } else if (cur) { push(); }
    });
    if (cur) push();
    function push() {
      if (cur.n >= cfg.windowMinHours) {
        cur.mean = cur.sum / cur.n; cur.end += 3600000;
        cur.rank = cur.mean * 0.6 + cur.peak.score * 0.4 + Math.min(cur.n, 6) * 0.15;
        wins.push(cur);
      }
      cur = null;
    }
    return wins;
  }

  // ------------------------------------------------------------------ orchestration
  /**
   * Lance tout : vérification, calibration, prévision de chaque spot, classement.
   * input = { spots, buoys, marine: {pointId:{series}}, wind, buoyObs, now, cfg, days }
   */
  function run(input) {
    var cfg = mergeCfg(DEFAULT_CONFIG, input.cfg || {});
    var now = input.now || Date.now();
    var start = Math.floor(now / 3600000) * 3600000 - 6 * 3600000;
    var hours = []; for (var i = 0; i < (input.days || 7) * 24 + 6; i++) hours.push(start + i * 3600000);

    // mesures : on écarte celles du futur (mode rejeu) et les trop anciennes
    var buoyObs = {}, buoyMeta = {};
    var minT = now - cfg.verification.maxAgeDays * 86400000;
    (input.buoys || []).forEach(function (b) {
      buoyMeta[b.code] = { code: b.code, name: b.name, nearshore: isNum(b.depth) && b.depth < cfg.verification.nearshoreDepth };
      var o = input.buoyObs && input.buoyObs[b.code];
      if (o) buoyObs[b.code] = o.filter(function (x) { return x.t <= now && x.t >= minT; });
    });

    // vérification par bouée (bouées au large uniquement pour la calibration)
    var verif = {}, calib = {};
    (input.buoys || []).forEach(function (b) {
      var obs = buoyObs[b.code];
      var pd = input.marine['buoy_' + b.code];
      if (obs && obs.length && pd) {
        verif[b.code] = verifyAgainstBuoy(obs, pd, cfg, now);
        if (!buoyMeta[b.code].nearshore) {
          calib[b.code] = modelCalibration(verif[b.code], cfg);
          calib[b.code]._verifiedAny = Object.keys(calib[b.code]).some(function (m) { return calib[b.code][m].verified; });
        }
      }
    });
    var offVerif = {};
    Object.keys(verif).forEach(function (c) { if (!buoyMeta[c].nearshore) offVerif[c] = verif[c]; });
    calib._global = globalCalibration(offVerif, cfg);

    var ctx = { marine: input.marine, wind: input.wind, buoyObs: buoyObs, buoyMeta: buoyMeta, now: now, cfg: cfg, calib: calib, hours: hours };
    var spots = input.spots.map(function (s) { return forecastSpot(s, ctx); });
    var windows = [];
    spots.forEach(function (s) { windows = windows.concat(s.windows); });
    windows.sort(function (a, b) { return b.rank - a.rank; });
    return { now: now, hours: hours, spots: spots, windows: windows, verification: verif, calibration: calib, buoyMeta: buoyMeta, buoyObs: buoyObs, cfg: cfg };
  }

  /**
   * Test de calibration "à l'aveugle" : on calibre les modèles avec les mesures antérieures à splitT,
   * puis on compare, sur les mesures postérieures, l'ensemble brut (poids a priori, sans biais)
   * à l'ensemble calibré. Renvoie les MAE et biais de chaque variante.
   */
  function backtestSplit(obs, pointData, splitT, cfg) {
    cfg = mergeCfg(DEFAULT_CONFIG, cfg || {});
    var train = obs.filter(function (o) { return o.t < splitT; });
    var test = obs.filter(function (o) { return o.t >= splitT && isNum(o.hs) && o.hs >= cfg.verification.minObsHs; });
    var cal = modelCalibration(verifyAgainstBuoy(train, pointData, cfg), cfg);
    var raw = modelCalibration(null, cfg);
    var acc = { raw: { n: 0, abs: 0, err: 0 }, cal: { n: 0, abs: 0, err: 0 }, best: {} };
    test.forEach(function (o) {
      var mods = modelsAt(pointData, o.t, cfg); if (!mods.length) return;
      [['raw', raw], ['cal', cal]].forEach(function (p) {
        var e = ensembleHs(mods, p[1]); if (!isNum(e)) return;
        var a = acc[p[0]]; a.n++; a.abs += Math.abs(e - o.hs); a.err += e - o.hs;
      });
      mods.forEach(function (m) {
        var b = acc.best[m.name] = acc.best[m.name] || { n: 0, abs: 0 };
        b.n++; b.abs += Math.abs(m.state.hs - o.hs);
      });
    });
    var f = function (a) { return a.n ? { n: a.n, mae: a.abs / a.n, bias: a.err / a.n } : null; };
    var single = {};
    Object.keys(acc.best).forEach(function (k) { single[k] = acc.best[k].abs / acc.best[k].n; });
    return { raw: f(acc.raw), calibrated: f(acc.cal), singleModelMae: single, nTrain: train.length, nTest: test.length };
  }

  function globalCalibration(verif, cfg) {
    // agrège toutes les bouées : MAE moyenne pondérée par n
    var agg = {};
    Object.keys(verif).forEach(function (code) {
      Object.keys(verif[code]).forEach(function (m) {
        var v = verif[code][m]; if (!v.n) return;
        var a = agg[m] = agg[m] || { n: 0, nb: 0, mae: 0, ratioNum: 0, ratioDen: 0 };
        a.n += v.n; a.nb += (v.nb || 0); a.mae += v.mae * v.n; a.ratioNum += (v.ratio || 1) * v.n; a.ratioDen += v.n;
      });
    });
    var merged = {};
    Object.keys(agg).forEach(function (m) { var a = agg[m]; merged[m] = { n: a.n, nb: a.nb, mae: a.mae / a.n, ratio: a.ratioNum / a.ratioDen }; });
    return modelCalibration(merged, cfg);
  }

  function mergeCfg(a, b) {
    var o = JSON.parse(JSON.stringify(a));
    (function rec(t, s) {
      Object.keys(s).forEach(function (k) {
        if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object') rec(t[k], s[k]);
        else t[k] = s[k];
      });
    })(o, b);
    return o;
  }

  /** prépare la liste des points à interroger (spots au large + bouées) */
  function queryPoints(spots, buoys, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    var pts = spots.map(function (s) { var p = modelPoint(s, cfg); return { id: s.id, lat: p.lat, lon: p.lon }; });
    (buoys || []).forEach(function (b) { pts.push({ id: 'buoy_' + b.code, lat: b.modelLat || b.lat, lon: b.modelLon || b.lon }); });
    return pts;
  }

  /** parse le tableau temps réel public Candhis (lignes [date, heure TU, H1/3, Hmax, Th1/3, dir, étalement, temp]) */
  function parseCandhisRows(rows) {
    var num = function (s) { var x = parseFloat(String(s).replace(',', '.')); return isFinite(x) ? x : null; };
    return rows.map(function (r) {
      var d = r[0].split('/'), hm = r[1].split(':');
      return { t: Date.UTC(+d[2], +d[1] - 1, +d[0], +hm[0], +hm[1]), hs: num(r[2]), hmax: num(r[3]), tm: num(r[4]), dir: num(r[5]), spread: num(r[6]), sst: num(r[7]) };
    }).filter(function (o) { return isFinite(o.t); }).sort(function (a, b) { return a.t - b.t; });
  }

  // ------------------------------------------------------------------ sérialisation (forecast.json)
  function r2(x) { return isNum(x) ? Math.round(x * 100) / 100 : null; }
  function r0(x) { return isNum(x) ? Math.round(x) : null; }
  /** Résultat de run() → JSON compact consommé par l'app web et le widget */
  function toForecastJSON(res, meta) {
    meta = meta || {};
    var col = function (rows, f) { return rows.map(function (r) { return r.missing ? null : f(r); }); };
    var spots = res.spots.map(function (s) {
      var rows = s.rows.filter(function (r) { return r.leadH >= -6; });
      var sp = s.spot;
      return {
        id: sp.id, name: sp.name, commune: sp.commune, lat: sp.lat, lon: sp.lon, normal: sp.normal,
        level: sp.level, confidence: sp.confidence, size: sp.size, swell: sp.swell,
        refBuoy: s.refBuoy, nowRatio: r2(s.nowRatio),
        nowObs: s.nowObs && { t: s.nowObs.t, hs: r2(s.nowObs.hs), tm: r2(s.nowObs.tm), dir: r0(s.nowObs.dir), code: s.nowObs.code },
        coastObs: s.coastObs && { t: s.coastObs.t, hs: r2(s.coastObs.hs), tm: r2(s.coastObs.tm), dir: r0(s.coastObs.dir), code: s.coastObs.code },
        h: {
          t: rows.map(function (r) { return r.t; }),
          score: col(rows, function (r) { return Math.round(r.score * 10) / 10; }),
          hb: col(rows, function (r) { return r2(r.hb); }), lo: col(rows, function (r) { return r2(r.hbLo); }), hi: col(rows, function (r) { return r2(r.hbHi); }),
          hs: col(rows, function (r) { return r2(r.hsOff); }), tp: col(rows, function (r) { return Math.round(r.tp * 10) / 10; }), dir: col(rows, function (r) { return r0(r.dir); }),
          ws: col(rows, function (r) { return r.wind ? r0(r.wind.spd) : null; }), wd: col(rows, function (r) { return r.wind ? r0(r.wind.dir) : null; }),
          wg: col(rows, function (r) { return r.wind ? r0(r.wind.gust) : null; }), wk: col(rows, function (r) { return r.wind ? r.wind.kind : null; }),
          day: rows.map(function (r) { return !!r.day; }), conf: col(rows, function (r) { return r2(r.conf); }),
          bas: col(rows, function (r) { return r.bascule ? 1 : 0; }), flat: col(rows, function (r) { return r.flattening ? 1 : 0; }),
          pw: col(rows, function (r) { return r0(r.power); }), n: col(rows, function (r) { return r.nModels; }),
          sst: col(rows, function (r) { return r2(r.sst); })
        },
        windows: s.windows.map(function (w) { return { start: w.start, end: w.end, mean: r2(w.mean), peak: r2(w.peak.score), text: w.peak.text, conf: r2(w.peak.conf) }; })
      };
    });
    var verif = {};
    Object.keys(res.verification || {}).forEach(function (c) {
      verif[c] = {};
      Object.keys(res.verification[c]).forEach(function (m) {
        var v = res.verification[c][m]; var cal = res.calibration[c] && res.calibration[c][m];
        verif[c][m] = { n: v.n, mae: r2(v.mae), bias: r2(v.bias), dirMae: r0(v.dirMae), w: cal ? r2(cal.weight) : null, k: cal ? r2(cal.bias) : null, off: cal && cal.insane ? 1 : 0 };
      });
    });
    var buoys = {};
    Object.keys(res.buoyObs || {}).forEach(function (c) {
      var o = res.buoyObs[c].filter(function (x) { return x.t >= res.now - 48 * 3600000; });
      var m = res.buoyMeta[c] || {};
      buoys[c] = { name: m.name, nearshore: !!m.nearshore, t: o.map(function (x) { return x.t; }), hs: o.map(function (x) { return x.hs; }), tm: o.map(function (x) { return x.tm; }), dir: o.map(function (x) { return x.dir; }) };
    });
    return {
      version: 'surf-engine ' + VERSION_STR, generated: meta.generated || Date.now(), now: res.now,
      sources: meta.sources || {}, spots: spots,
      windows: res.windows.slice(0, 12).map(function (w) { return { spot: w.spot, start: w.start, end: w.end, mean: r2(w.mean), peak: r2(w.peak.score), text: w.peak.text, conf: r2(w.peak.conf) }; }),
      verification: verif, buoys: buoys
    };
  }
  var VERSION_STR = '1.0.0';

  return {
    VERSION: VERSION_STR, toForecastJSON: toForecastJSON,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    // maths
    norm360: norm360, angDiff: angDiff, circMean: circMean, inArc: inArc, distToArc: distToArc, interp: interp, compass: compass,
    offsetPoint: offsetPoint, modelPoint: modelPoint, solarElevation: solarElevation,
    // physique
    breakingHeight: breakingHeight, windowFactor: windowFactor, surfHeight: surfHeight, wavePower: wavePower,
    windQuality: windQuality, periodFactor: periodFactor, sizeFactor: sizeFactor, blendWind: blendWind,
    // données
    OM_MARINE_VARS: OM_MARINE_VARS, OM_WAVE_MODELS: OM_WAVE_MODELS, OM_WIND_MODELS: OM_WIND_MODELS,
    openMeteoMarineURL: openMeteoMarineURL, openMeteoWindURL: openMeteoWindURL,
    parseOpenMeteoMarine: parseOpenMeteoMarine, parseOpenMeteoWind: parseOpenMeteoWind, parseCopernicus: parseCopernicus,
    parseCandhisRows: parseCandhisRows, mergeMarine: mergeMarine, valueAt: valueAt, seaStateAt: seaStateAt, modelsAt: modelsAt,
    queryPoints: queryPoints, sanitizePoint: sanitizePoint, median: median,
    // vérification + prévision
    verifyAgainstBuoy: verifyAgainstBuoy, modelCalibration: modelCalibration, forecastSpot: forecastSpot, findWindows: findWindows,
    run: run, backtestSplit: backtestSplit, ensembleHs: ensembleHs, mergeCfg: mergeCfg, explain: explain, label: label, fmt: fmt
  };
});
