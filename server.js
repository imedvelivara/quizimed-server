// ═══════════════════════════════════════════════════
// QUIZIMED SERVER - Multijoueur en temps réel
// Version corrigée
// ═══════════════════════════════════════════════════
//
// Lancement :
//   1. npm install express ws
//   2. node server.js
//
// Variables d'environnement :
//   PORT
//   OPENROUTER_API_KEY
//
// Recommandé : Node.js 18+
// ═══════════════════════════════════════════════════

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT) || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

const rooms = new Map();    // roomCode -> room
const clients = new Map();  // ws -> { name, roomCode, isAlive }

// ───────────────────────────────────────────────────
// Utils
// ───────────────────────────────────────────────────

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

function sanitizeAnswerIndex(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return -1;
  return n;
}

function sanitizeTimeLeft(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(15, n));
}

function generateRoomCode() {
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

function createRoom(hostName, topic, questionCount) {
  const code = generateRoomCode();

  const room = {
    code,
    host: hostName,
    topic,
    questionCount,
    players: [
      {
        name: hostName,
        score: 0,
        finished: false,
      },
    ],
    questions: [],
    state: "lobby", // lobby | generating | playing | results
    currentQuestion: 0,
    answersThisRound: {}, // { playerName: { answerIndex, timeLeft, correct, points } }
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  rooms.set(code, room);
  return room;
}

function touchRoom(room) {
  room.updatedAt = Date.now();
}

function sendTo(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    console.error("Erreur sendTo:", err.message);
  }
}

function broadcastToRoom(roomCode, message, excludeWs = null) {
  const payload = JSON.stringify(message);

  for (const [ws, info] of clients.entries()) {
    if (info.roomCode !== roomCode) continue;
    if (excludeWs && ws === excludeWs) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;

    try {
      ws.send(payload);
    } catch (err) {
      console.error("Erreur broadcastToRoom:", err.message);
    }
  }
}

function findPlayer(room, playerName) {
  return room.players.find((p) => p.name === playerName);
}

function getPublicPlayers(room) {
  return room.players.map((p) => ({
    name: p.name,
    score: p.score,
    finished: p.finished,
  }));
}

function getScoreboard(room) {
  return room.players.map((p) => ({
    name: p.name,
    score: p.score,
  }));
}

function getLeaderboard(room) {
  return [...room.players].sort((a, b) => b.score - a.score);
}

// ───────────────────────────────────────────────────
// AI Questions
// ───────────────────────────────────────────────────

function validateQuestions(rawQuestions, expectedCount) {
  if (!Array.isArray(rawQuestions)) return null;

  const cleaned = [];

  for (const item of rawQuestions) {
    if (!item || typeof item !== "object") continue;

    const question =
      typeof item.question === "string" ? item.question.trim() : "";
    const explanation =
      typeof item.explanation === "string" ? item.explanation.trim() : "";
    const options = Array.isArray(item.options)
      ? item.options.map((opt) => (typeof opt === "string" ? opt.trim() : ""))
      : [];
    const correct = Number(item.correct);

    if (!question) continue;
    if (!Array.isArray(options) || options.length !== 4) continue;
    if (options.some((opt) => !opt)) continue;
    if (!Number.isInteger(correct) || correct < 0 || correct > 3) continue;

    cleaned.push({
      question,
      options,
      correct,
      explanation: explanation || "Pas d'explication disponible.",
    });
  }

  if (cleaned.length === 0) return null;

  return cleaned.slice(0, expectedCount);
}

async function generateQuestions(topic, count) {
  console.log(`🔑 OPENROUTER_API_KEY présente: ${OPENROUTER_API_KEY ? "OUI" : "NON"}`);

  if (!OPENROUTER_API_KEY) {
    console.log("⚠️ Pas de clé OPENROUTER_API_KEY, utilisation de questions de démonstration");
    return generateDemoQuestions(topic, count);
  }

  const prompt = `Tu es un créateur de quiz expert.
Génère exactement ${count} questions de quiz à choix multiples sur le sujet "${topic}".

Réponds UNIQUEMENT avec un tableau JSON valide.
Aucun texte avant.
Aucun texte après.
Aucun markdown.

Format exact attendu :
[
  {
    "question": "La question ici ?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 0,
    "explanation": "Courte explication de la bonne réponse"
  }
]

Contraintes :
- Français
- Exactement 4 options par question
- "correct" est un index de 0 à 3
- Mauvaises réponses plausibles
- Questions variées
- Pas de doublons`;

  const models = [
    "openrouter/free",
    "qwen/qwen3-coder:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "stepfun/step-3.5-flash:free",
  ];

  for (const model of models) {
    try {
      console.log(`🤖 Essai avec ${model}...`);

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7,
          max_tokens: 4000,
        }),
      });

      const data = await response.json().catch(() => null);

      console.log(`📨 Réponse ${model} status:`, response.status);

      if (!response.ok) {
        console.error(`⚠️ ${model} échoué:`, data?.error?.message || JSON.stringify(data));
        continue;
      }

      const text = data?.choices?.[0]?.message?.content || "";
      if (!text) {
        console.error(`⚠️ ${model} a renvoyé une réponse vide`);
        continue;
      }

      const clean = text.replace(/```json|```/gi, "").trim();
      let parsed;

      try {
        parsed = JSON.parse(clean);
      } catch (err) {
        console.error(`⚠️ ${model} JSON invalide:`, err.message);
        continue;
      }

      const validated = validateQuestions(parsed, count);
      if (!validated || validated.length === 0) {
        console.error(`⚠️ ${model} a renvoyé un format de questions invalide`);
        continue;
      }

      if (validated.length < count) {
        console.warn(`⚠️ ${model} n'a renvoyé que ${validated.length}/${count} questions valides`);
      }

      return validated;
    } catch (err) {
      console.error(`⚠️ ${model} erreur:`, err.message);
    }
  }

  console.error("❌ Tous les modèles ont échoué");
  return generateDemoQuestions(topic, count);
}

