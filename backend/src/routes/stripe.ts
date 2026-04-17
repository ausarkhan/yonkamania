import { Hono } from 'hono';
import { authMiddleware, type AuthEnv } from '../middleware/auth';
import { stripe } from '../lib/stripe';
import { supabaseAdmin } from '../lib/supabase';
import { env } from '../env';

const stripeRouter = new Hono<AuthEnv>();

stripeRouter.post('/connect/onboard', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const user = c.get('user');

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_account_id')
    .eq('id', userId)
    .single();

  let accountId = profile?.stripe_account_id as string | undefined;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: user.email,
      metadata: { user_id: userId },
    });
    accountId = account.id;

    await supabaseAdmin
      .from('profiles')
      .update({ stripe_account_id: accountId, is_creator: true })
      .eq('id', userId);
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

stripeRouter.get('/connect/status', authMiddleware, async (c) => {
  const userId = c.get('userId');

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

  if (account.details_submitted && creatorProfile && !creatorProfile.onboarding_complete) {
    await supabaseAdmin.from('creator_profiles').update({ onboarding_complete: true }).eq('user_id', userId);
  }

  return c.json({
    data: {
      connected: true,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      onboarding_complete: account.details_submitted || creatorProfile?.onboarding_complete || false,
    },
  });
});

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

    await supabaseAdmin.from('creator_profiles').update({ stripe_account_id: accountId }).eq('user_id', userId);
    await supabaseAdmin.from('profiles').update({ stripe_account_id: accountId, is_creator: true }).eq('id', userId);
  }

  return c.json({ data: { account_id: accountId } });
});

stripeRouter.post('/create-account-link', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const { data: creatorProfile } = await supabaseAdmin
    .from('creator_profiles')
    .select('stripe_account_id')
    .eq('user_id', userId)
    .single();

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

stripeRouter.post('/checkout', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const { creator_id, price_cents } = await c.req.json();

  if (!creator_id || !price_cents) {
    return c.json({ error: { message: 'creator_id and price_cents are required', code: 'BAD_REQUEST' } }, 400);
  }

  const { data: creatorProfile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_account_id, display_name')
    .eq('id', creator_id)
    .single();

  if (!creatorProfile?.stripe_account_id) {
    return c.json({ error: { message: 'Creator has not set up payments', code: 'NOT_CONFIGURED' } }, 400);
  }

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
    await supabaseAdmin.from('profiles').update({ stripe_customer_id: customerId }).eq('id', userId);
  }

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
      transfer_data: { destination: creatorProfile.stripe_account_id as string },
      metadata: { subscriber_id: userId, creator_id },
    },
  });

  return c.json({ data: { url: session.url } });
});

const PLATFORM_FEE_PERCENT = 13;

stripeRouter.post('/create-subscription-session', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const creator_id = body.creator_id as string | undefined;

  if (!creator_id) {
    return c.json({ error: { message: 'creator_id is required', code: 'BAD_REQUEST' } }, 400);
  }

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

  const platform_fee_amount = Math.round(base_price * (PLATFORM_FEE_PERCENT / 100));
  const charge_amount = base_price + platform_fee_amount;
  const app_fee_percent = parseFloat(((platform_fee_amount / charge_amount) * 100).toFixed(5));

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
    await supabaseAdmin.from('profiles').update({ stripe_customer_id: customerId }).eq('id', userId);
  }

  const price = await stripe.prices.create({
    unit_amount: charge_amount,
    currency: 'usd',
    recurring: { interval: 'month' },
    product_data: { name: `Subscription to ${(creatorProfile.display_name as string | null) ?? 'Creator'}` },
  });

  const appUrl = env.APP_URL;
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    line_items: [{ price: price.id, quantity: 1 }],
    mode: 'subscription',
    success_url: `${appUrl}/creators/${creator_id}?subscription=success`,
    cancel_url: `${appUrl}/creators/${creator_id}`,
    metadata: { type: 'subscription', creator_id, fan_id: userId },
    subscription_data: {
      application_fee_percent: app_fee_percent,
      transfer_data: { destination: stripeAccountId },
      metadata: { type: 'subscription', creator_id, fan_id: userId },
    },
  });

  return c.json({ data: { url: session.url } });
});

