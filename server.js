const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY || "";

const rooms = new Map();
const clients = new Map();

// ─────────────────────────────────────
// Utils
// ─────────────────────────────────────
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizePlayerName(value) {
  if (!isNonEmptyString(value)) return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 20) return null;
  return name;
}

function sanitizeTopic(value) {
  if (!isNonEmptyString(value)) return null;
  const topic = value.trim().replace(/\s+/g, " ");
  if (topic.length < 2 || topic.length > 120) return null;
  return topic;
}

function sanitizeQuestionCount(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(30, n));
}

function sanitizeTimeLeft(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(15, n));
}

function sanitizeAnswerIndex(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n === -1) return -1;
  if (n >= 0 && n <= 3) return n;
  return null;
}

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let attempts = 0;

  while (attempts < 1000) {
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!rooms.has(code)) return code;
    attempts++;
  }

  throw new Error("Impossible de générer un code de salle unique");
}

function createRoom(host, topic, count) {
  const code = genCode();
  const room = {
    code,
    host,
    topic,
    questionCount: count,
    players: [{ name: host, score: 0 }],
    questions: [],
    state: "lobby", // lobby | generating | playing | results
    currentQ: 0,
    answersThisRound: {},
    created: Date.now(),
    updated: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function touchRoom(room) {
  room.updated = Date.now();
}

function sendTo(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    console.error("Erreur sendTo:", err.message);
  }
}

function sendAll(roomCode, message, excludeWs = null) {
  const payload = JSON.stringify(message);
  for (const [ws, info] of clients.entries()) {
    if (!info || info.roomCode !== roomCode) continue;
    if (excludeWs && ws === excludeWs) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;

    try {
      ws.send(payload);
    } catch (err) {
      console.error("Erreur sendAll:", err.message);
    }
  }
}

function findPlayer(room, playerName) {
  return room.players.find((p) => p.name === playerName);
}

function getScores(room) {
  return room.players.map((p) => ({ name: p.name, score: p.score }));
}

function getLeaderboard(room) {
  return [...room.players].sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────
// Web context search
// ─────────────────────────────────────
async function fetchWikiSummary(title, lang = "fr") {
  try {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "QUIZIMED/1.0" },
    });
    if (!res.ok) return "";
    const data = await res.json();
    return typeof data.extract === "string" ? data.extract.trim() : "";
  } catch {
    return "";
  }
}

