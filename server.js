// ═══════════════════════════════════════════════════
// QUIZIMED SERVER - Multijoueur en temps réel
// ═══════════════════════════════════════════════════
// 
// Pour lancer :
//   1. npm install
//   2. npm start
//   3. Ouvrir http://localhost:3000
//
// Pour déployer (gratuit) :
//   - Railway.app : connecte ton repo GitHub, déploie en 1 clic
//   - Render.com  : pareil, gratuit pour les petits projets
//   - Fly.io      : `fly launch` puis `fly deploy`
//
// Variables d'environnement :
//   PORT           - Port du serveur (défaut: 3000)
//   OPENROUTER_API_KEY - Clé API OpenRouter (GRATUIT sur openrouter.ai)
//
// ═══════════════════════════════════════════════════

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

// ─── In-memory storage ───
const rooms = new Map();    // roomCode -> Room
const clients = new Map();  // ws -> ClientInfo

// ─── Room structure ───
function createRoom(hostName, topic, questionCount) {
  const code = generateRoomCode();
  const room = {
    code,
    host: hostName,
    topic,
    questionCount,
    players: [{ name: hostName, score: 0, finished: false }],
    questions: [],
    state: "lobby", // lobby | generating | playing | results
    currentQuestion: 0,
    answersThisRound: {}, // { playerName: { answerIndex, timeLeft, correct, points } }
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  // Ensure unique
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

// ─── AI Question Generation (OpenRouter - modèles gratuits) ───
async function generateQuestions(topic, count) {
  console.log(`🔑 OPENROUTER_API_KEY présente: ${OPENROUTER_API_KEY ? "OUI" : "NON"}`);
  
  if (!OPENROUTER_API_KEY) {
    console.log("⚠️  Pas de clé OPENROUTER_API_KEY - utilisation de questions de démonstration");
    return generateDemoQuestions(topic, count);
  }

  const prompt = `Tu es un créateur de quiz expert. Génère exactement ${count} questions de quiz à choix multiples sur le sujet: "${topic}".

IMPORTANT: Réponds UNIQUEMENT avec un tableau JSON valide, sans aucun texte avant ou après, sans backticks markdown.

Chaque question doit avoir ce format exact:
[
  {
    "question": "La question ici ?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 0,
    "explanation": "Courte explication de la bonne réponse"
  }
]

Le champ "correct" est l'index (0-3) de la bonne réponse.
Questions variées en difficulté. Mauvaises réponses plausibles.
Exactement 4 options par question. Les questions doivent être en français.`;

  // Modèles gratuits sur OpenRouter (essayés dans l'ordre)
  const models = [
    "openrouter/free",
    "qwen/qwen3-coder:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "stepfun/step-3.5-flash:free"
  ];

  for (const model of models) {
    try {
      console.log(`🤖 Essai avec ${model}...`);
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.8,
          max_tokens: 8000,
        }),
      });

      const data = await response.json();
      console.log(`📨 Réponse ${model} status:`, response.status);

      if (!response.ok) {
        console.error(`⚠️ ${model} échoué:`, data.error?.message || JSON.stringify(data));
        continue;
      }

      const text = data.choices?.[0]?.message?.content || "";
      console.log("✅ Réponse reçue, longueur:", text.length);
      const clean = text.replace(/```json|```/g, "").trim();
      return JSON.parse(clean);
    } catch (err) {
      console.error(`⚠️ ${model} erreur:`, err.message);
      continue;
    }
  }

  console.error("❌ Tous les modèles ont échoué");
  return generateDemoQuestions(topic, count);
}

function generateDemoQuestions(topic, count) {
  const questions = [];
  for (let i = 0; i < count; i++) {
    questions.push({
      question: `Question ${i + 1} sur "${topic}" (démo - ajoutez OPENROUTER_API_KEY pour de vraies questions)`,
      options: ["Réponse A", "Réponse B", "Réponse C", "Réponse D"],
      correct: Math.floor(Math.random() * 4),
      explanation: "Ceci est une question de démonstration.",
    });
  }
  return questions;
}

