import express from "express";
import handler from "./api/index.js";
import {
  createMemoryRateLimiter,
  createRateLimitMiddleware,
} from "./src/rate_limit.js";

const app = express();

const rateLimit = createRateLimitMiddleware(createMemoryRateLimiter());
app.get("/api/:action", rateLimit, handler);

const PORT = 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`),
);
