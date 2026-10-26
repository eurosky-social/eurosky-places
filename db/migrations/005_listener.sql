-- Where the check-in listener is in Jetstream's stream (Jetstream's time_us, microseconds
-- since 1970), so that a restart resumes there instead of skipping what was published
-- meanwhile. One row per collection it follows.
CREATE TABLE meta.listener_cursors (
  collection  text PRIMARY KEY,
  time_us     bigint NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
