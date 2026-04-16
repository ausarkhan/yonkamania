import { Hono } from 'hono';
import { authMiddleware, type AuthEnv } from '../middleware/auth';
import { stripe } from '../lib/stripe';
import { supabaseAdmin } from '../lib/supabase';
import { env } from '../env';

const stripeRouter = new Hono<AuthEnv>();

// Create Stripe Connect Express account for creator onboarding
stripeRouter.post('/connect/onboard', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const user = c.get('user');

  // Check if user already has a Stripe account
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_account_id')
    .eq('id', userId)
    .single();

  let accountId = profile?.stripe_account_id as string | undefined;

  if (!accountId) {
    // Create new Connect Express account
    const account = await stripe.accounts.create({
      type: 'express',
      email: user.email,
      metadata: { user_id: userId },
    });
    accountId = account.id;

    // Save to profile
    await supabaseAdmin
      .from('profiles')
      .update({ stripe_account_id: accountId, is_creator: true })
      .eq('id', userId);
  }

  // Create onboarding link
  const appUrl = env.APP_URL;
  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${appUrl}/dashboard/creator`,
    return_url: `${appUrl}/dashboard/creator`,
    type: 'account_onboarding',
  });

  return c.json({ data: { url: accountLink.url } });
});

// Get Connect account status — reads from creator_profiles, syncs onboarding_complete
stripeRouter.get('/connect/status', authMiddleware, async (c) => {
  const userId = c.get('userId');

  // Prefer creator_profiles.stripe_account_id, fall back to profiles
  const { data: creatorProfile } = await supabaseAdmin
    .from('creator_profiles')
    .select('stripe_account_id, onboarding_complete')
    .eq('user_id', userId)
    .single();

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_account_id')
    .eq('id', userId)
    .single();

  const accountId = (creatorProfile?.stripe_account_id ?? profile?.stripe_account_id) as string | null;

  if (!accountId) {
    return c.json({ data: { connected: false, charges_enabled: false, payouts_enabled: false, details_submitted: false, onboarding_complete: false } });
  }

  const account = await stripe.accounts.retrieve(accountId);

  // Sync onboarding_complete when Stripe says details are submitted
  if (account.details_submitted && creatorProfile && !creatorProfile.onboarding_complete) {
    await supabaseAdmin
      .from('creator_profiles')
      .update({ onboarding_complete: true })
      .eq('user_id', userId);
  }

  return c.json({
    data: {
      connected: true,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      onboarding_complete: account.details_submitted || creatorProfile?.onboarding_complete || false,
    }
  });
});

// Create a Stripe Connect Express account and save to creator_profiles
stripeRouter.post('/create-connected-account', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const user = c.get('user');

  const { data: creatorProfile } = await supabaseAdmin
    .from('creator_profiles')
    .select('stripe_account_id')
    .eq('user_id', userId)
    .single();

  if (!creatorProfile) {
    return c.json({ error: { message: 'Creator profile not found. Become a creator first.', code: 'NOT_FOUND' } }, 404);
  }

  let accountId = creatorProfile.stripe_account_id as string | null;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: user.email,
      metadata: { user_id: userId },
    });
    accountId = account.id;

    // Save to both tables for compatibility
    await supabaseAdmin
      .from('creator_profiles')
      .update({ stripe_account_id: accountId })
      .eq('user_id', userId);

    await supabaseAdmin
      .from('profiles')
      .update({ stripe_account_id: accountId, is_creator: true })
      .eq('id', userId);
  }

  return c.json({ data: { account_id: accountId } });
});

// Create a Stripe account link (onboarding URL) for the creator
stripeRouter.post('/create-account-link', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const { data: creatorProfile } = await supabaseAdmin
    .from('creator_profiles')
    .select('stripe_account_id')
    .eq('user_id', userId)
    .single();

  // Also check profiles table as fallback
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_account_id')
    .eq('id', userId)
    .single();

  const accountId = (creatorProfile?.stripe_account_id ?? profile?.stripe_account_id) as string | null;

  if (!accountId) {
    return c.json({ error: { message: 'No Stripe account found. Create one first.', code: 'NOT_FOUND' } }, 404);
  }

  const appUrl = env.APP_URL;
  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${appUrl}/dashboard/creator`,
    return_url: `${appUrl}/dashboard/creator`,
    type: 'account_onboarding',
  });

  return c.json({ data: { url: accountLink.url } });
});

