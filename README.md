# 🧠 QUIZIMED - Quiz Multijoueur en Temps Réel

Quiz interactif avec génération de questions par IA et multijoueur en ligne.

## 🚀 Lancer en local

```bash
# 1. Installer les dépendances
npm install

# 2. Configurer la clé API Anthropic (optionnel, sans clé = mode démo)
export ANTHROPIC_API_KEY="sk-ant-..."

# 3. Lancer le serveur
npm start

# 4. Ouvrir http://localhost:3000
```

## 🌐 Déployer gratuitement

### Option 1 : Railway.app (recommandé)
1. Crée un compte sur [railway.app](https://railway.app)
2. Connecte ton GitHub
3. Clique "New Project" → "Deploy from GitHub repo"
4. Ajoute la variable d'environnement `ANTHROPIC_API_KEY`
5. C'est déployé ! Tu reçois une URL publique

### Option 2 : Render.com
1. Crée un compte sur [render.com](https://render.com)
2. "New" → "Web Service" → connecte ton repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Ajoute `ANTHROPIC_API_KEY` dans Environment

### Option 3 : Fly.io
```bash
fly launch
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly deploy
```

## 🎮 Comment ça marche

### Mode Solo
1. Entre ton pseudo et le sujet
2. Choisis le nombre de questions
3. Clique "Jouer Solo"
4. L'IA génère les questions et c'est parti !

### Mode Multijoueur
1. Crée une partie multijoueur
2. Partage le **lien** ou le **code** à tes amis (WhatsApp, SMS, Email...)
3. Tes amis ouvrent le lien → ils arrivent directement sur la page avec le code pré-rempli
4. Quand tout le monde est dans le lobby, le host lance la partie
5. Tout le monde joue en même temps avec scores en temps réel
6. Classement final à la fin !

## 📁 Structure

```
quizimed-server/
├── server.js          # Serveur Node.js + WebSocket
├── public/
│   └── index.html     # Client complet (HTML/CSS/JS)
├── package.json
└── README.md
```

## ⚙️ Variables d'environnement

| Variable | Description | Défaut |
|----------|-------------|--------|
| `PORT` | Port du serveur | 3000 |
| `ANTHROPIC_API_KEY` | Clé API Anthropic | (mode démo) |

## 🔧 Fonctionnalités

- ✅ Génération de questions par IA (Claude)
- ✅ Mode solo et multijoueur
- ✅ WebSocket pour le temps réel
- ✅ Timer avec scoring basé sur la vitesse
- ✅ Système de streak (séries)
- ✅ Lobby avec système d'invitation
- ✅ Partage par lien, WhatsApp, SMS, Email
- ✅ Classement et récapitulatif détaillé
- ✅ Design responsive (mobile + desktop)
- ✅ Nettoyage automatique des salles inactives
