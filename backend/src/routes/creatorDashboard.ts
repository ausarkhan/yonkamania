import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, type AuthEnv } from '../middleware/auth';
import { supabaseAdmin } from '../lib/supabase';

const creatorDashboardRouter = new Hono<AuthEnv>();

async function getCreatorProfile(userId: string) {
  const { data, error } = await supabaseAdmin
    .from('creator_profiles')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

creatorDashboardRouter.get('/overview', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const creatorProfile = await getCreatorProfile(userId).catch((err) => {
    console.error('[creator/overview] creator_profiles lookup error:', err);
    return null;
  });

  if (!creatorProfile) {
    return c.json({ error: { message: 'Creator profile not found', code: 'FORBIDDEN' } }, 403);
  }

  const [totalSubsResult, activeSubsResult, transactionsResult, tipsResult, purchasesResult, balanceResult] = await Promise.allSettled([
    supabaseAdmin.from('subscriptions').select('id', { count: 'exact', head: true }).eq('creator_id', userId),
    supabaseAdmin.from('subscriptions').select('id', { count: 'exact', head: true }).eq('creator_id', userId).eq('status', 'active'),
    supabaseAdmin.from('transactions').select('amount_cents, platform_fee_cents').eq('creator_id', userId),
    supabaseAdmin.from('tips').select('amount_cents').eq('creator_id', userId),
    supabaseAdmin.from('purchases').select('amount_cents').eq('creator_id', userId),
    supabaseAdmin.from('creator_balances').select('available_balance_cents, pending_balance_cents').eq('creator_id', userId).maybeSingle(),
  ]);

  const total_subscribers = totalSubsResult.status === 'fulfilled' ? (totalSubsResult.value.count ?? 0) : 0;
  const active_subscriptions = activeSubsResult.status === 'fulfilled' ? (activeSubsResult.value.count ?? 0) : 0;
  const transactions = transactionsResult.status === 'fulfilled' ? ((transactionsResult.value.data ?? []) as Array<Record<string, unknown>>) : [];
  const total_earnings_cents = transactions.reduce((sum, row) => sum + (((row.amount_cents as number) ?? 0) - (((row.platform_fee_cents as number | null) ?? 0))), 0);
  const tips = tipsResult.status === 'fulfilled' ? ((tipsResult.value.data ?? []) as Array<Record<string, unknown>>) : [];
  const tips_total_cents = tips.reduce((sum, row) => sum + (((row.amount_cents as number) ?? 0)), 0);
  const purchases = purchasesResult.status === 'fulfilled' ? ((purchasesResult.value.data ?? []) as Array<Record<string, unknown>>) : [];
  const ppv_sales_count = purchases.length;
  const ppv_sales_total_cents = purchases.reduce((sum, row) => sum + (((row.amount_cents as number) ?? 0)), 0);
  const balanceRow = balanceResult.status === 'fulfilled' ? (balanceResult.value.data as Record<string, unknown> | null) : null;
  const available_balance_cents = (balanceRow?.available_balance_cents as number) ?? 0;
  const pending_balance_cents = (balanceRow?.pending_balance_cents as number) ?? 0;

  return c.json({
    data: {
      total_subscribers,
      active_subscriptions,
      total_earnings_cents,
      tips_total_cents,
      ppv_sales_count,
      ppv_sales_total_cents,
      available_balance_cents,
      pending_balance_cents,
    },
  });
});

creatorDashboardRouter.get('/transactions', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const creatorProfile = await getCreatorProfile(userId).catch((err) => {
    console.error('[creator/transactions] creator_profiles lookup error:', err);
    return null;
  });

  if (!creatorProfile) {
    return c.json({ error: { message: 'Creator profile not found', code: 'FORBIDDEN' } }, 403);
  }

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('id, type, amount_cents, platform_fee_cents, status, created_at, fan_id')
    .eq('creator_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[creator/transactions] query error:', error.message);
    return c.json({ error: { message: 'Failed to fetch transactions', code: 'INTERNAL_ERROR' } }, 500);
  }

  return c.json({ data: data ?? [] });
});

