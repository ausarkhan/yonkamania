import { Hono } from 'hono';
import { supabaseAdmin } from '../lib/supabase';
import { resolvePostAccess } from '../lib/access';

const feedRouter = new Hono();

feedRouter.get('/', async (c) => {
  let userId: string | null = null;
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');
    const {
      data: { user },
    } = await supabaseAdmin.auth.getUser(token);
    if (user) userId = user.id;
  }

  const { data: posts, error } = await supabaseAdmin
    .from('posts')
    .select('id, creator_id, caption, access_type, price, is_published, created_at, post_media(id, media_url, media_type, sort_order)')
    .eq('is_published', true)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    console.error('Error fetching feed:', error);
    return c.json({ error: { message: 'Failed to fetch feed', code: 'FETCH_FAILED' } }, 500);
  }

  const rawPosts = posts ?? [];
  const accessMap = await resolvePostAccess(userId, rawPosts);

  const postsWithDetails = await Promise.all(
    rawPosts.map(async (post) => {
      const hasAccess = accessMap.get(post.id) ?? false;

      let signedMedia: typeof post.post_media = [];
      if (hasAccess && post.post_media && post.post_media.length > 0) {
        signedMedia = await Promise.all(
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
      }

      let creator: { display_name: string | null; avatar_url: string | null } = {
        display_name: null,
        avatar_url: null,
      };
      const { data: profileData } = await supabaseAdmin
        .from('profiles')
        .select('display_name, avatar_url')
        .eq('id', post.creator_id)
        .single();
      if (profileData) creator = profileData;

      return {
        id: post.id,
        creator_id: post.creator_id,
        content: post.caption,
        caption: post.caption,
        access_type: post.access_type,
        price: post.price,
        is_free: post.access_type === 'free',
        is_published: post.is_published,
        created_at: post.created_at,
        post_media: signedMedia,
        has_access: hasAccess,
        creator: {
          display_name: creator.display_name,
          avatar_url: creator.avatar_url,
        },
      };
    })
  );

  return c.json({ data: postsWithDetails });
});

export { feedRouter };