// Create checkout session for subscribing to a creator
// Accepts creator_id and price_cents directly (no tiers table)
stripeRouter.post('/checkout', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const { creator_id, price_cents } = await c.req.json();

  if (!creator_id || !price_cents) {
    return c.json({ error: { message: 'creator_id and price_cents are required', code: 'BAD_REQUEST' } }, 400);
  }

  // Get creator's Stripe account from profiles
  const { data: creatorProfile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_account_id, display_name')
    .eq('id', creator_id)
    .single();

  if (!creatorProfile?.stripe_account_id) {
    return c.json({ error: { message: 'Creator has not set up payments', code: 'NOT_CONFIGURED' } }, 400);
  }

  // Get or create customer
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_customer_id, email')
    .eq('id', userId)
    .single();

  let customerId = profile?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: profile?.email as string | undefined,
      metadata: { user_id: userId },
    });
    customerId = customer.id;
    await supabaseAdmin
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', userId);
  }

  // Create a dynamic price for this subscription
  const price = await stripe.prices.create({
    unit_amount: price_cents,
    currency: 'usd',
    recurring: { interval: 'month' },
    product_data: { name: `Subscription to ${creatorProfile.display_name ?? 'Creator'}` },
  });

  const appUrl = env.APP_URL;
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    line_items: [{ price: price.id, quantity: 1 }],
    mode: 'subscription',
    success_url: `${appUrl}/dashboard?subscription=success`,
    cancel_url: `${appUrl}/dashboard?subscription=canceled`,
    subscription_data: {
      application_fee_percent: 10,
      transfer_data: {
        destination: creatorProfile.stripe_account_id as string,
      },
      metadata: {
        subscriber_id: userId,
        creator_id,
      },
    },
  });

  return c.json({ data: { url: session.url } });
});

// Platform fee configuration — 13% added on top of creator's base price
const PLATFORM_FEE_PERCENT = 13;

