export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBAPP_URL: string;
}

const GEMS = [
  "https://cdn.jsdelivr.net/gh/BestMovieSearchHubBot/IndiaFriendBot@main/public/gems/red.png",
  "https://cdn.jsdelivr.net/gh/BestMovieSearchHubBot/IndiaFriendBot@main/public/gems/blue.png",
  "https://cdn.jsdelivr.net/gh/BestMovieSearchHubBot/IndiaFriendBot@main/public/gems/green.png",
  "https://cdn.jsdelivr.net/gh/BestMovieSearchHubBot/IndiaFriendBot@main/public/gems/yellow.png",
  "https://cdn.jsdelivr.net/gh/BestMovieSearchHubBot/IndiaFriendBot@main/public/gems/purple.png"
];

function getRandomGem(): string {
  return GEMS[Math.floor(Math.random() * GEMS.length)];
}

function generateMatrix(): string[][] {
  const matrix: string[][] = [];
  for (let i = 0; i < 3; i++) {
    matrix[i] = [];
    for (let j = 0; j < 3; j++) {
      matrix[i][j] = getRandomGem();
    }
  }
  return matrix;
}

function calculateWinMultiplier(matrix: string[][]): number {
  let multiplier = 0;
  for (let row = 0; row < 3; row++) {
    const [a, b, c] = matrix[row];
    if (a === b && b === c) multiplier += 5;
    else if (a === b || b === c || a === c) multiplier += 0.5;
  }
  return multiplier;
}

function generateReferralCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function handleAuth(request: Request, env: Env): Promise<Response> {
  const { telegramId, referCode } = await request.json() as any;
  if (!telegramId) return Response.json({ error: "telegramId required" }, { status: 400 });

  let user = await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegramId).first();
  if (!user) {
    const userId = crypto.randomUUID();
    const newCode = generateReferralCode();
    let coins = 1030;
    let referredBy: string | null = null;
    if (referCode) {
      const referrer = await env.DB.prepare("SELECT * FROM users WHERE referral_code = ?").bind(referCode).first();
      if (referrer && referrer.telegram_id !== telegramId) {
        await env.DB.prepare("UPDATE users SET coins = coins + 10 WHERE id = ?").bind(referrer.id).run();
        await env.DB.prepare("INSERT INTO referral_earnings (referrer_id, new_user_id) VALUES (?, ?)").bind(referrer.id, userId).run();
        coins += 10;
        referredBy = referrer.telegram_id;
      }
    }
    await env.DB.prepare(
      `INSERT INTO users (id, telegram_id, coins, referral_code, referred_by)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(userId, telegramId, coins, newCode, referredBy).run();
    user = { id: userId, coins, referral_code: newCode };
  }
  return Response.json({
    userId: user.id,
    telegramId,
    coins: user.coins,
    referralCode: user.referral_code
  });
}

async function handleSpin(request: Request, env: Env): Promise<Response> {
  const { userId, bet } = await request.json() as { userId: string; bet: number };
  if (!bet || bet < 1 || bet > 10) return Response.json({ error: "Bet must be 1-10" }, { status: 400 });
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });
  if (user.coins < bet) return Response.json({ error: "Insufficient coins" }, { status: 400 });

  let newCoins = user.coins - bet;
  await env.DB.prepare("UPDATE users SET coins = ?, total_spins = total_spins + 1 WHERE id = ?").bind(newCoins, userId).run();

  const matrix = generateMatrix();
  const multiplier = calculateWinMultiplier(matrix);
  const win = multiplier * bet;
  if (win > 0) {
    newCoins = newCoins + win;
    await env.DB.prepare("UPDATE users SET coins = ? WHERE id = ?").bind(newCoins, userId).run();
  }
  return Response.json({ matrix, win, newCoins });
}

async function handleRedeem(request: Request, env: Env): Promise<Response> {
  const { userId, type, email, uid } = await request.json() as any;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  let required = 0;
  if (type === 'amazon' || type === 'googleplay') {
    required = 500;
    if (!email) return Response.json({ error: "Email required" }, { status: 400 });
  } else if (type === 'freediamond') {
    required = 420;
    if (!uid) return Response.json({ error: "UID required" }, { status: 400 });
  } else return Response.json({ error: "Invalid type" }, { status: 400 });

  if (user.coins < required) return Response.json({ error: `Need ${required} coins` }, { status: 400 });

  const newCoins = user.coins - required;
  await env.DB.prepare("UPDATE users SET coins = ? WHERE id = ?").bind(newCoins, userId).run();
  await env.DB.prepare(
    `INSERT INTO redemptions (user_id, type, amount, email, uid) VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, type, required, email || null, uid || null).run();

  return Response.json({ success: true, newCoins });
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const update = await request.json() as any;
  const message = update.message;
  if (!message) return new Response("OK", { status: 200 });

  const chatId = message.chat.id;
  const telegramId = message.from?.id.toString();
  if (message.text === "/start") {
    let user = await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegramId).first();
    let replyText = "";
    if (!user) {
      replyText = `✨ Welcome ${message.from?.first_name || "Player"}! Click below to play.`;
    } else {
      replyText = `✨ Welcome back ${message.from?.first_name || "Player"}!\n💰 Coins: ${user.coins}\n🔗 Your referral code: \`${user.referral_code}\`\n\nShare this link – you both get 10 coins!`;
    }
    const webappUrl = `${env.WEBAPP_URL}?startapp=${user?.referral_code || ""}`;
    const botUsername = message.from?.username || "lucky_gems_bot";
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${botUsername}?startapp=${user?.referral_code || ""}`)}&text=Join me on Lucky Gems and get 10 free coins!`;
    const payload = {
      method: "sendMessage",
      chat_id: chatId,
      text: replyText,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎰 PLAY LUCKY GEMS", web_app: { url: webappUrl } }],
          [{ text: "🔗 Share Referral Link", url: shareUrl }]
        ]
      }
    };
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }
  return new Response("OK", { status: 200 });
}