// ─── Broadcast to room ───
function broadcastToRoom(roomCode, message, excludeWs = null) {
  const msg = JSON.stringify(message);
  for (const [ws, info] of clients.entries()) {
    if (info.roomCode === roomCode && ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function sendTo(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// ─── WebSocket Handler ───
wss.on("connection", (ws) => {
  clients.set(ws, { name: null, roomCode: null });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const info = clients.get(ws);

    switch (msg.type) {
      // ─── CREATE ROOM ───
      case "create_room": {
        const { playerName, topic, questionCount } = msg;
        if (!playerName || !topic) return;

        const room = createRoom(playerName, topic, questionCount || 10);
        info.name = playerName;
        info.roomCode = room.code;

        sendTo(ws, {
          type: "room_created",
          roomCode: room.code,
          players: room.players,
          topic: room.topic,
        });

        console.log(`🏠 Salle ${room.code} créée par ${playerName} (${topic}, ${room.questionCount}q)`);
        break;
      }

      // ─── JOIN ROOM ───
      case "join_room": {
        const { playerName, roomCode } = msg;
        const code = roomCode?.toUpperCase();
        const room = rooms.get(code);

        if (!room) {
          sendTo(ws, { type: "error", message: "Salle introuvable. Vérifie le code." });
          return;
        }
        if (room.state !== "lobby") {
          sendTo(ws, { type: "error", message: "La partie a déjà commencé." });
          return;
        }
        if (room.players.find((p) => p.name === playerName)) {
          sendTo(ws, { type: "error", message: "Ce pseudo est déjà pris dans cette salle." });
          return;
        }

        room.players.push({ name: playerName, score: 0, finished: false });
        info.name = playerName;
        info.roomCode = code;

        sendTo(ws, {
          type: "room_joined",
          roomCode: code,
          players: room.players,
          topic: room.topic,
          host: room.host,
        });

        broadcastToRoom(code, {
          type: "player_joined",
          players: room.players,
          newPlayer: playerName,
        }, ws);

        console.log(`👤 ${playerName} a rejoint ${code} (${room.players.length} joueurs)`);
        break;
      }

      // ─── START GAME ───
      case "start_game": {
        const room = rooms.get(info.roomCode);
        if (!room || room.host !== info.name) return;

        room.state = "generating";
        broadcastToRoom(info.roomCode, { type: "generating" });

        console.log(`🧠 Génération des questions pour ${info.roomCode}...`);
        const questions = await generateQuestions(room.topic, room.questionCount);
        room.questions = questions;
        room.state = "playing";
        room.currentQuestion = 0;
        room.answersThisRound = {};

        // Send questions WITHOUT correct answers to players
        const safeQuestions = questions.map((q) => ({
          question: q.question,
          options: q.options,
        }));

        broadcastToRoom(info.roomCode, {
          type: "game_start",
          questions: safeQuestions,
          totalQuestions: questions.length,
        });

        // Also send to host
        sendTo(ws, {
          type: "game_start",
          questions: safeQuestions,
          totalQuestions: questions.length,
        });

        console.log(`🎮 Partie lancée dans ${info.roomCode} (${questions.length} questions)`);
        break;
      }

      // ─── SUBMIT ANSWER ───
      case "submit_answer": {
        const { questionIndex, answerIndex, timeLeft } = msg;
        const room = rooms.get(info.roomCode);
        if (!room || room.state !== "playing") return;

        const q = room.questions[questionIndex];
        if (!q) return;
        
        // Prevent double answers
        if (room.answersThisRound[info.name]) return;

        const correct = answerIndex === q.correct;
        const timeBonus = Math.round((timeLeft / 15) * 500);
        const points = correct ? 1000 + timeBonus : 0;

        const player = room.players.find((p) => p.name === info.name);
        if (player) player.score += points;
        
        // Store answer for this round
        room.answersThisRound[info.name] = { answerIndex, timeLeft, correct, points };

        // Send result to the player who answered
        sendTo(ws, {
          type: "answer_result",
          questionIndex,
          correct,
          correctAnswer: q.correct,
          explanation: q.explanation,
          points,
          totalScore: player?.score || 0,
        });

        // Broadcast live answer status to everyone (who answered, correct or not)
        const answerStatus = {};
        for (const [name, ans] of Object.entries(room.answersThisRound)) {
          answerStatus[name] = { answered: true, correct: ans.correct };
        }
        
        broadcastToRoom(info.roomCode, {
          type: "live_answers",
          answerStatus,
          totalPlayers: room.players.length,
          answeredCount: Object.keys(room.answersThisRound).length,
        });
        // Also send to answerer
        sendTo(ws, {
          type: "live_answers",
          answerStatus,
          totalPlayers: room.players.length,
          answeredCount: Object.keys(room.answersThisRound).length,
        });

        // Broadcast updated scores
        const scores = room.players.map((p) => ({ name: p.name, score: p.score }));
        broadcastToRoom(info.roomCode, { type: "score_update", scores });
        sendTo(ws, { type: "score_update", scores });

        break;
      }

      // ─── NEXT QUESTION (host only) ───
      case "next_question": {
        const room = rooms.get(info.roomCode);
        if (!room || room.host !== info.name || room.state !== "playing") return;
        
        room.currentQuestion++;
        room.answersThisRound = {}; // Reset answers for new round
        
        if (room.currentQuestion >= room.questions.length) {
          // Game over
          room.state = "results";
          const leaderboard = [...room.players].sort((a, b) => b.score - a.score);
          broadcastToRoom(info.roomCode, { type: "final_results", leaderboard });
          sendTo(ws, { type: "final_results", leaderboard });
          console.log(`🏆 Partie terminée dans ${info.roomCode}`);
        } else {
          // Send next question to everyone
          broadcastToRoom(info.roomCode, { 
            type: "next_question", 
            questionIndex: room.currentQuestion 
          });
          sendTo(ws, { 
            type: "next_question", 
            questionIndex: room.currentQuestion 
          });
          console.log(`➡️ Question ${room.currentQuestion + 1} dans ${info.roomCode}`);
        }
        break;
      }

      // ─── PLAYER FINISHED (solo mode) ───
      case "player_finished": {
        const room = rooms.get(info.roomCode);
        if (!room) return;

        const player = room.players.find((p) => p.name === info.name);
        if (player) player.finished = true;

        // In solo mode, finish immediately
        if (room.players.length === 1) {
          room.state = "results";
          const leaderboard = [...room.players].sort((a, b) => b.score - a.score);
          sendTo(ws, { type: "final_results", leaderboard });
        }

        break;
      }

      // ─── LEAVE ───
      case "leave": {
        handleDisconnect(ws);
        break;
      }
    }
  });

  ws.on("close", () => handleDisconnect(ws));
});

function handleDisconnect(ws) {
  const info = clients.get(ws);
  if (info && info.roomCode) {
    const room = rooms.get(info.roomCode);
    if (room) {
      room.players = room.players.filter((p) => p.name !== info.name);
      if (room.players.length === 0) {
        rooms.delete(info.roomCode);
        console.log(`🗑️  Salle ${info.roomCode} supprimée (vide)`);
      } else {
        broadcastToRoom(info.roomCode, {
          type: "player_left",
          players: room.players,
          leftPlayer: info.name,
        });
      }
    }
  }
  clients.delete(ws);
}

// ─── Cleanup old rooms every 30 min ───
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > 3600000) { // 1h
      rooms.delete(code);
      console.log(`🧹 Salle ${code} nettoyée (expirée)`);
    }
  }
}, 1800000);

// ─── Serve static files ───
app.use(express.static(path.join(__dirname, "public")));

// ─── API endpoint for room info ───
app.get("/api/room/:code", (req, res) => {
  const room = rooms.get(req.params.code?.toUpperCase());
  if (!room) return res.status(404).json({ error: "Salle introuvable" });
  res.json({
    code: room.code,
    topic: room.topic,
    playerCount: room.players.length,
    state: room.state,
  });
});

// ─── Start ───
server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║         🧠 QUIZIMED SERVER 🧠         ║
  ╠═══════════════════════════════════════╣
  ║                                       ║
  ║  Serveur lancé sur le port ${String(PORT).padEnd(5)}      ║
  ║  http://localhost:${String(PORT).padEnd(5)}               ║
  ║                                       ║
  ${OPENROUTER_API_KEY ? "║  ✅ Clé API OpenRouter configurée      ║" : "║  ⚠️  Pas de clé API → mode démo        ║"}
  ║                                       ║
  ╚═══════════════════════════════════════╝
  `);
});
