const fs = require('fs');

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manifest WA SaaS Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen p-4 font-sans">
  <div class="max-w-xl mx-auto space-y-6">
    <header class="text-center py-4 border-b border-slate-800">
      <h1 class="text-2xl font-bold text-emerald-400">Manifest WA SaaS</h1>
      <p class="text-slate-400 text-sm">Self-Service Device Pairing & Bulk Messaging</p>
    </header>

    <div class="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg space-y-4">
      <h2 class="text-lg font-semibold text-white">1. Link Your WhatsApp Account</h2>
      <input id="phoneInput" type="text" placeholder="Phone Number (e.g. 2348012345678)" class="w-full p-3 rounded bg-slate-900 border border-slate-700 focus:outline-none focus:border-emerald-500 text-white">
      
      <div class="flex gap-3">
        <button onclick="requestPairing('pairing_code')" class="flex-1 bg-emerald-600 hover:bg-emerald-500 font-medium py-2.5 rounded text-sm transition">Get Pairing Code</button>
        <button onclick="requestPairing('qr')" class="flex-1 bg-slate-700 hover:bg-slate-600 font-medium py-2.5 rounded text-sm transition">Get QR Code</button>
      </div>

      <div id="pairingResult" class="hidden p-4 rounded bg-slate-900 border border-slate-700 text-center">
        <div id="pairingDisplay" class="text-xl font-mono text-emerald-400 font-bold tracking-widest"></div>
        <img id="qrDisplay" class="mx-auto hidden max-w-[200px] mt-2 rounded">
      </div>
    </div>

    <div class="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg space-y-4">
      <h2 class="text-lg font-semibold text-white">2. Send Bulk Campaign</h2>
      <textarea id="targetsInput" rows="3" placeholder="Target Phone Numbers (Comma separated or newlines)" class="w-full p-3 rounded bg-slate-900 border border-slate-700 focus:outline-none focus:border-emerald-500 text-white font-mono text-xs"></textarea>
      <textarea id="messageInput" rows="3" placeholder="Message text... Use Spintax like {Hi|Hello|Hey} {friend|customer}!" class="w-full p-3 rounded bg-slate-900 border border-slate-700 focus:outline-none focus:border-emerald-500 text-white text-sm"></textarea>

      <button onclick="sendCampaign()" class="w-full bg-blue-600 hover:bg-blue-500 font-semibold py-3 rounded text-white transition">Launch Campaign</button>
      <div id="campaignResult" class="text-xs text-center font-mono"></div>
    </div>
  </div>

  <script>
    const API_BASE = window.location.origin;

    async function requestPairing(mode) {
      const phone = document.getElementById('phoneInput').value.trim();
      if (!phone) return alert('Please enter phone number');

      const displayBox = document.getElementById('pairingResult');
      const textDisplay = document.getElementById('pairingDisplay');
      const qrDisplay = document.getElementById('qrDisplay');

      displayBox.classList.remove('hidden');
      textDisplay.innerText = 'Requesting...';
      qrDisplay.classList.add('hidden');

      try {
        const res = await fetch(\`\${API_BASE}/api/session/start\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, usePairingCode: mode === 'pairing_code' })
        });
        const data = await res.json();

        if (data.pairingCode) {
          textDisplay.innerText = \`Pairing Code: \${data.pairingCode}\`;
        } else if (data.qrCodeUrl) {
          textDisplay.innerText = 'Scan QR Code:';
          qrDisplay.src = data.qrCodeUrl;
          qrDisplay.classList.remove('hidden');
        } else {
          textDisplay.innerText = data.error || 'Failed to get credentials';
        }
      } catch (err) {
        textDisplay.innerText = 'Server connection error';
      }
    }

    async function sendCampaign() {
      const senderPhone = document.getElementById('phoneInput').value.trim();
      const rawTargets = document.getElementById('targetsInput').value;
      const message = document.getElementById('messageInput').value;

      if (!senderPhone || !rawTargets || !message) return alert('Fill all fields');

      const targets = rawTargets.split(/[\\n,]+/).map(t => t.trim()).filter(Boolean);
      const resDisplay = document.getElementById('campaignResult');
      resDisplay.innerText = 'Queuing campaign...';

      try {
        const res = await fetch(\`\${API_BASE}/api/campaign/send\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senderPhone, targets, message })
        });
        const data = await res.json();

        if (res.ok) {
          resDisplay.className = 'text-xs text-center font-mono text-emerald-400';
          resDisplay.innerText = \`✅ \${data.message}\`;
        } else {
          resDisplay.className = 'text-xs text-center font-mono text-rose-400';
          resDisplay.innerText = \`❌ \${data.error}\`;
        }
      } catch (err) {
        resDisplay.className = 'text-xs text-center font-mono text-rose-400';
        resDisplay.innerText = 'Dispatch error';
      }
    }
  </script>
</body>
</html>`;

fs.writeFileSync('public_index.html', htmlContent);
console.log('✅ Created public_index.html');