// ======================= COMPLETE HTML/JS (Original Layout + Bet Adjust + Smooth Spin) =======================
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="hi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Lucky Gems Slot</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;900&display=swap" rel="stylesheet">
<style>
* {
  box-sizing: border-box;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
body {
  margin: 0;
  padding: 0;
  font-family: 'Orbitron', sans-serif;
  background: url('https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/bg.jpg') no-repeat center center fixed;
  background-size: cover;
  height: 100vh;
  overflow: hidden;
}
img {
  -webkit-user-drag: none;
  user-drag: none;
  pointer-events: none;
}
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 15px;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(8px);
  color: white;
  z-index: 10;
  position: relative;
}
.coins {
  background: #111;
  padding: 5px 18px;
  border-radius: 40px;
  border: 1px solid #ffd700;
}
/* MACHINE CONTAINER */
.machine-container {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-top: 220px; 
  position: relative;
}
.machine {
  position: relative;
  width: 350px; 
  height: 350px; 
}

.frame {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 3;
  pointer-events: none; 
  transform: scale(1.25); 
  transform-origin: center;
}

.reels {
  position: absolute;
  top: 28px;    
  left: -8px;  
  width: 365px; 
  height: 350px; 
  display: flex;
  justify-content: center; 
  gap: 10px;    
  overflow: hidden; 
  z-index: 2;
}

.reel {
  display: flex;
  flex-direction: column;
  width: 85px;  
  align-items: center;
}

