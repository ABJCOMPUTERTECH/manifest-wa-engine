const db = require('./db');

function setVipUser(targetPhone) {
  const cleanPhone = targetPhone.replace(/[^0-9]/g, '');
  let user = db.get('users').find({ phone: cleanPhone }).value();

  if (user) {
    db.get('users').find({ phone: cleanPhone }).assign({ is_vip: true, credits: 999999 }).write();
  } else {
    db.get('users').push({
      id: 'usr_' + Date.now(),
      phone: cleanPhone,
      is_vip: true,
      credits: 999999,
      created_at: new Date().toISOString()
    }).write();
  }

  console.log(`✅ Success: ${cleanPhone} has been granted FREE VIP Access!`);
}

const command = process.argv[2];
const phoneArg = process.argv[3];

if (command === 'vip' && phoneArg) {
  setVipUser(phoneArg);
} else {
  console.log('Usage: node admin.js vip <PHONE_NUMBER>');
}
