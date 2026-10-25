require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");
const db = require("./db");
const { sendTickets } = require("./mailer");

const {
  MPESA_ENV = "sandbox", MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_PASSKEY,
  MPESA_SHORTCODE = "174379", PUBLIC_URL, CALLBACK_SECRET, ADMIN_KEY, PORT = 3000,
} = process.env;
for (const [k, v] of Object.entries({ MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_PASSKEY, PUBLIC_URL, CALLBACK_SECRET, ADMIN_KEY })) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
}
const BASE = MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

// Prices live on the server so customers can't change them. Index = event id used by the page.
const EVENTS = [
  { name: "Vibe Check by PHXP", price: 2000 }, { name: "Luo Festival", price: 3000 },
  { name: "SEC 2026", price: 5000 }, { name: "Sunday Brunch Club", price: 2500 },
  { name: "Stand-Up Night", price: 1500 }, { name: "Coast Beach Party", price: 1800 },
  { name: "Karaoke Lounge", price: 800 }, { name: "Rugby Sevens Day", price: 1200 },
];

let tokenCache = { value: null, exp: 0 };
async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString("base64");
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) throw new Error(`Token request failed (${r.status})`);
  const j = await r.json();
  tokenCache = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) - 60) * 1000 };
  return tokenCache.value;
}
const normalizePhone = (p) => {
  p = String(p).replace(/[\s+-]/g, "");
  if (/^0[17]\d{8}$/.test(p)) return "254" + p.slice(1);
  if (/^254[17]\d{8}$/.test(p)) return p;
  return null;
};
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length < 200;
const stamp = () => new Date(Date.now() + 3 * 3600e3).toISOString().replace(/\D/g, "").slice(0, 14); // Nairobi time
const admin = (req, res, next) => req.get("x-admin-key") === ADMIN_KEY ? next() : res.status(401).json({ error: "Unauthorized" });

// Tiny per-IP rate limit for /api/pay (5 per minute) to stop prompt-spamming.
const hits = new Map();
const limit = (req, res, next) => {
  const k = req.ip, now = Date.now(), arr = (hits.get(k) || []).filter((t) => now - t < 60000);
  if (arr.length >= 5) return res.status(429).json({ error: "Too many attempts. Wait a minute." });
  arr.push(now); hits.set(k, arr); next();
};

const q = {
  insertOrder: db.prepare("INSERT INTO orders(id,event_id,event,qty,amount,phone,email,created) VALUES(?,?,?,?,?,?,?,?)"),
  getOrder: db.prepare("SELECT * FROM orders WHERE id=?"),
  codes: db.prepare("SELECT code FROM tickets WHERE order_id=?"),
  insertTicket: db.prepare("INSERT INTO tickets(code,order_id) VALUES(?,?)"),
  fail: db.prepare("UPDATE orders SET status='failed', message=? WHERE id=? AND status='pending'"),
  pay: db.prepare("UPDATE orders SET status='paid', receipt=? WHERE id=? AND status='pending'"),
  emailed: db.prepare("UPDATE orders SET emailed=1 WHERE id=?"),
  expire: db.prepare("UPDATE orders SET status='failed', message='Expired' WHERE status='pending' AND created<?"),
  ticket: db.prepare("SELECT * FROM tickets WHERE code=?"),
  use: db.prepare("UPDATE tickets SET used=1, used_at=? WHERE code=? AND used=0"),
};
setInterval(() => q.expire.run(Date.now() - 10 * 60000), 60000);

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static("public"));

