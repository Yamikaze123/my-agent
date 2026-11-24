import { beforeEach, vi } from "vitest";
import { resetRateLimits } from "@/mastra/security/rate-limit";

vi.spyOn(console, "log").mockImplementation(() => {});

// Request limits are process-wide; without a reset, the number of requests a
// test file makes would decide whether later tests are refused.
beforeEach(() => {
  resetRateLimits();
});
