const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    BufferJSON
} = require('@whiskeysockets/baileys');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_KEY = process.env.ADMIN_KEY || "manifest_admin_2026";

let sock = null;
let isConnected = false;
let isInitializing = false;
let db = null;

// --- MongoDB Auth Store ---
async function useMongoAuthState(database) {
    const collection = database.collection('baileys_auth');

    const writeData = async (data, id) => {
        await collection.updateOne(
            { _id: id },
            { $set: { data: JSON.stringify(data, BufferJSON.replacer) } },
            { upsert: true }
        );
    };

    const readData = async (id) => {
        const doc = await collection.findOne({ _id: id });
        if (!doc) return null;
        return JSON.parse(doc.data, BufferJSON.reviver);
    };

    const removeData = async (id) => {
        await collection.deleteOne({ _id: id });
    };

    const creds = (await readData('creds')) || (await useMultiFileAuthState('temp').then(a => a.state.creds));

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = BufferJSON.reviver('', value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds'),
        clearSession: async () => {
            await collection.deleteMany({});
        }
    };
}

// --- Initialize WhatsApp Socket ---
async function initWhatsApp(forceReset = false) {
    if (!MONGO_URI) {
        console.error("CRITICAL: MONGO_URI environment variable is missing!");
        return;
    }

    if (isInitializing) return;
    isInitializing = true;

    try {
        if (!db) {
            const client = new MongoClient(MONGO_URI);
            await client.connect();
            db = client.db("whatsapp_saas");
            console.log("Connected to MongoDB Atlas.");
        }

        const authStore = await useMongoAuthState(db);

        if (forceReset) {
            console.log("Force resetting WhatsApp session...");
            await authStore.clearSession();
            isConnected = false;
        }

        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: authStore.state,
            printQRInTerminal: false,
            browser: ["Manifest WA Engine", "Chrome", "1.0.0"]
        });

        sock.ev.on('creds.update', authStore.saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                isConnected = true;
                isInitializing = false;
                console.log("WhatsApp Connection Active!");
            } else if (connection === 'close') {
                isConnected = false;
                isInitializing = false;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`Connection closed (Reason code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log("Session logged out by user. Clearing database session...");
                    await authStore.clearSession();
                } else if (shouldReconnect) {
                    setTimeout(() => initWhatsApp(), 5000);
                }
            }
        });
    } catch (err) {
        isInitializing = false;
        console.error("Initialization Error:", err);
    }
}

// --- API Endpoints ---

app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
        statusText: isConnected ? "CONNECTED" : "DISCONNECTED",
        userJid: sock?.user?.id || null
    });
});

app.post('/api/pair', async (req, res) => {
    const { phoneNumber, force } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: "Phone number is required." });

    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');

    try {
        if (force || !sock) {
            await initWhatsApp(force);
        }

        if (isConnected && !force) {
            return res.json({ connected: true, message: "Device is already linked and active." });
        }

        let attempts = 0;
        while ((!sock || !sock.ws) && attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }

        const code = await sock.requestPairingCode(cleanNum);
        res.json({ code, connected: false });
    } catch (err) {
        console.error("Pairing Error:", err);
        res.status(500).json({ error: "Failed to request pairing code. Please retry." });
    }
});

app.post('/api/vip/grant', async (req, res) => {
    const { phoneNumber, adminSecret } = req.body;

    if (!adminSecret || adminSecret !== ADMIN_KEY) {
        return res.status(401).json({ error: "Unauthorized: Invalid Admin Secret Key." });
    }

    if (!phoneNumber) return res.status(400).json({ error: "Phone number is required." });

    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');

    if (db) {
        await db.collection("vip_users").updateOne(
            { _id: cleanNum },
            { $set: { vip: true, grantedAt: new Date() } },
            { upsert: true }
        );
    }

    res.json({ success: true, message: `Granted VIP status to +${cleanNum}` });
});

app.post('/api/campaign/send', async (req, res) => {
    if (!isConnected) {
        return res.status(400).json({ error: "WhatsApp account not linked or session lost. Please link a device first." });
    }

    const { recipients, message } = req.body;
    if (!recipients || !message) {
        return res.status(400).json({ error: "Recipients and message body are required." });
    }

    const phoneList = recipients.split(',').map(p => p.trim().replace(/[^0-9]/g, '')).filter(Boolean);

    if (phoneList.length === 0) {
        return res.status(400).json({ error: "No valid recipient numbers provided." });
    }

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

                const delay = Math.floor(Math.random() * 4000) + 4000;
                await new Promise(resolve => setTimeout(resolve, delay));
            } catch (err) {
                console.error(`Failed to send to ${phone}:`, err);
            }
        }
    })();
});

// Fallback Route for Single Page App
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Manifest WA Engine running on port ${PORT}`);
    initWhatsApp();
});
