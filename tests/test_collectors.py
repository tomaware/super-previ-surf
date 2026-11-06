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
