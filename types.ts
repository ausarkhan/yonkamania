import { z } from 'zod';

// User profile (profiles table)
export const UserProfileSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  username: z.string().nullable().optional(),
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  bio: z.string().nullable(),
  banner_url: z.string().nullable().optional(),
  is_creator: z.boolean().optional(),
  stripe_account_id: z.string().nullable().optional(),
  stripe_customer_id: z.string().nullable().optional(),
  role: z.string().optional(),
  created_at: z.string(),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

// Creator profile (creator_profiles table)
export const CreatorProfileSchema = z.object({
  id: z.string(),
  display_name: z.string().nullable(),
  bio: z.string().nullable(),
  avatar_url: z.string().nullable(),
  banner_url: z.string().nullable(),
  category: z.string().nullable().optional(),
  is_verified: z.boolean().optional(),
  subscriber_count: z.number().optional(),
  created_at: z.string().optional(),
});

export type CreatorProfile = z.infer<typeof CreatorProfileSchema>;

// Post media (post_media table)
export const PostMediaSchema = z.object({
  id: z.string(),
  media_url: z.string(),
  media_type: z.string().nullable().optional(),
  sort_order: z.number().nullable().optional(),
  created_at: z.string().optional(),
});

export type PostMedia = z.infer<typeof PostMediaSchema>;

// Post (posts table)
export const PostSchema = z.object({
  id: z.string(),
  creator_id: z.string(),
  caption: z.string().nullable(),
  is_free: z.boolean().optional(), // derived: access_type === 'free'
  access_type: z.enum(['free', 'subscriber', 'ppv']).nullable().optional(),
  price: z.number().nullable().optional(),
  is_published: z.boolean().optional(),
  created_at: z.string(),
  post_media: z.array(PostMediaSchema).optional(),
  // Server-resolved: true if the requesting user is allowed to view this post's content
  has_access: z.boolean().optional(),
});

export type Post = z.infer<typeof PostSchema>;

// Create post request schema
export const PostMediaItemSchema = z.object({
  storage_path: z.string(),
  type: z.string(),
  thumbnail_url: z.string().nullable().optional(),
});

export type PostMediaItem = z.infer<typeof PostMediaItemSchema>;

export const CreatePostSchema = z.object({
  caption: z.string().min(1).max(2000),
  access_type: z.enum(['free', 'subscriber', 'ppv']),
  ppv_price: z.number().int().min(0).nullable().optional(), // cents
  media_items: z.array(PostMediaItemSchema).optional(),
});

export type CreatePost = z.infer<typeof CreatePostSchema>;

// Subscription (subscriptions table)
export const SubscriptionSchema = z.object({
  id: z.string(),
  subscriber_id: z.string(),
  creator_id: z.string(),
  status: z.string(),
  price: z.number().nullable().optional(),
  created_at: z.string(),
  creator_profiles: CreatorProfileSchema.nullable().optional(),
});

export type Subscription = z.infer<typeof SubscriptionSchema>;

// Subscription stats
export const SubscriptionStatsSchema = z.object({
  activeCount: z.number(),
  monthlySpend: z.number(),
  creatorsSupported: z.number(),
});

export type SubscriptionStats = z.infer<typeof SubscriptionStatsSchema>;

// API request schemas
export const UpdateProfileSchema = z.object({
  display_name: z.string().min(1).max(50).optional(),
  bio: z.string().max(500).optional(),
  avatar_url: z.string().url().optional(),
  banner_url: z.string().url().optional(),
  username: z.string().min(3).max(30).optional(),
});

export const CreatePPVSessionSchema = z.object({
  post_id: z.string(),
  creator_id: z.string(),
});

export type CreatePPVSession = z.infer<typeof CreatePPVSessionSchema>;

export const CreateTipSessionSchema = z.object({
  creator_id: z.string(),
  amount_cents: z.number().int().min(100),
});

export type CreateTipSession = z.infer<typeof CreateTipSessionSchema>;
