# plcov – Prototyp für Branch-, Bedingungs- und MC/DC-Coverage in PL/SQL

utPLSQL misst Coverage heute über `DBMS_PROFILER` und `DBMS_PLSQL_CODE_COVERAGE` und meldet daraus eine **Zeilen**-Quote.
plcov ist ein Prototyp, der stattdessen den Quellcode **instrumentiert**, wie JaCoCo oder Istanbul. So misst er Anweisungen, Branches
(auch implizite `ELSE`-Zweige), Teilbedingungen (WAHR / FALSCH / **NULL**), MC/DC und Schleifen (0 / 1 / n Durchläufe).
Als Test-Runner dienen die vorhandenen utPLSQL-Tests.

Ein Beispielbericht liegt in [`demo/report/index.html`](demo/report/index.html).

## Was die Demo zeigt

Gemessen wird dieselbe Testsuite (10 utPLSQL-Tests) auf Oracle AI Database 26ai Free (23.26):

| Objekt | Zeilen (utPLSQL) | Anweisungen | Branches | Bedingungen | MC/DC |
|---|---|---|---|---|---|
| `order_pricing` | **100 %** (23/23) | 84 % | **61 %** (11/18) | 50 % | **33 %** |
| `archive_orders` | 60 % | 100 % | 100 % | 100 % | 100 % |

- `order_pricing`: utPLSQL meldet 100 %, obwohl die Zweige `WHEN 'AT'` und `WHEN 'CH'` nie liefen und
  `if p_weight_kg > 20 then … end if;` (eine Zeile) nie WAHR war. Der Profiler zählt die Zeile schon, wenn nur die Bedingung ausgewertet wird.
- MC/DC findet fehlende Testfälle und schlägt sie konkret vor, z. B. „`p_vip` = WAHR, `p_amount > 1000` = FALSCH → Ergebnis FALSCH“.
- `archive_orders`: Der Exception-Handler ist mit `pragma coverage('NOT_FEASIBLE')` markiert. plcov rechnet ihn heraus, utPLSQL zählt ihn als nicht abgedeckt.
- Alle 10 Tests liefern mit und ohne Instrumentierung dasselbe Ergebnis. plcov prüft das bei jedem Lauf automatisch.

## Schnellstart

Voraussetzungen: Node.js 22 und Docker.

```bash
# 1. Datenbank (Oracle 23ai/26ai Free) starten
docker run -d --name ora23 -p 1521:1521 -e ORACLE_PASSWORD=Oracle123 \
  -e APP_USER=demo -e APP_USER_PASSWORD=demo gvenzl/oracle-free:23-slim-faststart

# 2. utPLSQL installieren (aus diesem Repository)
docker cp ../source ora23:/tmp/utplsql_source
docker exec ora23 bash -lc 'cd /tmp/utplsql_source && echo exit | sqlplus -S sys/Oracle123@localhost:1521/FREEPDB1 as sysdba @install_headless.sql'

# 3. Demo-Code und Tests einspielen, messen
npm install
npx tsx src/cli.ts deploy --config demo/plcov.json demo/src/*.sql demo/src/*.pks demo/src/*.pkb demo/src/*.prc demo/test/*.pks demo/test/*.pkb
npm run demo -- --out demo/report
```

## Befehle

| Befehl | Zweck |
|---|---|
| `plcov run --config plcov.json [--out dir]` | Kompletter Lauf: Baseline, utPLSQL-Coverage, Instrumentieren, Testlauf, Wiederherstellen, Bericht |
| `plcov instrument datei.sql [--no-sql]` | Zeigt offline, wie instrumentierter Code aussieht |
| `plcov report coverage.json [--out dir]` | Bericht aus gespeicherten Rohdaten neu erzeugen |
| `plcov deploy --config plcov.json dateien…` | SQL*Plus-artige Skripte einspielen (für die Demo) |

`plcov.json`: `user`, `password` (oder Umgebungsvariable `PLCOV_PASSWORD`), `connectString`, `schema`, `tests` (utPLSQL-Pfade),
optional `include` / `exclude` (Regex auf Objektnamen) und `sqlProbes` (`"auto"` = ab 23ai).

## Ablauf eines Laufs

