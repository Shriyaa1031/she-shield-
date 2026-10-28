const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'sos.db');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initializeDatabase() {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      relation TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sos_alerts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
      lat REAL,
      lng REAL,
      accuracy REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sos_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (alert_id) REFERENCES sos_alerts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_user ON sos_alerts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_locations_alert ON sos_locations(alert_id, created_at DESC);
  `;

  await new Promise((resolve, reject) => {
    db.exec(schema, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function authenticated(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.post('/api/register', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = randomUUID();
    await run('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', [userId, email, passwordHash]);

    const token = createToken({ id: userId, email });
    return res.status(201).json({ token, user: { id: userId, email } });
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ error: 'Unable to create account.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const user = await get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = createToken({ id: user.id, email: user.email });
    return res.json({ token, user: { id: user.id, email: user.email } });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Unable to sign in.' });
  }
});

app.get('/api/session', authenticated, async (req, res) => {
  const user = await get('SELECT id, email FROM users WHERE id = ?', [req.user.id]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ user: { id: user.id, email: user.email } });
});

app.get('/api/contacts', authenticated, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM contacts WHERE user_id = ? ORDER BY created_at ASC', [req.user.id]);
    res.json({ contacts: rows });
  } catch (error) {
    console.error('Contacts fetch error:', error);
    res.status(500).json({ error: 'Unable to load contacts.' });
  }
});

app.post('/api/contacts', authenticated, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim().replace(/[\s()-]/g, '');
    const relation = String(req.body.relation || '').trim() || null;

    if (!name) {
      return res.status(400).json({ error: 'Name is required.' });
    }

    if (!/^\+?\d{7,15}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid phone number with country code.' });
    }

    const contactId = randomUUID();
    await run(
      'INSERT INTO contacts (id, user_id, name, phone, relation) VALUES (?, ?, ?, ?, ?)',
      [contactId, req.user.id, name, phone, relation]
    );

    const contact = await get('SELECT * FROM contacts WHERE id = ?', [contactId]);
    res.status(201).json({ contact });
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Unable to save contact.' });
  }
});

app.delete('/api/contacts/:id', authenticated, async (req, res) => {
  try {
    const contact = await get('SELECT * FROM contacts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found.' });
    }

    await run('DELETE FROM contacts WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({ error: 'Unable to remove contact.' });
  }
});

app.post('/api/alerts', authenticated, async (req, res) => {
  try {
    const lat = req.body.lat != null ? Number(req.body.lat) : null;
    const lng = req.body.lng != null ? Number(req.body.lng) : null;
    const accuracy = req.body.accuracy != null ? Number(req.body.accuracy) : null;

    const alertId = randomUUID();
    await run(
      'INSERT INTO sos_alerts (id, user_id, status, lat, lng, accuracy) VALUES (?, ?, ?, ?, ?, ?)',
      [alertId, req.user.id, 'active', lat, lng, accuracy]
    );

    const alert = await get('SELECT * FROM sos_alerts WHERE id = ?', [alertId]);
    if (lat != null && lng != null) {
      await run(
        'INSERT INTO sos_locations (alert_id, user_id, lat, lng, accuracy) VALUES (?, ?, ?, ?, ?)',
        [alertId, req.user.id, lat, lng, accuracy]
      );
    }

    res.status(201).json({ alert });
  } catch (error) {
    console.error('Create alert error:', error);
    res.status(500).json({ error: 'Unable to create alert.' });
  }
});

app.get('/api/alerts/active', authenticated, async (req, res) => {
  try {
    const alert = await get(
      'SELECT * FROM sos_alerts WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      [req.user.id, 'active']
    );
    res.json({ alert });
  } catch (error) {
    console.error('Get active alert error:', error);
    res.status(500).json({ error: 'Unable to load active alert.' });
  }
});

app.get('/api/alerts/history', authenticated, async (req, res) => {
  try {
    const alerts = await all(
      'SELECT * FROM sos_alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 30',
      [req.user.id]
    );
    res.json({ alerts });
  } catch (error) {
    console.error('Alert history error:', error);
    res.status(500).json({ error: 'Unable to load alert history.' });
  }
});

app.post('/api/alerts/:id/location', authenticated, async (req, res) => {
  try {
    const alert = await get('SELECT * FROM sos_alerts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found.' });
    }

    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const accuracy = req.body.accuracy != null ? Number(req.body.accuracy) : null;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Latitude and longitude are required.' });
    }

    await run(
      'INSERT INTO sos_locations (alert_id, user_id, lat, lng, accuracy) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, req.user.id, lat, lng, accuracy]
    );

    await run(
      'UPDATE sos_alerts SET lat = ?, lng = ?, accuracy = ? WHERE id = ?',
      [lat, lng, accuracy, req.params.id]
    );

    const updatedAlert = await get('SELECT * FROM sos_alerts WHERE id = ?', [req.params.id]);
    res.json({ alert: updatedAlert });
  } catch (error) {
    console.error('Save location error:', error);
    res.status(500).json({ error: 'Unable to save location.' });
  }
});

app.patch('/api/alerts/:id/resolved', authenticated, async (req, res) => {
  try {
    const alert = await get('SELECT * FROM sos_alerts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found.' });
    }

    const resolvedAt = new Date().toISOString();
    await run(
      'UPDATE sos_alerts SET status = ?, resolved_at = ? WHERE id = ?',
      ['resolved', resolvedAt, req.params.id]
    );

    const updatedAlert = await get('SELECT * FROM sos_alerts WHERE id = ?', [req.params.id]);
    res.json({ alert: updatedAlert });
  } catch (error) {
    console.error('Resolve alert error:', error);
    res.status(500).json({ error: 'Unable to resolve alert.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`SafeHer SOS server running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
