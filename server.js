const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

const DB_FILE = path.join(__dirname, 'db.json');
function getDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], sessions: [] }, null, 2));
  }
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); }
  catch (e) { return { users: [], sessions: [] }; }
}
function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function parseSpintax(text) {
  const matches = text.match(/\{[^{}]*\}/g);
  if (!matches) return text;
  for (let match of matches) {
    const options = match.slice(1, -1).split('|');
    const choice = options[Math.floor(Math.random() * options.length)];
    text = text.replace(match, choice);
  }
  return parseSpintax(text);
}

let makeWASocket, useMultiFileAuthState, Browsers;
try {
  const baileys = require('@whiskeysockets/baileys');
  makeWASocket = baileys.default;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  Browsers = baileys.Browsers;
} catch (err) {
  console.error("⚠️ Baileys module notice:", err.message);
}

const sessions = {};

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.send('🚀 Engine Active');
});

app.post('/api/session/start', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const sessionDir = "session_" + cleanPhone;

  // Clean active existing socket if any
  if (sessions[cleanPhone]) {
    try { sessions[cleanPhone].end(); } catch(e) {}
    delete sessions[cleanPhone];
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers ? Browsers.ubuntu("Chrome") : ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        console.log("✅ Device successfully linked for: " + cleanPhone);
        sessions[cleanPhone] = sock;
        const dbData = getDb();
        dbData.sessions = dbData.sessions.filter(s => s.phone !== cleanPhone);
        dbData.sessions.push({ phone: cleanPhone, status: 'connected', updated_at: new Date().toISOString() });
        saveDb(dbData);
      }
      if (connection === 'close') {
        delete sessions[cleanPhone];
      }
    });

    if (!sock.authState.creds.registered) {
      // Allow Baileys 3.5s to stabilize WebSocket handshakes before requesting code
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(cleanPhone);
          sessions[cleanPhone] = sock;
          return res.json({ success: true, pairingCode: code });
        } catch (err) {
          console.error("❌ Pairing error detail:", err);
          return res.status(500).json({ error: 'Failed to generate code. Check internet connection or try again in 10s.' });
        }
      }, 3500);
    } else {
      sessions[cleanPhone] = sock;
      return res.json({ success: true, message: 'Device already linked and active' });
    }
  } catch (err) {
    console.error("❌ Init Error:", err);
    res.status(500).json({ error: 'Initialization error', details: err.message });
  }
});

app.post('/api/admin/grant-vip', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone is required' });
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const dbData = getDb();
  let user = dbData.users.find(u => u.phone === cleanPhone);

  if (user) {
    user.is_vip = true;
    user.credits = 999999;
  } else {
    dbData.users.push({ id: 'usr_' + Date.now(), phone: cleanPhone, is_vip: true, credits: 999999, created_at: new Date().toISOString() });
  }
  saveDb(dbData);
  res.json({ success: true, message: "Granted VIP access to " + cleanPhone });
});

app.post('/api/campaign/send', async (req, res) => {
  const { senderPhone, targets, message } = req.body;
  if (!senderPhone || !targets || !Array.isArray(targets) || !message) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const cleanSender = senderPhone.replace(/[^0-9]/g, '');
  const sock = sessions[cleanSender];

  if (!sock) return res.status(400).json({ error: 'WhatsApp account not linked or session lost.' });

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

    const delay = Math.floor(Math.random() * (12000 - 5000 + 1)) + 5000;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log("🚀 Server active on http://localhost:" + PORT);
});

setInterval(() => {}, 10000);
