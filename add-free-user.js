const db = require('./db');
const phone = process.argv[2];

if (!phone) {
  console.log('Error: Please provide a phone number.');
  console.log('Usage: node add-free-user.js 234XXXXXXXXXX');
  process.exit(1);
}

const existing = db.get('users').find({ phone }).value();

if (existing) {
  db.get('users').find({ phone }).assign({ is_free: 1 }).write();
} else {
  db.get('users').push({ phone, is_free: 1, subscription_expiry: null }).write();
}

console.log(`Successfully granted free lifetime access to ${phone}`);
