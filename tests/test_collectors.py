"""Tests des collecteurs Python (sans réseau) — lancer avec : python -m pytest tests/"""
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "collector"))
import candhis  # noqa: E402
import copernicus  # noqa: E402

SAMPLE = """<table><tr><th>Date</th><th>Heure (TU)</th><th>H1/3 (m)</th><th>Hmax (m)</th><th>Th1/3 (s)</th>
<th>Dir. au pic (°)</th><th>Etal. au pic (°)</th><th>Temp. mer (°C)</th></tr>
<tr><td>05/11/2026</td><td>21:00</td><td>2.1</td><td>4.0</td><td>6.8</td><td>119</td><td>21</td><td>17.2</td></tr>
<tr><td>05/11/2026</td><td>20:30</td><td>2.2</td><td>3.4</td><td>6.6</td><td>121</td><td>20</td><td>17.2</td></tr>
<tr><td>22/10/2026</td><td>00:00</td><td></td><td></td><td></td><td></td><td></td><td></td></tr></table>"""


def test_candhis_parse_table():
    p = candhis._TableParser()
    p.feed(SAMPLE)
    obs = candhis.parse_rows(p.rows)
    assert len(obs) == 2, "ligne vide ignorée"
    assert obs[0]["t"] < obs[1]["t"], "trié chronologiquement"
    assert obs[1]["t"] == int(datetime(2026, 11, 5, 21, tzinfo=timezone.utc).timestamp() * 1000)
    assert obs[1]["hs"] == 2.1 and obs[1]["dir"] == 119


def test_candhis_merge_dedup_and_window():
    now = int(datetime(2026, 11, 5, 22, tzinfo=timezone.utc).timestamp() * 1000)
    hist = {"03404": [{"t": now - 40 * 86400_000, "hs": 1}, {"t": now - 3600_000, "hs": 1.5}]}
    added = candhis.merge(hist, "03404", [{"t": now - 3600_000, "hs": 1.6}, {"t": now, "hs": 2}], now)
    assert added == 1
    assert [o["hs"] for o in hist["03404"]] == [1.6, 2], "doublon remplacé, ancien purgé"


def test_offset_point_matches_engine():
    lat, lon = copernicus.offset_point(42.70, 3.04, 90, 3)
    assert abs(lat - 42.70) < 1e-4 and lon > 3.04
    d = math.hypot((lat - 42.70) * 111.2, (lon - 3.04) * 111.2 * math.cos(math.radians(42.7)))
    assert abs(d - 3) < 0.05


def _fake_ds():
    lats = np.round(np.arange(42.3, 43.7, 0.042), 4)
    lons = np.round(np.arange(2.9, 4.3, 0.042), 4)
    times = pd.date_range("2026-11-05T00:00", periods=6, freq="h")
    hs = np.full((len(times), len(lats), len(lons)), 1.2)
    # une "côte" : tout ce qui est à l'ouest de 3.06 est de la terre (NaN)
    hs[:, :, lons < 3.06] = np.nan
    data = {v: (("time", "latitude", "longitude"), hs.copy()) for v in copernicus.VARIABLES}
    return xr.Dataset(data, coords={"time": times, "latitude": lats, "longitude": lons})


def test_copernicus_extract_picks_sea_cell():
    ds = _fake_ds()
    out = copernicus.extract(ds, {"canet": (42.70, 3.05), "large": (43.0, 3.6)})
    assert set(out) == {"canet", "large"}
    assert out["canet"]["lon"] >= 3.06, "maille de terre évitée"
    assert out["canet"]["VHM0"][0] == 1.2
    assert out["canet"]["time"][0] == "2026-11-05T00:00:00Z"


def test_copernicus_without_credentials_is_noop(monkeypatch, tmp_path):
    monkeypatch.delenv("COPERNICUSMARINE_SERVICE_USERNAME", raising=False)
    monkeypatch.delenv("COPERNICUSMARINE_SERVICE_PASSWORD", raising=False)
    monkeypatch.setattr(sys, "argv", ["copernicus.py", "--out", str(tmp_path / "c.json")])
    assert copernicus.main() == 0
    assert not (tmp_path / "c.json").exists()


# ---------------------------------------------------------------- API Candhis (secours)
# Réponse au format réel de getCampTR (entête + lignes), valeurs relevées le 09/11/2026 à Leucate
API_SAMPLE = {"success": True, "entete": ["Date", "H1/3 (m)", "Hmax (m)", "Th1/3 (s)", "Dir. au pic (°)", "Etal. au pic (°)", "Temp. mer (°C)"],
              "results": [["2026-11-09 17:00", "1.7", "3.1", "5.5", "134", "38", "17.8"],
                          ["2026-11-09 16:30", "99.90", "999.9999", "5.6", "999.9999", "999.9999", "17.8"],
                          ["2026-11-09 16:00", "1.8", "3.0", "5.6", "131", "35", "17.8"]]}


def test_candhis_parse_api_matches_public():
    obs = candhis.parse_api(API_SAMPLE)
    assert [o["t"] for o in obs] == sorted(o["t"] for o in obs)
    last = obs[-1]
    assert last["t"] == int(datetime(2026, 11, 9, 17, tzinfo=timezone.utc).timestamp() * 1000), "heures en temps universel"
    assert (last["hs"], last["hmax"], last["tm"], last["dir"], last["spread"], last["sst"]) == (1.7, 3.1, 5.5, 134, 38, 17.8)
    assert len(obs) == 2, "ligne 16:30 sans hauteur ni direction (99.90 / 999.9999) écartée"


