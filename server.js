const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ══════════════════════════════════════
// SESSION STORE (in-memory)
// ══════════════════════════════════════
// sessions[code] = { code, adminToken, config, data, autoState, clients: Set<ws> }
const sessions = {};

function genCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function broadcast(session, msg, excludeWs = null) {
  const payload = JSON.stringify(msg);
  session.clients.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

function broadcastAll(session, msg) {
  broadcast(session, msg, null);
}

function getPublicState(session) {
  return {
    type: 'state',
    config: session.config,
    data: session.data,
    autoState: session.autoState,
    adminCode: session.adminCode,
    viewCode: session.viewCode,
    serverTime: Date.now()
  };
}

// ══════════════════════════════════════
// REST — créer / rejoindre session
// ══════════════════════════════════════
app.post('/api/session/create', (req, res) => {
  const { config, adminPassword } = req.body;
  if (!config || !adminPassword) return res.status(400).json({ error: 'Manque config ou mot de passe' });

  // Deux codes distincts
  let adminCode, viewCode;
  do { adminCode = genCode(); } while (sessions[adminCode]);
  do { viewCode  = genCode(); } while (sessions[viewCode] || viewCode === adminCode);

  const adminToken = uuidv4();

  const data = Array.from({ length: config.sprints }, () =>
    config.participants.map(() => ({ state: 'pending', start: null, elapsed: null, faults: 0 }))
  );

  const session = {
    adminCode,
    viewCode,
    adminToken,
    adminPassword,
    config,
    data,
    autoState: { started: false, paused: false, sec: config.interval },
    clients: new Set(),
    tickId: null
  };

  // Indexer par les deux codes
  sessions[adminCode] = session;
  sessions[viewCode]  = session;

  setTimeout(() => {
    delete sessions[adminCode];
    delete sessions[viewCode];
  }, 12 * 60 * 60 * 1000);

  res.json({ adminCode, viewCode, adminToken });
});

app.post('/api/session/join', (req, res) => {
  const { code } = req.body;
  const session = sessions[code?.toUpperCase()];
  if (!session) return res.status(404).json({ error: 'Session introuvable' });
  const isAdmin = code.toUpperCase() === session.adminCode;
  res.json({ adminCode: session.adminCode, viewCode: session.viewCode, config: session.config, isAdmin });
});

app.post('/api/session/admin', (req, res) => {
  const { code, adminPassword } = req.body;
  const session = sessions[code?.toUpperCase()];
  if (!session) return res.status(404).json({ error: 'Session introuvable' });
  if (session.adminPassword !== adminPassword) return res.status(403).json({ error: 'Mot de passe incorrect' });
  res.json({ adminToken: session.adminToken });
});

// ══════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════
wss.on('connection', (ws) => {
  let currentSession = null;
  let isAdmin = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN ──
    if (msg.type === 'join') {
      const session = sessions[msg.code?.toUpperCase()];
      if (!session) { ws.send(JSON.stringify({ type: 'error', msg: 'Session introuvable' })); return; }
      currentSession = session;
      session.clients.add(ws);
      // Admin si le code fourni est le code admin
      isAdmin = (msg.code?.toUpperCase() === session.adminCode);
      ws.send(JSON.stringify({ ...getPublicState(session), isAdmin }));
      return;
    }

    if (!currentSession) return;

    // ── ADMIN ONLY ──
    if (!isAdmin) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Non autorisé' }));
      return;
    }

    const s = currentSession;

    // ── ACTION ──
    if (msg.type === 'action') {
      const { sprintIdx, piloteIdx, action } = msg;
      const e = s.data[sprintIdx]?.[piloteIdx];
      if (!e) return;

      if (action === 'd' && e.state === 'pending') {
        e.state = 'running';
        e.start = Date.now();
        // Lance/reset auto timer
        if (s.config.mode === 'auto') {
          if (!s.autoState.started) startAutoTimer(s);
          else { s.autoState.sec = s.config.interval; }
        }
      } else if (action === 'a' && e.state === 'running') {
        e.elapsed = Date.now() - e.start;
        e.state = 'done';
      } else if (action === 't' && e.state !== 'dnf') {
        if (e.state === 'running') e.elapsed = Date.now() - e.start;
        e.state = 'dnf';
      } else if (action === 'f' && e.state !== 'dnf') {
        e.faults = (e.faults || 0) + 1;
      } else return;

      broadcastAll(s, getPublicState(s));
    }

    // ── AUTO CONTROLS ──
    if (msg.type === 'auto_pause') {
      s.autoState.paused = !s.autoState.paused;
      broadcastAll(s, getPublicState(s));
    }
    if (msg.type === 'auto_force') {
      if (!s.autoState.started) startAutoTimer(s);
      else fireAutoDepart(s);
      broadcastAll(s, getPublicState(s));
    }
  });

  ws.on('close', () => {
    if (currentSession) currentSession.clients.delete(ws);
  });
});

// ══════════════════════════════════════
// AUTO TIMER (server-side)
// ══════════════════════════════════════
function startAutoTimer(session) {
  session.autoState.started = true;
  session.autoState.paused = false;
  session.autoState.sec = session.config.interval;
  clearInterval(session.tickId);
  session.tickId = setInterval(() => {
    if (session.autoState.paused) return;
    session.autoState.sec--;
    if (session.autoState.sec <= 0) {
      fireAutoDepart(session);
      session.autoState.sec = session.config.interval;
    }
    broadcastAll(session, getPublicState(session));
  }, 1000);
}

function fireAutoDepart(session) {
  const curSprint = session.config.currentSprint || 0;
  const idx = session.data[curSprint].findIndex(e => e.state === 'pending');
  if (idx !== -1) {
    const e = session.data[curSprint][idx];
    e.state = 'running';
    e.start = Date.now();
  }
}

server.listen(PORT, () => {
  console.log(`Motocross Chrono v2 running on port ${PORT}`);
});
