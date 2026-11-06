#!/usr/bin/env node
// Construit dist/super-previ-surf.html : un seul fichier, moteur et fiches spots intégrés,
// qui calcule la prévision en direct depuis Open-Meteo (s'ouvre tel quel, même hors GitHub).
'use strict';
const fs = require('fs'), path = require('path');
const { minify } = require('terser');
const ROOT = path.resolve(__dirname, '..');
(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  const eng = (await minify(fs.readFileSync(path.join(ROOT, 'engine/surf-engine.js'), 'utf8'), { compress: true, mangle: true })).code;
  const spots = JSON.stringify(require(path.join(ROOT, 'engine/spots.json')));
  const appSrc = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
  const app = (await minify(appSrc, { compress: true, mangle: true })).code;
  let out = html.replace('<script src="surf-engine.js"></script>', () => '<script>' + eng + '\nwindow.SPOTS_FALLBACK=' + spots + ';</script>')
    .replace(/<script>\n[\s\S]*?<\/script>/, () => '<script>' + app + '</script>');
  const dest = path.join(ROOT, 'dist/super-previ-surf.html');
  fs.writeFileSync(dest, out);
  console.log('dist/super-previ-surf.html', (out.length / 1024).toFixed(1), 'ko');
})();
