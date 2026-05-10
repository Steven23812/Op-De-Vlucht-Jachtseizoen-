# Op de Vlucht 🏃🚔

StukTV-stijl locatie-spel. Vluchteling deelt elke X minuten zijn GPS-locatie met agenten via Firebase.

## Op Vercel zetten

1. Upload deze map naar GitHub (nieuw repo)
2. Ga naar vercel.com → "Add New Project" → kies je GitHub repo
3. Vercel detecteert automatisch dat het een React app is
4. Klik "Deploy" — klaar!

## Lokaal testen

```bash
npm install
npm start
```

## Firebase Database regels

Ga in Firebase Console naar Realtime Database → Rules en zet dit:

```json
{
  "rules": {
    "parties": {
      "$code": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

## Spelen

1. Iedereen opent de app-URL op zijn telefoon
2. Eén persoon maakt een party aan en deelt de code
3. Host wijst rollen toe: 🏃 vluchteling en 🚔 agenten
4. Host start het spel — vluchteling krijgt automatisch GPS-updates
5. Agenten zien de locatie live in hun app verschijnen
