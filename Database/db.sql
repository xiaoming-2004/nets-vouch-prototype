SET FOREIGN_KEY_CHECKS = 0;

CREATE DATABASE IF NOT EXISTS NetsVouch
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE NetsVouch;

-- ==========================================
-- 1. DATA DEFINITION LANGUAGE (DDL) SCHEMA
-- ==========================================

-- Clean slate drop
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS merchant_activity_slots;
DROP TABLE IF EXISTS merchants;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS rejection_feedback;
DROP TABLE IF EXISTS user_exclusions;
DROP TABLE IF EXISTS search_requests;
DROP TABLE IF EXISTS recommendations;
DROP TABLE IF EXISTS vouch_credit_ledger;
DROP TABLE IF EXISTS vouches;
DROP TABLE IF EXISTS shared_offers;
DROP TABLE IF EXISTS referral_cooldowns;
DROP TABLE IF EXISTS research_evidence;
DROP TABLE IF EXISTS illustrative_baseline;
DROP TABLE IF EXISTS demo_meta;
DROP TABLE IF EXISTS campaigns;
DROP TABLE IF EXISTS campaign_daily_counters;
DROP TABLE IF EXISTS journeys;

-- 1. USERS TABLE (saved demo-user preferences; see preferences-store.js)
CREATE TABLE users (
    user_id VARCHAR(32) PRIMARY KEY,
    display_name VARCHAR(60) NOT NULL,
    dietary_preference ENUM('none', 'halal', 'vegetarian', 'vegan') NOT NULL DEFAULT 'none',
    mood_cuisine VARCHAR(32) NOT NULL DEFAULT 'any',
    craving VARCHAR(100) NOT NULL DEFAULT '',
    budget_max DECIMAL(6,2) NOT NULL DEFAULT 10.00,
    max_distance_minutes INT NOT NULL DEFAULT 10,
    notifications TINYINT(1) NOT NULL DEFAULT 1,
    has_set_preferences TINYINT(1) NOT NULL DEFAULT 0,
    weight_price_sensitivity DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    weight_distance_sensitivity DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    weight_quietness_affinity DECIMAL(5,2) NOT NULL DEFAULT 1.00
);

-- 1b. REJECTION FEEDBACK (every "Not for me" reason, saved against the demo user)
CREATE TABLE rejection_feedback (
    feedback_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    merchant_id VARCHAR(64) NOT NULL,
    reason ENUM('too-expensive', 'too-far', 'ate-recently', 'not-in-mood') NOT NULL,
    category VARCHAR(64) NULL,
    price DECIMAL(6,2) NULL,
    distance_minutes INT NULL,
    cuisine_tags TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_rejection_user (user_id, feedback_id)
);

-- 2. MERCHANTS TABLE
CREATE TABLE merchants (
    merchant_id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    location_label VARCHAR(160) NOT NULL,
    distance_metres INT NOT NULL,
    cuisine_type VARCHAR(64) NOT NULL,
    typical_price DECIMAL(6,2) NOT NULL,
    dietary_halal BOOLEAN DEFAULT FALSE,
    dietary_vegetarian BOOLEAN DEFAULT FALSE,
    dietary_vegan BOOLEAN DEFAULT FALSE,
    reward_amount DECIMAL(6,2) NOT NULL DEFAULT 0.50,
    min_spend DECIMAL(6,2) NOT NULL DEFAULT 5.00,
    is_sample_data BOOLEAN NOT NULL DEFAULT TRUE
);

-- 3. MERCHANT ACTIVITY 
CREATE TABLE merchant_activity_slots (
    slot_id INT AUTO_INCREMENT PRIMARY KEY,
    merchant_id VARCHAR(64) NOT NULL,
    day_of_week TINYINT NOT NULL, 
    hour_24 TINYINT NOT NULL,
    avg_tx_count INT NOT NULL,
    FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id) ON DELETE CASCADE
);

-- 4. TRANSACTIONS TABLE
CREATE TABLE transactions (
    transaction_id VARCHAR(64) PRIMARY KEY,
    journey_token VARCHAR(64) UNIQUE NOT NULL,
    user_id VARCHAR(32) NOT NULL,
    merchant_id VARCHAR(64) NOT NULL,
    purchase_amount DECIMAL(6,2) NOT NULL,
    vouch_credit_applied DECIMAL(6,2) NOT NULL DEFAULT 0.00,
    nets_amount_paid DECIMAL(6,2) NOT NULL,
    is_simulated BOOLEAN NOT NULL DEFAULT TRUE,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
);


-- ==========================================
-- 2. DATA MANIPULATION LANGUAGE (DML) SEEDING
-- ==========================================

-- Seed Demo Users
INSERT IGNORE INTO users (user_id, display_name, budget_max, max_distance_minutes, dietary_preference)
VALUES
('jia', 'Jia', 10.00, 10, 'none'),
('darren', 'Darren', 10.00, 10, 'none');

-- Seed Merchants 
INSERT IGNORE INTO merchants 
(merchant_id, name, location_label, distance_metres, cuisine_type, typical_price, dietary_halal, dietary_vegetarian, dietary_vegan, reward_amount, min_spend) 
VALUES 
('felicia-chicken-rice', 'Felicia''s Chicken Rice', 'RP North Food Court', 180, 'chicken-rice', 5.00, TRUE, FALSE, FALSE, 0.80, 5.00),
('green-bowl', 'Green Bowl', 'RP North Food Court', 210, 'healthy-food', 7.50, FALSE, TRUE, TRUE, 1.00, 9.00),
('woodlands-noodle-bar', 'Woodlands Noodle Bar', 'Woodlands Demo Outlet', 320, 'noodles', 6.00, FALSE, FALSE, FALSE, 0.80, 6.00),
('northside-wraps', 'Northside Wraps', 'Woodlands Demo Outlet', 720, 'wraps', 6.80, TRUE, FALSE, FALSE, 0.50, 8.00),
('spice-lane', 'Spice Lane', 'Woodlands Demo Outlet', 560, 'indian-food', 7.50, TRUE, TRUE, FALSE, 0.70, 7.50),
('makcik-nasi-padang', 'Makcik Sari Nasi Padang', 'RP South Canteen', 250, 'malay', 5.50, TRUE, FALSE, FALSE, 0.60, 5.00),
('tokyo-express-bento', 'Tokyo Express Donburi', 'Woodlands Hub', 480, 'japanese', 8.90, FALSE, FALSE, FALSE, 1.00, 10.00),
('ah-heng-fish-soup', 'Ah Heng Sliced Fish Soup', 'RP South Canteen', 260, 'soup', 5.20, FALSE, FALSE, FALSE, 0.50, 5.00),
('vegan-zen-kitchen', 'Zen Plant Kitchen', 'Woodlands Hub', 640, 'healthy-food', 9.50, FALSE, TRUE, TRUE, 1.20, 12.00),
('kopi-toast-corner', 'Nanyang Kopi & Toast', 'RP North Food Court', 150, 'cafe', 4.50, TRUE, TRUE, FALSE, 0.50, 4.00);

-- Seed Simulated Hourly Transaction Velocity
INSERT IGNORE INTO merchant_activity_slots (merchant_id, day_of_week, hour_24, avg_tx_count) VALUES
('felicia-chicken-rice', 1, 12, 45),
('felicia-chicken-rice', 1, 14, 5),
('green-bowl', 1, 12, 30),
('green-bowl', 1, 14, 8),
('kopi-toast-corner', 1, 9, 50),
('kopi-toast-corner', 1, 14, 12);

SET FOREIGN_KEY_CHECKS = 1;