function generateDemoQuestions(topic, count) {
  const questions = [];

  for (let i = 0; i < count; i++) {
    questions.push({
      question: `Question ${i + 1} sur "${topic}" (démo)`,
      options: ["Réponse A", "Réponse B", "Réponse C", "Réponse D"],
      correct: Math.floor(Math.random() * 4),
      explanation: "Ceci est une question de démonstration.",
    });
  }

  return questions;
}

// ───────────────────────────────────────────────────
// Room lifecycle
// ───────────────────────────────────────────────────

function promoteNewHostIfNeeded(roomCode, oldHostName) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.host !== oldHostName) return;
  if (room.players.length === 0) return;

  room.host = room.players[0].name;
  touchRoom(room);

  broadcastToRoom(roomCode, {
    type: "host_changed",
    host: room.host,
    players: getPublicPlayers(room),
  });

  console.log(`👑 Nouvel host dans ${roomCode}: ${room.host}`);
}

function handleDisconnect(ws) {
  const info = clients.get(ws);
  if (!info) return;

  const { name, roomCode } = info;

  if (roomCode) {
    const room = rooms.get(roomCode);

    if (room) {
      room.players = room.players.filter((p) => p.name !== name);
      delete room.answersThisRound[name];
      touchRoom(room);

      if (room.players.length === 0) {
        rooms.delete(roomCode);
        console.log(`🗑️ Salle ${roomCode} supprimée (vide)`);
      } else {
        const wasHost = room.host === name;

        if (wasHost) {
          promoteNewHostIfNeeded(roomCode, name);
        }

        broadcastToRoom(roomCode, {
          type: "player_left",
          leftPlayer: name,
          players: getPublicPlayers(room),
          host: room.host,
        });
      }
    }
  }

  clients.delete(ws);
}

// ───────────────────────────────────────────────────
// WebSocket
// ───────────────────────────────────────────────────

