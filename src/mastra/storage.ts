import { PostgresStore } from "@mastra/pg";
import { Memory } from "@mastra/memory";
import { requiredEnvironmentVariable } from "./config";

// Extend the global type to include our instances
declare global {
  var pgStore: PostgresStore | undefined;
  var memory: Memory | undefined;
}

// Get or create the PostgresStore instance
function getPgStore(): PostgresStore {
  if (!global.pgStore) {
    global.pgStore = new PostgresStore({
      id: "pg-storage",
      host: requiredEnvironmentVariable("DATABASE_HOST"),
      port: process.env.DATABASE_PORT || "6543",
      database: "postgres",
      user: requiredEnvironmentVariable("DATABASE_USER"),
      password: requiredEnvironmentVariable("DATABASE_PASSWORD"),
    });
  }
  return global.pgStore;
}

// Get or create the Memory instance
function getMemory(): Memory {
  if (!global.memory) {
    global.memory = new Memory({
      storage: getPgStore(),
    });
  }
  return global.memory;
}

export const storage = getPgStore();
export const memory = getMemory();
