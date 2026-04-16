import { supabaseAdmin } from './supabase';

type PostLike = {
  id: string;
  creator_id: string;
  access_type: string | null;
};

/**
 * Batch-resolve post access for a viewer.
 * Returns a Map<post_id, has_access>.
 *
 * Rules:
 *  free         → always true
 *  creator own  → always true (post.creator_id === userId)
 *  subscriber   → user has active/trialing subscription to that creator
 *  ppv          → user has a purchase record for that specific post
 *  unauthenticated → false for subscriber/ppv
 *
 * Only 2 DB queries total (batch by creator_id for subs, batch by post_id for purchases).
 */
export async function resolvePostAccess(
  userId: string | null,
  posts: PostLike[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (posts.length === 0) return result;

  const subscriberCreatorIds = new Set<string>();
  const ppvPostIds = new Set<string>();

  for (const post of posts) {
    const type = post.access_type ?? 'free';
    if (type === 'free') {
      result.set(post.id, true);
    } else if (userId && post.creator_id === userId) {
      // Creator always has full access to their own posts
      result.set(post.id, true);
    } else if (!userId) {
      // Unauthenticated — always locked for subscriber/ppv
      result.set(post.id, false);
    } else if (type === 'subscriber') {
      subscriberCreatorIds.add(post.creator_id);
    } else if (type === 'ppv') {
      ppvPostIds.add(post.id);
    } else {
      result.set(post.id, false);
    }
  }

  // Batch: check active subscriptions across all relevant creators
  const activeCreatorIds = new Set<string>();
  if (userId && subscriberCreatorIds.size > 0) {
    const { data: subs } = await supabaseAdmin
      .from('subscriptions')
      .select('creator_id')
      .eq('subscriber_id', userId)
      .in('status', ['active', 'trialing'])
      .in('creator_id', [...subscriberCreatorIds]);
    for (const sub of subs ?? []) {
      activeCreatorIds.add(sub.creator_id as string);
    }
  }

  // Batch: check PPV purchases for all relevant posts
  const purchasedPostIds = new Set<string>();
  if (userId && ppvPostIds.size > 0) {
    const { data: purchases } = await supabaseAdmin
      .from('purchases')
      .select('post_id')
      .eq('fan_id', userId)
      .in('post_id', [...ppvPostIds]);
    for (const p of purchases ?? []) {
      purchasedPostIds.add(p.post_id as string);
    }
  }

  // Resolve any posts not yet in the result map
  for (const post of posts) {
    if (result.has(post.id)) continue;
    const type = post.access_type ?? 'free';
    if (type === 'subscriber') {
      result.set(post.id, activeCreatorIds.has(post.creator_id));
    } else if (type === 'ppv') {
      result.set(post.id, purchasedPostIds.has(post.id));
    } else {
      result.set(post.id, false);
    }
  }

  return result;
}
