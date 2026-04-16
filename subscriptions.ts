import { Hono } from 'hono';
import { authMiddleware, type AuthEnv } from '../middleware/auth';
import { supabaseAdmin } from '../lib/supabase';

const subscriptionsRouter = new Hono<AuthEnv>();

// GET /api/subscriptions — get current user's active subscriptions
subscriptionsRouter.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const { data: subscriptions, error } = await supabaseAdmin
    .from('subscriptions')
    .select('id, subscriber_id, creator_id, status, price, created_at')
    .eq('subscriber_id', userId)
    .eq('status', 'active');

  if (error) {
    console.error('Error fetching subscriptions:', error);
    return c.json({ error: { message: 'Failed to fetch subscriptions', code: 'FETCH_FAILED' } }, 500);
  }

  const rows = subscriptions ?? [];

  // Fetch creator display info from profiles (display_name, avatar_url live on profiles, not creator_profiles)
  const creatorIds = [...new Set(rows.map((s) => s.creator_id as string))];
  let profileMap: Record<string, { display_name: string | null; avatar_url: string | null; bio: string | null }> = {};

  if (creatorIds.length > 0) {
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, display_name, avatar_url, bio')
      .in('id', creatorIds);
    for (const p of profiles ?? []) {
      const prof = p as { id: string; display_name: string | null; avatar_url: string | null; bio: string | null };
      profileMap[prof.id] = { display_name: prof.display_name, avatar_url: prof.avatar_url, bio: prof.bio };
    }
  }

  const enriched = rows.map((sub) => ({
    ...sub,
    creator_profiles: profileMap[sub.creator_id as string] ?? { display_name: null, avatar_url: null },
  }));

  return c.json({ data: enriched });
});

// GET /api/subscriptions/stats — get subscription stats for the current user
subscriptionsRouter.get('/stats', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const { data: subscriptions, error } = await supabaseAdmin
    .from('subscriptions')
    .select('id, creator_id, price, status')
    .eq('subscriber_id', userId)
    .eq('status', 'active');

  if (error) {
    return c.json({ data: { activeCount: 0, monthlySpend: 0, creatorsSupported: 0 } });
  }

  const activeCount = subscriptions?.length ?? 0;
  const monthlySpend = (subscriptions ?? []).reduce((sum, s) => sum + (Number(s.price) || 0), 0);
  const creatorsSupported = new Set((subscriptions ?? []).map((s) => s.creator_id)).size;

  return c.json({ data: { activeCount, monthlySpend, creatorsSupported } });
});

export { subscriptionsRouter };