stripeRouter.post('/create-ppv-session', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const post_id = body.post_id as string | undefined;
  const creator_id = body.creator_id as string | undefined;

  if (!post_id || !creator_id) {
    return c.json({ error: { message: 'post_id and creator_id are required', code: 'BAD_REQUEST' } }, 400);
  }

  const { data: post } = await supabaseAdmin.from('posts').select('id, access_type, price, creator_id').eq('id', post_id).single();

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

  const { data: creatorProfile } = await supabaseAdmin.from('creator_profiles').select('stripe_account_id').eq('user_id', creator_id).single();
  const { data: creatorBaseProfile } = await supabaseAdmin.from('profiles').select('stripe_account_id').eq('id', creator_id).single();

  const stripeAccountId = ((creatorProfile?.stripe_account_id as string | null) ?? (creatorBaseProfile?.stripe_account_id as string | null));

  if (!stripeAccountId) {
    return c.json({ error: { message: 'Creator has not set up payments yet', code: 'NOT_CONFIGURED' } }, 400);
  }

  const { data: fanProfile } = await supabaseAdmin.from('profiles').select('stripe_customer_id, email').eq('id', userId).single();

  let customerId = fanProfile?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: fanProfile?.email as string | undefined,
      metadata: { user_id: userId },
    });
    customerId = customer.id;
    await supabaseAdmin.from('profiles').update({ stripe_customer_id: customerId }).eq('id', userId);
  }

  const platform_fee_amount = Math.round(base_price * (PLATFORM_FEE_PERCENT / 100));
  const charge_amount = base_price + platform_fee_amount;
  const appUrl = env.APP_URL;

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    line_items: [{ price_data: { currency: 'usd', unit_amount: charge_amount, product_data: { name: 'Unlock Post' } }, quantity: 1 }],
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

  const { data: creatorProfile } = await supabaseAdmin.from('creator_profiles').select('stripe_account_id, display_name').eq('user_id', creator_id).single();
  const { data: creatorBaseProfile } = await supabaseAdmin.from('profiles').select('stripe_account_id').eq('id', creator_id).single();
  const stripeAccountId = ((creatorProfile?.stripe_account_id as string | null) ?? (creatorBaseProfile?.stripe_account_id as string | null));

  if (!stripeAccountId) {
    return c.json({ error: { message: 'Creator has not set up payments yet', code: 'NOT_CONFIGURED' } }, 400);
  }

  const { data: fanProfile } = await supabaseAdmin.from('profiles').select('stripe_customer_id, email').eq('id', userId).single();

  let customerId = fanProfile?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: fanProfile?.email as string | undefined,
      metadata: { user_id: userId },
    });
    customerId = customer.id;
    await supabaseAdmin.from('profiles').update({ stripe_customer_id: customerId }).eq('id', userId);
  }

  const platform_fee_amount = Math.round(amount_cents * (PLATFORM_FEE_PERCENT / 100));
  const charge_amount = amount_cents + platform_fee_amount;
  const displayName = (creatorProfile?.display_name as string | null) ?? null;
  const appUrl = env.APP_URL;

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    line_items: [{ price_data: { currency: 'usd', unit_amount: charge_amount, product_data: { name: `Tip for ${displayName ?? 'Creator'}` } }, quantity: 1 }],
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

function logSettledErrors(results: PromiseSettledResult<unknown>[], context: string) {
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`[webhook] ${context} operation[${index}] failed:`, result.reason);
    }
  });
}