// Create Stripe Checkout session for subscribing to a creator
// Fan pays base price + 13% platform fee; creator receives base price
stripeRouter.post('/create-subscription-session', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const creator_id = body.creator_id as string | undefined;

  if (!creator_id) {
    return c.json({ error: { message: 'creator_id is required', code: 'BAD_REQUEST' } }, 400);
  }

  // Get creator profile — subscription_price and Stripe account
  const { data: creatorProfile } = await supabaseAdmin
    .from('creator_profiles')
    .select('stripe_account_id, subscription_price, display_name')
    .eq('user_id', creator_id)
    .single();

  if (!creatorProfile) {
    return c.json({ error: { message: 'Creator not found', code: 'NOT_FOUND' } }, 404);
  }

  const stripeAccountId = creatorProfile.stripe_account_id as string | null;
  if (!stripeAccountId) {
    return c.json({ error: { message: 'Creator has not set up payments yet', code: 'NOT_CONFIGURED' } }, 400);
  }

  const base_price = creatorProfile.subscription_price as number | null;
  if (!base_price || base_price <= 0) {
    return c.json({ error: { message: 'Creator has not set a subscription price', code: 'NOT_CONFIGURED' } }, 400);
  }

  // Fee breakdown:
  //   fan pays: base_price + platform_fee (13% of base)
  //   creator receives: base_price (approx, before Stripe processing fees)
  //   platform keeps: platform_fee via application_fee_percent on charge_amount
  const platform_fee_amount = Math.round(base_price * (PLATFORM_FEE_PERCENT / 100));
  const charge_amount = base_price + platform_fee_amount;
  // Express as % of charge_amount so Stripe routes platform_fee_amount to us
  const app_fee_percent = parseFloat(((platform_fee_amount / charge_amount) * 100).toFixed(5));

  // Get or create Stripe customer for the fan
  const { data: fanProfile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_customer_id, email')
    .eq('id', userId)
    .single();

  let customerId = fanProfile?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: fanProfile?.email as string | undefined,
      metadata: { user_id: userId },
    });
    customerId = customer.id;
    await supabaseAdmin
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', userId);
  }

  // Create a dynamic monthly price for this creator's subscription
  const price = await stripe.prices.create({
    unit_amount: charge_amount,
    currency: 'usd',
    recurring: { interval: 'month' },
    product_data: {
      name: `Subscription to ${(creatorProfile.display_name as string | null) ?? 'Creator'}`,
    },
  });

  const appUrl = env.APP_URL;
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    line_items: [{ price: price.id, quantity: 1 }],
    mode: 'subscription',
    success_url: `${appUrl}/creators/${creator_id}?subscription=success`,
    cancel_url: `${appUrl}/creators/${creator_id}`,
    metadata: {
      type: 'subscription',
      creator_id,
      fan_id: userId,
    },
    subscription_data: {
      application_fee_percent: app_fee_percent,
      transfer_data: {
        destination: stripeAccountId,
      },
      metadata: {
        type: 'subscription',
        creator_id,
        fan_id: userId,
      },
    },
  });

  return c.json({ data: { url: session.url } });
});

// Create Stripe Checkout session for pay-per-view post unlock
stripeRouter.post('/create-ppv-session', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const post_id = body.post_id as string | undefined;
  const creator_id = body.creator_id as string | undefined;

  if (!post_id || !creator_id) {
    return c.json({ error: { message: 'post_id and creator_id are required', code: 'BAD_REQUEST' } }, 400);
  }

  // Fetch post details
  const { data: post } = await supabaseAdmin
    .from('posts')
    .select('id, access_type, price, creator_id')
    .eq('id', post_id)
    .single();

  if (!post) {
    return c.json({ error: { message: 'Post not found', code: 'NOT_FOUND' } }, 404);
  }

  if (post.access_type !== 'ppv') {
    return c.json({ error: { message: 'Post is not pay-per-view', code: 'BAD_REQUEST' } }, 400);
  }

  const base_price = post.price as number | null;
  if (!base_price || base_price <= 0) {
    return c.json({ error: { message: 'Post does not have a valid price', code: 'BAD_REQUEST' } }, 400);
  }

  // Fetch creator's Stripe account — prefer creator_profiles, fall back to profiles
  const { data: creatorProfile } = await supabaseAdmin
    .from('creator_profiles')
    .select('stripe_account_id')
    .eq('user_id', creator_id)
    .single();

  const { data: creatorBaseProfile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_account_id')
    .eq('id', creator_id)
    .single();

  const stripeAccountId = (
    (creatorProfile?.stripe_account_id as string | null) ??
    (creatorBaseProfile?.stripe_account_id as string | null)
  );

  if (!stripeAccountId) {
    return c.json({ error: { message: 'Creator has not set up payments yet', code: 'NOT_CONFIGURED' } }, 400);
  }

  // Get or create Stripe customer for the fan
  const { data: fanProfile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_customer_id, email')
    .eq('id', userId)
    .single();

  let customerId = fanProfile?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: fanProfile?.email as string | undefined,
      metadata: { user_id: userId },
    });
    customerId = customer.id;
    await supabaseAdmin
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', userId);
  }

  // Fee calculation: fan pays base_price + 13% platform fee
  const platform_fee_amount = Math.round(base_price * (PLATFORM_FEE_PERCENT / 100));
  const charge_amount = base_price + platform_fee_amount;

  const appUrl = env.APP_URL;
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: charge_amount,
          product_data: { name: 'Unlock Post' },
        },
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: `${appUrl}/creators/${creator_id}?ppv=success`,
    cancel_url: `${appUrl}/creators/${creator_id}`,
    metadata: { type: 'ppv_post', creator_id, fan_id: userId, post_id },
    payment_intent_data: {
      application_fee_amount: platform_fee_amount,
      transfer_data: { destination: stripeAccountId },
      metadata: { type: 'ppv_post', creator_id, fan_id: userId, post_id },
    },
  });

  return c.json({ data: { url: session.url } });
});