creatorDashboardRouter.get('/payouts', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const creatorProfile = await getCreatorProfile(userId).catch((err) => {
    console.error('[creator/payouts] creator_profiles lookup error:', err);
    return null;
  });

  if (!creatorProfile) {
    return c.json({ error: { message: 'Creator profile not found', code: 'FORBIDDEN' } }, 403);
  }

  const [balanceResult, payoutRequestsResult] = await Promise.allSettled([
    supabaseAdmin.from('creator_balances').select('available_balance_cents, pending_balance_cents').eq('creator_id', userId).maybeSingle(),
    supabaseAdmin.from('payout_requests').select('id, amount_cents, status, created_at, notes').eq('creator_id', userId).order('created_at', { ascending: false }).limit(10),
  ]);

  const balanceRow = balanceResult.status === 'fulfilled' ? (balanceResult.value.data as Record<string, unknown> | null) : null;
  const available_balance_cents = (balanceRow?.available_balance_cents as number) ?? 0;
  const pending_balance_cents = (balanceRow?.pending_balance_cents as number) ?? 0;
  const payout_requests = payoutRequestsResult.status === 'fulfilled' ? (payoutRequestsResult.value.data ?? []) : [];

  return c.json({ data: { available_balance_cents, pending_balance_cents, payout_requests } });
});

creatorDashboardRouter.post(
  '/payout-request',
  authMiddleware,
  zValidator('json', z.object({ amount_cents: z.number().int().min(100) })),
  async (c) => {
    const userId = c.get('userId');
    const { amount_cents } = c.req.valid('json');

    const creatorProfile = await getCreatorProfile(userId).catch((err) => {
      console.error('[creator/payout-request] creator_profiles lookup error:', err);
      return null;
    });

    if (!creatorProfile) {
      return c.json({ error: { message: 'Creator profile not found', code: 'FORBIDDEN' } }, 403);
    }

    const { data: balanceRow, error: balanceError } = await supabaseAdmin
      .from('creator_balances')
      .select('available_balance_cents')
      .eq('creator_id', userId)
      .maybeSingle();

    if (balanceError) {
      console.error('[creator/payout-request] balance lookup error:', balanceError.message);
      return c.json({ error: { message: 'Failed to fetch balance', code: 'INTERNAL_ERROR' } }, 500);
    }

    const available = (balanceRow as Record<string, unknown> | null)?.available_balance_cents as number ?? 0;

    if (amount_cents > available) {
      const dollars = (available / 100).toFixed(2);
      return c.json({ error: { message: `Requested amount exceeds available balance of $${dollars}`, code: 'INSUFFICIENT_BALANCE' } }, 400);
    }

    const { data: newRow, error: insertError } = await supabaseAdmin
      .from('payout_requests')
      .insert({ creator_id: userId, amount_cents, status: 'pending' })
      .select()
      .single();

    if (insertError) {
      console.error('[creator/payout-request] insert error:', insertError.message);
      return c.json({ error: { message: 'Failed to create payout request', code: 'INTERNAL_ERROR' } }, 500);
    }

    return c.json({ data: newRow });
  }
);

creatorDashboardRouter.get('/posts-summary', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const creatorProfile = await getCreatorProfile(userId).catch((err) => {
    console.error('[creator/posts-summary] creator_profiles lookup error:', err);
    return null;
  });

  if (!creatorProfile) {
    return c.json({ error: { message: 'Creator profile not found', code: 'FORBIDDEN' } }, 403);
  }

  const { data, error } = await supabaseAdmin.from('posts').select('access_type').eq('creator_id', userId);

  if (error) {
    console.error('[creator/posts-summary] query error:', error.message);
    return c.json({ error: { message: 'Failed to fetch posts', code: 'INTERNAL_ERROR' } }, 500);
  }

  const posts = (data ?? []) as Array<Record<string, unknown>>;
  const total = posts.length;
  const free = posts.filter((post) => post.access_type === 'free').length;
  const subscriber = posts.filter((post) => post.access_type === 'subscriber').length;
  const ppv = posts.filter((post) => post.access_type === 'ppv').length;

  return c.json({ data: { total, free, subscriber, ppv } });
});

export { creatorDashboardRouter };
