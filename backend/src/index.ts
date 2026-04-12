import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

const nodeEnv = process.env.NODE_ENV ?? 'development';
const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

if (Number.isNaN(port)) {
  throw new Error('Invalid PORT value. Expected a number.');
}

const configuredOrigins = (process.env.FRONTEND_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const localDevOrigins = nodeEnv === 'production'
  ? []
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

const allowedOrigins = new Set([...configuredOrigins, ...localDevOrigins]);

if (nodeEnv === 'production' && configuredOrigins.length === 0) {
  console.warn('[startup] FRONTEND_ORIGIN is not set. Browser requests from the frontend may fail CORS checks.');
}

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) {
        return '';
      }

      return allowedOrigins.has(origin) ? origin : '';
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);

app.onError((error, c) => {
  console.error('[request-error]', error);

  return c.json(
    {
      error: 'Internal Server Error',
      message: nodeEnv === 'production' ? 'Something went wrong.' : error.message,
    },
    500,
  );
});

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

app.get('/', (c) => {
  return c.json({
    service: 'yonkamania-backend',
    status: 'ok',
    environment: nodeEnv,
  });
});

app.get('/health', (c) => {
  return c.json({
    ok: true,
    uptime: process.uptime(),
    environment: nodeEnv,
    timestamp: new Date().toISOString(),
  });
});

const missingOptionalConfig = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'JWT_SECRET',
  'SESSION_SECRET',
].filter((key) => !process.env[key]);

if (missingOptionalConfig.length > 0) {
  console.warn(
    `[startup] Missing environment variables for optional integrations: ${missingOptionalConfig.join(', ')}`,
  );
}

try {
  const server = Bun.serve({
    fetch: app.fetch,
    hostname: host,
    port,
    error(error) {
      console.error('[server-error]', error);

      return new Response('Internal Server Error', { status: 500 });
    },
  });

  console.log(`[startup] API listening on http://${server.hostname}:${server.port} (${nodeEnv})`);
} catch (error) {
  console.error('[startup] Failed to start backend server.', error);
  process.exit(1);
}
