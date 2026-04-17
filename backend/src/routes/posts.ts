import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { supabaseAdmin } from '../lib/supabase';
import { authMiddleware, type AuthEnv } from '../middleware/auth';
import { CreatePostSchema } from '../types';
import { resolvePostAccess } from '../lib/access';

const postsRouter = new Hono<AuthEnv>();

postsRouter.get('/', async (c) => {
  const creatorId = c.req.query('creator_id');

  let userId: string | null = null;
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');
    const {
      data: { user },
    } = await supabaseAdmin.auth.getUser(token);
    if (user) userId = user.id;
  }

  let query = supabaseAdmin
    .from('posts')
    .select('id, creator_id, caption, is_published, access_type, price, created_at, post_media(id, media_url, media_type, sort_order)')
    .eq('is_published', true)
    .order('created_at', { ascending: false })
    .limit(20);

  if (creatorId) {
    query = query.eq('creator_id', creatorId);
  }

  const { data: posts, error } = await query;

  if (error) {
    console.error('Error fetching posts:', error);
    return c.json({ error: { message: 'Failed to fetch posts', code: 'FETCH_FAILED' } }, 500);
  }

  const rawPosts = posts ?? [];
  const accessMap = await resolvePostAccess(userId, rawPosts);

  const postsWithAccess = await Promise.all(
    rawPosts.map(async (post) => {
      const hasAccess = accessMap.get(post.id) ?? false;

      if (!hasAccess) {
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

  return c.json({ data: postsWithAccess });
});

postsRouter.post(
  '/',
  authMiddleware,
  zValidator('json', CreatePostSchema),
  async (c) => {
    const userId = c.get('userId');
    const { caption, access_type, ppv_price, media_items } = c.req.valid('json');

    const { data: creator, error: creatorError } = await supabaseAdmin
      .from('creator_profiles')
      .select('user_id')
      .eq('user_id', userId)
      .single();

    if (creatorError || !creator) {
      return c.json({ error: { message: 'Creator profile not found', code: 'NOT_CREATOR' } }, 403);
    }

    const { data: post, error: postError } = await supabaseAdmin
      .from('posts')
      .insert({
        creator_id: userId,
        caption,
        access_type,
        price: access_type === 'ppv' ? (ppv_price ?? 0) : null,
        is_published: true,
      })
      .select('id, creator_id, caption, is_published, access_type, price, created_at')
      .single();

    if (postError || !post) {
      console.error('Error creating post:', postError);
      return c.json({ error: { message: 'Failed to create post', code: 'CREATE_FAILED' } }, 500);
    }

    if (media_items && media_items.length > 0) {
      const mediaRows = media_items.map((item, index) => ({
        post_id: post.id,
        media_url: item.storage_path,
        media_type: item.type,
        sort_order: index,
      }));

      const { error: mediaError } = await supabaseAdmin.from('post_media').insert(mediaRows);

      if (mediaError) {
        console.error('Error inserting post media:', mediaError);
        return c.json({ error: { message: 'Post created but media upload failed', code: 'MEDIA_FAILED' } }, 500);
      }
    }

    return c.json({ data: post }, 201);
  }
);

postsRouter.delete('/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const postId = c.req.param('id');

  const { data: post, error: fetchError } = await supabaseAdmin
    .from('posts')
    .select('id, creator_id')
    .eq('id', postId)
    .single();

  if (fetchError || !post) {
    return c.json({ error: { message: 'Post not found', code: 'NOT_FOUND' } }, 404);
  }

  if (post.creator_id !== userId) {
    return c.json({ error: { message: 'Forbidden', code: 'FORBIDDEN' } }, 403);
  }

  const { error: mediaDeleteError } = await supabaseAdmin
    .from('post_media')
    .delete()
    .eq('post_id', postId);

  if (mediaDeleteError) {
    console.error('Error deleting post media:', mediaDeleteError);
    return c.json({ error: { message: 'Failed to delete post media', code: 'DELETE_FAILED' } }, 500);
  }

  const { error: deleteError } = await supabaseAdmin
    .from('posts')
    .delete()
    .eq('id', postId);

  if (deleteError) {
    console.error('Error deleting post:', deleteError);
    return c.json({ error: { message: 'Failed to delete post', code: 'DELETE_FAILED' } }, 500);
  }

  return new Response(null, { status: 204 });
});

export { postsRouter };
