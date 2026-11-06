# Journal des passes de raffinement — V1

Toutes les passes ont été faites sur des **données réelles du 05/11/2026** (Open-Meteo + 48 h de mesures Candhis), pendant un coup de mer d'ESE.

## Passe 1 — premier calcul sur données réelles

Moteur complet : ensemble pondéré, déferlement Komar & Gaillard, qualité du vent selon l'orientation, bascule, créneaux. 20 tests unitaires au vert.

Problèmes constatés :
- Gruissan affichait **4,4 m au bord** : la bouée de Port-la-Nouvelle (13 m de fond, vagues déjà amplifiées par le haut-fond) servait de référence et gonflait la prévision de 53 %.
- Paulilles et Perafita se calibraient sur des mesures de **Banyuls vieilles de 2 semaines** (bouée en panne).
- **NOAA GFS** totalement faux près des côtes (Espiguette : −1,4 m de biais, direction fausse de 131°, période −5,6 s).
- Trop de scores à **10/10** : le bonus de bascule multipliait au-delà du plafond.

## Passe 2 — corrections

- Bouées « côtières » (< 20 m de fond) : affichées comme « mesure près du bord », jamais utilisées pour calibrer.
- Mesures de plus de 30 jours ignorées ; bouée de référence = première bouée **au large et vérifiée**.
- Modèle aberrant à une bouée (direction > 60° ou période > 3 s d'erreur) : poids × 0,05.
- Nouvelle note : `9 × facteurs + bonus additifs`. Un 10 demande houle idéale, période ≥ 9 s, vent parfait et bascule.
- Test à l'aveugle ajouté (`backtestSplit`).

Résultat : erreur −42 % à Sète et −15 % à Leucate, mais **+24 % à l'Espiguette** (biais appris sur mer calme, appliqué en tempête).

## Passe 3 — calibration robuste

Comparaison de 11 variantes de calibration sur 18 tests à l'aveugle (6 instants × 3 bouées) :

| Variante | Erreur moyenne |
|---|---|
| sans calibration | 0,224 m |
| calibration passe 2 | 0,228 m |
| biais rétréci (n/(n+48)) + biais estimé sur mers ≥ 0,5 m + poids adoucis | **0,195 m** |

Correction « maintenant » par la bouée : −35 % d'erreur sur 0-3 h, mais une décroissance trop lente (10 h) **dégradait** la prévision à 6-12 h. Demi-vie ramenée à 3,5 h.

Comparaison avec Surf-Forecast (Canet) : a révélé que **GFS renvoyait 0 m à Canet** (maille classée terre) tout en pesant 19 % de l'ensemble. Ajout d'un contrôle de cohérence par point : Hs nul = donnée manquante, modèle très en dessous des autres à un point = écarté.

## Passe 4 — vérification finale sur données fraîches (23 h)

- 18 tests à l'aveugle : **0,31 m → 0,21 m (−30 %)**.
- GFS écarté automatiquement à Canet, à l'Espiguette et à Port-la-Nouvelle.
- `forecast.json` complet : 141 ko.
- Interface : rendu vérifié dans Chrome (bureau 1200 px clair, téléphone 390 px sombre), aucune erreur console, aucun débordement horizontal. Contraste des pastilles corrigé en mode sombre, heures insécables.

## Tests

- 26 tests du moteur (angles, déferlement, vent, parsers, soleil, vérification, nowcast, bouées côtières, modèles masqués, scénarios complets)
- 1 test de bout en bout du collecteur
- 2 tests d'interface (DOM simulé + version autonome)
- 5 tests Python (Candhis, Copernicus avec un faux jeu de données, absence d'identifiants)
