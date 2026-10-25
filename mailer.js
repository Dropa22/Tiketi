const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const { GMAIL_USER, GMAIL_APP_PASSWORD, SITE_NAME = "Tiketi" } = process.env;

const transport = GMAIL_USER && GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } })
  : null;

// Sends QR tickets as inline images (Gmail blocks data: URLs in email). BCCs the sender as a sales notice.
async function sendTickets(order, codes) {
  if (!transport) { console.warn("Email not configured; skipping send."); return false; }
  const attachments = [];
  for (let i = 0; i < codes.length; i++) {
    attachments.push({ filename: `${codes[i]}.png`, content: await QRCode.toBuffer(codes[i], { margin: 2, width: 360 }), cid: `t${i}` });
  }
  const blocks = codes.map((c, i) => `
    <div style="border:1px dashed #e8451e;border-radius:12px;padding:14px;margin:12px 0;text-align:center">
      <div style="font-size:12px;color:#777">Ticket ${i + 1} of ${codes.length}</div>
      <img src="cid:t${i}" width="180" height="180" alt="QR ticket">
      <div style="font-family:monospace;font-size:15px;margin-top:6px">${c}</div>
    </div>`).join("");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
    <h2 style="margin:0">${SITE_NAME}</h2>
    <p>Payment received. Here ${codes.length > 1 ? "are your tickets" : "is your ticket"} for <b>${order.event}</b>.</p>
    ${blocks}
    <p style="font-size:13px;color:#555">M-Pesa ref: ${order.receipt || "-"} · Total KES ${order.amount.toLocaleString()}<br>
    Show the QR code at the gate. Each code works once.</p></div>`;
  await transport.sendMail({
    from: `"${SITE_NAME}" <${GMAIL_USER}>`, to: order.email, bcc: GMAIL_USER,
    subject: `Your tickets: ${order.event}`, html, attachments,
  });
  return true;
}
module.exports = { sendTickets };