async function searchWikiTitles(query, lang = "fr") {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=3`;
    const res = await fetch(url, {
      headers: { "User-Agent": "QUIZIMED/1.0" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.query?.search)
      ? data.query.search.map((s) => s.title).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

async function searchTopic(topic) {
  try {
    console.log(`🔍 Recherche web: "${topic}"...`);

    const queries = [topic, `${topic} biographie`, `${topic} faits`];
    const collected = [];
    const seen = new Set();

    for (const query of queries.slice(0, 2)) {
      const directFr = await fetchWikiSummary(query, "fr");
      if (directFr && !seen.has(directFr)) {
        seen.add(directFr);
        collected.push(directFr);
      }

      const frTitles = await searchWikiTitles(query, "fr");
      for (const title of frTitles.slice(0, 2)) {
        const text = await fetchWikiSummary(title, "fr");
        if (text && !seen.has(text)) {
          seen.add(text);
          collected.push(text);
        }
      }
    }

    const directEn = await fetchWikiSummary(topic, "en");
    if (directEn && !seen.has(directEn)) {
      seen.add(directEn);
      collected.push(`[EN] ${directEn}`);
    }

    const finalText = collected.join("\n\n").slice(0, 4000);
    console.log(`📚 ${finalText.length} chars de contexte trouvés`);
    return finalText;
  } catch (err) {
    console.log(`⚠️ Recherche échouée: ${err.message}`);
    return "";
  }
}

// ─────────────────────────────────────
// AI questions
// ─────────────────────────────────────
function validateQuestions(rawQuestions, expectedCount) {
  if (!Array.isArray(rawQuestions)) return null;

  const cleaned = [];

  for (const item of rawQuestions) {
    if (!item || typeof item !== "object") continue;

    const question = typeof item.question === "string" ? item.question.trim() : "";
    const explanation = typeof item.explanation === "string" ? item.explanation.trim() : "";
    const options = Array.isArray(item.options)
      ? item.options.map((o) => (typeof o === "string" ? o.trim() : ""))
      : [];
    const correct = Number(item.correct);

    if (!question) continue;
    if (options.length !== 4) continue;
    if (options.some((o) => !o)) continue;
    if (!Number.isInteger(correct) || correct < 0 || correct > 3) continue;

    cleaned.push({
      question,
      options,
      correct,
      explanation: explanation || "Pas d'explication disponible.",
    });
  }

  if (!cleaned.length) return null;
  return cleaned.slice(0, expectedCount);
}

async function generateQuestions(topic, count) {
  if (!API_KEY) return demoQs(topic, count);

  const facts = await searchTopic(topic);

  const contextBlock = facts
    ? `\nVOICI DES INFORMATIONS VÉRIFIÉES SUR LE SUJET (source: Wikipedia):\n---\n${facts}\n---\nBase tes questions prioritairement sur ces informations.\n`
    : `\nAucune info trouvée en ligne. Base-toi uniquement sur des faits dont tu es absolument certain.\n`;

  const prompt = `RÔLE: Tu es un professeur expert qui crée des quiz de culture générale.
SUJET: "${topic}"
NOMBRE: Exactement ${count} questions
${contextBlock}
INSTRUCTIONS STRICTES:
- Ne jamais inventer de faits
- La bonne réponse doit être indiscutable
- Les 3 mauvaises réponses doivent être plausibles mais fausses
- Exactement 4 options par question
- Mélange les difficultés
- Chaque question doit porter sur un point différent
- Tout doit être en français

FORMAT:
Réponds uniquement avec un tableau JSON valide.
Aucun texte avant.
Aucun texte après.
Aucun backtick.

[{"question":"La question ?","options":["A","B","C","D"],"correct":0,"explanation":"Explication courte"}]

Le champ "correct" est l'index 0-3 de la bonne réponse.`;

  const models = [
    "openrouter/free",
    "qwen/qwen3-coder:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "stepfun/step-3.5-flash:free",
  ];

  for (const model of models) {
    try {
      console.log(`🤖 ${model}...`);

      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.4,
          max_tokens: 5000,
        }),
      });

      if (!res.ok) {
        console.log(`⚠️ ${model}: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "";
      if (!text) continue;

      const clean = text.replace(/```json|```/gi, "").trim();

      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch {
        continue;
      }

      const validated = validateQuestions(parsed, count);
      if (!validated || !validated.length) continue;

      console.log(`✅ ${validated.length} questions valides`);
      return validated;
    } catch (e) {
      console.log(`⚠️ ${model}: ${e.message}`);
    }
  }

  return demoQs(topic, count);
}

function demoQs(topic, n) {
  return Array.from({ length: n }, (_, i) => ({
    question: `Question démo ${i + 1} sur "${topic}"`,
    options: ["A", "B", "C", "D"],
    correct: 0,
    explanation: "Démo",
  }));
}

// ─────────────────────────────────────
// Room / disconnect handling
// ─────────────────────────────────────
function doLeave(ws) {
  const info = clients.get(ws);
  if (!info) return;

  if (!info.roomCode) {
    clients.delete(ws);
    return;
  }

  const roomCode = info.roomCode;
  const leavingName = info.name;
  const room = rooms.get(roomCode);

  if (room) {
    room.players = room.players.filter((p) => p.name !== leavingName);
    delete room.answersThisRound[leavingName];
    touchRoom(room);

    if (room.players.length === 0) {
      rooms.delete(roomCode);
      console.log(`🗑️ Salle ${roomCode} supprimée`);
    } else {
      const oldHost = room.host;
      let hostChanged = false;

      if (room.host === leavingName) {
        room.host = room.players[0].name;
        hostChanged = true;
      }

      sendAll(roomCode, {
        type: "player_left",
        players: room.players,
        leftPlayer: leavingName,
        host: room.host,
      });

      if (hostChanged && room.host !== oldHost) {
        sendAll(roomCode, {
          type: "host_changed",
          host: room.host,
          players: room.players,
        });
      }
    }
  }

  clients.delete(ws);
}

// ─────────────────────────────────────
// WebSocket
// ─────────────────────────────────────
wss.on("connection", (ws) => {
  clients.set(ws, { name: null, roomCode: null, isAlive: true });

  ws.on("pong", () => {
    const info = clients.get(ws);
    if (info) info.isAlive = true;
  });

  ws.on("message", async (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return sendTo(ws, { type: "error", message: "Message JSON invalide." });
    }

    const info = clients.get(ws);
    if (!info) return;

    try {
      if (m.type === "create_room") {
        const playerName = sanitizePlayerName(m.playerName);
        const topic = sanitizeTopic(m.topic);
        const questionCount = sanitizeQuestionCount(m.questionCount);

        if (!playerName) {
          return sendTo(ws, { type: "error", message: "Pseudo invalide." });
        }

        if (!topic) {
          return sendTo(ws, { type: "error", message: "Sujet invalide." });
        }

        const room = createRoom(playerName, topic, questionCount);
        info.name = playerName;
        info.roomCode = room.code;

        sendTo(ws, {
          type: "room_created",
          roomCode: room.code,
          host: room.host,
          players: room.players,
          topic: room.topic,
          questionCount: room.questionCount,
        });
      }

      else if (m.type === "join_room") {
        const playerName = sanitizePlayerName(m.playerName);
        const code = typeof m.roomCode === "string" ? m.roomCode.trim().toUpperCase() : "";
        const room = rooms.get(code);

        if (!playerName) {
          return sendTo(ws, { type: "error", message: "Pseudo invalide." });
        }

        if (!room) {
          return sendTo(ws, { type: "error", message: "Salle introuvable." });
        }

        if (room.state !== "lobby") {
          return sendTo(ws, { type: "error", message: "Partie déjà lancée." });
        }

        if (room.players.some((p) => p.name.toLowerCase() === playerName.toLowerCase())) {
          return sendTo(ws, { type: "error", message: "Pseudo pris." });
        }

        room.players.push({ name: playerName, score: 0 });
        touchRoom(room);

        info.name = playerName;
        info.roomCode = code;

        sendTo(ws, {
          type: "room_joined",
          roomCode: code,
          host: room.host,
          players: room.players,
          topic: room.topic,
          questionCount: room.questionCount,
        });

        sendAll(code, {
          type: "player_joined",
          host: room.host,
          players: room.players,
          newPlayer: playerName,
        }, ws);
      }

      else if (m.type === "start_game") {
        const room = rooms.get(info.roomCode);
        if (!room || room.host !== info.name || room.state !== "lobby") return;

        room.state = "generating";
        room.currentQ = 0;
        room.answersThisRound = {};
        touchRoom(room);

        sendAll(info.roomCode, { type: "generating" });

        const qs = await generateQuestions(room.topic, room.questionCount);

        room.questions = Array.isArray(qs) ? qs : demoQs(room.topic, room.questionCount);
        room.state = "playing";
        room.currentQ = 0;
        room.answersThisRound = {};
        touchRoom(room);

        sendAll(info.roomCode, {
          type: "game_start",
          questions: room.questions.map((q) => ({
            question: q.question,
            options: q.options,
          })),
          totalQuestions: room.questions.length,
          questionIndex: 0,
        });
      }

      else if (m.type === "submit_answer") {
        const room = rooms.get(info.roomCode);
        if (!room || room.state !== "playing") return;
        if (!info.name) return;

        const questionIndex = Number(m.questionIndex);
        const answerIndex = sanitizeAnswerIndex(m.answerIndex);
        const timeLeft = sanitizeTimeLeft(m.timeLeft);

        if (!Number.isInteger(questionIndex)) return;
        if (questionIndex !== room.currentQ) return;
        if (answerIndex === null) return;

        const q = room.questions[questionIndex];
        if (!q) return;

        room.answersThisRound ||= {};
        if (room.answersThisRound[info.name]) return;

        room.answersThisRound[info.name] = true;

        const isTimeout = answerIndex === -1;
        const correct = !isTimeout && answerIndex === q.correct;
        const pts = correct ? 1000 + Math.round((timeLeft / 15) * 500) : 0;

        const player = findPlayer(room, info.name);
        if (!player) return;

        player.score += pts;
        touchRoom(room);

        sendTo(ws, {
          type: "answer_result",
          questionIndex,
          correct,
          correctAnswer: q.correct,
          explanation: q.explanation,
          points: pts,
          totalScore: player.score,
        });

        const answerStatus = {};
        for (const name of Object.keys(room.answersThisRound)) {
          const currentPlayer = findPlayer(room, name);
          if (currentPlayer) {
            answerStatus[name] = { answered: true };
          }
        }

        sendAll(info.roomCode, {
          type: "live_answers",
          answerStatus,
          answeredCount: Object.keys(room.answersThisRound).length,
          totalPlayers: room.players.length,
        });

        sendAll(info.roomCode, {
          type: "score_update",
          scores: getScores(room),
        });
      }

      else if (m.type === "next_question") {
        const room = rooms.get(info.roomCode);
        if (!room || room.host !== info.name || room.state !== "playing") return;

        room.currentQ++;
        room.answersThisRound = {};
        touchRoom(room);

        if (room.currentQ >= room.questions.length) {
          room.state = "results";
          touchRoom(room);

          sendAll(info.roomCode, {
            type: "final_results",
            leaderboard: getLeaderboard(room),
          });
        } else {
          sendAll(info.roomCode, {
            type: "next_question",
            questionIndex: room.currentQ,
          });
        }
      }

      else if (m.type === "leave") {
        doLeave(ws);
        try { ws.close(); } catch {}
      }

      else {
        sendTo(ws, { type: "error", message: "Type de message inconnu." });
      }
    } catch (err) {
      console.error("Erreur WS:", err);
      sendTo(ws, { type: "error", message: "Erreur serveur." });
    }
  });

  ws.on("close", () => doLeave(ws));

  ws.on("error", (err) => {
    console.error("Erreur WebSocket:", err.message);
  });
});

// ─────────────────────────────────────
// Heartbeat
// ─────────────────────────────────────
const heartbeatInterval = setInterval(() => {
  for (const [ws, info] of clients.entries()) {
    if (!info) continue;

    if (info.isAlive === false) {
      try { ws.terminate(); } catch {}
      clients.delete(ws);
      continue;
    }

    info.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

// ─────────────────────────────────────
// Cleanup
// ─────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.updated > 60 * 60 * 1000) {
      rooms.delete(code);
      console.log(`🧹 Salle ${code} nettoyée`);
    }
  }
}, 30 * 60 * 1000);

// ─────────────────────────────────────
// HTTP
// ─────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    clients: clients.size,
    uptime: process.uptime(),
  });
});

app.get("/api/room/:code", (req, res) => {
  const code = typeof req.params.code === "string" ? req.params.code.toUpperCase() : "";
  const room = rooms.get(code);

  if (!room) {
    return res.status(404).json({ error: "Salle introuvable" });
  }

  return res.json({
    code: room.code,
    topic: room.topic,
    playerCount: room.players.length,
    host: room.host,
    state: room.state,
    questionCount: room.questionCount,
  });
});

server.listen(PORT, () => {
  console.log(`🧠 QUIZIMED port ${PORT} | API: ${API_KEY ? "✅" : "⚠️ démo"}`);
});
