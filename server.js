const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, disconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'supersecretkey';
const MONGO_URI = process.env.MONGO_URI;

// Multi-Tenant Session Pool
const sessions = new Map(); // tenantId -> { sock, isConnected, qrCode, pairingCode }
let db = null;

if (MONGO_URI) {
    MongoClient.connect(MONGO_URI)
        .then(client => {
            db = client.db('broadcast_engine');
            console.log('✅ MongoDB Atlas Connected (Multi-Tenant Mode)');
        })
        .catch(err => console.error('MongoDB Connection Error:', err));
}

// Session Directory Manager per Tenant
function getAuthPath(tenantId) {
    const dir = path.join(__dirname, 'sessions', tenantId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function removeAuthFolder(tenantId) {
    const dir = path.join(__dirname, 'sessions', tenantId);
    if (fs.existsSync(dir)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch (e) {
            console.error(`Error deleting session folder for ${tenantId}:`, e);
        }
    }
}

// Multi-Tenant WhatsApp Connection Initializer
async function initTenantSession(tenantId) {
    if (sessions.has(tenantId) && sessions.get(tenantId).sock) {
        return sessions.get(tenantId);
    }

    const authPath = getAuthPath(tenantId);
    const sessionData = { sock: null, isConnected: false, pairingCode: null };
    sessions.set(tenantId, sessionData);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        
        let version;
        try {
            const fetched = await fetchLatestBaileysVersion();
            version = fetched.version;
        } catch (vErr) {
            console.warn('Using default Baileys version fallback.');
        }

        const sock = makeWASocket({
            ...(version ? { version } : {}),
            logger: pino({ level: 'fatal' }),
            printQRInTerminal: false,
            auth: state,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000
        });

        sessionData.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                sessionData.isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                if (statusCode === disconnectReason.loggedOut) {
                    console.log(`Tenant [${tenantId}] logged out. Wiping session.`);
                    removeAuthFolder(tenantId);
                    sessions.delete(tenantId);
                } else {
                    console.log(`Tenant [${tenantId}] connection closed. Reconnecting...`);
                    setTimeout(() => initTenantSession(tenantId), 3000);
                }
            } else if (connection === 'open') {
                sessionData.isConnected = true;
                console.log(`✅ Tenant [${tenantId}] WhatsApp connection active!`);
            }
        });

        return sessionData;
    } catch (err) {
        console.error(`Session Init Failed for Tenant [${tenantId}]:`, err);
        sessions.delete(tenantId);
        throw err;
    }
}

// Get Session Status for a Specific User/Tenant
app.get('/api/status', (req, res) => {
    const tenantId = req.query.tenantId || req.query.phoneNumber;
    if (!tenantId) {
        return res.status(400).json({ error: 'tenantId or phoneNumber parameter is required.' });
    }

    const cleanId = tenantId.replace(/[^0-9]/g, '');
    const session = sessions.get(cleanId);

    res.json({
        tenantId: cleanId,
        connected: session ? session.isConnected : false
    });
});

// Request Pairing Code for a Specific User/Tenant
app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required.' });

    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanNum.length < 10) return res.status(400).json({ error: 'Invalid phone number format.' });

    try {
        let session = sessions.get(cleanNum);

        if (session && session.isConnected) {
            return res.json({ connected: true, message: 'Device is already connected.' });
        }

        // Initialize or retrieve user-specific socket session
        session = await initTenantSession(cleanNum);

        // Wait for WebSocket ready state
        let attempts = 0;
        while ((!session.sock || !session.sock.ws || session.sock.ws.readyState !== 1) && attempts < 30) {
            await new Promise(r => setTimeout(r, 500));
            attempts++;
        }

        if (!session.sock || !session.sock.ws || session.sock.ws.readyState !== 1) {
            return res.status(500).json({ error: 'Session setup initializing. Tap Request Pairing Code again.' });
        }

        const code = await session.sock.requestPairingCode(cleanNum);
        return res.json({ code, connected: false, tenantId: cleanNum });
    } catch (err) {
        console.error(`Pairing Error for ${cleanNum}:`, err);
        return res.status(500).json({ error: err.message || 'Failed to generate pairing code.' });
    }
});

// Admin VIP Access Route
app.post('/api/vip/grant', async (req, res) => {
    const { adminSecret, phoneNumber } = req.body;

    if (!adminSecret || adminSecret.trim() !== ADMIN_KEY.trim()) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Admin Secret Key.' });
    }

    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required.' });

    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');

    if (db) {
        try {
            await db.collection('vip_users').updateOne(
                { _id: cleanNum },
                { $set: { vip: true, grantedAt: new Date() } },
                { upsert: true }
            );
            return res.json({ success: true, message: `Granted VIP status to +${cleanNum}` });
        } catch (dbErr) {
            return res.status(500).json({ error: 'Database update failed.' });
        }
    }

    res.json({ success: true, message: `VIP set locally for +${cleanNum} (MongoDB not connected)` });
});

// Launch Multi-Tenant Campaign
app.post('/api/campaign/send', async (req, res) => {
    const { senderNumber, recipients, message, delay } = req.body;

    if (!senderNumber) {
        return res.status(400).json({ error: 'senderNumber (your linked WhatsApp number) is required.' });
    }

    const tenantId = senderNumber.replace(/[^0-9]/g, '');
    const session = sessions.get(tenantId);

    if (!session || !session.isConnected) {
        return res.status(400).json({ error: `WhatsApp account +${tenantId} is not linked. Please pair device first.` });
    }

    if (!recipients || !message) {
        return res.status(400).json({ error: 'Recipients and message body are required.' });
    }

    const rawList = Array.isArray(recipients) ? recipients : String(recipients).split(/[\n,\r]+/);
    const phoneList = Array.from(new Set(
        rawList
            .map(p => String(p).trim().replace(/[^0-9]/g, ''))
            .filter(p => p.length >= 10)
    ));

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

    res.json({ success: true, message: `Campaign initiated for ${phoneList.length} recipient(s) via +${tenantId}.` });

    // Background job isolated per tenant
    (async () => {
        for (let i = 0; i < phoneList.length; i++) {
            const phone = phoneList[i];
            try {
                const parsedMsg = parseSpintax(message);
                const jid = `${phone}@s.whatsapp.net`;
                await session.sock.sendMessage(jid, { text: parsedMsg });
                console.log(`[Tenant +${tenantId}] [${i + 1}/${phoneList.length}] Sent to ${phone}`);

                const jitter = Math.floor(Math.random() * 2000);
                await new Promise(r => setTimeout(r, interval + jitter));
            } catch (err) {
                console.error(`[Tenant +${tenantId}] Failed to send to ${phone}:`, err);
            }
        }
    })();
});

app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Multi-Tenant Manifest Engine running on port ${PORT}`);
});
