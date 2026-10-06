const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, disconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'supersecretkey';
const MONGO_URI = process.env.MONGO_URI;

let sock = null;
let isConnected = false;
let db = null;
let currentPairingPhone = null;

if (MONGO_URI) {
    MongoClient.connect(MONGO_URI)
        .then(client => {
            db = client.db('broadcast_engine');
            console.log('MongoDB Atlas Connected');
        })
        .catch(err => console.error('MongoDB Error:', err));
}

async function initWhatsApp(cleanSession = false) {
    const authPath = path.join(__dirname, 'auth_info_baileys');

    if (cleanSession) {
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end(undefined);
            } catch (e) {}
            sock = null;
        }
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
            } catch (e) {}
        }
        isConnected = false;
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            // Official browser identifier required for web client pairing
            browser: ["Chrome (Linux)", "Chrome", "110.0.5481.177"]
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                // Do NOT wipe auth files during connection reconnect loops
                if (statusCode !== disconnectReason.loggedOut) {
                    setTimeout(() => initWhatsApp(false), 3000);
                } else {
                    console.log('Logged out. Session cleared.');
                    initWhatsApp(true);
                }
            } else if (connection === 'open') {
                isConnected = true;
                console.log('✅ WhatsApp device connected successfully!');
            }
        });
    } catch (e) {
        console.error('Socket Init Error:', e);
    }
}

app.get('/api/status', (req, res) => {
    res.json({ connected: isConnected });
});

app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required.' });

    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanNum.length < 10) return res.status(400).json({ error: 'Invalid phone number length.' });

    try {
        // If device is already connected, no need to pair again
        if (isConnected) {
            return res.json({ connected: true, message: 'Device is already linked and active.' });
        }

        // Initialize fresh socket if null or disconnected, but keep state for key exchange
        if (!sock || !sock.ws || sock.ws.readyState !== 1) {
            await initWhatsApp(true);
        }

        // Wait for socket open state
        let attempts = 0;
        while ((!sock || !sock.ws || sock.ws.readyState !== 1) && attempts < 15) {
            await new Promise(r => setTimeout(r, 500));
            attempts++;
        }

        if (!sock || sock.ws.readyState !== 1) {
            return res.status(500).json({ error: 'Connection to WhatsApp servers timed out. Please try again.' });
        }

        // Small delay to allow handshake readiness
        await new Promise(r => setTimeout(r, 1000));

        const code = await sock.requestPairingCode(cleanNum);
        return res.json({ code, connected: false });
    } catch (err) {
        console.error('Pairing Code Request Error:', err);
        return res.status(500).json({ error: err.message || 'Failed to request pairing code.' });
    }
});

app.post('/api/vip/grant', async (req, res) => {
    const { adminSecret, phoneNumber } = req.body;

    if (!adminSecret || adminSecret !== ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Admin Secret Key.' });
    }

    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required.' });

    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');

    if (db) {
        await db.collection('vip_users').updateOne(
            { _id: cleanNum },
            { $set: { vip: true, grantedAt: new Date() } },
            { upsert: true }
        );
    }

    res.json({ success: true, message: `Granted VIP status to +${cleanNum}` });
});

app.post('/api/campaign/send', async (req, res) => {
    if (!isConnected) {
        return res.status(400).json({ error: 'WhatsApp account not linked or session lost. Please link a device first.' });
    }

    const { recipients, message, delay } = req.body;
    if (!recipients || !message) {
        return res.status(400).json({ error: 'Recipients and message body are required.' });
    }

    const rawList = Array.isArray(recipients) ? recipients : recipients.split(/[\n,]+/);
    const phoneList = rawList
        .map(p => String(p).trim().replace(/[^0-9]/g, ''))
        .filter(Boolean);

    if (phoneList.length === 0) {
        return res.status(400).json({ error: 'No valid recipient numbers provided.' });
    }

    const interval = parseInt(delay) || 15000;

    const parseSpintax = (text) => {
        return text.replace(/\{([^{}]+)\}/g, (match, choices) => {
            const options = choices.split('|');
            return options[Math.floor(Math.random() * options.length)];
        });
    };

    res.json({ success: true, message: `Campaign initiated for ${phoneList.length} recipient(s).` });

    (async () => {
        for (let i = 0; i < phoneList.length; i++) {
            const phone = phoneList[i];
            try {
                const parsedMsg = parseSpintax(message);
                const jid = `${phone}@s.whatsapp.net`;
                await sock.sendMessage(jid, { text: parsedMsg });
                console.log(`[${i + 1}/${phoneList.length}] Sent to ${phone}`);

                const jitter = Math.floor(Math.random() * 2000);
                await new Promise(r => setTimeout(r, interval + jitter));
            } catch (err) {
                console.error(`Failed to send to ${phone}:`, err);
            }
        }
    })();
});

app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Manifest WA Engine active on port ${PORT}`);
    initWhatsApp(false);
});
