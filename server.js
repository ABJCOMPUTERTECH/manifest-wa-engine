const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, disconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

// Prevent global uncaught errors from crashing the Node process
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'supersecretkey';
const MONGO_URI = process.env.MONGO_URI;

let sock = null;
let isConnected = false;
let db = null;
let isInitializing = false;

if (MONGO_URI) {
    MongoClient.connect(MONGO_URI)
        .then(client => {
            db = client.db('broadcast_engine');
            console.log('MongoDB Atlas Connected');
        })
        .catch(err => console.error('MongoDB Error:', err));
}

function cleanAuthFolder() {
    const authPath = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authPath)) {
        try {
            fs.rmSync(authPath, { recursive: true, force: true });
        } catch (e) {
            console.error('Error cleaning auth folder:', e);
        }
    }
}

async function initWhatsApp(forceClean = false) {
    if (isInitializing) return;
    isInitializing = true;

    if (forceClean) {
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end(undefined);
            } catch (e) {}
            sock = null;
        }
        cleanAuthFolder();
        isConnected = false;
    }

    const authPath = path.join(__dirname, 'auth_info_baileys');

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        
        let version;
        try {
            const fetched = await fetchLatestBaileysVersion();
            version = fetched.version;
        } catch (vErr) {
            console.warn('Could not fetch latest version, proceeding with default.');
        }

        sock = makeWASocket({
            ...(version ? { version } : {}),
            logger: pino({ level: 'fatal' }),
            printQRInTerminal: false,
            auth: state,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                isConnected = false;
                isInitializing = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                if (statusCode === disconnectReason.loggedOut) {
                    console.log('Device logged out. Wiping session.');
                    cleanAuthFolder();
                } else {
                    setTimeout(() => initWhatsApp(false), 3000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                isInitializing = false;
                console.log('✅ WhatsApp connection active!');
            }
        });
    } catch (e) {
        console.error('Socket Init Error:', e);
    } finally {
        isInitializing = false;
    }
}

app.get('/api/status', (req, res) => {
    res.json({ connected: isConnected });
});

app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required.' });

    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanNum.length < 10) return res.status(400).json({ error: 'Invalid phone number format.' });

    try {
        if (isConnected) {
            return res.json({ connected: true, message: 'Device is already connected.' });
        }

        await initWhatsApp(true);

        let attempts = 0;
        while ((!sock || !sock.ws || sock.ws.readyState !== 1) && attempts < 50) {
            await new Promise(r => setTimeout(r, 500));
            attempts++;
        }

        if (!sock || !sock.ws || sock.ws.readyState !== 1) {
            return res.status(500).json({ error: 'WhatsApp connection timeout. Please tap Request Pairing Code again.' });
        }

        await new Promise(r => setTimeout(r, 2000));

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
        return res.json({ success: true, message: `Granted VIP status to +${cleanNum}` });
    }

    res.json({ success: true, message: `VIP set locally for +${cleanNum} (MongoDB not connected)` });
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