def test_candhis_parse_api_hm0_and_extra_column():
    js = {"entete": ["Date", "Hm0 (m)", "T02 (s)", "Dir. au pic (°)"], "results": [["01101", "2026-11-09 17:00", "1.6", "5.1", "130"]]}
    o = candhis.parse_api(js)[0]
    assert (o["hs"], o["tm"], o["dir"]) == (1.6, 5.1, 130), "code campagne en tête de ligne non décrit dans l'entête"
    assert candhis.parse_api({"success": True, "nbLig": 0}) == []


def test_candhis_api_only_when_public_fails(monkeypatch, tmp_path):
    import json as _json
    root = tmp_path
    (root / "engine").mkdir(); (root / "data" / "history").mkdir(parents=True)
    (root / "engine" / "spots.json").write_text(_json.dumps({"buoys": [{"code": "01101", "name": "Leucate"}, {"code": "03404", "name": "Sète"}, {"code": "06601", "name": "Banyuls"}]}))
    monkeypatch.setattr(candhis, "ROOT", root)
    monkeypatch.setattr(candhis.time, "sleep", lambda s: None)
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    fresh = [{"t": now - 1800_000, "hs": 1.0, "dir": 100}]
    def public(code):
        if code == "03404":
            return fresh
        if code == "01101":
            raise OSError("site en maintenance")
        return [{"t": now - 20 * 86400_000, "hs": None, "dir": 200}]   # Banyuls : vieille mesure
    calls, longs = [], []
    def api(code, key, state, days=1):
        state["n"] += 1
        if days > 1:
            longs.append(code)
            return [{"t": now - 30 * 86400_000, "hs": 0.8, "dir": 150}] if code != "06601" else []
        calls.append(code)
        return [{"t": now - 600_000, "hs": 1.7, "dir": 134}] if code == "01101" else []
    monkeypatch.setattr(candhis, "fetch_public", public)
    monkeypatch.setattr(candhis, "fetch_api", api)
    monkeypatch.setenv("CANDHIS_KEY", "cle-test")
    assert candhis.main() == 0
    hist = _json.loads((root / "data" / "history" / "buoys.json").read_text())
    assert hist["01101"][-1]["hs"] == 1.7, "Leucate récupérée par l'API"
    assert longs == ["01101", "03404", "06601"] and hist["03404"][0]["hs"] == 0.8, "historique 35 j chargé une fois"
    assert calls == ["01101", "06601"], "pas d'appel API pour une bouée à jour"
    calls.clear(); longs.clear()
    candhis.main()
    assert calls == ["01101"], "Banyuls vide : pas redemandée avant 12 h"
    # API pas plus récente que le public : pas redemandée avant 3 h
    st0 = _json.loads((root / "data" / "history" / "candhis_api.json").read_text())
    assert st0["vide"]["06601"] > now + 11 * 3600_000
    assert longs == [], "historique pas rechargé"
    st = _json.loads((root / "data" / "history" / "candhis_api.json").read_text())
    assert st["n"] == 6
    monkeypatch.delenv("CANDHIS_KEY")
    calls.clear()
    candhis.main()
    assert calls == [], "sans clé : jamais d'appel API"


def test_candhis_api_not_newer_backoff(monkeypatch, tmp_path):
    import json as _json
    root = tmp_path
    (root / "engine").mkdir(); (root / "data" / "history").mkdir(parents=True)
    (root / "engine" / "spots.json").write_text(_json.dumps({"buoys": [{"code": "01102", "name": "Port-la-Nouvelle"}]}))
    hist_dir = root / "data" / "history"
    monkeypatch.setattr(candhis, "ROOT", root)
    monkeypatch.setattr(candhis.time, "sleep", lambda s: None)
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    old = [{"t": now - 5 * 3600_000, "hs": 2.4, "dir": 198}]   # émet toutes les ~6 h
    calls = []
    monkeypatch.setattr(candhis, "fetch_public", lambda code: old)
    def api(code, key, state, days=1):
        state["n"] += 1
        if days > 1:
            return []
        calls.append(code)
        return old
    monkeypatch.setattr(candhis, "fetch_api", api)
    monkeypatch.setenv("CANDHIS_KEY", "cle-test")
    candhis.main(); candhis.main(); candhis.main()
    assert calls == ["01102"], "une seule requête tant que la bouée n'a rien de neuf (3 h)"
    st = _json.loads((hist_dir / "candhis_api.json").read_text())
    assert now + 2.9 * 3600_000 < st["vide"]["01102"] < now + 3.1 * 3600_000


def test_copernicus_extra_points_for_ocean(tmp_path):
    f = tmp_path / "x.json"
    f.write_text('{"spots": [{"id": "saintes-maries", "lat": 43.448, "lon": 4.43, "normal": 175}]}')
    pts = copernicus.extra_points(f)
    assert list(pts) == ["saintes-maries"]
    assert pts["saintes-maries"] == copernicus.offset_point(43.448, 4.43, 175, copernicus.OFFSHORE_KM)
    assert copernicus.extra_points(tmp_path / "absent.json") == {}
    # le fichier livré ne touche aucun spot de l'app
    spots = {s["id"] for s in __import__("json").loads((Path(__file__).resolve().parent.parent / "engine" / "spots.json").read_text())["spots"]}
    assert not (set(copernicus.extra_points()) & spots)
