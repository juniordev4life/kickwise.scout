# kickwise.scout

ETL-Job: holt Bundesliga-Spielplan + Ergebnisse von openligadb und schreibt sie idempotent in BigQuery.

## Architektur

```
Cloud Scheduler  ────daily 06:00────▶  Cloud Run Job (Scout)
                                          │
                                          ▼
                              openligadb-Adapter
                                          │
                                          ▼
                              Normalizer (snake_case rows)
                                          │
                                          ▼
                          BigQuery (kickwise_main.matches, teams, seasons)
                                MERGE-Upserts (idempotent)
```

## CLI

```bash
# Aktuelle Saison aktualisieren (Default für Scheduler)
node src/index.js --mode=current-season

# Einzelner Spieltag (z. B. zum Recover nach Fehler)
node src/index.js --mode=matchday --matchday=30

# Historischer Backfill (einmalig beim Setup)
node src/index.js --mode=historic --since-season=2010/2011

# Eine spezifische Saison neu laden
node src/index.js --mode=season --season=2020/2021
```

Alle Modi schreiben **idempotent** via BigQuery MERGE — wiederholtes Ausführen erzeugt keine Duplikate.

## Lokal entwickeln

```bash
cp .env.example .env.local
# .env.local → BQ_PROJECT_ID, BQ_DATASET setzen
# Lokal gegen echtes BQ-Projekt schreiben? Vorsicht — nutzt euw3-Capacity.
# Alternative: BQ-Sandbox / kleines Test-Projekt.

gcloud auth application-default login

npm install
npm run sync:current
```

## Tests

```bash
npm run test:run
```

Unit-Tests prüfen die Normalizer (deterministic, ohne Netz). Integration-Tests gegen openligadb sind kostenlos und schnell, aber bisher nicht eingerichtet.

## Geplante Erweiterungen (Phase 2)

- Understat-Adapter für xG/xA pro Spieler/Spiel → `player_match_stats`, `xg_match_data`
- FBref-Adapter für detaillierte Spielminuten und Karten
- Player-Stammdaten-Sync (aktuell nur grobe Lineup-Daten von openligadb)
