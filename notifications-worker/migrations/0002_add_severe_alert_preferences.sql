ALTER TABLE push_subscriptions ADD COLUMN morning_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN severe_alerts_enabled INTEGER NOT NULL DEFAULT 0;

UPDATE push_subscriptions
SET morning_enabled = enabled
WHERE morning_enabled = 0 AND enabled = 1;

CREATE TABLE IF NOT EXISTS severe_alert_notifications (
  subscription_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0,
  notified_at INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, alert_id)
);

CREATE INDEX IF NOT EXISTS severe_alert_notifications_expires_at_idx
  ON severe_alert_notifications (expires_at);
