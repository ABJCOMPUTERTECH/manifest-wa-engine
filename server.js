const express = require('express');
const { default: makeWASocket, disconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const useMongoDBAuthState = require('baileys-mongodb-auth');
const pino = require('pino');
const path = require('path');
const { MongoClient } = require('mongodb');

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'supersecretkey';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';

const sessions = new Map();
let mongoClient = null;
let db = null;

async function initMongo() {
    if (!mongoClient) {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db('broadcast_engine');
        console.log('✅ MongoDB Atlas Connected');
    }
}
initMongo().catch(err => console.error('MongoDB Initial Connection Error:', err));

async function getOrCreateSession(tenantId) {
    if (sessions.has(tenantId)) {
        return sessions.get(tenantId);
    }

    await initMongo();
    const collection = db.collection(`auth_${tenantId}`);
    const { state, saveCreds } = await useMongoDBAuthState(collection);

    let version;
    try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
    } catch (e) {}

    const sock = makeWASocket({
        ...(version ? { version } : {}),
        logger: pino({ level: 'fatal' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 120000,
        defaultQueryTimeoutMs: 120000,
        keepAliveIntervalMs: 25000,
        syncFullHistory: false
    });

    const sessionData = { sock, isConnected: false, readyPromise: null };

    sessionData.readyPromise = new Promise((resolve) => {
        const handler = (update) => {
            if (update.qr || update.connection === 'open') {
                sock.ev.off('connection.update', handler);
                resolve();
            }
        };
        sock.ev.on('connection.update', handler);
        setTimeout(resolve, 60000);
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            sessionData.isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === disconnectReason.loggedOut) {
                try { await collection.drop(); } catch (e) {}
                sessions.delete(tenantId);
            } else {
                setTimeout(() => {
                    sessions.delete(tenantId);
                    getOrCreateSession(tenantId);
                }, 5000);
            }
        } else if (connection === 'open') {
            sessionData.isConnected = true;
            console.log(`✅ Tenant [${tenantId}] Active & Synced to MongoDB!`);
        }
    });

    sessions.set(tenantId, sessionData);
    return sessionData;
}

app.get('/api/status', (req, res) => {
    const tenantId = req.query.tenantId || req.query.phoneNumber;
    if (!tenantId) return res.status(400).json({ error: 'tenantId required.' });
    const cleanId = tenantId.replace(/[^0-9]/g, '');
    const session = sessions.get(cleanId);
    res.json({ tenantId: cleanId, connected: session ? session.isConnected : false });
});

app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required.' });

    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanNum.length < 10) return res.status(400).json({ error: 'Invalid phone number format.' });

    try {
        const session = await getOrCreateSession(cleanNum);

        if (session.isConnected) {
            return res.json({ connected: true, message: 'Device is already connected.' });
        }

        await session.readyPromise;

        const code = await session.sock.requestPairingCode(cleanNum);
        return res.json({ code, connected: false, tenantId: cleanNum });
    } catch (err) {
        console.error(`Pairing error for ${cleanNum}:`, err);
        return res.status(500).json({ error: err.message || 'Failed to generate pairing code.' });
    }
});

app.post('/api/campaign/send', async (req, res) => {
    const { senderNumber, recipients, message, delay } = req.body;
    if (!senderNumber) return res.status(400).json({ error: 'senderNumber is required.' });

    const tenantId = senderNumber.replace(/[^0-9]/g, '');
    const session = sessions.get(tenantId);

    if (!session || !session.isConnected) {
        return res.status(400).json({ error: `WhatsApp account +${tenantId} is not linked.` });
    }

    if (!recipients || !message) return res.status(400).json({ error: 'Recipients and message body required.' });

    const rawList = Array.isArray(recipients) ? recipients : String(recipients).split(/[\n,\r]+/);
    const phoneList = Array.from(new Set(
        rawList.map(p => String(p).trim().replace(/[^0-9]/g, '')).filter(p => p.length >= 10)
    ));

    if (phoneList.length === 0) return res.status(400).json({ error: 'No valid recipient numbers.' });

    const interval = parseInt(delay) || 15000;
    const parseSpintax = (text) => text.replace(/\{([^{}]+)\}/g, (_, choices) => {
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)];
    });

    res.json({ success: true, message: `Campaign initiated for ${phoneList.length} recipient(s) via +${tenantId}.` });

    (async () => {
        for (let i = 0; i < phoneList.length; i++) {
            const phone = phoneList[i];
            try {
                const parsedMsg = parseSpintax(message);
                await session.sock.sendMessage(`${phone}@s.whatsapp.net`, { text: parsedMsg });
                console.log(`[Tenant +${tenantId}] Sent to ${phone}`);
                await new Promise(r => setTimeout(r, interval + Math.floor(Math.random() * 2000)));
            } catch (err) {
                console.error(`[Tenant +${tenantId}] Send error ${phone}:`, err);
            }
        }
    })();
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Multi-Tenant Engine live on port ${PORT}`));
