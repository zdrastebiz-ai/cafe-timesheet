const express = require('express');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'cafe.db');

let db;

// ==================== DB HELPERS ====================
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGet(sql, params = []) {
  const rows = dbAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
  return { lastId: db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] };
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ==================== INIT ====================
async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, dob TEXT NOT NULL, position TEXT NOT NULL,
    payType TEXT DEFAULT 'weekly', phone TEXT DEFAULT '', bank TEXT DEFAULT '', card TEXT DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employeeId INTEGER NOT NULL, date TEXT NOT NULL, startTime TEXT NOT NULL, endTime TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employeeId INTEGER NOT NULL, rate REAL NOT NULL, fromDate TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

  // Начальные должности
  const posCount = dbGet('SELECT COUNT(*) as c FROM positions');
  if (posCount.c === 0) {
    ['Бариста', 'Повар', 'Официант', 'Кассир', 'Администратор', 'Уборщик']
      .forEach(p => db.run('INSERT INTO positions (name) VALUES (?)', [p]));
  }

  // Пароль по умолчанию
  if (!dbGet("SELECT value FROM settings WHERE key='adminPassword'")) {
    db.run("INSERT INTO settings (key, value) VALUES ('adminPassword', 'admin')");
  }

  // Email по умолчанию
  if (!dbGet("SELECT value FROM settings WHERE key='emailTo'")) {
    db.run("INSERT INTO settings (key, value) VALUES ('emailTo', 'rv87@bk.ru')");
  }

  saveDb();
}

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== API: EMPLOYEES ====================
app.get('/api/employees', (req, res) => {
  res.json(dbAll('SELECT * FROM employees ORDER BY name'));
});

app.post('/api/employees', (req, res) => {
  const { name, dob, position, payType, phone, bank, card } = req.body;
  const r = dbRun('INSERT INTO employees (name, dob, position, payType, phone, bank, card) VALUES (?,?,?,?,?,?,?)',
    [name, dob, position, payType || 'weekly', phone || '', bank || '', card || '']);
  res.json({ id: r.lastId });
});

app.put('/api/employees/:id', (req, res) => {
  const { name, dob, position, payType, phone, bank, card } = req.body;
  dbRun('UPDATE employees SET name=?, dob=?, position=?, payType=?, phone=?, bank=?, card=? WHERE id=?',
    [name, dob, position, payType || 'weekly', phone || '', bank || '', card || '', Number(req.params.id)]);
  res.json({ ok: true });
});