wss.on("connection", (ws) => {
  clients.set(ws, {
    name: null,
    roomCode: null,
    isAlive: true,
  });

  ws.on("pong", () => {
    const info = clients.get(ws);
    if (info) info.isAlive = true;
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendTo(ws, { type: "error", message: "Message JSON invalide." });
    }

    const info = clients.get(ws);
    if (!info) return;

    try {
      switch (msg.type) {
        // ───────────────── CREATE ROOM ─────────────────
        case "create_room": {
          const playerName = sanitizePlayerName(msg.playerName);
          const topic = sanitizeTopic(msg.topic);
          const questionCount = sanitizeQuestionCount(msg.questionCount);

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
            players: getPublicPlayers(room),
            topic: room.topic,
            host: room.host,
            questionCount: room.questionCount,
          });

          console.log(`🏠 Salle ${room.code} créée par ${playerName} (${topic}, ${room.questionCount}q)`);
          break;
        }

        // ───────────────── JOIN ROOM ─────────────────
        case "join_room": {
          const playerName = sanitizePlayerName(msg.playerName);
          const roomCode = typeof msg.roomCode === "string" ? msg.roomCode.trim().toUpperCase() : "";
          const room = rooms.get(roomCode);

          if (!playerName) {
            return sendTo(ws, { type: "error", message: "Pseudo invalide." });
          }

          if (!room) {
            return sendTo(ws, { type: "error", message: "Salle introuvable. Vérifie le code." });
          }

          if (room.state !== "lobby") {
            return sendTo(ws, { type: "error", message: "La partie a déjà commencé." });
          }

          if (room.players.some((p) => p.name.toLowerCase() === playerName.toLowerCase())) {
            return sendTo(ws, { type: "error", message: "Ce pseudo est déjà pris dans cette salle." });
          }

          room.players.push({
            name: playerName,
            score: 0,
            finished: false,
          });
          touchRoom(room);

          info.name = playerName;
          info.roomCode = roomCode;

          sendTo(ws, {
            type: "room_joined",
            roomCode,
            players: getPublicPlayers(room),
            topic: room.topic,
            host: room.host,
            questionCount: room.questionCount,
          });

          broadcastToRoom(
            roomCode,
            {
              type: "player_joined",
              newPlayer: playerName,
              players: getPublicPlayers(room),
              host: room.host,
            },
            ws
          );

          console.log(`👤 ${playerName} a rejoint ${roomCode} (${room.players.length} joueurs)`);
          break;
        }

        // ───────────────── START GAME ─────────────────
        case "start_game": {
          const room = rooms.get(info.roomCode);

          if (!room) return;
          if (room.host !== info.name) return;
          if (room.state !== "lobby") return;

          room.state = "generating";
          room.currentQuestion = 0;
          room.answersThisRound = {};
          touchRoom(room);

          broadcastToRoom(info.roomCode, { type: "generating" });

          console.log(`🧠 Génération des questions pour ${info.roomCode}...`);

          const questions = await generateQuestions(room.topic, room.questionCount);

          room.questions = Array.isArray(questions) ? questions : generateDemoQuestions(room.topic, room.questionCount);
          room.state = "playing";
          room.currentQuestion = 0;
          room.answersThisRound = {};
          touchRoom(room);

          const safeQuestions = room.questions.map((q) => ({
            question: q.question,
            options: q.options,
          }));

          broadcastToRoom(info.roomCode, {
            type: "game_start",
            questions: safeQuestions,
            totalQuestions: safeQuestions.length,
            questionIndex: 0,
          });

          console.log(`🎮 Partie lancée dans ${info.roomCode} (${safeQuestions.length} questions)`);
          break;
        }

        // ───────────────── SUBMIT ANSWER ─────────────────
        case "submit_answer": {
          const room = rooms.get(info.roomCode);

          if (!room) return;
          if (room.state !== "playing") return;
          if (!info.name) return;

          const questionIndex = Number(msg.questionIndex);
          const answerIndex = sanitizeAnswerIndex(msg.answerIndex);
          const timeLeft = sanitizeTimeLeft(msg.timeLeft);

          if (!Number.isInteger(questionIndex)) return;
          if (questionIndex !== room.currentQuestion) return;
          if (answerIndex < 0 || answerIndex > 3) return;

          const q = room.questions[questionIndex];
          if (!q) return;

          if (room.answersThisRound[info.name]) return;

          const correct = answerIndex === q.correct;
          const timeBonus = Math.round((timeLeft / 15) * 500);
          const points = correct ? 1000 + timeBonus : 0;

          const player = findPlayer(room, info.name);
          if (!player) return;

          player.score += points;
          touchRoom(room);

          room.answersThisRound[info.name] = {
            answerIndex,
            timeLeft,
            correct,
            points,
          };

          sendTo(ws, {
            type: "answer_result",
            questionIndex,
            correct,
            correctAnswer: q.correct,
            explanation: q.explanation,
            points,
            totalScore: player.score,
          });

          const answerStatus = {};
          for (const [name, ans] of Object.entries(room.answersThisRound)) {
            answerStatus[name] = {
              answered: true,
              correct: ans.correct,
            };
          }

          broadcastToRoom(info.roomCode, {
            type: "live_answers",
            answerStatus,
            totalPlayers: room.players.length,
            answeredCount: Object.keys(room.answersThisRound).length,
          });

          broadcastToRoom(info.roomCode, {
            type: "score_update",
            scores: getScoreboard(room),
          });

          break;
        }

        // ───────────────── NEXT QUESTION ─────────────────
        case "next_question": {
          const room = rooms.get(info.roomCode);

          if (!room) return;
          if (room.host !== info.name) return;
          if (room.state !== "playing") return;

          room.currentQuestion += 1;
          room.answersThisRound = {};
          touchRoom(room);

          if (room.currentQuestion >= room.questions.length) {
            room.state = "results";
            touchRoom(room);

            broadcastToRoom(info.roomCode, {
              type: "final_results",
              leaderboard: getLeaderboard(room),
            });

            console.log(`🏆 Partie terminée dans ${info.roomCode}`);
          } else {
            broadcastToRoom(info.roomCode, {
              type: "next_question",
              questionIndex: room.currentQuestion,
            });

            console.log(`➡️ Question ${room.currentQuestion + 1} dans ${info.roomCode}`);
          }

          break;
        }

        // ───────────────── PLAYER FINISHED ─────────────────
        case "player_finished": {
          const room = rooms.get(info.roomCode);
          if (!room) return;

          const player = findPlayer(room, info.name);
          if (!player) return;

          player.finished = true;
          touchRoom(room);

          if (room.players.length === 1) {
            room.state = "results";
            touchRoom(room);

            sendTo(ws, {
              type: "final_results",
              leaderboard: getLeaderboard(room),
            });
          }

          break;
        }

        // ───────────────── LEAVE ─────────────────
        case "leave": {
          handleDisconnect(ws);
          try {
            ws.close();
          } catch (_) {}
          break;
        }

        default: {
          sendTo(ws, { type: "error", message: "Type de message inconnu." });
          break;
        }
      }
    } catch (err) {
      console.error("Erreur traitement message WS:", err);
      sendTo(ws, { type: "error", message: "Erreur serveur." });
    }
  });

  ws.on("close", () => {
    handleDisconnect(ws);
  });

  ws.on("error", (err) => {
    console.error("Erreur WebSocket:", err.message);
  });
});