// Create Stripe Checkout session for tipping a creator
stripeRouter.post('/create-tip-session', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const creator_id = body.creator_id as string | undefined;
  const amount_cents = body.amount_cents as number | undefined;

  if (!creator_id || amount_cents === undefined) {
    return c.json({ error: { message: 'creator_id and amount_cents are required', code: 'BAD_REQUEST' } }, 400);
  }

  if (!Number.isInteger(amount_cents) || amount_cents < 100) {
    return c.json({ error: { message: 'amount_cents must be an integer of at least 100 (minimum $1.00)', code: 'BAD_REQUEST' } }, 400);
  }

  // Fetch creator's Stripe account — prefer creator_profiles, fall back to profiles
  const { data: creatorProfile } = await supabaseAdmin
    .from('creator_profiles')
    .select('stripe_account_id, display_name')
    .eq('user_id', creator_id)
    .single();

  const { data: creatorBaseProfile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_account_id')
    .eq('id', creator_id)
    .single();

  const stripeAccountId = (
    (creatorProfile?.stripe_account_id as string | null) ??
    (creatorBaseProfile?.stripe_account_id as string | null)
  );

  if (!stripeAccountId) {
    return c.json({ error: { message: 'Creator has not set up payments yet', code: 'NOT_CONFIGURED' } }, 400);
  }

  // Get or create Stripe customer for the fan
  const { data: fanProfile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_customer_id, email')
    .eq('id', userId)
    .single();

  let customerId = fanProfile?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: fanProfile?.email as string | undefined,
      metadata: { user_id: userId },
    });
    customerId = customer.id;
    await supabaseAdmin
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', userId);
  }

  // Fee calculation: fan pays amount_cents + 13% platform fee
  const platform_fee_amount = Math.round(amount_cents * (PLATFORM_FEE_PERCENT / 100));
  const charge_amount = amount_cents + platform_fee_amount;

  const displayName = (creatorProfile?.display_name as string | null) ?? null;

  const appUrl = env.APP_URL;
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: charge_amount,
          product_data: { name: `Tip for ${displayName ?? 'Creator'}` },
        },
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: `${appUrl}/creators/${creator_id}?tip=success`,
    cancel_url: `${appUrl}/creators/${creator_id}`,
    metadata: { type: 'tip', creator_id, fan_id: userId },
    payment_intent_data: {
      application_fee_amount: platform_fee_amount,
      transfer_data: { destination: stripeAccountId },
      metadata: { type: 'tip', creator_id, fan_id: userId },
    },
  });

  return c.json({ data: { url: session.url } });
});

// ─── Stripe Webhook ───────────────────────────────────────────────────────────
//
// Event flow:
//   checkout.session.completed  → one-time payments (PPV, tip) and initial subscription confirmation
//   customer.subscription.*     → canonical subscription lifecycle (create/update/delete)
//   invoice.paid                → recurring subscription renewal (keep status active)
//   payment_intent.succeeded    → redundant safety net for PPV/tip (uses payment_intent metadata)
//   account.updated             → sync creator onboarding / verification status
//
// Tables written per event:
//   ppv_post  → purchases (insert), transactions (insert)
//   tip       → tips (insert), transactions (insert)
//   subscription lifecycle → subscriptions (upsert/update)
//   account.updated → creator_profiles (update)

