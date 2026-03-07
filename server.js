const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ── In-memory store (backed by data.json for persistence) ──
let db = {
  people: [],   // { name, won }
  rounds: [
    {
      name: '第一輪',
      prizes: [
        { name: '安慰獎', count: 5, done: false },
        { name: '三獎',   count: 3, done: false },
      ],
    },
    {
      name: '第二輪',
      prizes: [
        { name: '二獎', count: 2, done: false },
      ],
    },
    {
      name: '第三輪',
      prizes: [
        { name: '頭獎 🏆', count: 1, done: false },
      ],
    },
  ],
  winners: [],  // { name, prizeName, roundName, time }
  adminPin: '1234',
  activeRound: -1,   // which round is shown on draw page
  activePrize: -1,   // which prize is selected on draw page
};

// Load from file if it exists
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      db = JSON.parse(raw);
      // Backward compat: migrate old prizes[] to rounds[]
      if (db.prizes && !db.rounds) {
        db.rounds = [{ name: '第一輪', prizes: db.prizes }];
        delete db.prizes;
        saveData();
      }
      if (db.activeRound === undefined) db.activeRound = -1;
      if (db.activePrize === undefined) db.activePrize = -1;
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

// ── SSE ──
let sseClients = [];

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately
  res.write(`event: init\ndata: ${JSON.stringify({
    activeRound: db.activeRound,
    activePrize: db.activePrize,
    rounds: db.rounds,
    people: db.people,
    winners: db.winners
  })}\n\n`);

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
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '姓名為必填' });
  if (db.people.find(p => p.name === name)) {
    return res.status(409).json({ error: '此姓名已登記' });
  }
  const person = { name, won: false };
  db.people.push(person);
  saveData();
  broadcast('refresh', { people: db.people, winners: db.winners });
  res.json({ ok: true, person, total: db.people.length });
});

app.delete('/api/people/:index', (req, res) => {
  const i = parseInt(req.params.index);
  if (i < 0 || i >= db.people.length) return res.status(404).json({ error: '找不到此人' });
  if (db.people[i].won) return res.status(400).json({ error: '已中獎者無法移除' });
  db.people.splice(i, 1);
  saveData();
  broadcast('refresh', { people: db.people, winners: db.winners });
  res.json({ ok: true });
});

app.post('/api/people/batch', (req, res) => {
  const { lines } = req.body; // array of {name, email}
  let added = 0;
  lines.forEach(({ name }) => {
    if (name && !db.people.find(p => p.name === name)) {
      db.people.push({ name, won: false });
      added++;
    }
  });
  saveData();
  broadcast('refresh', { people: db.people, winners: db.winners });
  res.json({ ok: true, added });
});

app.delete('/api/people', (req, res) => {
  db.people = [];
  db.winners = [];
  db.rounds.forEach(r => r.prizes.forEach(p => p.done = false));
  db.activeRound = -1;
  db.activePrize = -1;
  saveData();
  broadcast('refresh', { people: db.people, winners: db.winners, rounds: db.rounds, activeRound: -1, activePrize: -1 });
  res.json({ ok: true });
});

// ── Rounds ──
app.put('/api/rounds', (req, res) => {
  const { rounds } = req.body;
  db.rounds = rounds;
  saveData();
  broadcast('refresh', { rounds: db.rounds });
  res.json({ ok: true });
});

// ── Active Round / Prize (admin controls what draw page shows) ──
app.put('/api/active-round', (req, res) => {
  const { roundIndex } = req.body;
  db.activeRound = roundIndex;
  db.activePrize = -1;
  saveData();
  broadcast('activeRound', { activeRound: roundIndex, activePrize: -1, rounds: db.rounds });
  res.json({ ok: true });
});

app.put('/api/active-prize', (req, res) => {
  const { prizeIndex } = req.body;
  db.activePrize = prizeIndex;
  saveData();
  broadcast('activePrize', { activePrize: prizeIndex, activeRound: db.activeRound, rounds: db.rounds });
  res.json({ ok: true });
});

// ── Draw ──
app.post('/api/draw', (req, res) => {
  const { roundIndex, prizeIndex } = req.body;
  const round = db.rounds[roundIndex];
  if (!round) return res.status(400).json({ error: '輪次不存在' });
  const prize = round.prizes[prizeIndex];
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
    const person = db.people.find(x => x.name === p.name);
    if (person) person.won = true;
    db.winners.push({ name: p.name, prizeName: prize.name, roundName: round.name, time });
  });
  prize.done = true;
  saveData();

  // Broadcast draw event to draw page (includes all names for animation)
  broadcast('draw', {
    winners: picked,
    prize: prize.name,
    round: round.name,
    roundIndex,
    prizeIndex,
    allPeople: avail.map(p => p.name),
    count,
    allWinners: db.winners,
    rounds: db.rounds,
    people: db.people
  });

  res.json({ ok: true, winners: picked, prize: prize.name, round: round.name });
});

// ── Winners ──
app.delete('/api/winners', (req, res) => {
  db.people.forEach(p => p.won = false);
  db.winners = [];
  db.rounds.forEach(r => r.prizes.forEach(p => p.done = false));
  db.activeRound = -1;
  db.activePrize = -1;
  saveData();
  broadcast('refresh', { people: db.people, winners: db.winners, rounds: db.rounds, activeRound: -1, activePrize: -1 });
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
  const rows = ['\uFEFF名次,姓名,輪次,獎項,時間'];
  const grp = {};
  db.winners.forEach(w => {
    const key = (w.roundName || '') + '|' + w.prizeName;
    if (!grp[key]) grp[key] = [];
    grp[key].push(w);
  });
  Object.values(grp).forEach(ws =>
    ws.forEach((w, i) => rows.push(`${i+1},${w.name},${w.roundName||''},${w.prizeName},${w.time}`))
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="winners.csv"');
  res.send(rows.join('\n'));
});

// ── Page routes ──
app.get('/draw', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'draw.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Catch-all: serve index.html (registration page)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🎉 IM 行動教會春酒抽獎系統啟動：http://localhost:${PORT}`);
  console.log(`   登記頁面: http://localhost:${PORT}`);
  console.log(`   抽獎頁面: http://localhost:${PORT}/draw`);
  console.log(`   管理後台: http://localhost:${PORT}/admin`);
});