// ───────────────────────────────────────────────────
// Heartbeat WS
// ───────────────────────────────────────────────────

const heartbeatInterval = setInterval(() => {
  for (const [ws, info] of clients.entries()) {
    if (info.isAlive === false) {
      try {
        ws.terminate();
      } catch (_) {}
      handleDisconnect(ws);
      continue;
    }

    info.isAlive = false;

    try {
      ws.ping();
    } catch (_) {}
  }
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

// ───────────────────────────────────────────────────
// Cleanup old rooms
// ───────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms.entries()) {
    const inactiveTooLong = now - room.updatedAt > 60 * 60 * 1000;
    if (inactiveTooLong) {
      rooms.delete(code);
      console.log(`🧹 Salle ${code} nettoyée (inactive/expirée)`);
    }
  }
}, 30 * 60 * 1000);

// ───────────────────────────────────────────────────
// HTTP
// ───────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "public")));

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
    state: room.state,
    host: room.host,
    questionCount: room.questionCount,
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    clients: clients.size,
    uptime: process.uptime(),
  });
});

// ───────────────────────────────────────────────────
// Start
// ───────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║         🧠 QUIZIMED SERVER 🧠         ║
╠═══════════════════════════════════════╣
║                                       ║
║  Serveur lancé sur le port ${String(PORT).padEnd(5)}      ║
║  http://localhost:${String(PORT).padEnd(5)}               ║
║                                       ║
${OPENROUTER_API_KEY
  ? "║  ✅ Clé API OpenRouter configurée      ║"
  : "║  ⚠️  Pas de clé API → mode démo        ║"}
║                                       ║
╚═══════════════════════════════════════╝
  `);
});
