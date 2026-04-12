# Yonkamania

This repository is now organized as a simple monorepo:

- `backend/` — Hono API running on Bun, prepared for Railway deployment
- `webapp/` — React + Vite frontend, kept separate for later Vercel or Netlify deployment

## Repository layout

```text
.
├── backend/
└── webapp/
```

## Backend deployment on Railway

Railway should be pointed at the `backend/` directory as the service root.

### Recommended Railway settings

- **Root Directory:** `backend`
- **Install Command:** `bun install`
- **Start Command:** `bun run start`

### Required backend environment variables

Create these in Railway before going live:

- `NODE_ENV=production`
- `PORT` (Railway usually injects this automatically)
- `HOST=0.0.0.0`
- `FRONTEND_ORIGIN` — your deployed frontend URL for CORS
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET` if Stripe webhooks are used
- `JWT_SECRET`
- `SESSION_SECRET`

> Set `FRONTEND_ORIGIN` to your real frontend URL so browser requests are allowed in production.

## Local development

### Backend

```bash
cd backend
bun install
cp .env.example .env
bun run dev
```

### Frontend

```bash
cd webapp
npm install
cp .env.example .env
npm run dev
```

Set `VITE_API_URL` in `webapp/.env` to your backend URL.

## Notes

- No backend or frontend app files are mixed into the repo root.
- Secrets should stay in environment variables and never be committed.
- The backend is ready first for Railway, while the frontend remains isolated in `webapp/`.
