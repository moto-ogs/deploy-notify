# deploy-notify

Eine Action für alle Deploy-Meldungen von moto in Slack.

## Was im Kanal ankommt

| Ergebnis | Production | Staging, Demo, andere |
|---|---|---|
| Deploy erfolgreich | Meldung, Release Notes als Antwort im Thread | nichts |
| Deploy fehlgeschlagen | Meldung | Meldung |
| Deploy abgebrochen (cancelled) | Meldung | nichts |

Die Regel steht in `shouldNotify` in [src/lib.js](src/lib.js). Wer sie ändert, ändert sie für alle Repos.

Die Release Notes nennen jede Änderung seit dem letzten erfolgreichen Lauf desselben Jobs auf demselben Branch: gemergte Pull Requests und direkte Commits, gruppiert nach `feat` (Neu), `fix` (Behoben) und Titeln ohne Präfix (Änderungen). `chore`, `refactor`, `test`, `docs`, `ci` und `build` werden nur gezählt. Ein Merge von `development` nach `main` zählt nicht selbst, sondern mit den Pull Requests, die er mitbringt.

## Einbau

```yaml
permissions:
  contents: read
  actions: read # findet den letzten erfolgreichen Deploy

steps:
  # … Deploy …
  - name: Notify Slack
    if: always()
    uses: moto-ogs/deploy-notify@v1
    with:
      slack_token: ${{ secrets.SLACK_BOT_TOKEN }}
      channel: ${{ vars.SLACK_DEPLOY_CHANNEL }}
      status: ${{ job.status }}
      environment: production
      app: Website
```

Weitere Eingaben stehen in [action.yml](action.yml): `version`, `exit_code`, `exit_codes: deploy-remote`, `previous_sha`, `dry_run`.

Die Action lässt einen Job nie scheitern: Fehler beim Senden erscheinen als Warnung im Log.

## Slack-App

Die Action braucht einen Bot-Token (`xoxb-…`) mit dem Scope `chat:write`. Der Bot muss Mitglied des Kanals sein. Ein Incoming Webhook reicht nicht, weil er keine Antworten im Thread schreiben kann. Token und Kanal liegen als Organisations-Secret `SLACK_BOT_TOKEN` und Organisations-Variable `SLACK_DEPLOY_CHANNEL` auf GitHub.

## Entwicklung

```sh
node --test
```

Kein Build, keine Abhängigkeiten. Ein Release verschiebt den Tag `v1` auf den neuen Commit:

```sh
git tag -f v1 && git push -f origin v1
```