app.post("/api/pay", limit, async (req, res) => {
  try {
    const { phone, email, qty, eventId } = req.body || {};
    const ev = EVENTS[eventId], n = Number(qty), msisdn = normalizePhone(phone);
    if (!ev) return res.status(400).json({ error: "Unknown event." });
    if (!Number.isInteger(n) || n < 1 || n > 10) return res.status(400).json({ error: "Quantity must be 1 to 10." });
    if (!msisdn) return res.status(400).json({ error: "Invalid phone number." });
    if (!validEmail(String(email || ""))) return res.status(400).json({ error: "Invalid email." });

    const amount = ev.price * n, ts = stamp();
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${ts}`).toString("base64");
    const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: ts,
        TransactionType: "CustomerPayBillOnline", Amount: amount, PartyA: msisdn, PartyB: MPESA_SHORTCODE,
        PhoneNumber: msisdn, CallBackURL: `${PUBLIC_URL}/api/mpesa/callback/${CALLBACK_SECRET}`,
        AccountReference: "Tiketi", TransactionDesc: ev.name.slice(0, 13),
      }),
    });
    const j = await r.json();
    if (j.ResponseCode !== "0") return res.status(502).json({ error: j.errorMessage || j.ResponseDescription || "M-Pesa rejected the request." });
    q.insertOrder.run(j.CheckoutRequestID, eventId, ev.name, n, amount, msisdn, String(email).trim(), Date.now());
    res.json({ orderId: j.CheckoutRequestID });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not start payment. Try again." }); }
});

app.post("/api/mpesa/callback/:secret", (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: "Accepted" }); // always ack quickly
  (async () => {
    if (req.params.secret !== CALLBACK_SECRET) return;
    const cb = req.body?.Body?.stkCallback;
    const o = cb && q.getOrder.get(cb.CheckoutRequestID);
    if (!o || o.status !== "pending") return;
    if (cb.ResultCode !== 0) return void q.fail.run(cb.ResultDesc, o.id);
    const meta = Object.fromEntries((cb.CallbackMetadata?.Item || []).map((i) => [i.Name, i.Value]));
    if (Number(meta.Amount) !== o.amount) return void q.fail.run("Amount mismatch. Contact support.", o.id);
    const codes = [];
    db.transaction(() => {
      if (!q.pay.run(String(meta.MpesaReceiptNumber), o.id).changes) return;
      for (let i = 0; i < o.qty; i++) {
        const code = "TKT-" + crypto.randomBytes(5).toString("hex").toUpperCase();
        q.insertTicket.run(code, o.id); codes.push(code);
      }
    })();
    if (!codes.length) return;
    try {
      if (await sendTickets({ ...o, receipt: String(meta.MpesaReceiptNumber) }, codes)) q.emailed.run(o.id);
    } catch (e) { console.error("Email failed (use /api/admin/resend):", e.message); }
  })().catch((e) => console.error("callback error", e));
});

app.get("/api/status/:id", async (req, res) => {
  const o = q.getOrder.get(req.params.id);
  if (!o) return res.status(404).json({ status: "unknown" });
  let tickets = [];
  if (o.status === "paid") {
    tickets = await Promise.all(q.codes.all(o.id).map(async ({ code }) => ({ code, qr: await QRCode.toDataURL(code, { margin: 1, width: 240 }) })));
  }
  res.json({ status: o.status, message: o.message, receipt: o.receipt, tickets });
});

// Gate scanner (used by /scan.html). Atomically marks a ticket used so it can't be admitted twice.
app.post("/api/verify", admin, (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const t = q.ticket.get(code);
  if (!t) return res.json({ valid: false, reason: "Not found" });
  const o = q.getOrder.get(t.order_id);
  if (!q.use.run(Date.now(), code).changes) {
    return res.json({ valid: false, reason: "Already used at " + new Date(t.used_at).toLocaleTimeString("en-KE", { timeZone: "Africa/Nairobi" }), event: o.event });
  }
  res.json({ valid: true, event: o.event });
});

// Sales dashboard data and email resend (admin only).
app.get("/api/admin/stats", admin, (req, res) => {
  res.json(db.prepare(`SELECT o.event, COUNT(DISTINCT o.id) orders, COALESCE(SUM(DISTINCT o.amount),0) amount_note,
    (SELECT COUNT(*) FROM tickets t JOIN orders x ON x.id=t.order_id WHERE x.event=o.event) tickets,
    (SELECT COUNT(*) FROM tickets t JOIN orders x ON x.id=t.order_id WHERE x.event=o.event AND t.used=1) scanned,
    (SELECT COALESCE(SUM(amount),0) FROM orders WHERE event=o.event AND status='paid') revenue
    FROM orders o WHERE o.status='paid' GROUP BY o.event`).all().map(({ amount_note, ...r }) => r));
});
app.post("/api/admin/resend", admin, async (req, res) => {
  const o = q.getOrder.get(String(req.body?.orderId || ""));
  if (!o || o.status !== "paid") return res.status(404).json({ error: "Paid order not found" });
  try { await sendTickets(o, q.codes.all(o.id).map((c) => c.code)); q.emailed.run(o.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Tiketi running on :${PORT} (${MPESA_ENV})`));
