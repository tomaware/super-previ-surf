// Super Prévi Surf — widget iPhone (app Scriptable, gratuite)
// 1. Installer Scriptable depuis l'App Store
// 2. Nouveau script, coller ce fichier (FORECAST_URL pointe déjà sur ton site GitHub Pages)
// 3. Écran d'accueil → ajouter un widget Scriptable (petit ou moyen) → choisir ce script
// Le widget lit data/forecast.json (recalculé chaque heure par GitHub Actions) : rien n'est calculé sur le téléphone.

const FORECAST_URL = "https://tomaware.github.io/super-previ-surf/data/forecast.json";
const SITE_URL = FORECAST_URL.replace("data/forecast.json", "");
const TZ = "Europe/Paris";

const COLORS = ["#4e5d69", "#d29a3a", "#d8c443", "#56c271", "#37d0c0", "#9b82ff"];
const bucket = (s) => (s == null ? 0 : s < 1.5 ? 0 : s < 3 ? 1 : s < 5 ? 2 : s < 7 ? 3 : s < 8.5 ? 4 : 5);
const f1 = (x) => (x == null ? "—" : x.toFixed(1).replace(".", ","));
const fmt = (t, o) => new Date(t).toLocaleString("fr-FR", Object.assign({ timeZone: TZ }, o));
const hh = (t) => fmt(t, { hour: "2-digit", minute: "2-digit" }).replace(":00", " h");
function dayLabel(t) {
  const k = (x) => fmt(x, { year: "numeric", month: "2-digit", day: "2-digit" });
  if (k(t) === k(Date.now())) return "Auj.";
  if (k(t) === k(Date.now() + 86400e3)) return "Demain";
  return fmt(t, { weekday: "short", day: "numeric" });
}

async function load() {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.documentsDirectory(), "super-previ-surf.json");
  try {
    const req = new Request(FORECAST_URL);
    req.timeoutInterval = 15;
    const d = await req.loadJSON();
    if (!d || !d.spots) throw new Error("réponse invalide");
    fm.writeString(cache, JSON.stringify(d));
    return d;
  } catch (e) {
    if (fm.fileExists(cache)) { const d = JSON.parse(fm.readString(cache)); d._offline = true; return d; }
    throw e;
  }
}

function nowIdx(sp) {
  let best = 0, bd = Infinity;
  sp.h.t.forEach((t, i) => { const d = Math.abs(t - Date.now()); if (d < bd) { bd = d; best = i; } });
  return best;
}

function pill(stack, s, size) {
  const p = stack.addStack();
  p.backgroundColor = new Color(COLORS[bucket(s)]);
  p.cornerRadius = 6;
  p.setPadding(2, 6, 2, 6);
  const t = p.addText(f1(s));
  t.font = Font.boldMonospacedSystemFont(size || 13);
  t.textColor = new Color(bucket(s) === 0 ? "#e8eef2" : "#08161d");
}

async function build() {
  const w = new ListWidget();
  w.backgroundColor = new Color("#0b1620");
  w.url = SITE_URL;
  w.setPadding(12, 14, 12, 14);
  let d;
  try { d = await load(); } catch (e) {
    const t = w.addText("Prévi surf indisponible\n" + e.message); t.textColor = Color.white(); t.font = Font.systemFont(12);
    return w;
  }
  const family = config.widgetFamily || "medium";
  const title = w.addText("SURF · " + (d._offline ? "hors ligne" : "calculé " + hh(d.generated)));
  title.font = Font.semiboldSystemFont(10); title.textColor = new Color("#6f8291");
  w.addSpacer(6);

  const wins = (d.windows || []).filter((x) => x.end > Date.now());
  const best = wins[0];
  if (best) {
    const sp = d.spots.find((s) => s.id === best.spot);
    const row = w.addStack(); row.centerAlignContent();
    const name = row.addText(sp ? sp.name : best.spot);
    name.font = Font.boldSystemFont(family === "small" ? 14 : 16); name.textColor = Color.white(); name.lineLimit = 1;
    row.addSpacer(); pill(row, best.mean, 14);
    const when = w.addText(dayLabel(best.start) + " " + hh(best.start) + "–" + hh(best.end));
    when.font = Font.systemFont(12); when.textColor = new Color("#a9b8c3");
    if (family !== "small") {
      const tx = w.addText(best.text); tx.font = Font.systemFont(11); tx.textColor = new Color("#a9b8c3"); tx.lineLimit = 2;
    }
  } else {
    const t = w.addText("Pas de créneau surfable sur 7 jours"); t.font = Font.systemFont(13); t.textColor = Color.white();
  }

  if (family !== "small") {
    w.addSpacer(8);
    // les 3 meilleurs spots maintenant
    const now = d.spots.map((sp) => { const i = nowIdx(sp); return { sp, s: sp.h.score[i], hb: sp.h.hb[i], ws: sp.h.ws[i], wk: sp.h.wk[i] }; })
      .sort((a, b) => (b.s || 0) - (a.s || 0)).slice(0, 3);
    now.forEach((x) => {
      const r = w.addStack(); r.centerAlignContent();
      const n = r.addText(x.sp.name.replace(/ \(.*\)/, "")); n.font = Font.systemFont(12); n.textColor = Color.white(); n.lineLimit = 1;
      r.addSpacer();
      const m = r.addText(f1(x.hb) + " m · " + (x.ws == null ? "—" : x.ws) + " km/h  "); m.font = Font.systemFont(11); m.textColor = new Color("#a9b8c3");
      pill(r, x.s, 11);
      w.addSpacer(3);
    });
  }
  // prochaine mise à jour souhaitée : 30 min
  w.refreshAfterDate = new Date(Date.now() + 30 * 60e3);
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
