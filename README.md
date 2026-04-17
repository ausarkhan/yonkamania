# Yonkamania - Creator Subscription Platform

A website-first creator subscription platform where fans can support their favorite creators through monthly subscriptions.

## Tech Stack

- **Frontend:** React + Vite + TypeScript + Tailwind CSS + shadcn/ui
- **Backend:** Hono + Bun + TypeScript
- **Auth:** Supabase Auth (email/password + Google OAuth)
- **Database:** Supabase (PostgreSQL)
- **Payments:** Stripe + Stripe Connect Express (creator payouts)

## Project Structure

```
webapp/                    # React frontend (port 8000)
  src/
    pages/                 # Route pages
      Home.tsx             # Landing page
      Auth.tsx             # Sign in / Sign up
      Dashboard.tsx        # User dashboard
      CreatorDashboard.tsx # Creator studio
      Creators.tsx         # Browse creators
      CreatorProfile.tsx   # Individual creator page
      Subscriptions.tsx    # Manage subscriptions
      Settings.tsx         # Account settings
    components/
      layout/              # Navbar, Sidebar, DashboardLayout
      home/                # Landing page components
      ui/                  # shadcn/ui components
    contexts/
      AuthContext.tsx       # Auth provider
    hooks/
      useAuth.ts           # Supabase auth hook
    lib/
      supabase.ts          # Supabase browser client
      apiClient.ts         # Authenticated API client
      api.ts               # Base API helper
      utils.ts             # Utilities

backend/                   # Hono API server (port 3000)
  src/
    routes/
      auth.ts              # User profile routes
      stripe.ts            # Stripe Connect + Checkout
      creators.ts          # Creator discovery
    lib/
      supabase.ts          # Supabase admin client
      stripe.ts            # Stripe server client
    middleware/
      auth.ts              # JWT auth middleware
    types.ts               # Shared Zod schemas
```

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/user/profile | Yes | Get current user profile |
| PATCH | /api/user/profile | Yes | Update user profile |
| POST | /api/stripe/connect/onboard | Yes | Start Stripe Connect onboarding |
| GET | /api/stripe/connect/status | Yes | Check Stripe Connect status |
| POST | /api/stripe/checkout | Yes | Create subscription checkout |
| GET | /api/creators | No | List featured creators |
| GET | /api/creators/:id | No | Get creator profile + tiers |

## Database Tables Needed (Supabase)

- `profiles` - User profiles (linked to auth.users)
- `tiers` - Subscription tiers per creator
- `subscriptions` - Active subscriptions
- `posts` - Creator content (future)

## Environment Variables

### Frontend (.env)
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase anonymous key
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` - Stripe publishable key

### Backend (.env)
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anonymous key
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key (server only)
- `STRIPE_SECRET_KEY` - Stripe secret key (server only)
