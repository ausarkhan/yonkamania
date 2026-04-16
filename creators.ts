import { Hono } from 'hono';
import { supabaseAdmin } from '../lib/supabase';
import { resolvePostAccess } from '../lib/access';

const creatorsRouter = new Hono();

// Get featured/all creators from creator_profiles
creatorsRouter.get('/', async (c) => {
  const { data: creators, error } = await supabaseAdmin
    .from('creator_profiles')
    .select('*')
    .limit(20);

  if (error) {
    console.error('Error fetching creators:', error);
    return c.json({ error: { message: 'Failed to fetch creators', code: 'FETCH_FAILED' } }, 500);
  }

  // Join profile data for each creator
  const creatorsWithProfiles = await Promise.all(
    (creators || []).map(async (cp: Record<string, unknown>) => {
      const userId = cp.user_id as string;
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('display_name, avatar_url, username, bio')
        .eq('id', userId)
        .single();
      return {
        ...cp,
        id: userId,
        display_name: profile?.display_name ?? null,
        avatar_url: profile?.avatar_url ?? null,
        username: profile?.username ?? null,
        bio: profile?.bio ?? null,
      };
    })
  );

  return c.json({ data: creatorsWithProfiles });
});

// Get creator profile with posts (access-controlled per viewer)
creatorsRouter.get('/:id', async (c) => {
  const creatorId = c.req.param('id');

  // Extract optional viewer identity up-front — used for access checks and isFollowing
  let userId: string | null = null;
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');
    const { data: { user } } = await supabaseAdmin.auth.getUser(token);
    if (user) userId = user.id;
  }

  // creator_profiles uses user_id as PK
  const { data: creator, error: creatorError } = await supabaseAdmin
    .from('creator_profiles')
    .select('*')
    .eq('user_id', creatorId)
    .single();

  if (creatorError || !creator) {
    return c.json({ error: { message: 'Creator not found', code: 'NOT_FOUND' } }, 404);
  }

  const resolvedId = (creator as Record<string, unknown>).user_id as string ?? creatorId;

  // Fetch profile info (display_name, avatar_url) from profiles table
  const { data: profileData } = await supabaseAdmin
    .from('profiles')
    .select('display_name, avatar_url, username, bio')
    .eq('id', resolvedId)
    .single();

  const { data: posts } = await supabaseAdmin
    .from('posts')
    .select('id, creator_id, caption, is_published, access_type, price, created_at, post_media(id, media_url, media_type, sort_order)')
    .eq('creator_id', resolvedId)
    .eq('is_published', true)
    .order('created_at', { ascending: false })
    .limit(20);

  const rawPosts = posts ?? [];

  // Batch-resolve access for all posts (2 DB queries max)
  const accessMap = await resolvePostAccess(userId, rawPosts);

  // Sign media URLs only for posts the viewer can access; redact media for locked posts
  const postsWithAccess = await Promise.all(
    rawPosts.map(async (post) => {
      const hasAccess = accessMap.get(post.id) ?? false;

      if (!hasAccess) {
        // Return post metadata but no media — client shows locked UI
        return { ...post, post_media: [], has_access: false };
      }

      if (!post.post_media || post.post_media.length === 0) {
        return { ...post, post_media: [], has_access: true };
      }

      const signedMedia = await Promise.all(
        post.post_media.map(async (item: { id: string; media_url: string; media_type: string | null; sort_order: number | null }) => {
          if (!item.media_url || item.media_url.startsWith('http')) return item;
          const { data, error: signError } = await supabaseAdmin.storage
            .from('post-media')
            .createSignedUrl(item.media_url, 3600);
          if (signError || !data) {
            console.error('Failed to sign URL for', item.media_url, signError);
            return item;
          }
          return { ...item, media_url: data.signedUrl };
        })
      );

      return { ...post, post_media: signedMedia, has_access: true };
    })
  );

  // Get subscriber count
  const { count: subscriberCount } = await supabaseAdmin
    .from('subscriptions')
    .select('*', { count: 'exact', head: true })
    .eq('creator_id', resolvedId)
    .eq('status', 'active');

  // Get follow count
  const { count: followCount } = await supabaseAdmin
    .from('follows')
    .select('*', { count: 'exact', head: true })
    .eq('creator_id', resolvedId);

  // Check if requesting user follows this creator
  let isFollowing = false;
  if (userId) {
    const { data: followRow } = await supabaseAdmin
      .from('follows')
      .select('follower_id')
      .eq('follower_id', userId)
      .eq('creator_id', resolvedId)
      .maybeSingle();
    isFollowing = !!followRow;
  }

  return c.json({
    data: {
      ...creator,
      id: resolvedId,
      display_name: profileData?.display_name ?? null,
      avatar_url: profileData?.avatar_url ?? null,
      username: profileData?.username ?? null,
      bio: profileData?.bio ?? null,
      posts: postsWithAccess,
      subscriber_count: subscriberCount ?? 0,
      follow_count: followCount ?? 0,
      is_following: isFollowing,
    },
  });
});

export { creatorsRouter };
