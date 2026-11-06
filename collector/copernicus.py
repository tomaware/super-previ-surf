"""
Extraction Copernicus Marine — MEDSEA_ANALYSISFORECAST_WAV_006_017 (Med-WAV, ~4,2 km, horaire, 10 j)
-----------------------------------------------------------------------------------------------------
Écrit data/copernicus.json : séries horaires aux points modèles des spots et des bouées,
au format attendu par engine/surf-engine.js (parseCopernicus).

Identifiants : JAMAIS dans le code. Le toolbox les lit dans les variables d'environnement
  COPERNICUSMARINE_SERVICE_USERNAME / COPERNICUSMARINE_SERVICE_PASSWORD
(secrets GitHub Actions). Sans identifiants, le script s'arrête proprement (code 0) et l'app
continue avec les autres modèles.

Usage : python collector/copernicus.py [--days-back 2] [--days-ahead 10]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRODUCT_ID = "MEDSEA_ANALYSISFORECAST_WAV_006_017"
# identifiant du jeu horaire ; si le catalogue change, on le retrouve par description (voir find_dataset_id)
DEFAULT_DATASET_ID = os.environ.get("CMEMS_WAV_DATASET_ID", "cmems_mod_med_wav_anfc_4.2km_PT1H-i")
VARIABLES = [
    "VHM0", "VTPK", "VTM10", "VTM02", "VMDR",
    "VHM0_SW1", "VTM01_SW1", "VMDR_SW1",
    "VHM0_SW2", "VTM01_SW2", "VMDR_SW2",
    "VHM0_WW", "VTM01_WW", "VMDR_WW",
]
OFFSHORE_KM = 3.0


def offset_point(lat: float, lon: float, az: float, km: float) -> tuple[float, float]:
    """Même calcul que engine.offsetPoint : point décalé de km le long de l'azimut az."""
    dlat = km * math.cos(math.radians(az)) / 111.2
    dlon = km * math.sin(math.radians(az)) / (111.2 * math.cos(math.radians(lat)))
    return round(lat + dlat, 4), round(lon + dlon, 4)


def query_points(spots_doc: dict) -> dict[str, tuple[float, float]]:
    pts: dict[str, tuple[float, float]] = {}
    for s in spots_doc["spots"]:
        if s.get("modelLat") is not None:
            pts[s["id"]] = (s["modelLat"], s["modelLon"])
        else:
            pts[s["id"]] = offset_point(s["lat"], s["lon"], s["normal"], OFFSHORE_KM)
    for b in spots_doc.get("buoys", []):
        pts["buoy_" + b["code"]] = (b.get("modelLat") or b["lat"], b.get("modelLon") or b["lon"])
    return pts


def find_dataset_id(cm) -> str:
    """Retrouve l'identifiant du jeu horaire 'analysis-forecast' dans le catalogue."""
    try:
        cat = cm.describe(product_id=PRODUCT_ID, disable_progress_bar=True)
        ids = [d.dataset_id for p in cat.products for d in p.datasets]
        hourly = [i for i in ids if "wav" in i and "anfc" in i and "PT1H" in i]
        if hourly:
            return sorted(hourly)[0]
    except Exception as e:  # pragma: no cover - réseau
        print(f"[copernicus] describe impossible : {e}", file=sys.stderr)
    return DEFAULT_DATASET_ID


def nearest_sea_index(lats, lons, field0, lat: float, lon: float, max_ring: int = 3):
    """Indice (i, j) de la maille de mer (valeur non NaN) la plus proche du point."""
    import numpy as np

    i0 = int(np.abs(lats - lat).argmin())
    j0 = int(np.abs(lons - lon).argmin())
    best, best_d = None, 1e9
    for r in range(0, max_ring + 1):
        for i in range(max(0, i0 - r), min(len(lats), i0 + r + 1)):
            for j in range(max(0, j0 - r), min(len(lons), j0 + r + 1)):
                v = field0[i, j]
                if v is None or (isinstance(v, float) and math.isnan(v)) or np.isnan(v):
                    continue
                d = (lats[i] - lat) ** 2 + ((lons[j] - lon) * math.cos(math.radians(lat))) ** 2
                if d < best_d:
                    best, best_d = (i, j), d
        if best is not None:
            return best
    return None


