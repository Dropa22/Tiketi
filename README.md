# Tiketi backend v2 (M-Pesa + SQLite + Email + Gate scanner)

## Run locally
1. Node 18+ (22 recommended). `npm install`
2. `cp .env.example .env` and fill it in (never share or commit it).
3. Gmail: turn on 2-Step Verification for Bennettryan765@gmail.com, then create an **App Password** and put it in `GMAIL_APP_PASSWORD`.
4. `ngrok http 3000`, set `PUBLIC_URL` to the https URL.
5. `npm start`, open http://localhost:3000. Scanner: http://localhost:3000/scan.html

## What each part does
- **Database:** SQLite file at `DB_PATH`. Orders and tickets survive restarts. Back up the file regularly.
- **Email:** After payment confirms, the customer gets QR tickets by email. Bennettryan765@gmail.com is BCC'd on every sale.
  If sending fails: `POST /api/admin/resend` with header `x-admin-key` and JSON `{"orderId":"..."}`.
- **Gate scanner:** open `/scan.html` on a phone, enter the admin key, scan. Green = valid (marked used), red = invalid or already used.
- **Sales stats:** `GET /api/admin/stats` with header `x-admin-key`.
- Pending orders unpaid after 10 minutes are marked expired. Basic rate limit: 5 payment attempts/min per IP.

## Deploy
Needs a host with a **persistent disk** for the SQLite file (Render disk, Railway volume, or a VPS). Set the env vars there and `PUBLIC_URL` to your domain.

## Go live
Complete Daraja Go Live with your Paybill/Till, set `MPESA_ENV=production`, swap in live key/secret/passkey/shortcode.

## Gmail limits
Gmail sending is fine for a start (about 500 emails/day). For large events, switch to a transactional provider (Resend, SendGrid, Brevo) by changing `mailer.js`.
