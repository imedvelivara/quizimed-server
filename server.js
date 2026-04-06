const express = require("express");
const http = require("http");
const WebSocket = require("ws");
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
  const room = {
    code,
    host,
    topic,
    questionCount: count,
    players: [{ name: host, score: 0 }],
    questions: [],
    state: "lobby",
    currentQ: 0,
    answersThisRound: {},
    created: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

// ─── Web Search ───
async function searchTopic(topic) {
  try {
    console.log(`🔍 Recherche web: "${topic}"...`);
    const searches = [topic, topic + " discographie", topic + " biographie", topic + " faits"];
    let allText = "";

    for (const q of searches.slice(0, 2)) {
      try {
        const searchUrl = `https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`;
        const res = await fetch(searchUrl);
        if (res.ok) {
          const data = await res.json();
          if (data.extract) allText += data.extract + "\n\n";
        }
      } catch {}

      try {
        const searchApi = `https://fr.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&utf8=1&srlimit=3`;
        const res = await fetch(searchApi);
        if (res.ok) {
          const data = await res.json();
          const titles = data.query?.search?.map(s => s.title) || [];
          for (const title of titles.slice(0, 2)) {
            try {
              const pageRes = await fetch(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
              if (pageRes.ok) {
                const pageData = await pageRes.json();
                if (pageData.extract && !allText.includes(pageData.extract)) {
                  allText += pageData.extract + "\n\n";
                }
              }
            } catch {}
          }
        }
      } catch {}
    }

    try {
      const enRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`);
      if (enRes.ok) {
        const enData = await enRes.json();
        if (enData.extract) allText += "[EN] " + enData.extract + "\n\n";
      }
    } catch {}

    const trimmed = allText.trim().substring(0, 4000);
    console.log(`📚 ${trimmed.length} chars de contexte trouvés`);
    return trimmed;
  } catch (err) {
    console.log(`⚠️ Recherche échouée: ${err.message}`);
    return "";
  }
}

// ─── AI ───
async function generateQuestions(topic, count) {
  if (!API_KEY) return demoQs(topic, count);

  const facts = await searchTopic(topic);

  const contextBlock = facts
    ? `\nVOICI DES INFORMATIONS VÉRIFIÉES SUR LE SUJET (source: Wikipedia):\n---\n${facts}\n---\nBase tes questions PRIORITAIREMENT sur ces informations. Tu peux aussi utiliser tes connaissances si elles sont fiables, mais les infos ci-dessus sont ta source principale.\n`
    : "\nAucune info trouvée en ligne. Base-toi uniquement sur des faits dont tu es ABSOLUMENT certain.\n";

  const prompt = `RÔLE: Tu es un professeur expert qui crée des quiz de culture générale pour un jeu télévisé. Tes questions doivent être IRRÉPROCHABLES en termes d'exactitude.

SUJET: "${topic}"
NOMBRE: Exactement ${count} questions
${contextBlock}
INSTRUCTIONS STRICTES:
- Base-toi sur les FAITS RÉELS fournis ci-dessus
- INTERDICTION d'inventer des chiffres, des dates, des classements ou des records
- Si une information est incertaine, NE PAS l'inclure
- La bonne réponse doit être INDISCUTABLE
- Les 3 mauvaises réponses doivent être du même type que la bonne (si la bonne est un album, les mauvaises sont aussi des albums, etc.)
- Les mauvaises réponses doivent être FAUSSES mais CRÉDIBLES
- Mélange les difficultés: facile, moyen, difficile
- Chaque question doit tester une connaissance DIFFÉRENTE
- Questions et réponses en FRANÇAIS

FORMAT: Réponds UNIQUEMENT avec un tableau JSON valide. Pas de texte avant, pas de texte après, pas de backticks.
[{"question":"La question ?","options":["A","B","C","D"],"correct":0,"explanation":"Explication courte"}]

Le champ "correct" est l'INDEX (0-3) de la bonne réponse. MÉLANGE la position de la bonne réponse !`;

  const models = [
    "openrouter/free",
    "qwen/qwen3-coder:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "stepfun/step-3.5-flash:free"
  ];

  for (const model of models) {
    try {
      console.log(`🤖 ${model}...`);
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.4,
          max_tokens: 8000
        }),
      });

      if (!res.ok) {
        console.log(`⚠️ ${model}: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);

      if (!Array.isArray(parsed) || !parsed.length) continue;
      if (!parsed.every(q =>
        q.question &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        typeof q.correct === "number" &&
        q.correct >= 0 &&
        q.correct <= 3
      )) continue;

      console.log(`✅ ${parsed.length}q`);
      return parsed;
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
    explanation: "Démo"
  }));
}

function sendTo(ws, m) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function sendAll(code, m) {
  const d = JSON.stringify(m);
  for (const [ws, i] of clients.entries()) {
    if (i.roomCode === code && ws.readyState === WebSocket.OPEN) ws.send(d);
  }
}

wss.on("connection", ws => {
  clients.set(ws, { name: null, roomCode: null });

  ws.on("message", async raw => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const info = clients.get(ws);
    if (!info) return;

    if (m.type === "create_room") {
      if (!m.playerName || !m.topic) return;

      const room = createRoom(m.playerName, m.topic, m.questionCount || 10);
      info.name = m.playerName;
      info.roomCode = room.code;

      sendTo(ws, {
        type: "room_created",
        roomCode: room.code,
        host: room.host,
        players: room.players,
        topic: room.topic,
        questionCount: room.questionCount
      });
    }

    else if (m.type === "join_room") {
      const code = m.roomCode?.toUpperCase();
      const room = rooms.get(code);

      if (!room) return sendTo(ws, { type: "error", message: "Salle introuvable." });
      if (room.state !== "lobby") return sendTo(ws, { type: "error", message: "Partie déjà lancée." });
      if (!m.playerName) return sendTo(ws, { type: "error", message: "Pseudo invalide." });
      if (room.players.find(p => p.name === m.playerName)) return sendTo(ws, { type: "error", message: "Pseudo pris." });

      room.players.push({ name: m.playerName, score: 0 });
      info.name = m.playerName;
      info.roomCode = code;

      sendTo(ws, {
        type: "room_joined",
        roomCode: code,
        host: room.host,
        players: room.players,
        topic: room.topic,
        questionCount: room.questionCount
      });

      sendAll(code, { type: "player_update", host: room.host, players: room.players });
    }

    else if (m.type === "start_game") {
      const room = rooms.get(info.roomCode);
      if (!room || room.host !== info.name || room.state !== "lobby") return;

      room.state = "generating";
      sendAll(info.roomCode, { type: "generating" });

      const qs = await generateQuestions(room.topic, room.questionCount);

      room.questions = qs;
      room.state = "playing";
      room.currentQ = 0;
      room.answersThisRound = {};

      sendAll(info.roomCode, {
        type: "game_start",
        questions: qs.map(q => ({ question: q.question, options: q.options })),
        totalQuestions: qs.length,
        questionIndex: 0
      });
    }

    else if (m.type === "submit_answer") {
      const room = rooms.get(info.roomCode);
      if (!room || room.state !== "playing") return;

      const questionIndex = Number(m.questionIndex);
      const answerIndex = Number(m.answerIndex);
      const timeLeft = Math.max(0, Math.min(Number(m.timeLeft) || 0, 15));

      if (!Number.isInteger(questionIndex)) return;
      if (questionIndex !== room.currentQ) return;

      const q = room.questions[questionIndex];
      if (!q) return;

      room.answersThisRound ||= {};
      if (room.answersThisRound[info.name]) return;
      room.answersThisRound[info.name] = true;

      const correct = answerIndex >= 0 && answerIndex === q.correct;
      const pts = correct ? 1000 + Math.round((timeLeft / 15) * 500) : 0;

      const p = room.players.find(p => p.name === info.name);
      if (p) p.score += pts;

      sendTo(ws, {
        type: "answer_result",
        questionIndex,
        correct,
        correctAnswer: q.correct,
        explanation: q.explanation,
        points: pts,
        totalScore: p?.score || 0
      });

      sendAll(info.roomCode, {
        type: "score_update",
        scores: room.players.map(p => ({ name: p.name, score: p.score }))
      });
    }

    else if (m.type === "next_question") {
      const room = rooms.get(info.roomCode);
      if (!room || room.host !== info.name || room.state !== "playing") return;

      room.currentQ++;
      room.answersThisRound = {};

      if (room.currentQ >= room.questions.length) {
        room.state = "results";
        sendAll(info.roomCode, {
          type: "final_results",
          leaderboard: [...room.players].sort((a, b) => b.score - a.score)
        });
      } else {
        sendAll(info.roomCode, {
          type: "next_question",
          questionIndex: room.currentQ
        });
      }
    }

    else if (m.type === "leave") {
      doLeave(ws);
      try { ws.close(); } catch {}
    }
  });

  ws.on("close", () => doLeave(ws));
});

function doLeave(ws) {
  const info = clients.get(ws);
  if (!info?.roomCode) {
    clients.delete(ws);
    return;
  }

  const roomCode = info.roomCode;
  const room = rooms.get(roomCode);

  if (room) {
    room.players = room.players.filter(p => p.name !== info.name);

    if (room.players.length === 0) {
      rooms.delete(roomCode);
    } else {
      if (room.host === info.name) {
        room.host = room.players[0].name;
      }

      sendAll(roomCode, {
        type: "player_update",
        host: room.host,
        players: room.players
      });
    }
  }

  clients.delete(ws);
}

setInterval(() => {
  for (const [c, r] of rooms.entries()) {
    if (Date.now() - r.created > 3600000) rooms.delete(c);
  }
}, 1800000);

app.use(express.static(path.join(__dirname, "public")));

server.listen(PORT, () => {
  console.log(`🧠 QUIZIMED port ${PORT} | API: ${API_KEY ? "✅" : "⚠️ démo"}`);
});
