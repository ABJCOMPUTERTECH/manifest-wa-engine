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

let sock = null;
let isConnected = false;
const vipUsers = new Set();

async function useMongoAuthState(db) {
    const collection = db.collection('baileys_auth');

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
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function initWhatsApp() {
    if (!MONGO_URI) {
        console.error("CRITICAL: MONGO_URI environment variable is missing!");
        return;
    }

    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        console.log("Connected to MongoDB Atlas successfully.");
        
        const db = client.db("whatsapp_saas");
        const { state, saveCreds } = await useMongoAuthState(db);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                isConnected = true;
                console.log("WhatsApp Engine Connected & Ready!");
            } else if (connection === 'close') {
                isConnected = false;
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`Connection closed. Reconnecting: ${shouldReconnect}`);
                if (shouldReconnect) {
                    setTimeout(initWhatsApp, 5000);
                }
            }
        });
    } catch (err) {
        console.error("Initialization Error:", err);
    }
}

app.get('/api/status', (req, res) => {
    res.json({ connected: isConnected });
});

app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: "Phone number is required." });
    if (isConnected) return res.json({ message: "Device already linked and active" });

    try {
        if (!sock) await initWhatsApp();
        setTimeout(async () => {
            const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
            res.json({ code });
        }, 3000);
    } catch (err) {
        res.status(500).json({ error: "Failed to request pairing code." });
    }
});

app.post('/api/vip/grant', (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: "Phone number required." });
    vipUsers.add(phoneNumber.trim());
    res.json({ message: `Granted VIP access to ${phoneNumber}` });
});

app.post('/api/campaign/send', async (req, res) => {
    if (!isConnected) {
        return res.status(400).json({ error: "WhatsApp account not linked or session lost." });
    }

    const { recipients, message } = req.body;
    if (!recipients || !message) {
        return res.status(400).json({ error: "Recipients and message body are required." });
    }

    const phoneList = recipients.split(',').map(p => p.trim().replace(/[^0-9]/g, '')).filter(Boolean);
    
    const parseSpintax = (text) => {
        return text.replace(/\{([^{}]+)\}/g, (match, choices) => {
            const options = choices.split('|');
            return options[Math.floor(Math.random() * options.length)];
        });
    };

    res.json({ message: `Campaign initiated for ${phoneList.length} contacts.` });

    for (const phone of phoneList) {
        try {
            const parsedMsg = parseSpintax(message);
            const jid = `${phone}@s.whatsapp.net`;
            await sock.sendMessage(jid, { text: parsedMsg });
            console.log(`Sent to ${phone}`);
            
            const delay = Math.floor(Math.random() * 4000) + 4000;
            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (err) {
            console.error(`Failed to send to ${phone}:`, err);
        }
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    initWhatsApp();
});
