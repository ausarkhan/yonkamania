import "@vibecodeapp/proxy"; // DO NOT REMOVE OTHERWISE VIBECODE PROXY WILL NOT WORK
import { Hono } from "hono";
import { cors } from "hono/cors";
import "./env";
import { sampleRouter } from "./routes/sample";
import { authRouter } from "./routes/auth";
import { stripeRouter, stripeWebhookRouter } from "./routes/stripe";
import { creatorsRouter } from "./routes/creators";
import { postsRouter } from "./routes/posts";
import { subscriptionsRouter } from "./routes/subscriptions";
import { followsRouter } from "./routes/follows";
import { feedRouter } from "./routes/feed";
import { creatorDashboardRouter } from "./routes/creatorDashboard";
import { consentRouter } from "./routes/consent";
import { logger } from "hono/logger";

const app = new Hono();

// CORS middleware - validates origin against allowlist
const allowed = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/[a-z0-9-]+\.dev\.vibecode\.run$/,
  /^https:\/\/[a-z0-9-]+\.vibecode\.run$/,
  /^https:\/\/[a-z0-9-]+\.vibecodeapp\.com$/,
  /^https:\/\/[a-z0-9-]+\.vibecode\.dev$/,
  /^https:\/\/vibecode\.dev$/,
  /^https:\/\/yonkamania\.space$/,
];

app.use(
  "*",
  cors({
    origin: (origin) => (origin && allowed.some((re) => re.test(origin)) ? origin : null),
    credentials: true,
  })
);

// Logging
app.use("*", logger());

// Health check endpoint
app.get("/health", (c) => c.json({ status: "ok" }));

// Routes
app.route("/api/sample", sampleRouter);
app.route("/api/user", authRouter);
app.route("/api/stripe", stripeRouter);
app.route("/api/creators", creatorsRouter);
app.route("/api/posts", postsRouter);
app.route("/api/subscriptions", subscriptionsRouter);
app.route("/api/follows", followsRouter);
app.route("/api/feed", feedRouter);
app.route("/api/creator", creatorDashboardRouter);
app.route("/api/consent", consentRouter);

// Production Stripe webhook endpoint — POST /webhooks/stripe
// Register this URL in the Stripe Dashboard: https://api.yonkamania.space/webhooks/stripe
app.route("/webhooks/stripe", stripeWebhookRouter);

const port = Number(process.env.PORT) || 3000;

export default {
  port,
  fetch: app.fetch,
};
