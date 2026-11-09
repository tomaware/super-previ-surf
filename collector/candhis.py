"""
Mesures des bouées Candhis (Cerema) — licence ouverte Etalab
-------------------------------------------------------------
Lit les ~48 dernières heures publiées en temps réel sur candhis.cerema.fr pour chaque bouée de
engine/spots.json, et les ajoute à data/history/buoys.json (historique glissant de 35 jours,
indispensable pour vérifier et calibrer les modèles).

Source principale : le tableau public (aucun quota). Si une bouée n'y répond pas (site en
maintenance, page modifiée) ou n'y a rien de récent, on passe par l'API officielle Candhis
avec la clé CANDHIS_KEY (secret GitHub), dans la limite de API_BUDGET requêtes par jour
(la limite Candhis est de 150 par jour, partagée avec tout autre usage de la clé).
Vérifié le 09/11/2026 : l'API et le tableau public donnent exactement les mêmes valeurs
(H1/3, Th1/3, direction, heures en temps universel) aux 4 bouées en service.

Mention obligatoire : « Candhis – Cerema, données temps réel ».
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://candhis.cerema.fr/_public_/campagne.php?"
KEEP_DAYS = 35
API = "https://candhis.cerema.fr/API/v1/"
API_BUDGET = 40             # requêtes API par jour au plus depuis GitHub (secours seulement)
STALE_H = 3                 # tableau public sans mesure depuis 3 h → on tente l'API
UA = "SuperPreviSurf/1.0 (usage personnel; donnees Candhis Etalab)"


class _TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self._row, self._cell, self._in_cell = [], None, [], False

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._in_cell, self._cell = True, []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._row is not None and self._in_cell:
            self._row.append("".join(self._cell).strip())
            self._in_cell = False
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._in_cell:
            self._cell.append(data)


def _num(s: str):
    try:
        return float(s.replace(",", "."))
    except (ValueError, AttributeError):
        return None


def parse_rows(rows: list[list[str]]) -> list[dict]:
    """[date, heure TU, H1/3, Hmax, Th1/3, dir pic, étalement, temp] → mesures (même logique que parseCandhisRows)."""
    out = []
    for r in rows:
        if len(r) < 6 or len(r[0]) != 10 or r[0][2] != "/":
            continue
        try:
            d, m, y = (int(x) for x in r[0].split("/"))
            hh, mm = (int(x) for x in r[1].split(":"))
        except ValueError:
            continue
        t = int(datetime(y, m, d, hh, mm, tzinfo=timezone.utc).timestamp() * 1000)
        o = {"t": t, "hs": _num(r[2]), "hmax": _num(r[3]), "tm": _num(r[4]), "dir": _num(r[5]),
             "spread": _num(r[6]) if len(r) > 6 else None, "sst": _num(r[7]) if len(r) > 7 else None}
        if o["hs"] is not None or o["dir"] is not None:
            out.append(o)
    return sorted(out, key=lambda o: o["t"])


def fetch_public(code: str) -> list[dict]:
    url = BASE + base64.b64encode(f"camp={code}".encode()).decode()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    p = _TableParser()
    p.feed(html)
    return parse_rows(p.rows)


# ---------------------------------------------------------------- API officielle (secours)
def _val(o: dict, patterns: list[str]):
    """Valeur de la première colonne dont le nom correspond (les noms exacts varient selon le capteur)."""
    for pat in patterns:
        for k, v in o.items():
            if re.search(pat, str(k), re.I) and v not in ("", None):
                return v
    return None


def _clean(x, maxi):
    v = _num(str(x)) if x is not None else None
    return None if v is None or v >= maxi or v < 0 else v   # 999.9999 / 99.90 : valeur absente


def parse_api(js: dict) -> list[dict]:
    """Réponse getCampTR { entete, results } → mesures au même format que le tableau public."""
    if not js or not js.get("results"):
        return []
    ent = js.get("entete") or []
    out = []
    for r in js["results"]:
        if isinstance(r, dict):
            o = r
        elif isinstance(r, list):
            noms = (["Code campagne"] + ent) if len(r) == len(ent) + 1 else ent
            o = {(noms[i] if i < len(noms) else f"c{i}"): v for i, v in enumerate(r)}
        else:
            continue
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})", str(_val(o, [r"^date", r"heure", r"time"]) or ""))
        if not m:
            continue
        y, mo, d, hh, mm = (int(x) for x in m.groups())
        t = int(datetime(y, mo, d, hh, mm, tzinfo=timezone.utc).timestamp() * 1000)
        ob = {"t": t,
              "hs": _clean(_val(o, [r"^h\s*1/3", r"^h13", r"^hm0", r"^hs$"]), 20),
              "hmax": _clean(_val(o, [r"^hmax"]), 40),
              "tm": _clean(_val(o, [r"^th\s*1/3", r"^th13", r"^t02", r"^tm"]), 40),
              "dir": _clean(_val(o, [r"^dir"]), 361),
              "spread": _clean(_val(o, [r"^[ée]tal"]), 361),
              "sst": _clean(_val(o, [r"^temp"]), 40)}
        if ob["hs"] is not None or ob["dir"] is not None:
            out.append(ob)
    return sorted(out, key=lambda o: o["t"])


def _budget(state_path: Path) -> dict:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        st = json.loads(state_path.read_text())
    except (OSError, ValueError):
        st = {}
    if st.get("jour") != today:
        st = {"jour": today, "n": 0, "vide": st.get("vide", {}), "historique": st.get("historique", {})}
    st.setdefault("vide", {})
    return st


def fetch_api(code: str, key: str, state: dict, days: int = 1) -> list[dict]:
    """Mesures d'une bouée par l'API depuis `days` jours (dateFin = aujourd'hui, en temps universel)."""
    now = datetime.now(timezone.utc)
    q = {"camp": code, "dateDeb": (now - timedelta(days=days)).strftime("%Y-%m-%d"), "dateFin": now.strftime("%Y-%m-%d")}
    if state["n"] >= API_BUDGET:
        raise RuntimeError(f"budget API du jour atteint ({state['n']})")
    state["n"] += 1
    req = urllib.request.Request(API + "getCampTR.php?" + urllib.parse.urlencode(q), headers={"Authorization": key, "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            js = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        if e.code in (429, 423):
            state["n"] = API_BUDGET          # quota Candhis atteint ou adresse bloquée : plus rien aujourd'hui
        raise RuntimeError(f"API HTTP {e.code}") from None
    return parse_api(js)


def merge(history: dict, code: str, obs: list[dict], now_ms: int) -> int:
    old = {o["t"]: o for o in history.get(code, [])}
    added = sum(1 for o in obs if o["t"] not in old)
    for o in obs:
        old[o["t"]] = o
    cutoff = now_ms - KEEP_DAYS * 86400_000
    history[code] = sorted((o for o in old.values() if o["t"] >= cutoff), key=lambda o: o["t"])
    return added


def main() -> int:
    spots = json.loads((ROOT / "engine" / "spots.json").read_text())
    hist_path = ROOT / "data" / "history" / "buoys.json"
    history = json.loads(hist_path.read_text()) if hist_path.exists() else {}
    now_ms = int(time.time() * 1000)
    key = os.environ.get("CANDHIS_KEY", "").strip()
    state_path = hist_path.parent / "candhis_api.json"
    state = _budget(state_path)
    ok = 0
    # Une seule fois par bouée : l'historique des 35 derniers jours par l'API (le tableau public
    # n'en donne que 48 h), pour que la calibration des modèles soit tout de suite solide
    if key:
        state.setdefault("historique", {})
        for b in spots.get("buoys", []):
            code = b["code"]
            if state["historique"].get(code):
                continue
            try:
                past = fetch_api(code, key, state, days=KEEP_DAYS)
                n = merge(history, code, past, now_ms) if past else 0
                state["historique"][code] = 1
                print(f"[candhis] {code} {b['name']}: historique API {len(past)} mesures, {n} ajoutées")
            except Exception as e:   # pas de nouvel essai : le quota sert d'abord au secours horaire
                state["historique"][code] = "échec"
                print(f"[candhis] {code}: historique API en échec ({e}), l'historique se construira au fil des heures", file=sys.stderr)
    for b in spots.get("buoys", []):
        code = b["code"]
        obs, source = [], "public"
        try:
            obs = fetch_public(code)
        except Exception as e:  # réseau, site en maintenance…
            print(f"[candhis] {code}: tableau public en échec ({e})", file=sys.stderr)
        last = obs[-1]["t"] if obs else None
        # Bouée sans temps réel côté API (ex. Banyuls hors service) : pas redemandée avant 12 h ;
        # API pas plus récente que le tableau public (bouée qui émet toutes les 3-6 h) : pas avant 3 h
        recent_vide = now_ms < state["vide"].get(code, 0)
        if key and (last is None or now_ms - last > STALE_H * 3600_000) and not recent_vide:
            try:
                api = fetch_api(code, key, state)
                if api and (last is None or api[-1]["t"] > last):
                    obs, source = api, "API"
                elif api:
                    state["vide"][code] = now_ms + 3 * 3600_000
                    print(f"[candhis] {code}: l'API n'a rien de plus récent (nouvel essai dans 3 h)")
                else:
                    state["vide"][code] = now_ms + 12 * 3600_000
                    print(f"[candhis] {code}: l'API n'a pas de mesure récente non plus (nouvel essai dans 12 h)")
            except Exception as e:
                print(f"[candhis] {code}: API en échec ({e})", file=sys.stderr)
        if obs:
            n = merge(history, code, obs, now_ms)
            age = (now_ms - obs[-1]["t"]) / 3600_000
            print(f"[candhis] {code} {b['name']} ({source}): {len(obs)} lignes, {n} nouvelles, dernière il y a {age:.1f} h")
            ok += 1
        else:
            print(f"[candhis] {code} {b['name']}: aucune mesure")
        time.sleep(1)  # politesse envers le serveur public
    hist_path.parent.mkdir(parents=True, exist_ok=True)
    hist_path.write_text(json.dumps(history, separators=(",", ":")))
    if key:
        state_path.write_text(json.dumps(state))
        print(f"[candhis] API : {state['n']} requête(s) aujourd'hui (budget {API_BUDGET})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
