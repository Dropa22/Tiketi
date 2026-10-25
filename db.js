const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const file = process.env.DB_PATH || "./data/tiketi.db";
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, event_id INTEGER, event TEXT, qty INTEGER, amount INTEGER,
  phone TEXT, email TEXT, status TEXT DEFAULT 'pending', message TEXT, receipt TEXT,
  emailed INTEGER DEFAULT 0, created INTEGER
);
CREATE TABLE IF NOT EXISTS tickets(
  code TEXT PRIMARY KEY, order_id TEXT, used INTEGER DEFAULT 0, used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
`);
module.exports = db;