def extract(ds, pts: dict[str, tuple[float, float]]) -> dict:
    """Extrait les séries aux points (dataset xarray déjà sous-échantillonné)."""
    import numpy as np

    lats = ds["latitude"].values
    lons = ds["longitude"].values
    times = [
        datetime.fromtimestamp(t.astype("datetime64[s]").astype(int), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        for t in ds["time"].values
    ]
    hs = ds["VHM0"].values  # (time, lat, lon)
    # première échéance où le champ est défini, pour repérer la terre
    first = next((k for k in range(hs.shape[0]) if not np.all(np.isnan(hs[k]))), 0)
    out: dict[str, dict] = {}
    for pid, (lat, lon) in pts.items():
        ij = nearest_sea_index(lats, lons, hs[first], lat, lon)
        if ij is None:
            print(f"[copernicus] {pid}: aucune maille de mer proche", file=sys.stderr)
            continue
        i, j = ij
        rec: dict = {"time": times, "lat": float(lats[i]), "lon": float(lons[j])}
        for v in VARIABLES:
            if v not in ds:
                continue
            arr = ds[v].values[:, i, j]
            rec[v] = [None if (a is None or np.isnan(a)) else round(float(a), 3) for a in arr]
        out[pid] = rec
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days-back", type=float, default=2)
    ap.add_argument("--days-ahead", type=float, default=10)
    ap.add_argument("--out", default=str(ROOT / "data" / "copernicus.json"))
    args = ap.parse_args()

    if not (os.environ.get("COPERNICUSMARINE_SERVICE_USERNAME") and os.environ.get("COPERNICUSMARINE_SERVICE_PASSWORD")):
        print("[copernicus] identifiants absents : étape ignorée (l'app tourne sans Copernicus).")
        return 0

    import copernicusmarine as cm

    spots_doc = json.loads((ROOT / "engine" / "spots.json").read_text())
    pts = query_points(spots_doc)
    lat_min = min(p[0] for p in pts.values()) - 0.15
    lat_max = max(p[0] for p in pts.values()) + 0.15
    lon_min = min(p[1] for p in pts.values()) - 0.15
    lon_max = max(p[1] for p in pts.values()) + 0.15
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = now - timedelta(days=args.days_back)
    end = now + timedelta(days=args.days_ahead)

    dataset_id = DEFAULT_DATASET_ID
    t0 = time.time()
    for attempt in range(3):
        try:
            ds = cm.open_dataset(
                dataset_id=dataset_id,
                variables=VARIABLES,
                minimum_longitude=lon_min, maximum_longitude=lon_max,
                minimum_latitude=lat_min, maximum_latitude=lat_max,
                start_datetime=start.strftime("%Y-%m-%dT%H:%M:%S"),
                end_datetime=end.strftime("%Y-%m-%dT%H:%M:%S"),
                coordinates_selection_method="outside",
            )
            break
        except cm.VariableDoesNotExistInTheDataset as e:
            # une variable a été renommée : on retire celles qui manquent et on réessaie
            missing = [v for v in VARIABLES if v in str(e)]
            print(f"[copernicus] variables absentes {missing} : nouvel essai sans elles", file=sys.stderr)
            for v in missing:
                VARIABLES.remove(v)
        except cm.DatasetNotFound:
            dataset_id = find_dataset_id(cm)
            print(f"[copernicus] jeu introuvable, essai avec {dataset_id}", file=sys.stderr)
        except cm.InvalidUsernameOrPassword:
            print("[copernicus] identifiant ou mot de passe refusé par Copernicus.", file=sys.stderr)
            return 1
        except Exception as e:  # réseau, service en maintenance…
            print(f"[copernicus] tentative {attempt + 1} échouée : {e}", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    else:
        print("[copernicus] abandon après 3 tentatives", file=sys.stderr)
        return 1

    ds = ds.load()
    points = extract(ds, pts)
    doc = {
        "source": f"E.U. Copernicus Marine Service Information — {PRODUCT_ID} ({dataset_id})",
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "start": start.isoformat(), "end": end.isoformat(),
        "points": points,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(doc, separators=(",", ":")))
    print(f"[copernicus] {len(points)} points, {len(ds['time'])} échéances, {time.time() - t0:.0f} s → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
