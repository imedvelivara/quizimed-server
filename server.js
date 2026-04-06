const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY || "";

const rooms = new Map();
const clients = new Map();

function genCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let r = "";
  for (let i = 0; i < 6; i++) r += c[Math.floor(Math.random() * c.length)];
  return rooms.has(r) ? genCode() : r;
}

function createRoom(host, topic, count) {
  const code = genCode();
  const room = { code, host, topic, questionCount: count, players: [{ name: host, score: 0 }], questions: [], state: "lobby", currentQ: 0, created: Date.now() };
  rooms.set(code, room);
  return room;
}

// ─── AI ───
async function generateQuestions(topic, count) {
  if (!API_KEY) return demoQs(topic, count);
  const prompt = `Tu es un créateur de quiz expert et très rigoureux. Génère exactement ${count} questions de quiz à choix multiples sur le sujet: "${topic}".

RÈGLES CRITIQUES:
1. Chaque réponse correcte DOIT être véritablement correcte et vérifiable
2. Ne JAMAIS inventer de fausses informations
3. Si tu n'es pas sûr d'un fait, choisis une autre question
4. Les 3 mauvaises réponses doivent être plausibles mais clairement incorrectes
5. Varie les difficultés
6. Questions en français

Réponds UNIQUEMENT avec un tableau JSON, sans texte ni backticks:
[{"question":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."}]
correct = index 0-3 de la bonne réponse.`;

  const models = ["openrouter/free","qwen/qwen3-coder:free","nvidia/nemotron-3-super-120b-a12b:free","meta-llama/llama-3.3-70b-instruct:free","stepfun/step-3.5-flash:free"];
  for (const model of models) {
    try {
      console.log(`🤖 ${model}...`);
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.7, max_tokens: 8000 }),
      });
      if (!res.ok) { console.log(`⚠️ ${model}: ${res.status}`); continue; }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (!Array.isArray(parsed) || !parsed.length) continue;
      if (!parsed.every(q => q.question && Array.isArray(q.options) && q.options.length === 4 && typeof q.correct === "number" && q.correct >= 0 && q.correct <= 3)) continue;
      console.log(`✅ ${parsed.length}q`);
      return parsed;
    } catch (e) { console.log(`⚠️ ${model}: ${e.message}`); }
  }
  return demoQs(topic, count);
}

function demoQs(topic, n) {
  return Array.from({ length: n }, (_, i) => ({ question: `Question démo ${i + 1} sur "${topic}"`, options: ["A", "B", "C", "D"], correct: 0, explanation: "Démo" }));
}

function sendTo(ws, m) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); }
function sendAll(code, m) { const d = JSON.stringify(m); for (const [ws, i] of clients.entries()) if (i.roomCode === code && ws.readyState === WebSocket.OPEN) ws.send(d); }

wss.on("connection", ws => {
  clients.set(ws, { name: null, roomCode: null });

  ws.on("message", async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const info = clients.get(ws);

    if (m.type === "create_room") {
      if (!m.playerName || !m.topic) return;
      const room = createRoom(m.playerName, m.topic, m.questionCount || 10);
      info.name = m.playerName; info.roomCode = room.code;
      sendTo(ws, { type: "room_created", roomCode: room.code, host: room.host, players: room.players, topic: room.topic, questionCount: room.questionCount });
    }

    else if (m.type === "join_room") {
      const code = m.roomCode?.toUpperCase();
      const room = rooms.get(code);
      if (!room) return sendTo(ws, { type: "error", message: "Salle introuvable." });
      if (room.state !== "lobby") return sendTo(ws, { type: "error", message: "Partie déjà lancée." });
      if (room.players.find(p => p.name === m.playerName)) return sendTo(ws, { type: "error", message: "Pseudo pris." });
      room.players.push({ name: m.playerName, score: 0 });
      info.name = m.playerName; info.roomCode = code;
      sendTo(ws, { type: "room_joined", roomCode: code, host: room.host, players: room.players, topic: room.topic, questionCount: room.questionCount });
      sendAll(code, { type: "player_update", host: room.host, players: room.players });
    }

    else if (m.type === "start_game") {
      const room = rooms.get(info.roomCode);
      if (!room || room.host !== info.name) return;
      room.state = "generating";
      sendAll(info.roomCode, { type: "generating" });
      const qs = await generateQuestions(room.topic, room.questionCount);
      room.questions = qs; room.state = "playing"; room.currentQ = 0;
      sendAll(info.roomCode, { type: "game_start", questions: qs.map(q => ({ question: q.question, options: q.options })) });
    }

    else if (m.type === "submit_answer") {
      const room = rooms.get(info.roomCode);
      if (!room || room.state !== "playing") return;
      const q = room.questions[m.questionIndex];
      if (!q) return;
      const correct = m.answerIndex >= 0 && m.answerIndex === q.correct;
      const pts = correct ? 1000 + Math.round(((m.timeLeft || 0) / 15) * 500) : 0;
      const p = room.players.find(p => p.name === info.name);
      if (p) p.score += pts;
      sendTo(ws, { type: "answer_result", questionIndex: m.questionIndex, correct, correctAnswer: q.correct, explanation: q.explanation, points: pts, totalScore: p?.score || 0 });
      sendAll(info.roomCode, { type: "score_update", scores: room.players.map(p => ({ name: p.name, score: p.score })) });
    }

    else if (m.type === "next_question") {
      const room = rooms.get(info.roomCode);
      if (!room || room.host !== info.name) return;
      room.currentQ++;
      if (room.currentQ >= room.questions.length) {
        room.state = "results";
        sendAll(info.roomCode, { type: "final_results", leaderboard: [...room.players].sort((a, b) => b.score - a.score) });
      } else {
        sendAll(info.roomCode, { type: "next_question", questionIndex: room.currentQ });
      }
    }

    else if (m.type === "leave") {
      doLeave(ws);
    }
  });

  ws.on("close", () => doLeave(ws));
});

function doLeave(ws) {
  const info = clients.get(ws);
  if (!info?.roomCode) { clients.delete(ws); return; }
  const room = rooms.get(info.roomCode);
  if (room) {
    room.players = room.players.filter(p => p.name !== info.name);
    if (room.players.length === 0) {
      rooms.delete(info.roomCode);
    } else {
      // Reassign host if needed
      if (room.host === info.name) {
        room.host = room.players[0].name;
      }
      sendAll(info.roomCode, { type: "player_update", host: room.host, players: room.players });
    }
  }
  info.roomCode = null;
  info.name = null;
}

setInterval(() => { for (const [c, r] of rooms.entries()) if (Date.now() - r.created > 3600000) rooms.delete(c); }, 1800000);
app.use(express.static(path.join(__dirname, "public")));
server.listen(PORT, () => console.log(`🧠 QUIZIMED port ${PORT} | API: ${API_KEY ? "✅" : "⚠️ démo"}`));
