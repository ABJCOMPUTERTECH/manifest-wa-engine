const fs = require('fs');

const code = `const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const db = require('./db');
const { getRandomDelay, parseSpintax } = require('./queue');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

const sessions = {};
const qrCodes = {};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public_index.html'));
});

app.post('/api/session/start', async (req, res) => {
  const { phone, usePairingCode } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const sessionDir = "session_" + cleanPhone;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) qrCodes[cleanPhone] = await qrcode.toDataURL(qr);
      if (connection === 'open') {
        console.log("✅ Session connected for: " + cleanPhone);
        sessions[cleanPhone] = sock;
        delete qrCodes[cleanPhone];
        db.get('sessions').remove({ phone: cleanPhone }).write();
        db.get('sessions').push({ phone: cleanPhone, status: 'connected', updated_at: new Date().toISOString() }).write();
      }
      if (connection === 'close') delete sessions[cleanPhone];
    });

    if (usePairingCode && !sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(cleanPhone);
          return res.json({ success: true, pairingCode: code, mode: 'pairing_code' });
        } catch (err) {
          return res.status(500).json({ error: 'Failed to generate pairing code', details: err.message });
        }
      }, 3000);
    } else {
      setTimeout(() => {
        return res.json({ success: true, qrCodeUrl: qrCodes[cleanPhone] || null, mode: 'qr' });
      }, 3000);
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to initialize session', details: err.message });
  }
});

app.post('/api/admin/grant-vip', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone is required' });

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  let user = db.get('users').find({ phone: cleanPhone }).value();

  if (user) {
    db.get('users').find({ phone: cleanPhone }).assign({ is_vip: true, credits: 999999 }).write();
  } else {
    db.get('users').push({ id: 'usr_' + Date.now(), phone: cleanPhone, is_vip: true, credits: 999999, created_at: new Date().toISOString() }).write();
  }

  res.json({ success: true, message: "Granted VIP access to " + cleanPhone });
});

app.post('/api/campaign/send', async (req, res) => {
  const { senderPhone, targets, message } = req.body;
  if (!senderPhone || !targets || !Array.isArray(targets) || !message) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const cleanSender = senderPhone.replace(/[^0-9]/g, '');
  const sock = sessions[cleanSender];

  if (!sock) return res.status(400).json({ error: 'WhatsApp account not linked.' });

  const user = db.get('users').find({ phone: cleanSender }).value();
  if (!user || (!user.is_vip && user.credits <= 0)) {
    return res.status(403).json({ error: 'Insufficient credits.' });
  }

  res.json({ success: true, message: "Campaign queued for " + targets.length + " recipients." });

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    const finalMessage = parseSpintax(message);

    try {
      await sock.sendMessage(target, { text: finalMessage });
      console.log("[" + (i + 1) + "/" + targets.length + "] Sent to " + targets[i]);
    } catch (err) {
      console.error("Failed sending to " + targets[i] + ":", err.message);
    }

    const delay = getRandomDelay();
    await new Promise(resolve => setTimeout(resolve, delay));
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log("🚀 SaaS Backend Engine API running on http://localhost:" + PORT);
});
`;

fs.writeFileSync('server.js', code);
console.log("✅ Clean server.js successfully written!");