// Helper to check Promise.allSettled results and log any rejections
function logSettledErrors(results: PromiseSettledResult<unknown>[], context: string) {
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[webhook] ${context} operation[${i}] failed:`, r.reason);
    }
  });
}

// Extracted webhook handler — shared by /api/stripe/webhook and /webhooks/stripe
const handleStripeWebhook = async (c: import('hono').Context) => {
  const rawBody = await c.req.text();
  const sig = c.req.header('stripe-signature') ?? '';
  const secret = env.STRIPE_WEBHOOK_SECRET;

  let event: import('stripe').Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err);
    return c.json({ error: { message: 'Invalid webhook signature', code: 'INVALID_SIGNATURE' } }, 400);
  }

  console.log(`[webhook] Received event: ${event.type} (id=${event.id})`);

  try {
    switch (event.type) {

      // ── checkout.session.completed ─────────────────────────────────────────
      // Fires once when a Checkout session finishes. Primary handler for PPV and tip.
      // For subscriptions the canonical source of truth is customer.subscription.* below.
      case 'checkout.session.completed': {
        const session = event.data.object as import('stripe').Stripe.Checkout.Session;
        const meta = session.metadata ?? {};
        const type = meta.type;

        console.log(`[webhook] checkout.session.completed | type=${type} session=${session.id} amount=${session.amount_total}`);

        if (type === 'ppv_post') {
          const { post_id, creator_id, fan_id } = meta;
          if (!post_id || !creator_id || !fan_id) {
            console.error(`[webhook] ppv_post missing metadata | post_id=${post_id} creator_id=${creator_id} fan_id=${fan_id}`);
            break;
          }
          const charge_amount = session.amount_total ?? 0;
          const base_amount = Math.round(charge_amount / 1.13);
          const platform_fee = charge_amount - base_amount;

          console.log(`[webhook] ppv_post → inserting purchase & transaction | post=${post_id} fan=${fan_id} creator=${creator_id} charge=${charge_amount} fee=${platform_fee}`);
          const results = await Promise.allSettled([
            supabaseAdmin.from('purchases').insert({
              post_id,
              fan_id,
              creator_id,
              amount_cents: base_amount,
              stripe_session_id: session.id,
            }),
            supabaseAdmin.from('transactions').insert({
              type: 'ppv_post',
              creator_id,
              fan_id,
              amount_cents: charge_amount,
              platform_fee_cents: platform_fee,
              stripe_session_id: session.id,
              stripe_payment_intent_id: session.payment_intent as string | null,
            }),
          ]);
          logSettledErrors(results, 'ppv_post checkout.session.completed');
          // Log individual Supabase errors
          results.forEach((r, i) => {
            if (r.status === 'fulfilled' && (r.value as { error?: { message: string } }).error) {
              console.error(`[webhook] ppv_post DB insert[${i}] error:`, (r.value as { error: { message: string } }).error.message);
            }
          });
        }

        if (type === 'tip') {
          const { creator_id, fan_id } = meta;
          if (!creator_id || !fan_id) {
            console.error(`[webhook] tip missing metadata | creator_id=${creator_id} fan_id=${fan_id}`);
            break;
          }
          const charge_amount = session.amount_total ?? 0;
          const base_amount = Math.round(charge_amount / 1.13);
          const platform_fee = charge_amount - base_amount;

          console.log(`[webhook] tip → inserting tip & transaction | fan=${fan_id} creator=${creator_id} charge=${charge_amount} fee=${platform_fee}`);
          const results = await Promise.allSettled([
            supabaseAdmin.from('tips').insert({
              creator_id,
              fan_id,
              amount_cents: base_amount,
              stripe_session_id: session.id,
            }),
            supabaseAdmin.from('transactions').insert({
              type: 'tip',
              creator_id,
              fan_id,
              amount_cents: charge_amount,
              platform_fee_cents: platform_fee,
              stripe_session_id: session.id,
              stripe_payment_intent_id: session.payment_intent as string | null,
            }),
          ]);
          logSettledErrors(results, 'tip checkout.session.completed');
          results.forEach((r, i) => {
            if (r.status === 'fulfilled' && (r.value as { error?: { message: string } }).error) {
              console.error(`[webhook] tip DB insert[${i}] error:`, (r.value as { error: { message: string } }).error.message);
            }
          });
        }

        // For subscription checkout.session.completed we record a transaction;
        // the subscription row itself is created/updated by customer.subscription.created below.
        if (type === 'subscription') {
          const { creator_id, fan_id } = meta;
          if (!creator_id || !fan_id) {
            console.error(`[webhook] subscription missing metadata | creator_id=${creator_id} fan_id=${fan_id}`);
            break;
          }
          const charge_amount = session.amount_total ?? 0;
          const base_amount = Math.round(charge_amount / 1.13);
          const platform_fee = charge_amount - base_amount;

          console.log(`[webhook] subscription → inserting transaction | fan=${fan_id} creator=${creator_id} charge=${charge_amount} fee=${platform_fee}`);
          const { error } = await supabaseAdmin.from('transactions').insert({
            type: 'subscription',
            creator_id,
            fan_id,
            amount_cents: charge_amount,
            platform_fee_cents: platform_fee,
            stripe_session_id: session.id,
          });
          if (error) console.error('[webhook] subscription transactions insert error:', error.message);
        }

        break;
      }

      // ── customer.subscription.created ──────────────────────────────────────
      case 'customer.subscription.created': {
        const sub = event.data.object as import('stripe').Stripe.Subscription;
        const meta = sub.metadata ?? {};
        const creator_id = meta.creator_id;
        const fan_id = meta.fan_id;

        console.log(`[webhook] customer.subscription.created | stripe_sub=${sub.id} status=${sub.status} creator=${creator_id} fan=${fan_id}`);

        if (!creator_id || !fan_id) {
          console.warn('[webhook] subscription.created missing creator_id/fan_id in metadata — cannot upsert subscriptions row');
          break;
        }

        const price = sub.items.data[0]?.plan?.amount ?? null;

        const { error } = await supabaseAdmin.from('subscriptions').upsert({
          subscriber_id: fan_id,
          creator_id,
          status: sub.status,
          stripe_subscription_id: sub.id,
          price,
        }, { onConflict: 'subscriber_id,creator_id', ignoreDuplicates: false });

        if (error) {
          console.error('[webhook] subscriptions upsert error:', error.message);
        } else {
          console.log(`[webhook] subscriptions upserted | fan=${fan_id} creator=${creator_id} status=${sub.status}`);
        }
        break;
      }

      // ── customer.subscription.updated ──────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object as import('stripe').Stripe.Subscription;
        const meta = sub.metadata ?? {};
        const creator_id = meta.creator_id;
        const fan_id = meta.fan_id;

        console.log(`[webhook] customer.subscription.updated | stripe_sub=${sub.id} status=${sub.status} creator=${creator_id} fan=${fan_id}`);

        if (creator_id && fan_id) {
          const price = sub.items.data[0]?.plan?.amount ?? null;
          const { error } = await supabaseAdmin.from('subscriptions').upsert({
            subscriber_id: fan_id,
            creator_id,
            status: sub.status,
            stripe_subscription_id: sub.id,
            price,
          }, { onConflict: 'subscriber_id,creator_id', ignoreDuplicates: false });
          if (error) {
            console.error('[webhook] subscriptions upsert error:', error.message);
          } else {
            console.log(`[webhook] subscriptions updated | fan=${fan_id} creator=${creator_id} status=${sub.status}`);
          }
        } else {
          // Fall back: update by stripe_subscription_id
          console.log(`[webhook] subscription.updated falling back to stripe_subscription_id lookup | sub=${sub.id}`);
          const { error } = await supabaseAdmin.from('subscriptions')
            .update({ status: sub.status })
            .eq('stripe_subscription_id', sub.id);
          if (error) {
            console.error('[webhook] subscriptions update by stripe_id error:', error.message);
          } else {
            console.log(`[webhook] subscriptions updated by stripe_id | sub=${sub.id} status=${sub.status}`);
          }
        }
        break;
      }

      // ── customer.subscription.deleted ──────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object as import('stripe').Stripe.Subscription;
        const meta = sub.metadata ?? {};
        const creator_id = meta.creator_id;
        const fan_id = meta.fan_id;

        console.log(`[webhook] customer.subscription.deleted | stripe_sub=${sub.id} creator=${creator_id} fan=${fan_id}`);

        if (creator_id && fan_id) {
          const { error } = await supabaseAdmin.from('subscriptions')
            .update({ status: 'cancelled' })
            .eq('subscriber_id', fan_id)
            .eq('creator_id', creator_id);
          if (error) {
            console.error('[webhook] subscriptions cancel error:', error.message);
          } else {
            console.log(`[webhook] subscriptions cancelled | fan=${fan_id} creator=${creator_id}`);
          }
        } else {
          const { error } = await supabaseAdmin.from('subscriptions')
            .update({ status: 'cancelled' })
            .eq('stripe_subscription_id', sub.id);
          if (error) {
            console.error('[webhook] subscriptions cancel by stripe_id error:', error.message);
          } else {
            console.log(`[webhook] subscriptions cancelled by stripe_id | sub=${sub.id}`);
          }
        }
        break;
      }

      // ── invoice.paid ───────────────────────────────────────────────────────
      // Fires on every successful subscription charge (initial + renewals).
      case 'invoice.paid': {
        const invoice = event.data.object as import('stripe').Stripe.Invoice;
        const stripeSubId = (invoice as unknown as Record<string, unknown>).subscription as string | null;

        console.log(`[webhook] invoice.paid | invoice=${invoice.id} stripe_sub=${stripeSubId ?? 'none'} amount=${(invoice as unknown as Record<string, unknown>).amount_paid ?? 0}`);

        if (stripeSubId) {
          const { error } = await supabaseAdmin.from('subscriptions')
            .update({ status: 'active' })
            .eq('stripe_subscription_id', stripeSubId);
          if (error) {
            console.error('[webhook] invoice.paid subscription status update error:', error.message);
          } else {
            console.log(`[webhook] subscription kept active via invoice.paid | sub=${stripeSubId}`);
          }
        } else {
          console.warn('[webhook] invoice.paid has no subscription id — skipping');
        }
        break;
      }

      // ── payment_intent.succeeded ───────────────────────────────────────────
      // Safety net for PPV / tip in case checkout.session.completed was missed.
      // Uses metadata set on payment_intent_data when creating the session.
      case 'payment_intent.succeeded': {
        const pi = event.data.object as import('stripe').Stripe.PaymentIntent;
        const meta = pi.metadata ?? {};
        const type = meta.type;

        console.log(`[webhook] payment_intent.succeeded | pi=${pi.id} type=${type ?? 'none'} amount=${pi.amount}`);

        if (type === 'ppv_post') {
          const { post_id, creator_id, fan_id } = meta;
          if (!post_id || !creator_id || !fan_id) {
            console.error(`[webhook] payment_intent ppv_post missing metadata | post_id=${post_id} creator_id=${creator_id} fan_id=${fan_id}`);
            break;
          }
          const charge_amount = pi.amount;
          const base_amount = Math.round(charge_amount / 1.13);

          // Only insert if not already recorded (idempotency via stripe_session_id)
          const { data: existing } = await supabaseAdmin.from('purchases')
            .select('id').eq('stripe_session_id', pi.id).maybeSingle();

          if (existing) {
            console.log(`[webhook] payment_intent ppv_post already recorded — skipping | pi=${pi.id}`);
          } else {
            console.log(`[webhook] payment_intent ppv_post safety-net insert | post=${post_id} fan=${fan_id} creator=${creator_id}`);
            const results = await Promise.allSettled([
              supabaseAdmin.from('purchases').insert({
                post_id,
                fan_id,
                creator_id,
                amount_cents: base_amount,
                stripe_session_id: pi.id,
              }),
              supabaseAdmin.from('transactions').insert({
                type: 'ppv_post',
                creator_id,
                fan_id,
                amount_cents: charge_amount,
                platform_fee_cents: charge_amount - base_amount,
                stripe_payment_intent_id: pi.id,
              }),
            ]);
            logSettledErrors(results, 'ppv_post payment_intent.succeeded');
          }
        }

        if (type === 'tip') {
          const { creator_id, fan_id } = meta;
          if (!creator_id || !fan_id) {
            console.error(`[webhook] payment_intent tip missing metadata | creator_id=${creator_id} fan_id=${fan_id}`);
            break;
          }
          const charge_amount = pi.amount;
          const base_amount = Math.round(charge_amount / 1.13);

          const { data: existing } = await supabaseAdmin.from('tips')
            .select('id').eq('stripe_session_id', pi.id).maybeSingle();

          if (existing) {
            console.log(`[webhook] payment_intent tip already recorded — skipping | pi=${pi.id}`);
          } else {
            console.log(`[webhook] payment_intent tip safety-net insert | fan=${fan_id} creator=${creator_id}`);
            const results = await Promise.allSettled([
              supabaseAdmin.from('tips').insert({
                creator_id,
                fan_id,
                amount_cents: base_amount,
                stripe_session_id: pi.id,
              }),
              supabaseAdmin.from('transactions').insert({
                type: 'tip',
                creator_id,
                fan_id,
                amount_cents: charge_amount,
                platform_fee_cents: charge_amount - base_amount,
                stripe_payment_intent_id: pi.id,
              }),
            ]);
            logSettledErrors(results, 'tip payment_intent.succeeded');
          }
        }

        break;
      }

      // ── account.updated ────────────────────────────────────────────────────
      // Fires when a connected Stripe Express account changes state.
      // Syncs onboarding_complete and verified to creator_profiles.
      case 'account.updated': {
        const account = event.data.object as import('stripe').Stripe.Account;
        const userId = account.metadata?.user_id;

        console.log(`[webhook] account.updated | stripe_account=${account.id} user_id=${userId ?? 'missing'} details_submitted=${account.details_submitted} charges_enabled=${account.charges_enabled}`);

        if (!userId) {
          console.warn('[webhook] account.updated missing user_id metadata — cannot sync creator_profiles');
          break;
        }

        const updates: Record<string, unknown> = {};
        if (account.details_submitted) updates.onboarding_complete = true;
        if (account.charges_enabled) updates.verified = true;

        if (Object.keys(updates).length > 0) {
          const { error } = await supabaseAdmin.from('creator_profiles')
            .update(updates)
            .eq('user_id', userId);
          if (error) {
            console.error('[webhook] creator_profiles update error:', error.message);
          } else {
            console.log(`[webhook] creator_profiles updated | user=${userId} fields=${JSON.stringify(updates)}`);
          }
        } else {
          console.log(`[webhook] account.updated no relevant fields changed | account=${account.id}`);
        }
        break;
      }

      default:
        console.log(`[webhook] Unhandled event type: ${event.type} — no action taken`);
    }
  } catch (err) {
    // Log but always return 200 so Stripe doesn't retry unnecessarily
    console.error(`[webhook] Unhandled error processing ${event.type}:`, err);
  }

  return c.json({ received: true });
};

// Register webhook on the stripe API router (legacy path: /api/stripe/webhook)
stripeRouter.post('/webhook', handleStripeWebhook);

// Dedicated webhook router for the production path: POST /webhooks/stripe
import { Hono as HonoWebhook } from 'hono';
const stripeWebhookRouter = new HonoWebhook();
stripeWebhookRouter.post('/', handleStripeWebhook);

export { stripeRouter, stripeWebhookRouter };
