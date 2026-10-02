const db = require('./db');

const code = process.argv[2];
const days = parseInt(process.argv[3]) || 30;
const uses = parseInt(process.argv[4]) || 1;

if (!code) {
  console.log('Usage: node add-promo-code.js <CODE> [days] [max_uses]');
  console.log('Example: node add-promo-code.js VIP30 30 1');
  process.exit(1);
}

const cleanCode = code.toUpperCase();
const existing = db.get('promo_codes').find({ code: cleanCode }).value();

if (existing) {
  db.get('promo_codes').find({ code: cleanCode }).assign({ days_granted: days, uses_left: uses }).write();
} else {
  db.get('promo_codes').push({ code: cleanCode, days_granted: days, uses_left: uses }).write();
}

console.log(`Created promo code "${cleanCode}" (${days} days, ${uses} use(s))`);
