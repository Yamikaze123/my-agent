import { PostgresStore } from "@mastra/pg";
import { Memory } from "@mastra/memory";

// Extend the global type to include our instances
declare global {
  var pgStore: PostgresStore | undefined
  var memory: Memory | undefined
}

// Get or create the PostgresStore instance
function getPgStore(): PostgresStore {
  if (!global.pgStore) {
    if (!process.env.DATABASE_PASSWORD) {
      throw new Error('DATABASE_PASSWORD is not defined in environment variables')
    }
    global.pgStore = new PostgresStore({
      id: 'pg-storage',
      host: process.env.DATABASE_HOST || 'aws-1-us-west-2.pooler.supabase.com',
      port: process.env.DATABASE_PORT || '6543',
      database: 'postgres',
      user: process.env.DATABASE_USER || 'postgres.ckxyksujagxjygdnbmbn',
      password: process.env.DATABASE_PASSWORD
    })
  }
  return global.pgStore
}

// Get or create the Memory instance
function getMemory(): Memory {
  if (!global.memory) {
    global.memory = new Memory({
      storage: getPgStore(),
    })
  }
  return global.memory
}

export const storage = getPgStore()
export const memory = getMemory()