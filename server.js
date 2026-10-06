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

// MongoDB Connection
if (MONGO_URI) {
    MongoClient.connect(MONGO_URI)
        .then(client => {
            db = client.db('broadcast_engine');
            console.log('Connected to MongoDB Atlas');
        })
        .catch(err => console.error('MongoDB Connection Error:', err));
}

async function initWhatsApp(force = false) {
    const authPath = path.join(__dirname, 'auth_info_baileys');

    if (force && fs.existsSync(authPath)) {
        try {
            fs.rmSync(authPath, { recursive: true, force: true });
        } catch (e) {}
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== disconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => initWhatsApp(false), 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            console.log('WhatsApp connection opened successfully.');
        }
    });
}

// Health/Status API
app.get('/api/status', (req, res) => {
    res.json({ connected: isConnected });
});

// Pairing Code Endpoint
app.post('/api/pair', async (req, res) => {
    const { phoneNumber, force } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required.' });

    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');

    try {
        if (force || !sock) {
            await initWhatsApp(true);
        }

        // Wait up to 5 seconds for socket setup
        let attempts = 0;
        while ((!sock || !sock.ws) && attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }

        if (!sock) throw new Error('Socket initialization timed out');

        const code = await sock.requestPairingCode(cleanNum);
        res.json({ code, connected: false });
    } catch (err) {
        console.error('Pairing Error:', err);
        res.status(500).json({ error: 'Failed to request pairing code. Please retry.' });
    }
});

// Grant VIP Access Endpoint
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

// Broadcast Campaign Endpoint
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

                // Apply anti-spam jitter delay
                const jitter = Math.floor(Math.random() * 2000);
                await new Promise(resolve => setTimeout(resolve, interval + jitter));
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
    console.log(`Manifest WA Engine running on port ${PORT}`);
    initWhatsApp();
});
