# Deploying the Volley backend to Vercel

The app is a Fastify server wrapped as a single Vercel serverless function
(`api/index.ts`); `vercel.json` rewrites every path to it and raises the function
timeout to 60s (Hunter + draft calls can take 10–40s). Postgres must be a hosted
serverless database — your laptop's local Postgres is not reachable from Vercel.

## One-time setup (steps only you can do — account + billing)

### 1. Create a serverless Postgres
Use **Vercel Postgres** (Storage tab → Create → Postgres) or **Neon** (neon.tech).
Copy the **pooled** connection string (Neon: the host ending in `-pooler`). It must
include `sslmode=require`.

### 2. Provision the schema (run once from your machine)
The DB starts empty. From this folder, point drizzle at the new DB and push the schema:

```bash
DATABASE_URL="<your-neon-pooled-url>" npm run db:push
```

Re-run this whenever `src/db/schema.ts` changes.

### 3. Import the repo on Vercel
vercel.com → Add New → Project → import **mehek-builds/volley-backend**.
Framework preset: **Other**. Leave build/output settings default (Vercel detects
`api/` functions automatically — no build command needed).

### 4. Add Environment Variables (Project → Settings → Environment Variables)
Set these for Production (and Preview if you want):

| Key | Value |
|-----|-------|
| `DATABASE_URL` | your Neon/Vercel Postgres **pooled** URL |
| `JWT_SIGNING_SECRET` | any 32+ char random string |
| `ENCRYPTION_KEY` | any 32+ char random string, encrypts `application_profile` columns at rest |
| `BLOB_READ_WRITE_TOKEN` | Vercel Storage tab -> Create -> Blob; stores generated resume files |
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `HUNTER_API_KEY` | your Hunter key |
| `REOON_API_KEY` | your Reoon key (optional) |
| `BOUNCEBAN_API_KEY` | your BounceBan key (optional) |
| `APOLLO_API_KEY` | your Apollo key (optional fallback) |
| `NODE_ENV` | `production` |

`VERCEL` is set automatically by Vercel — that's what disables the local listener.
Do **not** set `PORT`/`HOST` (serverless ignores them).

### 5. Deploy
Click Deploy. Then verify:

```bash
curl https://<your-app>.vercel.app/health      # -> {"status":"ok",...}
```

## Point the extension at the deployed backend
In `student-outreach-extension`, create `.env` with:

```
VITE_API_BASE=https://<your-app>.vercel.app
```

Then rebuild: `npm run build`, and reload the unpacked extension in Chrome
(`chrome://extensions` → Volley → reload). The popup + Apply flow now hit Vercel.

## Notes
- **Cold starts:** the free tier sleeps; first request after idle is slow (~1–3s).
- **CORS** already allows the `chrome-extension://` origin (origin: true).
- **Function timeout** is 60s (Hobby max). If a resolve ever exceeds it, lower the
  per-resolve contact count or upgrade the plan (Pro allows 300s).
