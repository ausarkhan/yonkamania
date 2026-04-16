import { Hono } from 'hono';
import { authMiddleware, type AuthEnv } from '../middleware/auth';
import { supabaseAdmin } from '../lib/supabase';

const authRouter = new Hono<AuthEnv>();

// POST /api/user/bootstrap — create profile if it doesn't exist
authRouter.post('/bootstrap', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const userEmail = c.get('userEmail');

  // Check for existing profile
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') {
    // PGRST116 = row not found, which is expected when no profile exists
    return c.json({ error: { message: 'Failed to check profile', code: 'DB_ERROR' } }, 500);
  }

  if (existing) {
    return c.json({ data: { profile: existing, isNew: false } });
  }

  // Create new profile
  const emailPrefix = (userEmail.split('@')[0] ?? 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
  const randomSuffix = Math.random().toString(36).slice(2, 6);
  const username = `${emailPrefix}${randomSuffix}`;

  const { data: newProfile, error: insertError } = await supabaseAdmin
    .from('profiles')
    .insert({
      id: userId,
      email: userEmail,
      username,
      display_name: emailPrefix,
      role: 'fan',
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    console.error('Profile creation error:', insertError);
    return c.json({ error: { message: 'Failed to create profile', code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data: { profile: newProfile, isNew: true } });
});

// GET /api/user/profile — get current user's profile
authRouter.get('/profile', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('*, creator_profiles(*)')
    .eq('id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return c.json({ error: { message: 'Profile not found', code: 'NOT_FOUND' } }, 404);
    }
    return c.json({ error: { message: 'Failed to fetch profile', code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data: profile });
});

// POST /api/user/become-creator — create creator_profiles row for the current user
authRouter.post('/become-creator', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));

  // Check if already a creator
  const { data: existing } = await supabaseAdmin
    .from('creator_profiles')
    .select('user_id')
    .eq('user_id', userId)
    .single();

  if (existing) {
    return c.json({ data: { already_creator: true } });
  }

  const { data: creatorProfile, error } = await supabaseAdmin
    .from('creator_profiles')
    .insert({
      user_id: userId,
      category: body.category ?? null,
      subscription_price: body.subscription_price ?? 0,
      banner_url: body.banner_url ?? null,
      onboarding_complete: false,
      verified: false,
    })
    .select()
    .single();

  if (error) {
    console.error('Creator profile creation error:', error);
    return c.json({ error: { message: 'Failed to create creator profile', code: 'DB_ERROR' } }, 500);
  }

  // Mark the profiles row as creator
  await supabaseAdmin
    .from('profiles')
    .update({ role: 'creator', is_creator: true })
    .eq('id', userId);

  return c.json({ data: { creator_profile: creatorProfile, already_creator: false } });
});

// PATCH /api/user/profile — update current user's profile
authRouter.patch('/profile', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));

  // Only allow safe fields to be updated
  const allowed = ['username', 'display_name', 'avatar_url', 'bio'];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: { message: 'No valid fields to update', code: 'BAD_REQUEST' } }, 400);
  }

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    return c.json({ error: { message: 'Failed to update profile', code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data: profile });
});

// PATCH /api/user/creator-profile — update creator profile fields
authRouter.patch('/creator-profile', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));

  const allowed = ['banner_url', 'category', 'subscription_price', 'bio', 'display_name', 'avatar_url'];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: { message: 'No valid fields to update', code: 'BAD_REQUEST' } }, 400);
  }

  const { data: profile, error } = await supabaseAdmin
    .from('creator_profiles')
    .update(updates)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    return c.json({ error: { message: 'Failed to update creator profile', code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data: profile });
});

// POST /api/user/avatar — upload avatar image to Supabase Storage
authRouter.post('/avatar', authMiddleware, async (c) => {
  const userId = c.get('userId');

  let file: File | undefined;
  try {
    const body = await c.req.parseBody();
    const raw = body['avatar'];
    if (raw instanceof File) file = raw;
  } catch {
    return c.json({ error: { message: 'Invalid request body', code: 'BAD_REQUEST' } }, 400);
  }

  if (!file) {
    return c.json({ error: { message: 'No file provided', code: 'BAD_REQUEST' } }, 400);
  }

  // Validate type
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) {
    return c.json({ error: { message: 'Only JPG, PNG, or WebP images are allowed', code: 'INVALID_TYPE' } }, 400);
  }

  // Validate size (5MB max)
  if (file.size > 5 * 1024 * 1024) {
    return c.json({ error: { message: 'File too large. Max size is 5MB', code: 'TOO_LARGE' } }, 400);
  }

  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const storagePath = `${userId}/${Date.now()}.${ext}`;

  const arrayBuffer = await file.arrayBuffer();

  const { error: uploadError } = await supabaseAdmin.storage
    .from('avatars')
    .upload(storagePath, arrayBuffer, {
      contentType: file.type,
      upsert: true,
    });

  if (uploadError) {
    console.error('Avatar upload error:', uploadError);
    return c.json({ error: { message: 'Failed to upload image', code: 'UPLOAD_ERROR' } }, 500);
  }

  const { data: { publicUrl } } = supabaseAdmin.storage.from('avatars').getPublicUrl(storagePath);

  const { error: updateError } = await supabaseAdmin
    .from('profiles')
    .update({ avatar_url: publicUrl })
    .eq('id', userId);

  if (updateError) {
    return c.json({ error: { message: 'Failed to save avatar URL', code: 'DB_ERROR' } }, 500);
  }

  return c.json({ data: { avatar_url: publicUrl } });
});

export { authRouter };
