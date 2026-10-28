const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);

const supabase = USE_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;

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

function getSupabaseUserClient(token) {
  if (!SUPABASE_URL) {
    return null;
  }

  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY || SUPABASE_SECRET_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

async function initializeDatabase() {
  if (USE_SUPABASE) {
    return;
  }

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

async function authenticated(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (USE_SUPABASE) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      req.user = { id: user.id, email: user.email };
      return next();
    } catch (error) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function createSupabaseUser(email, password) {
  const { data: userData, error: userError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { source: 'she-shield' },
  });

  if (userError) {
    throw userError;
  }

  if (!userData?.user) {
    throw new Error('Account creation failed.');
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.signInWithPassword({ email, password });

  if (sessionError) {
    throw sessionError;
  }

  return {
    user: userData.user,
    token: sessionData?.session?.access_token || null,
  };
}

async function loginSupabaseUser(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    throw error;
  }

  return {
    user: data.user,
    token: data.session?.access_token || null,
  };
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.post('/api/register', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    if (USE_SUPABASE) {
      const result = await createSupabaseUser(email, password);
      return res.status(201).json({
        token: result.token,
        user: { id: result.user.id, email: result.user.email },
      });
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
    const message = error?.message || 'Unable to create account.';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (USE_SUPABASE) {
      const result = await loginSupabaseUser(email, password);
      return res.json({
        token: result.token,
        user: { id: result.user.id, email: result.user.email },
      });
    }

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
    const message = error?.message || 'Unable to sign in.';
    return res.status(400).json({ error: message });
  }
});

app.get('/api/session', authenticated, async (req, res) => {
  if (USE_SUPABASE) {
    return res.json({ user: { id: req.user.id, email: req.user.email } });
  }

  const user = await get('SELECT id, email FROM users WHERE id = ?', [req.user.id]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ user: { id: user.id, email: user.email } });
});

app.get('/api/contacts', authenticated, async (req, res) => {
  try {
    if (USE_SUPABASE) {
      const userClient = getSupabaseUserClient(req.headers.authorization.slice(7));
      const { data, error } = await userClient
        .from('contacts')
        .select('*')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return res.json({ contacts: data || [] });
    }

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

    if (USE_SUPABASE) {
      const userClient = getSupabaseUserClient(req.headers.authorization.slice(7));
      const { data, error } = await userClient
        .from('contacts')
        .insert([{ user_id: req.user.id, name, phone, relation }])
        .select()
        .single();

      if (error) throw error;
      return res.status(201).json({ contact: data });
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
    if (USE_SUPABASE) {
      const userClient = getSupabaseUserClient(req.headers.authorization.slice(7));
      const { data, error } = await userClient
        .from('contacts')
        .delete()
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .select()
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Contact not found.' });
        }
        throw error;
      }

      return res.json({ ok: true, contact: data });
    }

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

    if (USE_SUPABASE) {
      const userClient = getSupabaseUserClient(req.headers.authorization.slice(7));
      const { data: alert, error } = await userClient
        .from('sos_alerts')
        .insert([{ user_id: req.user.id, status: 'active', lat, lng, accuracy }])
        .select()
        .single();

      if (error) throw error;

      if (lat != null && lng != null) {
        const { error: locationError } = await userClient
          .from('sos_locations')
          .insert([{ alert_id: alert.id, user_id: req.user.id, lat, lng, accuracy }]);

        if (locationError) throw locationError;
      }

      return res.status(201).json({ alert });
    }

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
    if (USE_SUPABASE) {
      const userClient = getSupabaseUserClient(req.headers.authorization.slice(7));
      const { data, error } = await userClient
        .from('sos_alerts')
        .select('*')
        .eq('user_id', req.user.id)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return res.json({ alert: data || null });
    }

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
    if (USE_SUPABASE) {
      const userClient = getSupabaseUserClient(req.headers.authorization.slice(7));
      const { data, error } = await userClient
        .from('sos_alerts')
        .select('*')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(30);

      if (error) throw error;
      return res.json({ alerts: data || [] });
    }

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
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const accuracy = req.body.accuracy != null ? Number(req.body.accuracy) : null;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Latitude and longitude are required.' });
    }

    if (USE_SUPABASE) {
      const userClient = getSupabaseUserClient(req.headers.authorization.slice(7));
      const { data: alert, error: alertError } = await userClient
        .from('sos_alerts')
        .select('*')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .maybeSingle();

      if (alertError) throw alertError;
      if (!alert) {
        return res.status(404).json({ error: 'Alert not found.' });
      }

      const { error: locationError } = await userClient
        .from('sos_locations')
        .insert([{ alert_id: req.params.id, user_id: req.user.id, lat, lng, accuracy }]);

      if (locationError) throw locationError;

      const { data: updatedAlert, error: updateError } = await userClient
        .from('sos_alerts')
        .update({ lat, lng, accuracy })
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .select()
        .single();

      if (updateError) throw updateError;
      return res.json({ alert: updatedAlert });
    }

    const alert = await get('SELECT * FROM sos_alerts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found.' });
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
    if (USE_SUPABASE) {
      const userClient = getSupabaseUserClient(req.headers.authorization.slice(7));
      const { data: alert, error: fetchError } = await userClient
        .from('sos_alerts')
        .select('*')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .maybeSingle();

      if (fetchError) throw fetchError;
      if (!alert) {
        return res.status(404).json({ error: 'Alert not found.' });
      }

      const resolvedAt = new Date().toISOString();
      const { data: updatedAlert, error: updateError } = await userClient
        .from('sos_alerts')
        .update({ status: 'resolved', resolved_at: resolvedAt })
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .select()
        .single();

      if (updateError) throw updateError;
      return res.json({ alert: updatedAlert });
    }

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
    if (USE_SUPABASE) {
      console.log('Using Supabase database and auth');
    }
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