1. Aufwärmlauf, dann Testlauf **ohne** Coverage (Referenz für Ergebnisse und Laufzeit)
2. Testlauf **mit** utPLSQL-Coverage (Zeilenquote zum Vergleich)
3. Quelltext über `DBMS_PREPROCESSOR` holen (bedingte Kompilierung ist aufgelöst), instrumentieren, mit den Originaleinstellungen kompilieren
   (`plsql_optimize_level`, `plsql_code_type`, `plsql_ccflags`, …). Kompiliert ein Objekt nicht, bleibt das Original aktiv.
4. Testlauf auf instrumentiertem Code, Sonden einsammeln
5. Original wiederherstellen (auch bei Fehlern, `finally`), ungültige Abhängigkeiten neu kompilieren
6. Testergebnisse aus 1 und 4 vergleichen, Bericht schreiben

## So sieht instrumentierter Code aus

```sql
-- Original
if p_vip and p_amount > 1000 then

-- Instrumentiert (gleiche Zeile, keine Zeilenumbrüche eingefügt)
cov$.s(1);if cov$.d(1,cov$.o(1) and (cov$.c(1,1,p_vip) and cov$.c(1,2,p_amount > 1000))) then
```

- `s` zählt Anweisungen, `o` / `d` öffnen und schließen eine Entscheidung (Wahrheitsvektor für MC/DC), `c` / `n` zeichnen eine Teilbedingung auf.
- **Kurzschluss bleibt exakt erhalten.** Oracle wertet Bedingungen in `IF`/`WHILE`/`WHEN` als Sprungcode aus: NULL bricht ein `AND` ab
  wie FALSCH. Die Sonden zeichnen den echten Wert (auch NULL) auf und geben ihn polaritätsgerecht zurück: `c` bildet NULL auf FALSCH ab,
  `n` (unter `NOT`) auf WAHR. Ohne diesen Schritt würden Funktionen mit Seiteneffekten öfter aufgerufen. Der Äquivalenztest
  (`test/db.test.ts`) hat genau diesen Fehler gefunden.
- **SQL-Sonden (nur 23ai/26ai):** `CASE` in Select-Liste, `SET` und `VALUES` wird mit `BOOLEAN`-Sonden in SQL instrumentiert.
  Bedingungen in `WHERE`/`ON`/`HAVING` bewusst nicht, weil das den Ausführungsplan ändern würde. Bei `GROUP BY` ebenfalls nicht,
  weil die Ausdrücke identisch bleiben müssen.

## Technik und Performance

- **TypeScript passt.** Parsen und Instrumentieren der Demo dauert ~5 ms. Die Laufzeit entsteht ausschließlich in der Datenbank
  (Kompilieren ~50–120 ms, Testlauf). Die Sprache ist für die Performance nicht entscheidend.
- **Datenbank-Overhead:** Probes zählen nur in Package-Speicher (assoziative Arrays mit Ganzzahl-Schlüsseln). Geschrieben wird einmal am
  Ende per autonomer Transaktion. Im sondenreichsten Test (20 000 Aufrufe einer trivialen Funktion) liegt plcov bei 48–90 ms gegenüber
  6 ms ohne und 30–50 ms mit utPLSQL-eigener Coverage. Bei Code mit echtem SQL-Anteil fällt der relative Overhead deutlich kleiner aus.
- Laufzeit-Package `cov$` wird mit `plsql_optimize_level = 3` kompiliert, wenn erlaubt nativ.

## Tests

```bash
npm test                                                   # Parser, Instrumentierung, MC/DC (offline)
PLCOV_DB=demo/demo@localhost:1521/FREEPDB1 npm test        # zusätzlich Äquivalenztest gegen echte DB
npm run typecheck
```

## Grenzen des Prototyps

- Objekte müssen im verbundenen Schema liegen (Laufzeit `cov$` wird dort installiert).
- Treffer aus anderen Sessions (Scheduler-Jobs, parallele Abfragen) werden nicht eingesammelt.
- Nicht gemessen: dynamisches SQL, mit `wrap` verschlüsselter Code, Compound-Trigger, einfache `CASE x WHEN …`-Ausdrücke,
  `WHEN`-Filter in FOR-Iterationen (21c), Trigger-`WHEN`-Klauseln. Der Bericht listet solche Stellen unter „Nicht gemessen“.
- Der Parser ist ein eigener, fehlertoleranter Struktur-Parser (kein vollständiges PL/SQL-Grammatikmodell). Kann er ein Objekt
  nicht verstehen, wird es übersprungen und im Bericht markiert.
- Rekursion innerhalb derselben Schleife zählt Iterationen ungenau. Schleifenmetriken sind eine Näherung.
