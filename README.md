# Super Prévi Surf — V1

Prévision surf personnelle pour les spots du Golfe du Lion (Carnon, Palavas, Sète, La Guillotine, Gruissan, Canet, Paulilles, Perafita), dans l'esprit de « Super prévision vent » : plusieurs modèles croisés, vérifiés en continu contre les bouées, et une note par heure qui dit simplement **quand et où aller**.

## Ce que fait l'app

- **Houle** : ensemble de 6 modèles (Copernicus Med-WAV, Météo-France MFWAM, ECMWF WAM, DWD EWAM et GWAM, NOAA GFS-Wave), houle décomposée en trains (houle 1, houle 2, mer du vent).
- **Vent** : AROME 1,3 km → ARPEGE (Météo-France) mélangé à ECMWF IFS selon l'échéance.
- **Mesures** : bouées Candhis (Sète, Espiguette, Leucate, Port-la-Nouvelle, Banyuls) pour vérifier les modèles et corriger les premières heures.
- **Par spot et par heure** : hauteur au bord, note sur 10, qualité du vent (offshore / side / onshore selon l'orientation de la plage), confiance, et créneaux de jour regroupés.

## Organisation du dépôt

```
engine/surf-engine.js   le moteur (JS pur, sans dépendance) — utilisé par le serveur, l'app et le widget
engine/spots.json       fiches spots et bouées (à ajuster, voir plus bas)
engine/config.json      surcharges de réglages (vide = valeurs par défaut du moteur)
collector/copernicus.py extraction Copernicus Med-WAV aux points des spots
collector/candhis.py    mesures temps réel Candhis + historique glissant 35 jours
collector/build.js      calcul complet → data/forecast.json
web/index.html          l'app web (lit data/forecast.json, sinon recalcule en direct)
widget/…-widget.js      widget iPhone (Scriptable)
dist/super-previ-surf.html  version autonome : un seul fichier, calcul en direct
.github/workflows/prevision.yml  exécution horaire + publication GitHub Pages
tests/                  29 tests JS + 5 tests Python
```

## Mise en route (≈ 15 min)

1. **Change ton mot de passe Copernicus** (il est passé en clair dans une conversation), sur marine.copernicus.eu.
2. Crée un dépôt GitHub `super-previ-surf` **public** (GitHub Pages gratuit l'exige ; aucun identifiant n'est jamais dans le dépôt) et dépose-y tout le contenu de ce dossier.
3. Dans le dépôt : **Settings → Secrets and variables → Actions → New repository secret**, crée :
   - `COPERNICUSMARINE_SERVICE_USERNAME` = ton identifiant Copernicus
   - `COPERNICUSMARINE_SERVICE_PASSWORD` = ton nouveau mot de passe
   - `CANDHIS_KEY` = ta clé de l'API Candhis (facultatif : historique long + secours du tableau public)
4. **Settings → Pages → Build and deployment → Source : GitHub Actions**.
5. **Actions → Prévision surf → Run workflow** (première exécution manuelle, ~3 min). Ensuite ça tourne seul toutes les heures.
6. L'app est en ligne sur `https://<ton-compte>.github.io/super-previ-surf/`.

Sans les secrets Copernicus, tout fonctionne avec les 5 autres modèles ; la puce « Copernicus » reste rouge.

### Widget iPhone

Installe **Scriptable** (gratuit), crée un script, colle `widget/super-previ-surf-widget.js`, remplace `FORECAST_URL` par l'adresse de ton site + `data/forecast.json`, puis ajoute un widget Scriptable (petit ou moyen) sur l'écran d'accueil. Il affiche le meilleur créneau à venir et les 3 meilleurs spots maintenant, et garde la dernière prévision si tu n'as pas de réseau.

### Version autonome

`dist/super-previ-surf.html` s'ouvre directement dans un navigateur : il calcule en direct depuis Open-Meteo (sans Copernicus ni bouées, qui nécessitent le serveur). Pratique pour tester avant la mise en ligne.

## L'algorithme, étape par étape

1. **Point modèle** : pour chaque spot, la houle est lue 3 km au large dans l'axe de la plage (les modèles sont faux pile sur la plage). Les mailles « terre » sont évitées (Copernicus : maille de mer la plus proche ; Open-Meteo : `cell_selection=sea`).
2. **Contrôle de cohérence** : un modèle dont la hauteur est nulle ou très inférieure aux autres à un point (maille masquée) y est écarté. Exemple réel du 05/11 : GFS renvoyait 0 m à Canet, il est maintenant exclu automatiquement.
3. **Vérification contre les bouées** : erreur moyenne, biais, erreur de direction et de période de chaque modèle à chaque bouée au large. Les poids de l'ensemble sont `a priori / (erreur² + 0,2²)` ; un modèle aberrant en direction (> 60°) ou en période (> 3 s) à une bouée y est quasi ignoré.
4. **Correction de biais** : estimée sur les mers ≥ 0,5 m, rétrécie tant que l'historique est court (`n/(n+48)`), bornée à ±20-25 %. Elle se renforce d'elle-même quand l'historique de 35 jours se remplit.
5. **Correction « maintenant »** : l'écart mesure / modèle à la bouée de référence corrige les premières heures, puis s'efface (demi-vie ≈ 2,5 h).
6. **Hauteur au bord** : chaque train de houle est transformé en hauteur au déferlement (Komar & Gaillard, `Hb = 0,39·g^0,2·(T·H0²·cos θ)^0,4`), atténué hors de la fenêtre du spot, puis les trains sont combinés en énergie.
7. **Vent** : qualité continue selon l'angle à la direction offshore et la vitesse (offshore léger = parfait, onshore 20 km/h = nul, tramontane > 40 km/h pénalisée, rafales irrégulières pénalisées).
8. **Spécificités Méditerranée** :
   - période « bonne » dès 7-8 s (le seuil Atlantique de 12 s ne s'applique pas) ;
   - **bascule** : bonus quand le vent tombe ou passe offshore après ≥ 5 h de vent marin ;
   - **aplatissement** : malus après ≥ 8 h de tramontane / mistral > 40 km/h ;
   - pénalité de clapot quand la mer du vent domine par vent onshore.
9. **Note** : 9 × taille × période × vent × clapot, + bonus bascule, + bonus période longue (≥ 9 s). Un 10 reste exceptionnel.
10. **Créneaux** : heures de jour consécutives (soleil > −4°, on surfe dès l'aube) avec une note ≥ 4, classées sur 7 jours.

Tous les coefficients sont dans `DEFAULT_CONFIG` du moteur et peuvent être surchargés dans `engine/config.json` sans toucher au code.

## Rapport de la V1 (tests du 05/11/2026, tempête d'ESE en cours)

**Données réelles utilisées** : Open-Meteo (5 modèles houle × 13 points, 2 modèles vent × 8 spots) et 48 h de mesures Candhis aux 5 bouées, au moment d'un coup de mer d'ESE (2,1-2,5 m, 7 s à Sète et Leucate, 3,8 m à Port-la-Nouvelle par 13 m de fond).

**Vérification des modèles (48 h)** : aucun modèle n'est le meilleur partout. ECMWF est le plus juste à Sète et Leucate (0,2-0,3 m d'erreur), Météo-France à l'Espiguette, DWD EWAM à Leucate. GFS est aberrant près des côtes à l'Espiguette et à Port-la-Nouvelle (direction fausse de plus de 100°) et il est maintenant écarté là où c'est le cas. D'où l'intérêt d'un ensemble pondéré par bouée plutôt qu'un modèle unique.

**Tests à l'aveugle** (calibration sur les mesures avant l'instant T, évaluation sur les mesures après T, 6 instants × 3 bouées) :

| | Erreur moyenne sur la hauteur au large |
|---|---|
| Ensemble brut (poids a priori) | 0,31 m |
| Ensemble calibré (V1) | **0,21 m (−30 %)** |
| + correction par la bouée, 0-3 h | −35 % supplémentaires sur les premières heures |

**Comparaison avec Surf-Forecast** (Canet, vendredi 06/11) : leur modèle fait retomber la mer beaucoup plus vite (0,9 m à 8 h) que le consensus Météo-France / ECMWF / DWD utilisé ici (≈ 1,2 m E 8 s). La V1 annonce donc vendredi matin comme une très bonne fenêtre post-tempête avec vent d'ouest offshore ; la mesure à la bouée de Leucate vendredi dira qui avait raison, et la vérification intégrera l'écart automatiquement.

### Passes de raffinement

Voir `CHANGELOG.md` : 4 passes sur données réelles, chacune avec ses corrections et leur effet mesuré.

### Limites connues

- **Calibration encore jeune** : la page Candhis publique ne donne que 48 h. L'historique se construit à chaque exécution (35 jours glissants) ; la correction de biais deviendra pleinement fiable au bout de 2-3 semaines. Avec la clé de l'API Candhis officielle (secret `CANDHIS_KEY`), les 35 derniers jours de chaque bouée sont chargés d'un coup au premier passage, et l'API prend le relais quand le tableau public ne répond pas (40 requêtes par jour au plus, sur les 150 permises).
- **Copernicus non testé en conditions réelles** depuis l'environnement de développement (réseau restreint) : le code suit l'API officielle du toolbox v2 et gère les erreurs (identifiant refusé, jeu renommé, variable absente, service en maintenance), mais la première exécution GitHub Actions est le vrai test. Si elle échoue, l'app continue sans Copernicus et le journal de l'action indique pourquoi.
- **Hauteur au bord** : formule physique générale, non calibrée spot par spot. Le facteur `shelter` de chaque fiche permet de l'ajuster après quelques sessions.
- **Bouée de Banyuls hors service** depuis le 21/10/2026 : Paulilles et Perafita se calibrent sur Leucate en attendant.
- **Marée** : négligée (20-30 cm en Méditerranée) ; la surcote est récupérée mais pas encore exploitée dans la note.

### Fiches spots à valider avec toi

| Spot | À vérifier |
|---|---|
| La Guillotine (Vias) | orientation (160° supposé), fenêtre de houle, vent offshore, tailles |
| Paulilles | orientation de la baie (NE supposé), houles qui rentrent, vent offshore |
| Platja de Perafita | orientation (E supposé), fenêtre, vent offshore |
| Palavas | fenêtre de houle (S→SE supposée) |
| Tous | coordonnées exactes du pic, taille mini / maxi selon ton niveau |

Modifie `engine/spots.json` (aucune autre modification nécessaire) puis relance le workflow.

## Sources et licences

Copernicus Marine Service (E.U. Copernicus Marine Service Information, MEDSEA_ANALYSISFORECAST_WAV_006_017) · Open-Meteo (CC BY 4.0) avec les modèles de Météo-France, ECMWF, DWD et NOAA · Candhis – Cerema, licence ouverte Etalab · fenêtres de spots : Surfnerd, Surf-Forecast, Plages.tv, Wannasurf.

## Développement

```
npm install          # jsdom et terser, pour les tests d'interface
npm test             # 29 tests JS (moteur, pipeline, interface) + 5 tests Python
npm run standalone   # régénère dist/super-previ-surf.html
```
