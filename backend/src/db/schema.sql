-- Concert Ticket Booking System Schema
-- Baseline per Section 9 & 10 of HLD

CREATE TABLE IF NOT EXISTS users (
    user_id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
    event_id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    venue VARCHAR(255) NOT NULL,
    event_time TIMESTAMP WITH TIME ZONE NOT NULL,
    total_seats INT NOT NULL,
    price_minor INT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    sale_status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'PAUSED', 'ENDED'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Serializes queue sequencing and coordinates dispatch without long locks
CREATE TABLE IF NOT EXISTS event_control (
    event_id VARCHAR(64) PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
    next_queue_sequence BIGINT NOT NULL DEFAULT 1,
    dispatch_paused BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Fixed payment gateways created per event/system run
CREATE TABLE IF NOT EXISTS payment_gateways (
    gateway_id INT NOT NULL,
    event_id VARCHAR(64) NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL DEFAULT 'FREE', -- 'FREE', 'BUSY', 'RECONCILING'
    current_assignment_id VARCHAR(64),
    generation BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (gateway_id, event_id)
);

CREATE TABLE IF NOT EXISTS seats (
    seat_id VARCHAR(64) PRIMARY KEY,
    event_id VARCHAR(64) NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    label VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'AVAILABLE', -- 'AVAILABLE', 'HELD', 'SOLD'
    current_reservation_id VARCHAR(64),
    version INT NOT NULL DEFAULT 0,
    CONSTRAINT uq_event_seat_label UNIQUE (event_id, label)
);

CREATE TABLE IF NOT EXISTS queue_entries (
    entry_id VARCHAR(64) PRIMARY KEY,
    event_id VARCHAR(64) NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    attempt_number INT NOT NULL DEFAULT 1,
    queue_sequence BIGINT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'WAITING', -- 'WAITING', 'PROCESSING', 'CONFIRMED', 'FAILED', 'RECONCILING', 'SOLD_OUT'
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    assigned_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT uq_event_queue_sequence UNIQUE (event_id, queue_sequence)
);

-- Partial index to prevent multiple concurrent active queue entries per user/event
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_user_queue_entry 
ON queue_entries (event_id, user_id) 
WHERE status IN ('WAITING', 'PROCESSING', 'RECONCILING');

CREATE TABLE IF NOT EXISTS reservations (
    reservation_id VARCHAR(64) PRIMARY KEY,
    event_id VARCHAR(64) NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    seat_id VARCHAR(64) NOT NULL REFERENCES seats(seat_id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deadline TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
    assignment_id VARCHAR(64) PRIMARY KEY,
    entry_id VARCHAR(64) UNIQUE NOT NULL REFERENCES queue_entries(entry_id) ON DELETE CASCADE,
    gateway_id INT NOT NULL,
    gateway_generation BIGINT NOT NULL,
    reservation_id VARCHAR(64) NOT NULL REFERENCES reservations(reservation_id) ON DELETE CASCADE,
    state VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'COMPLETED', 'FAILED', 'RECONCILING', 'CANCELLED'
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS payments (
    payment_id VARCHAR(64) PRIMARY KEY,
    assignment_id VARCHAR(64) UNIQUE NOT NULL REFERENCES assignments(assignment_id) ON DELETE CASCADE,
    provider_reference VARCHAR(128) UNIQUE NOT NULL,
    idempotency_key VARCHAR(128) UNIQUE NOT NULL,
    amount_minor INT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'SUCCESS', 'FAILED', 'CANCELLED', 'PENDING'
    sampled_duration INT, -- in ms
    sampled_outcome VARCHAR(32),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS bookings (
    booking_id VARCHAR(64) PRIMARY KEY,
    reservation_id VARCHAR(64) UNIQUE NOT NULL REFERENCES reservations(reservation_id) ON DELETE CASCADE,
    seat_id VARCHAR(64) UNIQUE NOT NULL REFERENCES seats(seat_id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    payment_id VARCHAR(64) UNIQUE NOT NULL REFERENCES payments(payment_id) ON DELETE CASCADE,
    confirmed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS callback_receipts (
    provider_event_id VARCHAR(128) PRIMARY KEY,
    payment_id VARCHAR(64) NOT NULL REFERENCES payments(payment_id) ON DELETE CASCADE,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processing_status VARCHAR(32) NOT NULL DEFAULT 'PROCESSED'
);

CREATE TABLE IF NOT EXISTS idempotency_records (
    record_id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    operation VARCHAR(64) NOT NULL,
    request_key VARCHAR(128) NOT NULL,
    request_hash VARCHAR(128) NOT NULL,
    result_reference VARCHAR(64),
    response_body TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_idempotency_user_op_key UNIQUE (user_id, operation, request_key)
);

-- Essential Performance Indexes
CREATE INDEX IF NOT EXISTS idx_queue_event_status_seq ON queue_entries (event_id, status, queue_sequence);
CREATE INDEX IF NOT EXISTS idx_seats_event_status ON seats (event_id, status);
CREATE INDEX IF NOT EXISTS idx_assignments_deadline ON assignments (deadline) WHERE state = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_gateways_status ON payment_gateways (event_id, status);