const handleStripeWebhook = async (c: import('hono').Context) => {
  const rawBody = await c.req.text();
  const sig = c.req.header('stripe-signature') ?? '';
  const secret = env.STRIPE_WEBHOOK_SECRET;

  let event: import('stripe').Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (error) {
    console.error('[webhook] Signature verification failed:', error);
    return c.json({ error: { message: 'Invalid webhook signature', code: 'INVALID_SIGNATURE' } }, 400);
  }

  console.log(`[webhook] Received event: ${event.type} (id=${event.id})`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as import('stripe').Stripe.Checkout.Session;
        const meta = session.metadata ?? {};
        const type = meta.type;

        if (type === 'ppv_post') {
          const { post_id, creator_id, fan_id } = meta;
          if (!post_id || !creator_id || !fan_id) break;
          const charge_amount = session.amount_total ?? 0;
          const base_amount = Math.round(charge_amount / 1.13);
          const platform_fee = charge_amount - base_amount;

          const results = await Promise.allSettled([
            supabaseAdmin.from('purchases').insert({ post_id, fan_id, creator_id, amount_cents: base_amount, stripe_session_id: session.id }),
            supabaseAdmin.from('transactions').insert({ type: 'ppv_post', creator_id, fan_id, amount_cents: charge_amount, platform_fee_cents: platform_fee, stripe_session_id: session.id, stripe_payment_intent_id: session.payment_intent as string | null }),
          ]);
          logSettledErrors(results, 'ppv_post checkout.session.completed');
        }

        if (type === 'tip') {
          const { creator_id, fan_id } = meta;
          if (!creator_id || !fan_id) break;
          const charge_amount = session.amount_total ?? 0;
          const base_amount = Math.round(charge_amount / 1.13);
          const platform_fee = charge_amount - base_amount;

          const results = await Promise.allSettled([
            supabaseAdmin.from('tips').insert({ creator_id, fan_id, amount_cents: base_amount, stripe_session_id: session.id }),
            supabaseAdmin.from('transactions').insert({ type: 'tip', creator_id, fan_id, amount_cents: charge_amount, platform_fee_cents: platform_fee, stripe_session_id: session.id, stripe_payment_intent_id: session.payment_intent as string | null }),
          ]);
          logSettledErrors(results, 'tip checkout.session.completed');
        }

        if (type === 'subscription') {
          const { creator_id, fan_id } = meta;
          if (!creator_id || !fan_id) break;
          const charge_amount = session.amount_total ?? 0;
          const base_amount = Math.round(charge_amount / 1.13);
          const platform_fee = charge_amount - base_amount;
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

      case 'customer.subscription.created': {
        const sub = event.data.object as import('stripe').Stripe.Subscription;
        const meta = sub.metadata ?? {};
        const creator_id = meta.creator_id;
        const fan_id = meta.fan_id;
        if (!creator_id || !fan_id) break;
        const price = sub.items.data[0]?.plan?.amount ?? null;
        const { error } = await supabaseAdmin.from('subscriptions').upsert({
          subscriber_id: fan_id,
          creator_id,
          status: sub.status,
          stripe_subscription_id: sub.id,
          price,
        }, { onConflict: 'subscriber_id,creator_id', ignoreDuplicates: false });
        if (error) console.error('[webhook] subscriptions upsert error:', error.message);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as import('stripe').Stripe.Subscription;
        const meta = sub.metadata ?? {};
        const creator_id = meta.creator_id;
        const fan_id = meta.fan_id;

        if (creator_id && fan_id) {
          const price = sub.items.data[0]?.plan?.amount ?? null;
          const { error } = await supabaseAdmin.from('subscriptions').upsert({
            subscriber_id: fan_id,
            creator_id,
            status: sub.status,
            stripe_subscription_id: sub.id,
            price,
          }, { onConflict: 'subscriber_id,creator_id', ignoreDuplicates: false });
          if (error) console.error('[webhook] subscriptions upsert error:', error.message);
        } else {
          const { error } = await supabaseAdmin.from('subscriptions').update({ status: sub.status }).eq('stripe_subscription_id', sub.id);
          if (error) console.error('[webhook] subscriptions update by stripe_id error:', error.message);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as import('stripe').Stripe.Subscription;
        const meta = sub.metadata ?? {};
        const creator_id = meta.creator_id;
        const fan_id = meta.fan_id;

        if (creator_id && fan_id) {
          const { error } = await supabaseAdmin.from('subscriptions').update({ status: 'cancelled' }).eq('subscriber_id', fan_id).eq('creator_id', creator_id);
          if (error) console.error('[webhook] subscriptions cancel error:', error.message);
        } else {
          const { error } = await supabaseAdmin.from('subscriptions').update({ status: 'cancelled' }).eq('stripe_subscription_id', sub.id);
          if (error) console.error('[webhook] subscriptions cancel by stripe_id error:', error.message);
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as import('stripe').Stripe.Invoice;
        const stripeSubId = (invoice as unknown as Record<string, unknown>).subscription as string | null;
        if (stripeSubId) {
          const { error } = await supabaseAdmin.from('subscriptions').update({ status: 'active' }).eq('stripe_subscription_id', stripeSubId);
          if (error) console.error('[webhook] invoice.paid subscription status update error:', error.message);
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object as import('stripe').Stripe.PaymentIntent;
        const meta = pi.metadata ?? {};
        const type = meta.type;

        if (type === 'ppv_post') {
          const { post_id, creator_id, fan_id } = meta;
          if (!post_id || !creator_id || !fan_id) break;
          const charge_amount = pi.amount;
          const base_amount = Math.round(charge_amount / 1.13);
          const { data: existing } = await supabaseAdmin.from('purchases').select('id').eq('stripe_session_id', pi.id).maybeSingle();

          if (!existing) {
            const results = await Promise.allSettled([
              supabaseAdmin.from('purchases').insert({ post_id, fan_id, creator_id, amount_cents: base_amount, stripe_session_id: pi.id }),
              supabaseAdmin.from('transactions').insert({ type: 'ppv_post', creator_id, fan_id, amount_cents: charge_amount, platform_fee_cents: charge_amount - base_amount, stripe_payment_intent_id: pi.id }),
            ]);
            logSettledErrors(results, 'ppv_post payment_intent.succeeded');
          }
        }

        if (type === 'tip') {
          const { creator_id, fan_id } = meta;
          if (!creator_id || !fan_id) break;
          const charge_amount = pi.amount;
          const base_amount = Math.round(charge_amount / 1.13);
          const { data: existing } = await supabaseAdmin.from('tips').select('id').eq('stripe_session_id', pi.id).maybeSingle();

          if (!existing) {
            const results = await Promise.allSettled([
              supabaseAdmin.from('tips').insert({ creator_id, fan_id, amount_cents: base_amount, stripe_session_id: pi.id }),
              supabaseAdmin.from('transactions').insert({ type: 'tip', creator_id, fan_id, amount_cents: charge_amount, platform_fee_cents: charge_amount - base_amount, stripe_payment_intent_id: pi.id }),
            ]);
            logSettledErrors(results, 'tip payment_intent.succeeded');
          }
        }
        break;
      }

      case 'account.updated': {
        const account = event.data.object as import('stripe').Stripe.Account;
        const userId = account.metadata?.user_id;
        if (!userId) break;

        const updates: Record<string, unknown> = {};
        if (account.details_submitted) updates.onboarding_complete = true;
        if (account.charges_enabled) updates.verified = true;

        if (Object.keys(updates).length > 0) {
          const { error } = await supabaseAdmin.from('creator_profiles').update(updates).eq('user_id', userId);
          if (error) console.error('[webhook] creator_profiles update error:', error.message);
        }
        break;
      }

      default:
        console.log(`[webhook] Unhandled event type: ${event.type} - no action taken`);
    }
  } catch (error) {
    console.error(`[webhook] Unhandled error processing ${event.type}:`, error);
  }

  return c.json({ received: true });
};

stripeRouter.post('/webhook', handleStripeWebhook);

const stripeWebhookRouter = new Hono();
stripeWebhookRouter.post('/', handleStripeWebhook);

export { stripeRouter, stripeWebhookRouter };
