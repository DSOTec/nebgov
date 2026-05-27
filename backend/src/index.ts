import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import competitionsRouter from "./routes/competitions";
import leaderboardRouter from "./routes/leaderboard";
import authRouter from "./routes/auth";
import notificationsRouter from "./routes/notifications";
import securityRouter from "./routes/security";
import { securityMonitor } from "./services/security-monitor";
import { runBackendMigrations } from "./db/migrationRunner";
import pino from "pino";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import { generateOpenApiDocument } from "./openapi";
import { logger } from "./logger";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Rate limiters
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

const joinLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many join attempts" },
});

const leaderboardLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

// Logging middleware
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === "/health",
    },
  }),
);

// Swagger documentation
app.get("/openapi.json", (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(generateOpenApiDocument());
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(generateOpenApiDocument()));

// Health check — exempt from rate limiting
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Apply global limiter to all routes below
app.use(globalLimiter);

// Routes
app.use("/auth", authRouter);
app.post("/competitions/:id/join", joinLimiter);
app.post("/competitions/:id/leave", joinLimiter);
app.use("/competitions", competitionsRouter);
app.use("/leaderboard/history", leaderboardLimiter);
app.use("/leaderboard", leaderboardRouter);
app.use("/notifications", notificationsRouter);
app.use("/security", securityRouter);

// Error handling
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    logger.error({ err }, "Unhandled error");
    res.status(500).json({ error: "Internal server error" });
  },
);

async function bootstrap(): Promise<void> {
  await runBackendMigrations();
  app.listen(PORT, () => {
    logger.info({ port: PORT }, "Backend server running");

    // Start the security monitor
    securityMonitor.start().catch((err) => {
      logger.error({ err }, "Failed to start security monitor");
    });
  });
}

if (process.env.NODE_ENV !== "test") {
  bootstrap().catch((err: unknown) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
}

export default app;
