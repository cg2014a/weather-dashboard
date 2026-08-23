CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL UNIQUE,
  management_token_hash TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL UNIQUE,
  subscription_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_delivery_at INTEGER NOT NULL,
  delivery_lock_until INTEGER NOT NULL DEFAULT 0,
  test_cooldown_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS push_subscriptions_due_idx
  ON push_subscriptions (enabled, next_delivery_at, delivery_lock_until);