.reel img {
  width: 85px;  
  height: 85px; 
  object-fit: contain;
  margin-bottom: 18px; 
}
.sidebar {
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 4;
}
.sidebtn {
  background: linear-gradient(180deg, #9c27b0, #4a148c);
  padding: 12px 8px;
  border-radius: 8px;
  color: white;
  text-align: center;
  font-size: 12px;
  border: 1px solid #ffffff50;
  cursor: pointer;
}
.controls {
  position: fixed;
  bottom: 50px;
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 10px 15px;
  z-index: 10;
}
.bet-bar {
  position: relative;
  width: 90%;
  top: 35px;
  max-width: 520px;
}

.bet-bar img {
  width: 100%;
  transform: scale(1.5);
}

.spin-btn {
  position: absolute;
  right: 15px;
  bottom: 25px;
  width: 28%;
  max-width: 180px;
  z-index: 20;
}

.spin-btn img {
  width: 100%;
  cursor: pointer;
}

.bet-controls {
  display: flex;
  gap: 15px;
  bottom: 25px;
  background: rgba(0,0,0,0.7);
  border-radius: 50px;
  padding: 5px 15px;
  border: 1px solid gold;
  z-index: 5;
}
.bet-controls button {
  background: none;
  border: none;
  font-size: 28px;
  font-weight: bold;
  color: #ffd966;
  cursor: pointer;
  font-family: 'Orbitron', monospace;
  width: 40px;
  text-align: center;
  padding: 0;
  z-index: 5;
}
.bet-controls span {
  font-size: 24px;
  font-weight: bold;
  color: white;
  min-width: 50px;
  text-align: center;
}
#winOverlay {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0,0,0,0.9);
  z-index: 1000;
  flex-direction: column;
  justify-content: center;
  align-items: center;
}
.win-box {
  text-align: center;
  animation: popIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  background: linear-gradient(145deg,#2a1f0e,#1a1207);
  padding: 30px 50px;
  border-radius: 70px;
  border: 3px solid gold;
}
.win-title {
  font-size: 54px;
  background: linear-gradient(to bottom,#fff700,#ff8c00);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin: 0;
}
.win-amount {
  font-size: 40px;
  color: white;
  margin: 20px 0;
}
.collect-btn {
  padding: 15px 50px;
  background: linear-gradient(180deg,#ffb300,#fb8c00);
  border: none;
  border-radius: 50px;
  font-weight: bold;
  cursor: pointer;
}
.glow {
  filter: drop-shadow(0 0 15px gold) brightness(1.2);
  transform: scale(1.05);
}
.modal {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0,0,0,0.85);
  backdrop-filter: blur(8px);
  z-index: 2000;
  justify-content: center;
  align-items: center;
}
.modal-content {
  background: linear-gradient(145deg,#2a2418,#1a1408);
  border: 2px solid #f5bc70;
  border-radius: 50px;
  padding: 30px;
  text-align: center;
  width: 90%;
  max-width: 380px;
}
.refer-code-box {
  background: #000;
  font-size: 28px;
  letter-spacing: 4px;
  padding: 15px;
  border-radius: 30px;
  border: 1px solid gold;
  color: gold;
  margin: 15px 0;
}
.casino-input, .casino-select {
  width: 100%;
  padding: 12px;
  margin: 10px 0;
  background: #1e1a0e;
  border: 1px solid #e4b83e;
  border-radius: 40px;
  color: white;
  text-align: center;
}
.casino-btn {
  background: linear-gradient(180deg,#ffb300,#fb8c00);
  border: none;
  border-radius: 40px;
  padding: 12px 25px;
  margin: 8px;
  font-weight: bold;
  cursor: pointer;
}
@keyframes popIn {
  0% { transform: scale(0.2); opacity: 0; }
  80% { transform: scale(1.05); }
  100% { transform: scale(1); opacity: 1; }
}
</style>
</head>
<body oncontextmenu="return false;">
<div class="topbar">
  <div>👤 <span id="username">Player</span></div>
  <div class="coins">💰 <span id="coins">0.00</span></div>
</div>
<div class="machine-container">
  <div class="machine">
    <img src="https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/frame.png" class="frame" draggable="false">
    <div class="reels">
      <div class="reel" id="r1"></div>
      <div class="reel" id="r2"></div>
      <div class="reel" id="r3"></div>
    </div>
  </div>
  <div class="sidebar">
    <div class="sidebtn" id="referBtn">🔗 REFER</div>
    <div class="sidebtn" id="redeemBtn">🎁 REDEEM</div>
  </div>
</div>
<div class="controls">
  <div class="bet-bar">
    <img src="https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/bet-bar.png" draggable="false">
    <div class="bet-text">BET</div>
    <div class="bet-controls">
      <button id="betMinus">-</button>
      <span id="betValue">1</span>
      <button id="betPlus">+</button>
    </div>
  </div>
  <div class="spin-btn" id="spinBtn">
    <img src="https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/spin-btn.png" draggable="false">
  </div>
</div>
<div id="winOverlay">
  <div class="win-box">
    <h1 class="win-title">BIG WIN!</h1>
    <div class="win-amount" id="winLabel">+0</div>
    <button class="collect-btn" id="collectBtn">COLLECT</button>
  </div>
</div>
<div id="referModal" class="modal">
  <div class="modal-content">
    <div style="font-size:24px;">🔗 YOUR REFERRAL LINK</div>
    <div class="refer-code-box" id="referLinkDisplay">Loading...</div>
    <button class="casino-btn" id="copyReferLink">COPY LINK</button>
    <button class="casino-btn" id="closeReferModal">CLOSE</button>
  </div>
</div>
<div id="redeemModal" class="modal">
  <div class="modal-content">
    <div style="font-size:24px;">🎁 REDEEM</div>
    <select id="redeemType" class="casino-select">
      <option value="amazon">Amazon Gift Voucher (500 coins)</option>
      <option value="googleplay">Google Play Voucher (500 coins)</option>
      <option value="freediamond">Free Fire 500 Diamonds (420 coins)</option>
    </select>
    <div id="emailField"><input type="email" id="redeemEmail" placeholder="Email" class="casino-input"></div>
    <div id="uidField" style="display:none"><input type="text" id="redeemUid" placeholder="Free Fire UID" class="casino-input"></div>
    <button id="submitRedeem" class="casino-btn">REDEEM</button>
    <button id="closeRedeemModal" class="casino-btn">CANCEL</button>
    <p id="redeemMsg"></p>
  </div>
</div>
<script>
const tg = window.Telegram.WebApp;
tg.expand();
tg.ready();

let userId = null;
let currentCoins = 0;
let currentBet = 1;
let isSpinning = false;
let bigWinAmount = 0;

const gemsList = ${JSON.stringify(GEMS)};

function createReelDom(id, arr) {
  const reel = document.getElementById(id);
  reel.innerHTML = "";
  arr.forEach(src => {
    let img = document.createElement("img");
    img.src = src;
    img.draggable = false;
    reel.appendChild(img);
  });
}

function randomReel() {
  let count = {};
  gemsList.forEach(g => count[g] = 0);
  let arr = [];
  while (arr.length < 15) {
    let g = gemsList[Math.floor(Math.random() * gemsList.length)];
    if (count[g] < 3) {
      arr.push(g);
      count[g]++;
    }
  }
  arr.sort(() => Math.random() - 0.5);
  return arr;
}

function initReels() {
  for (let i = 1; i <= 3; i++) createReelDom('r' + i, randomReel());
}
initReels();

function updateCoins() {
  document.getElementById("coins").innerText = currentCoins.toFixed(2);
}

function enableSpin(en) {
  const btn = document.getElementById("spinBtn");
  btn.style.pointerEvents = en ? "auto" : "none";
  btn.style.opacity = en ? "1" : "0.6";
}

async function animateSpin(finalMatrix) {
  return new Promise(resolve => {
    let spins = 0;
    const totalSpins = 20;
    const interval = setInterval(() => {
      for (let i = 1; i <= 3; i++) {
        createReelDom('r' + i, randomReel());
      }
      spins++;
      if (spins >= totalSpins) {
        clearInterval(interval);
        for (let col = 0; col < 3; col++) {
          let colImgs = [];
          for (let row = 0; row < 3; row++) {
            colImgs.push(finalMatrix[row][col]);
          }
          let full = [...colImgs, ...colImgs, ...colImgs, ...colImgs, ...colImgs].slice(0, 15);
          createReelDom('r' + (col + 1), full);
        }
        resolve();
      }
    }, 50);
  });
}

function highlightWins(mat) {
  document.querySelectorAll('.glow').forEach(el => el.classList.remove('glow'));
  for (let row = 0; row < 3; row++) {
    const [a, b, c] = mat[row];
    if (a === b && b === c) {
      for (let col = 0; col < 3; col++) {
        let el = document.getElementById('r' + (col + 1)).children[row];
        if (el) el.classList.add('glow');
      }
    } else if (a === b || b === c || a === c) {
      let pairs = [];
      if (a === b) pairs.push([0, 1]);
      if (b === c) pairs.push([1, 2]);
      if (a === c) pairs.push([0, 2]);
      for (let pair of pairs) {
        for (let col of pair) {
          let el = document.getElementById('r' + (col + 1)).children[row];
          if (el) el.classList.add('glow');
        }
      }
    }
  }
}

function smoothCoins(target, cb) {
  let start = currentCoins;
  let step = Math.max(0.05, (target - start) / 20);
  let it = setInterval(() => {
    start += step;
    if (start >= target) {
      clearInterval(it);
      currentCoins = target;
      updateCoins();
      if (cb) cb();
    } else {
      currentCoins = start;
      updateCoins();
    }
  }, 30);
}

function showBigWin(amt) {
  document.getElementById("winLabel").innerText = "+" + amt.toFixed(2) + " COINS";
  document.getElementById("winOverlay").style.display = "flex";
  bigWinAmount = amt;
}

function closeWin() {
  document.getElementById("winOverlay").style.display = "none";
  smoothCoins(currentCoins + bigWinAmount, () => {
    isSpinning = false;
    enableSpin(true);
  });
  bigWinAmount = 0;
}

async function spin() {
  if (isSpinning) return;
  isSpinning = true;
  enableSpin(false);
  try {
    const res = await fetch('/api/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, bet: currentBet })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    currentCoins = data.newCoins - data.win;
    updateCoins();
    await animateSpin(data.matrix);
    highlightWins(data.matrix);
    if (data.win > 0) {
      if (data.win >= 15) showBigWin(data.win);
      else smoothCoins(currentCoins + data.win, () => {
        isSpinning = false;
        enableSpin(true);
        document.querySelectorAll('.glow').forEach(el => el.classList.remove('glow'));
      });
    } else {
      isSpinning = false;
      enableSpin(true);
      document.querySelectorAll('.glow').forEach(el => el.classList.remove('glow'));
    }
  } catch (e) {
    alert("Spin error: " + e.message);
    console.error(e);
    isSpinning = false;
    enableSpin(true);
  }
}

async function initAuth() {
  const u = tg.initDataUnsafe?.user;
  if (!u) {
    alert("Open from Telegram");
    return;
  }
  const telegramId = u.id.toString();
  const urlParams = new URLSearchParams(location.search);
  const ref = urlParams.get('startapp');
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegramId, referCode: ref })
  });
  const data = await res.json();
  userId = data.userId;
  currentCoins = data.coins;
  updateCoins();
  document.getElementById("username").innerText = u.first_name || "Player";
  const botUsername = u.username || "lucky_gems_bot";
  window.referralLink = "https://t.me/" + botUsername + "?startapp=" + data.referralCode;
}

// Bet controls
document.getElementById("betPlus").onclick = () => {
  if (currentBet < 10) {
    currentBet++;
    document.getElementById("betValue").innerText = currentBet;
  }
};
document.getElementById("betMinus").onclick = () => {
  if (currentBet > 1) {
    currentBet--;
    document.getElementById("betValue").innerText = currentBet;
  }
};

// Referral modal
document.getElementById("referBtn").onclick = () => {
  document.getElementById("referLinkDisplay").innerText = window.referralLink || "Loading...";
  document.getElementById("referModal").style.display = "flex";
};
document.getElementById("copyReferLink").onclick = () => {
  const link = window.referralLink;
  if (link) {
    navigator.clipboard.writeText(link);
    alert("Referral link copied!");
  } else {
    alert("Loading, please try again.");
  }
};
document.getElementById("closeReferModal").onclick = () => {
  document.getElementById("referModal").style.display = "none";
};

// Redeem modal
document.getElementById("redeemBtn").onclick = () => {
  document.getElementById("redeemModal").style.display = "flex";
  document.getElementById("redeemMsg").innerText = "";
};
document.getElementById("closeRedeemModal").onclick = () => {
  document.getElementById("redeemModal").style.display = "none";
};
document.getElementById("redeemType").onchange = function() {
  if (this.value === "freediamond") {
    document.getElementById("emailField").style.display = "none";
    document.getElementById("uidField").style.display = "block";
  } else {
    document.getElementById("emailField").style.display = "block";
    document.getElementById("uidField").style.display = "none";
  }
};
document.getElementById("submitRedeem").onclick = async () => {
  const type = document.getElementById("redeemType").value;
  let email = null, uid = null;
  if (type === "freediamond") {
    uid = document.getElementById("redeemUid").value;
    if (!uid) { alert("Enter UID"); return; }
  } else {
    email = document.getElementById("redeemEmail").value;
    if (!email) { alert("Enter email"); return; }
  }
  const res = await fetch('/api/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, type, email, uid })
  });
  const data = await res.json();
  if (res.ok) {
    currentCoins = data.newCoins;
    updateCoins();
    alert("Redemption request submitted!");
    document.getElementById("redeemModal").style.display = "none";
  } else {
    alert(data.error);
  }
};

document.getElementById("spinBtn").addEventListener("click", spin);
document.getElementById("collectBtn").addEventListener("click", closeWin);

initAuth();
</script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
      return new Response(HTML_CONTENT, { headers: { "Content-Type": "text/html" } });
    }

    if (path === "/api/auth" && request.method === "POST") return handleAuth(request, env);
    if (path === "/api/spin" && request.method === "POST") return handleSpin(request, env);
    if (path === "/api/redeem" && request.method === "POST") return handleRedeem(request, env);
    if (path === "/webhook" && request.method === "POST") return handleTelegramWebhook(request, env);

    return new Response("Not Found", { status: 404 });
  }
};
