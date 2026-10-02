const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const db = require('./db');

const PAYONEER_PAYMENT_LINK = 'https://payoneer.com/your-custom-link';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n--- SCAN THIS QR CODE WITH WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed (status ${statusCode}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot Engine Active & Ready!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const senderPhone = remoteJid.split('@')[0];
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

        let user = db.get('users').find({ phone: senderPhone }).value();

        // 1. Redeem Promo Code
        if (text.toUpperCase().startsWith('REDEEM ')) {
            const inputCode = text.split(' ')[1]?.toUpperCase();
            const promo = db.get('promo_codes').find({ code: inputCode }).value();

            if (promo && promo.uses_left > 0) {
                const newExpiry = new Date();
                newExpiry.setDate(newExpiry.getDate() + promo.days_granted);

                if (user) {
                    db.get('users').find({ phone: senderPhone }).assign({ subscription_expiry: newExpiry.toISOString() }).write();
                } else {
                    db.get('users').push({ phone: senderPhone, is_free: 0, subscription_expiry: newExpiry.toISOString() }).write();
                }

                db.get('promo_codes').find({ code: inputCode }).assign({ uses_left: promo.uses_left - 1 }).write();

                await sock.sendMessage(remoteJid, { text: `✅ Promo code applied! You have been granted access for ${promo.days_granted} days.` });
                return;
            } else {
                await sock.sendMessage(remoteJid, { text: `❌ Invalid or expired promo code.` });
                return;
            }
        }

        // 2. Access Control Check
        const now = new Date();
        const isFree = user && user.is_free === 1;
        const hasValidSub = user && user.subscription_expiry && new Date(user.subscription_expiry) > now;

        if (!isFree && !hasValidSub) {
            await sock.sendMessage(remoteJid, {
                text: `🔒 *Access Restricted*\n\nYou do not have active access to this service.\n\n` +
                      `💳 *Pay to Unlock Access:* ${PAYONEER_PAYMENT_LINK}\n\n` +
                      `🎁 *Have a promo code?* Reply with: *REDEEM <YOUR_CODE>*\n\n` +
                      `_After payment, forward your proof of payment to support to activate your line._`
            });
            return;
        }

        // 3. Process Commands for Authorized Users
        if (text.toLowerCase() === 'ping') {
            await sock.sendMessage(remoteJid, { text: 'Pong! Your access is verified.' });
        }
    });
}

startBot();
