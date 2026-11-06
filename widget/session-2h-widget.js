// Session 2 h — widget iPhone (app Scriptable)
// Coller ce script dans Scriptable, puis ajouter un widget Scriptable (petit ou moyen) qui l'utilise.
// Il charge la prévision et la logique de choix depuis ton site : rien à mettre à jour ici.
// Tes créneaux pour le widget se règlent juste en dessous (l'app web garde les siens dans le navigateur).

const SITE = "https://tomaware.github.io/super-previ-surf/";
const PREFS = {
  spots: ["palavas", "carnon"],
  len: 2,          // durée de session (h)
  min: 4,          // note mini pour bouger
  week: [
    { on: true, from: 7, to: 9 },      // avant le boulot
    { on: true, from: 12, to: 14 },    // pause de midi
    { on: true, from: 17.5, to: 21 }   // après le boulot
  ],
  weekend: { on: true, from: 7, to: 20 }
};

const TZ = "Europe/Paris";
const NAMES = { palavas: "Palavas", carnon: "Carnon" };
const COLORS = ["#3e5560", "#d29a3a", "#d8c443", "#56c271", "#37d0c0", "#9b82ff"];
const bucket = (s) => (s == null ? 0 : s < 1.5 ? 0 : s < 3 ? 1 : s < 5 ? 2 : s < 7 ? 3 : s < 8.5 ? 4 : 5);
const f1 = (x) => (x == null ? "—" : x.toFixed(1).replace(".", ","));
const hm = (t) => new Date(t).toLocaleTimeString("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).replace(":00", " h").replace(":", " h ");

async function getText(url) {
  const r = new Request(url + (url.includes("?") ? "&" : "?") + "t=" + Math.floor(Date.now() / 600e3));
  r.timeoutInterval = 20;
  const txt = await r.loadString();
  const code = r.response && r.response.statusCode;
  if (code && code !== 200) throw new Error("le site répond " + code);
  return txt;
}

async function load() {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.documentsDirectory(), "session-2h-cache.json");
  try {
    const [core, fc] = await Promise.all([getText(SITE + "session/session-core.js"), getText(SITE + "data/forecast.json")]);
    let forecast;
    try { forecast = JSON.parse(fc); } catch (_) { throw new Error("prévision illisible"); }
    fm.writeString(cache, JSON.stringify({ core, forecast }));
    return { core, forecast };
  } catch (e) {
    if (fm.fileExists(cache)) { const c = JSON.parse(fm.readString(cache)); c.offline = true; return c; }
    throw e;
  }
}

function dayLabel(S, t) {
  const k = S.local(t).key;
  if (k === S.local(Date.now()).key) return "Aujourd'hui";
  if (k === S.local(Date.now() + 864e5).key) return "Demain";
  const s = new Date(t).toLocaleDateString("fr-FR", { timeZone: TZ, weekday: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function build() {
  const w = new ListWidget();
  w.backgroundColor = new Color("#0c1d26");
  w.url = SITE + "session/";
  w.setPadding(12, 14, 12, 14);
  const family = config.widgetFamily || "medium";
  let S, data;
  try {
    data = await load();
    const m = { exports: {} };
    new Function("module", "self", data.core)(m, {});
    S = m.exports;
    if (!S || !S.plan) throw new Error("logique introuvable");
  } catch (e) {
    const t = w.addText("Session 2 h indisponible\n" + e.message); t.textColor = Color.white(); t.font = Font.systemFont(12);
    return w;
  }
  const P = S.plan(data.forecast, PREFS, Date.now());
  const s = P.next;

  const head = w.addText("SESSION 2 H" + (data.offline ? " · hors ligne" : ""));
  head.font = Font.semiboldSystemFont(10); head.textColor = new Color("#6c8692");
  w.addSpacer(4);

  if (!s) {
    const t = w.addText("Pas cette semaine"); t.font = Font.boldSystemFont(18); t.textColor = Color.white();
    if (P.top) { const u = w.addText("Le moins pire : " + dayLabel(S, P.top.start) + " " + hm(P.top.start) + ", " + f1(P.top.score) + "/10"); u.font = Font.systemFont(11); u.textColor = new Color("#a3b7bf"); }
    return w;
  }
  const d = w.addText(dayLabel(S, s.start)); d.font = Font.boldSystemFont(family === "small" ? 16 : 18); d.textColor = Color.white();
  const row = w.addStack(); row.centerAlignContent();
  const tm = row.addStack(); tm.backgroundColor = new Color("#ffd23f"); tm.cornerRadius = 6; tm.setPadding(1, 6, 1, 6);
  const tt = tm.addText(hm(s.start) + " → " + hm(s.end)); tt.font = Font.boldSystemFont(family === "small" ? 14 : 17); tt.textColor = new Color("#2b2100");
  row.addSpacer();
  const p = row.addStack(); p.backgroundColor = new Color(COLORS[bucket(s.score)]); p.cornerRadius = 6; p.setPadding(2, 6, 2, 6);
  const pt = p.addText(f1(s.score)); pt.font = Font.boldMonospacedSystemFont(13); pt.textColor = new Color(bucket(s.score) === 0 ? "#e9f1f3" : "#0c1d26");
  w.addSpacer(4);
  const where = w.addText((NAMES[s.spot] || s.name) + " · " + f1(s.hb) + " m · vent " + (s.ws == null ? "—" : Math.round(s.ws)) + " km/h " + (s.wk || ""));
  where.font = Font.systemFont(11); where.textColor = new Color("#a3b7bf"); where.lineLimit = 2;
  if (family !== "small" && P.best && P.best !== s && P.best.score >= s.score + 1) {
    w.addSpacer(4);
    const b = w.addText("Mieux : " + dayLabel(S, P.best.start) + " " + hm(P.best.start) + " (" + f1(P.best.score) + ")");
    b.font = Font.systemFont(11); b.textColor = new Color("#ffd23f");
  }
  w.refreshAfterDate = new Date(Date.now() + 30 * 60e3);
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
