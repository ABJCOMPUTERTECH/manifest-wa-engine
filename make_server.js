const fs = require('fs');

const serverCode = `const express = require('express');
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
  res.sendFile(path.join(__dirname, 'index.html'));
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

const htmlCode = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manifest WA Automation Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen p-4 md:p-8">
  <div class="max-w-4xl mx-auto space-y-6">
    <header class="border-b border-slate-800 pb-4">
      <h1 class="text-2xl font-bold text-emerald-400">Manifest WA Automation SaaS Engine</h1>
      <p class="text-slate-400 text-sm">Device Pairing & Bulk Campaign Dispatcher</p>
    </header>

    <!-- 1. Device Pairing Section -->
    <div class="bg-slate-800 border border-slate-700 rounded-xl p-5 space-y-4">
      <h2 class="text-lg font-semibold text-slate-200">1. Link WhatsApp Account</h2>
      <div class="flex flex-col md:flex-row gap-3">
        <input id="senderPhone" type="text" placeholder="Sender Phone (e.g., 2348012345678)" class="bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 flex-1 text-sm focus:outline-none focus:border-emerald-500">
        <button onclick="startSession(true)" class="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-4 py-2 rounded-lg text-sm transition">Get Pairing Code</button>
      </div>
      <div id="pairingResult" class="text-sm text-amber-400 font-mono hidden"></div>
    </div>

    <!-- 2. VIP Access Section -->
    <div class="bg-slate-800 border border-slate-700 rounded-xl p-5 space-y-4">
      <h2 class="text-lg font-semibold text-slate-200">2. Admin VIP Authorization</h2>
      <div class="flex flex-col md:flex-row gap-3">
        <input id="vipPhone" type="text" placeholder="Phone Number to Grant VIP" class="bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 flex-1 text-sm focus:outline-none focus:border-emerald-500">
        <button onclick="grantVip()" class="bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-4 py-2 rounded-lg text-sm transition">Grant Unlimited Credits</button>
      </div>
      <div id="vipResult" class="text-sm text-emerald-400 font-mono hidden"></div>
    </div>

    <!-- 3. Bulk Dispatcher Section -->
    <div class="bg-slate-800 border border-slate-700 rounded-xl p-5 space-y-4">
      <h2 class="text-lg font-semibold text-slate-200">3. Campaign Message Dispatcher</h2>
      <textarea id="targetList" rows="3" placeholder="Target Phone Numbers (Comma or line separated, e.g., 2348011112222, 2348033334444)" class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-emerald-500"></textarea>
      <textarea id="campaignMessage" rows="4" placeholder="Message template with Spintax support: {Hello|Hi|Greetings} customer!" class="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm focus:outline-none focus:border-emerald-500"></textarea>
      <button onclick="sendCampaign()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2.5 rounded-lg text-sm transition">Launch Campaign</button>
      <div id="campaignResult" class="text-sm text-cyan-400 font-mono hidden"></div>
    </div>
  </div>

  <script>
    async function startSession(usePairingCode) {
      const phone = document.getElementById('senderPhone').value;
      const resDiv = document.getElementById('pairingResult');
      resDiv.classList.remove('hidden');
      resDiv.innerText = 'Requesting session...';

      try {
        const res = await fetch('/api/session/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, usePairingCode })
        });
        const data = await res.json();
        if (data.pairingCode) {
          resDiv.innerText = 'PAIRING CODE: ' + data.pairingCode;
        } else {
          resDiv.innerText = JSON.stringify(data);
        }
      } catch (e) {
        resDiv.innerText = 'Error: ' + e.message;
      }
    }

    async function grantVip() {
      const phone = document.getElementById('vipPhone').value;
      const resDiv = document.getElementById('vipResult');
      resDiv.classList.remove('hidden');

      try {
        const res = await fetch('/api/admin/grant-vip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone })
        });
        const data = await res.json();
        resDiv.innerText = data.message || data.error;
      } catch (e) {
        resDiv.innerText = 'Error: ' + e.message;
      }
    }

    async function sendCampaign() {
      const senderPhone = document.getElementById('senderPhone').value;
      const rawTargets = document.getElementById('targetList').value;
      const message = document.getElementById('campaignMessage').value;
      const resDiv = document.getElementById('campaignResult');
      resDiv.classList.remove('hidden');

      const targets = rawTargets.split(/[,\n]/).map(t => t.trim()).filter(Boolean);

      try {
        const res = await fetch('/api/campaign/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senderPhone, targets, message })
        });
        const data = await res.json();
        resDiv.innerText = data.message || data.error;
      } catch (e) {
        resDiv.innerText = 'Error: ' + e.message;
      }
    }
  </script>
</body>
</html>`;

fs.writeFileSync('server.js', serverCode);
fs.writeFileSync('index.html', htmlCode);
console.log('✅ Created clean server.js and index.html!');
