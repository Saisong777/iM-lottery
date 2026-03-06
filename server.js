const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ── In-memory store (backed by data.json for persistence) ──
let db = {
  people: [],   // { name, email, won }
  prizes: [
    { name: '安慰獎', count: 5, done: false },
    { name: '三獎',   count: 3, done: false },
    { name: '二獎',   count: 2, done: false },
    { name: '頭獎 🏆',count: 1, done: false },
  ],
  winners: [],  // { name, email, prizeName, time }
  adminPin: '1234',
};

// Load from file if it exists
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      db = JSON.parse(raw);
      console.log('✅ 資料載入成功');
    }
  } catch (e) {
    console.error('⚠️  資料載入失敗，使用預設值', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (e) {
    console.error('⚠️  資料儲存失敗', e.message);
  }
}

loadData();

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE (Server-Sent Events) ──
let sseClients = [];

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ══════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════

// SSE endpoint for display page
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// GET all data
app.get('/api/data', (req, res) => {
  res.json(db);
});

// ── People ──
app.post('/api/people', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: '姓名與 Email 為必填' });
  if (db.people.find(p => p.email === email)) {
    return res.status(409).json({ error: '此 Email 已登記' });
  }
  const person = { name, email, won: false };
  db.people.push(person);
  saveData();
  res.json({ ok: true, person, total: db.people.length });
});

app.delete('/api/people/:index', (req, res) => {
  const i = parseInt(req.params.index);
  if (i < 0 || i >= db.people.length) return res.status(404).json({ error: '找不到此人' });
  if (db.people[i].won) return res.status(400).json({ error: '已中獎者無法移除' });
  db.people.splice(i, 1);
  saveData();
  res.json({ ok: true });
});

app.post('/api/people/batch', (req, res) => {
  const { lines } = req.body; // array of {name, email}
  let added = 0;
  lines.forEach(({ name, email }) => {
    if (name && !db.people.find(p => p.name === name)) {
      db.people.push({ name, email: email || '', won: false });
      added++;
    }
  });
  saveData();
  res.json({ ok: true, added });
});

app.delete('/api/people', (req, res) => {
  db.people = [];
  db.winners = [];
  db.prizes.forEach(p => p.done = false);
  saveData();
  res.json({ ok: true });
});

// ── Prizes ──
app.put('/api/prizes', (req, res) => {
  const { prizes } = req.body;
  db.prizes = prizes;
  saveData();
  res.json({ ok: true });
});

// ── Draw ──
app.post('/api/draw', (req, res) => {
  const { prizeIndex } = req.body;
  const prize = db.prizes[prizeIndex];
  if (!prize) return res.status(400).json({ error: '獎項不存在' });
  if (prize.done) return res.status(400).json({ error: '此獎項已抽完' });

  const avail = db.people.filter(p => !p.won);
  if (!avail.length) return res.status(400).json({ error: '沒有可抽的參與者' });

  const count = Math.min(prize.count, avail.length);

  // Fisher-Yates shuffle
  const pool = [...avail];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, count);

  // Mark as won
  const time = new Date().toLocaleTimeString('zh-TW');
  picked.forEach(p => {
    const person = db.people.find(x => x.email === p.email);
    if (person) person.won = true;
    db.winners.push({ name: p.name, email: p.email, prizeName: prize.name, time });
  });
  prize.done = true;
  saveData();

  res.json({ ok: true, winners: picked, prize: prize.name });
});

// ── Draw with SSE broadcast ──
let drawBusy = false;

app.post('/api/draw-start', async (req, res) => {
  if (drawBusy) return res.status(409).json({ error: '抽獎進行中' });
  const { prizeIndex } = req.body;
  const prize = db.prizes[prizeIndex];
  if (!prize) return res.status(400).json({ error: '獎項不存在' });
  if (prize.done) return res.status(400).json({ error: '此獎項已抽完' });

  const avail = db.people.filter(p => !p.won);
  if (!avail.length) return res.status(400).json({ error: '沒有可抽的參與者' });

  drawBusy = true;
  const count = Math.min(prize.count, avail.length);

  // Fisher-Yates shuffle
  const pool = [...avail];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, count);

  // Mark as won
  const time = new Date().toLocaleTimeString('zh-TW');
  picked.forEach(p => {
    const person = db.people.find(x => x.email === p.email);
    if (person) person.won = true;
    db.winners.push({ name: p.name, email: p.email, prizeName: prize.name, time });
  });
  prize.done = true;
  saveData();

  // Respond immediately so admin knows result
  res.json({ ok: true, winners: picked, prize: prize.name });

  // Broadcast SSE sequence
  const names = avail.map(p => p.name);
  broadcast('draw-start', { prizeName: prize.name, count });

  // Countdown 3 seconds, then rolling ~2.5s, then reveal
  const delay = ms => new Promise(r => setTimeout(r, ms));
  await delay(3200);

  // Rolling phase: send random names for ~2.5 seconds
  const rollDur = 2500;
  const rollInterval = 100;
  const rollSteps = Math.floor(rollDur / rollInterval);
  for (let i = 0; i < rollSteps; i++) {
    const randomName = names[Math.floor(Math.random() * names.length)];
    broadcast('draw-rolling', { name: randomName });
    await delay(rollInterval);
  }

  // Reveal winners
  if (picked.length === 1) {
    broadcast('draw-result', { winners: picked.map(w => w.name), prizeName: prize.name });
  } else {
    // Reveal one by one with delay
    for (let i = 0; i < picked.length; i++) {
      // Roll briefly before each reveal
      for (let j = 0; j < 12; j++) {
        broadcast('draw-rolling', { name: names[Math.floor(Math.random() * names.length)] });
        await delay(100);
      }
      broadcast('draw-reveal-one', {
        name: picked[i].name,
        index: i,
        total: picked.length,
        prizeName: prize.name,
      });
      await delay(800);
    }
    broadcast('draw-result', { winners: picked.map(w => w.name), prizeName: prize.name });
  }

  drawBusy = false;
});

// ── Winners ──
app.delete('/api/winners', (req, res) => {
  db.people.forEach(p => p.won = false);
  db.winners = [];
  db.prizes.forEach(p => p.done = false);
  saveData();
  res.json({ ok: true });
});

// ── Admin Auth ──
app.post('/api/login', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ ok: false, error: '請輸入密碼' });
  if (pin === db.adminPin) return res.json({ ok: true });
  res.json({ ok: false, error: '密碼錯誤' });
});

app.put('/api/admin-pin', (req, res) => {
  const { oldPin, newPin } = req.body;
  if (!oldPin || !newPin) return res.status(400).json({ ok: false, error: '請填寫完整' });
  if (oldPin !== db.adminPin) return res.status(403).json({ ok: false, error: '舊密碼錯誤' });
  if (newPin.length < 4) return res.status(400).json({ ok: false, error: '新密碼至少 4 碼' });
  db.adminPin = newPin;
  saveData();
  res.json({ ok: true });
});

// ── Export ──
app.get('/api/export', (req, res) => {
  const rows = ['\uFEFF名次,姓名,Email,獎項,時間'];
  const grp = {};
  db.winners.forEach(w => {
    if (!grp[w.prizeName]) grp[w.prizeName] = [];
    grp[w.prizeName].push(w);
  });
  Object.values(grp).forEach(ws =>
    ws.forEach((w, i) => rows.push(`${i+1},${w.name},${w.email},${w.prizeName},${w.time}`))
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="winners.csv"');
  res.send(rows.join('\n'));
});

// Catch-all: serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🎉 IM 行動教會春酒抽獎系統啟動：http://localhost:${PORT}`);
});
