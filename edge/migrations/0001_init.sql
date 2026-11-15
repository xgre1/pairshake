-- PairShake's database. Each row keeps its whole record as JSON in `data` (what the room works with), plus the
-- columns worth querying on their own.

-- Everyone who talked to Emma (or signed up), demo test attendees included (test = 1).
CREATE TABLE users (
  id          TEXT PRIMARY KEY,           -- random, 10 hex characters; whoever has it is this user
  email       TEXT UNIQUE,                -- only with an account
  name        TEXT,
  app         INTEGER NOT NULL DEFAULT 0, -- joined from the iPhone app
  test        INTEGER NOT NULL DEFAULT 0, -- a made-up attendee from the test button
  has_profile INTEGER NOT NULL DEFAULT 0, -- Emma has written their card (they can be matched)
  created_at  REAL NOT NULL,              -- unix seconds
  updated_at  REAL NOT NULL,
  data        TEXT NOT NULL               -- the whole record: transcript, profile, socials, inbox, password hash...
);

-- One row per introduction between two people, with its chat and each side's yes or no.
CREATE TABLE missions (
  id          TEXT PRIMARY KEY,
  a           TEXT NOT NULL,              -- the person Emma was talking to
  b           TEXT NOT NULL,              -- the person she introduced them to (a user id, or a demo attendee "s1".."s10")
  outcome     INTEGER,                    -- NULL until both decided (or one said no); 1 = they meet, 0 = not
  created_at  REAL NOT NULL,
  updated_at  REAL NOT NULL,
  data        TEXT NOT NULL
);
CREATE INDEX missions_a ON missions(a);
CREATE INDEX missions_b ON missions(b);

-- Small values for the whole room (the counts on the room screen).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
