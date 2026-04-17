import { Hono } from 'hono';
import { supabaseAdmin } from '../lib/supabase';
import { authMiddleware, type AuthEnv } from '../middleware/auth';

const followsRouter = new Hono<AuthEnv>();

followsRouter.post('/:creator_id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const creatorId = c.req.param('creator_id');

  const { error } = await supabaseAdmin
    .from('follows')
    .upsert(
      { follower_id: userId, creator_id: creatorId },
      { onConflict: 'follower_id,creator_id', ignoreDuplicates: true }
    );

  if (error) {
    console.error('Error following creator:', error);
    return c.json({ error: { message: 'Failed to follow creator', code: 'FOLLOW_FAILED' } }, 500);
  }

  return c.json({ data: { followed: true } });
});

followsRouter.delete('/:creator_id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const creatorId = c.req.param('creator_id');

  const { error } = await supabaseAdmin
    .from('follows')
    .delete()
    .eq('follower_id', userId)
    .eq('creator_id', creatorId);

  if (error) {
    console.error('Error unfollowing creator:', error);
    return c.json({ error: { message: 'Failed to unfollow creator', code: 'UNFOLLOW_FAILED' } }, 500);
  }

  return c.json({ data: { followed: false } });
});

followsRouter.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const { data: follows, error } = await supabaseAdmin
    .from('follows')
    .select('creator_id')
    .eq('follower_id', userId);

  if (error) {
    console.error('Error fetching follows:', error);
    return c.json({ error: { message: 'Failed to fetch follows', code: 'FETCH_FAILED' } }, 500);
  }

  const creatorIds = (follows || []).map((f: { creator_id: string }) => f.creator_id);
  return c.json({ data: creatorIds });
});

followsRouter.get('/count/:creator_id', async (c) => {
  const creatorId = c.req.param('creator_id');

  const { count, error } = await supabaseAdmin
    .from('follows')
    .select('*', { count: 'exact', head: true })
    .eq('creator_id', creatorId);

  if (error) {
    console.error('Error fetching follow count:', error);
    return c.json({ error: { message: 'Failed to fetch follow count', code: 'FETCH_FAILED' } }, 500);
  }

  return c.json({ data: { count: count ?? 0 } });
});

export { followsRouter };
