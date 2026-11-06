"""
Mesures des bouées Candhis (Cerema) — licence ouverte Etalab
-------------------------------------------------------------
Lit les ~48 dernières heures publiées en temps réel sur candhis.cerema.fr pour chaque bouée de
engine/spots.json, et les ajoute à data/history/buoys.json (historique glissant de 35 jours,
indispensable pour vérifier et calibrer les modèles).

Quand le jeton de l'API officielle sera disponible (variable CANDHIS_TOKEN), brancher
fetch_api() ; d'ici là on lit le tableau public, en même origine que l'affichage du site.

Mention obligatoire : « Candhis – Cerema, données temps réel ».
"""
from __future__ import annotations

import base64
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://candhis.cerema.fr/_public_/campagne.php?"
KEEP_DAYS = 35
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
    ok = 0
    for b in spots.get("buoys", []):
        code = b["code"]
        try:
            obs = fetch_public(code)
            n = merge(history, code, obs, now_ms)
            last = obs[-1]["t"] if obs else None
            age = (now_ms - last) / 3600_000 if last else None
            print(f"[candhis] {code} {b['name']}: {len(obs)} lignes, {n} nouvelles, dernière il y a {age:.1f} h" if age is not None else f"[candhis] {code}: aucune mesure")
            ok += 1
        except Exception as e:  # réseau, site en maintenance…
            print(f"[candhis] {code}: échec {e}", file=sys.stderr)
        time.sleep(1)  # politesse envers le serveur public
    hist_path.parent.mkdir(parents=True, exist_ok=True)
    hist_path.write_text(json.dumps(history, separators=(",", ":")))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
