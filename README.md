# office-convert

Micro-service qui convertit les **documents Office legacy** (`.doc`, `.ppt`,
`.xls`, `.xlsb`, …) en **images PNG** lisibles par Gemini.

- `soffice` (LibreOffice headless) → PDF
- `pdftoppm` (poppler) → une PNG par page

L'app Next.js tourne sur Vercel (serverless, pas de LibreOffice possible) et
appelle ce service via une URL HTTP.

## API

### `GET /health`

```json
{ "ok": true }
```

### `POST /convert`

En-tête : `Authorization: Bearer <CONVERT_TOKEN>` (si `CONVERT_TOKEN` est défini).

Corps JSON :

```json
{ "name": "cours.doc", "dataBase64": "..." }
```

Réponse :

```json
{
  "images": [
    { "name": "cours-page1.png", "mimeType": "image/png", "dataBase64": "..." }
  ]
}
```

### `POST /chunk`

Utilisé par l'app (car Vercel plafonne le corps des requêtes à 4,5 Mo). Un
document est découpé en morceaux envoyés successivement avec le même
`sessionId`.

Corps JSON :

```json
{ "sessionId": "a1b2…", "name": "cours.doc", "chunkIndex": 0, "chunkCount": 3, "dataBase64": "..." }
```

Réponse d'un morceau intermédiaire :

```json
{ "pending": true, "received": 1, "total": 3 }
```

Réponse du **dernier** morceau : la conversion démarre **en arrière-plan** et le
service renvoie un identifiant de travail (réponse immédiate) :

```json
{ "jobId": "9f3c1e…" }
```

### `GET /jobs/:id`

État d'une conversion :

```json
{ "status": "processing" }
{ "status": "done", "pageCount": 42 }
{ "status": "error", "error": 422 }
```

### `GET /jobs/:id/pages/:index`

Renvoie une page rastérisée :

```json
{ "name": "cours-page1.png", "mimeType": "image/png", "dataBase64": "..." }
```

Codes d'erreur : `400` (requête invalide), `401` (jeton), `404` (job/page
inconnu), `409` (morceau manquant ou job pas prêt), `413` (trop gros), `422`
(conversion impossible), `504` (délai dépassé).

## Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `8080` | Port d'écoute |
| `CONVERT_TOKEN` | *(vide)* | Jeton partagé. **À définir en production.** |
| `MAX_BYTES` | `25000000` | Taille max d'un fichier source |
| `MAX_PAGES` | `60` | Pages max rastérisées |
| `RENDER_DPI` | `120` | Résolution des images |
| `CONVERT_TIMEOUT_MS` | `300000` | Délai max par étape de conversion |
| `MAX_CHUNKS` | `64` | Morceaux max par document |
| `TTL_MS` | `1800000` | Âge avant purge d'un job/morceau abandonné |

## Lancer en local (Docker)

```bash
docker build -t office-convert .
docker run --rm -p 8080:8080 -e CONVERT_TOKEN=secret office-convert
```

Test :

```bash
curl -s localhost:8080/convert \
  -H "Authorization: Bearer secret" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"test.doc\",\"dataBase64\":\"$(base64 -w0 test.doc)\"}" | head -c 200
```

## Déployer

N'importe quel hôte capable de faire tourner un conteneur Docker :

- **VPS** : `docker run -d --restart unless-stopped -p 8080:8080 -e CONVERT_TOKEN=... office-convert`
- **Fly.io** : `fly launch` puis `fly secrets set CONVERT_TOKEN=...`
- **Render / Railway** : « Deploy from Dockerfile », définir `CONVERT_TOKEN`.

Puis, côté Vercel, configurer :

| Variable (Vercel) | Valeur |
|---|---|
| `OFFICE_CONVERT_URL` | `https://mon-service.exemple.com` |
| `OFFICE_CONVERT_TOKEN` | le même jeton que `CONVERT_TOKEN` |

Sans `OFFICE_CONVERT_URL`, la route `/api/ai/tutor/convert` répond
`convert-unavailable` et les fichiers legacy affichent une erreur de conversion.
