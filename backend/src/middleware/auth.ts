import { createMiddleware } from 'hono/factory';
import type { User } from '@supabase/supabase-js';
import { supabaseAdmin } from '../lib/supabase';

type AuthVariables = {
  userId: string;
  userEmail: string;
  user: User;
};

export type AuthEnv = {
  Variables: AuthVariables;
};

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: { message: 'Missing or invalid authorization header', code: 'UNAUTHORIZED' } }, 401);
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return c.json({ error: { message: 'Missing bearer token', code: 'UNAUTHORIZED' } }, 401);
  }

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    return c.json({ error: { message: 'Invalid or expired token', code: 'UNAUTHORIZED' } }, 401);
  }

  c.set('userId', user.id);
  c.set('userEmail', user.email ?? '');
  c.set('user', user);

  await next();
});
