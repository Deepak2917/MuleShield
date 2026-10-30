BEGIN;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ANALYST', 'ADMINISTRATOR')),
    enabled INTEGER NOT NULL DEFAULT 1,
    mfa_enabled INTEGER NOT NULL DEFAULT 0,
    totp_secret TEXT,
    pending_totp_secret TEXT,
    last_totp_step BIGINT,
    recovery_hashes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mfa_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mfa_enrollment_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    actor_id TEXT,
    object_id TEXT,
    success INTEGER NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS investigations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    reported_amount DOUBLE PRECISION,
    currency TEXT NOT NULL DEFAULT 'USD',
    date_from TEXT,
    date_to TEXT,
    known_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'OPEN',
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    transaction_id TEXT NOT NULL,
    sender_account TEXT NOT NULL,
    receiver_account TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    timestamp TEXT NOT NULL,
    transaction_type TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    UNIQUE (investigation_id, transaction_id)
);

CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    rule_name TEXT NOT NULL,
    severity TEXT NOT NULL,
    explanation TEXT NOT NULL,
    supporting_transaction_ids TEXT NOT NULL,
    account_ids TEXT NOT NULL,
    timestamps TEXT NOT NULL,
    amounts TEXT NOT NULL,
    threshold TEXT NOT NULL,
    recommended_next_step TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS investigation_notes (
    id TEXT PRIMARY KEY,
    investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES users(id),
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    status TEXT NOT NULL DEFAULT 'STOPPED',
    events_processed INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_timestamp_idx
    ON audit_events(timestamp);

CREATE INDEX IF NOT EXISTS investigations_owner_idx
    ON investigations(owner_id, updated_at);

CREATE INDEX IF NOT EXISTS transactions_case_idx
    ON transactions(investigation_id, timestamp);

CREATE INDEX IF NOT EXISTS findings_case_idx
    ON findings(investigation_id, created_at);

COMMIT;