app.delete('/api/employees/:id', (req, res) => {
  dbRun('DELETE FROM employees WHERE id=?', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ==================== API: SHIFTS ====================
app.get('/api/shifts', (req, res) => {
  const { date, employeeId } = req.query;
  let sql = 'SELECT * FROM shifts WHERE 1=1';
  const params = [];
  if (date) { sql += ' AND date=?'; params.push(date); }
  if (employeeId) { sql += ' AND employeeId=?'; params.push(Number(employeeId)); }
  sql += ' ORDER BY date DESC, startTime DESC';
  res.json(dbAll(sql, params));
});

app.get('/api/shifts/range', (req, res) => {
  const { from, to, employeeId } = req.query;
  let sql = 'SELECT * FROM shifts WHERE date >= ? AND date <= ? AND endTime IS NOT NULL';
  const params = [from, to];
  if (employeeId) { sql += ' AND employeeId=?'; params.push(Number(employeeId)); }
  sql += ' ORDER BY date, startTime';
  res.json(dbAll(sql, params));
});

app.post('/api/shifts', (req, res) => {
  const { employeeId, date, startTime } = req.body;
  const existing = dbGet('SELECT id FROM shifts WHERE employeeId=? AND date=? AND endTime IS NULL', [employeeId, date]);
  if (existing) return res.status(400).json({ error: 'Смена уже открыта' });
  const r = dbRun('INSERT INTO shifts (employeeId, date, startTime) VALUES (?,?,?)', [employeeId, date, startTime]);
  res.json({ id: r.lastId });
});

app.put('/api/shifts/:id/end', (req, res) => {
  const { endTime } = req.body;
  dbRun('UPDATE shifts SET endTime=? WHERE id=?', [endTime, Number(req.params.id)]);
  res.json({ ok: true });
});

// ==================== API: RATES ====================
app.get('/api/rates', (req, res) => {
  res.json(dbAll('SELECT * FROM rates ORDER BY fromDate DESC'));
});

app.post('/api/rates', (req, res) => {
  const { employeeId, rate, fromDate } = req.body;
  const r = dbRun('INSERT INTO rates (employeeId, rate, fromDate) VALUES (?,?,?)', [employeeId, rate, fromDate]);
  res.json({ id: r.lastId });
});

// ==================== API: POSITIONS ====================
app.get('/api/positions', (req, res) => {
  res.json(dbAll('SELECT * FROM positions ORDER BY name'));
});

app.post('/api/positions', (req, res) => {
  const { name } = req.body;
  const r = dbRun('INSERT INTO positions (name) VALUES (?)', [name]);
  res.json({ id: r.lastId });
});

app.delete('/api/positions/:id', (req, res) => {
  dbRun('DELETE FROM positions WHERE id=?', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ==================== API: SETTINGS ====================
app.get('/api/settings/:key', (req, res) => {
  const row = dbGet('SELECT value FROM settings WHERE key=?', [req.params.key]);
  res.json({ value: row ? row.value : null });
});

app.put('/api/settings/:key', (req, res) => {
  const { value } = req.body;
  dbRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [req.params.key, value]);
  res.json({ ok: true });
});

// ==================== API: REPORT ====================
app.get('/api/report', (req, res) => {
  const { from, to, payType } = req.query;
  res.json(generateReportData(from, to, payType || null));
});

function generateReportData(from, to, payType) {
  let empSql = 'SELECT * FROM employees';
  const empParams = [];
  if (payType) { empSql += ' WHERE payType=?'; empParams.push(payType); }
  empSql += ' ORDER BY name';
  const employees = dbAll(empSql, empParams);

  const shifts = dbAll('SELECT * FROM shifts WHERE date >= ? AND date <= ? AND endTime IS NOT NULL ORDER BY date, startTime', [from, to]);
  const rates = dbAll('SELECT * FROM rates ORDER BY fromDate DESC');

  function getRateForDate(empId, dateStr) {
    const r = rates.find(r => r.employeeId === empId && r.fromDate <= dateStr);
    return r ? r.rate : 0;
  }

  function parseTime(str) {
    const [h, m] = str.split(':').map(Number);
    return h * 60 + m;
  }

  const rows = employees.map(emp => {
    const empShifts = shifts.filter(s => s.employeeId === emp.id);
    let totalMinutes = 0, totalPay = 0, daysWorked = 0;

    empShifts.forEach(s => {
      const mins = parseTime(s.endTime) - parseTime(s.startTime);
      if (mins > 0) {
        totalMinutes += mins; daysWorked++;
        totalPay += (mins / 60) * getRateForDate(emp.id, s.date);
      }
    });

    return {
      id: emp.id, name: emp.name, position: emp.position, payType: emp.payType,
      daysWorked, totalMinutes, totalPay: Math.round(totalPay),
      currentRate: getRateForDate(emp.id, to)
    };
  });

  return { from, to, rows, grandTotal: rows.reduce((sum, r) => sum + r.totalPay, 0) };
}

// ==================== EMAIL ====================
function getEmailConfig() {
  const g = key => { const r = dbGet("SELECT value FROM settings WHERE key=?", [key]); return r?.value || ''; };
  return {
    host: g('smtpHost'), port: Number(g('smtpPort')) || 587,
    user: g('smtpUser'), pass: g('smtpPass'), to: g('emailTo') || 'rv87@bk.ru'
  };
}

function createTransporter() {
  const cfg = getEmailConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) return null;
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass }
  });
}

function formatHours(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h + 'ч ' + (m < 10 ? '0' : '') + m + 'м';
}

function reportToHtml(title, report) {
  let html = `<h2 style="font-family:sans-serif;color:#2c3e50">${title}</h2>`;
  html += `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">`;
  html += `<tr style="background:#f5f6fa;font-weight:bold"><td>ФИО</td><td>Должность</td><td>Дней</td><td>Часов</td><td>Ставка</td><td>К выплате</td></tr>`;
  report.rows.forEach(r => {
    html += `<tr><td>${r.name}</td><td>${r.position}</td><td>${r.daysWorked}</td><td>${formatHours(r.totalMinutes)}</td><td>${r.daysWorked > 0 ? r.currentRate + ' руб/ч' : '—'}</td><td><b>${r.totalPay.toLocaleString('ru-RU')} руб.</b></td></tr>`;
  });
  html += `<tr style="background:#fef9e7;font-weight:bold"><td colspan="5">ИТОГО</td><td>${report.grandTotal.toLocaleString('ru-RU')} руб.</td></tr></table>`;
  return html;
}

async function sendReportEmail(title, report) {
  const transporter = createTransporter();
  if (!transporter) { console.log('[Email] SMTP не настроен:', title); return; }
  const cfg = getEmailConfig();
  try {
    await transporter.sendMail({ from: `"Кафе Табель" <${cfg.user}>`, to: cfg.to, subject: title, html: reportToHtml(title, report) });
    console.log('[Email] Отправлено:', title, '→', cfg.to);
  } catch (err) { console.error('[Email] Ошибка:', err.message); }
}

app.post('/api/test-email', async (req, res) => {
  const transporter = createTransporter();
  if (!transporter) return res.status(400).json({ error: 'SMTP не настроен' });
  const cfg = getEmailConfig();
  try {
    await transporter.sendMail({ from: `"Кафе Табель" <${cfg.user}>`, to: cfg.to, subject: 'Тест: Кафе Табель', html: '<h3>Тестовое письмо</h3><p>Отправка отчётов настроена корректно.</p>' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/send-report', async (req, res) => {
  const { type, from, to, title } = req.body;
  const payType = type === 'weekly' ? 'weekly' : (type === 'bimonthly' ? 'bimonthly' : null);
  try { await sendReportEmail(title, generateReportData(from, to, payType)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== CRON JOBS ====================
function getMonthName(m) {
  return ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][m - 1];
}
function fmtDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function lastDay(y, m) { return new Date(y, m, 0).getDate(); }

// Пн 08:00 — еженедельный
cron.schedule('0 8 * * 1', async () => {
  const t = new Date(); const pm = new Date(t); pm.setDate(t.getDate()-7);
  const ps = new Date(pm); ps.setDate(pm.getDate()+6);
  const from = fmtDate(pm), to = fmtDate(ps);
  await sendReportEmail(`Еженедельный отчёт: ${from} — ${to}`, generateReportData(from, to, 'weekly'));
});

// 25-го 08:00 — аванс (1–14)
cron.schedule('0 8 25 * *', async () => {
  const t = new Date(), y = t.getFullYear(), m = t.getMonth()+1;
  const ms = `${y}-${String(m).padStart(2,'0')}`;
  await sendReportEmail(`Аванс (25-го): 1–14 ${getMonthName(m)} ${y}`, generateReportData(`${ms}-01`, `${ms}-14`, 'bimonthly'));
});

// 10-го 08:00 — остаток (15–конец пред. месяца)
cron.schedule('0 8 10 * *', async () => {
  const p = new Date(); p.setMonth(p.getMonth()-1);
  const y = p.getFullYear(), m = p.getMonth()+1, ld = lastDay(y, m);
  const ms = `${y}-${String(m).padStart(2,'0')}`;
  await sendReportEmail(`Остаток зарплаты (10-го): 15–${ld} ${getMonthName(m)} ${y}`, generateReportData(`${ms}-15`, `${ms}-${ld}`, 'bimonthly'));
});

// 1-го 08:00 — полный за пред. месяц
cron.schedule('0 8 1 * *', async () => {
  const p = new Date(); p.setMonth(p.getMonth()-1);
  const y = p.getFullYear(), m = p.getMonth()+1, ld = lastDay(y, m);
  const ms = `${y}-${String(m).padStart(2,'0')}`;
  await sendReportEmail(`Полный отчёт за ${getMonthName(m)} ${y} (все сотрудники)`, generateReportData(`${ms}-01`, `${ms}-${ld}`, null));
});

// ==================== START ====================
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    console.log('Расписание email-отчётов:');
    console.log('  Пн 08:00 — еженедельный');
    console.log('  25-го 08:00 — аванс (1–14)');
    console.log('  10-го 08:00 — остаток (15–конец пред. месяца)');
    console.log('  1-го 08:00 — полный за пред. месяц (все)');
  });
}).catch(err => { console.error('Ошибка инициализации БД:', err); process.exit(1); });
