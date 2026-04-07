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

const SHRINKME_API_KEY = "357d12f69660eea305f044d24b1297ca78cfd2ca";

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
    let coins = 10;
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

async function handleUnlock(request: Request, env: Env): Promise<Response> {
  const { userId } = await request.json() as { userId: string };
  if (!userId) return Response.json({ error: "userId required" }, { status: 400 });

  const existing = await env.DB.prepare("SELECT last_unlock_at FROM unlocks WHERE user_id = ? ORDER BY last_unlock_at DESC LIMIT 1").bind(userId).first();
  if (existing) {
    const last = new Date(existing.last_unlock_at);
    const now = new Date();
    const diffHours = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
    if (diffHours < 24) {
      return Response.json({ error: "Already unlocked within 24 hours", locked: false }, { status: 400 });
    }
  }

  const token = crypto.randomUUID();
  const gameBaseUrl = env.WEBAPP_URL;
  const callbackUrl = `${gameBaseUrl}?unlock_token=${token}&userId=${userId}`;
  const longUrl = encodeURIComponent(callbackUrl);
  const shrinkApiUrl = `https://shrinkme.io/api?api=${SHRINKME_API_KEY}&url=${longUrl}&format=text`;
  try {
    const shrinkRes = await fetch(shrinkApiUrl);
    const shortLink = await shrinkRes.text();
    if (!shortLink || shortLink.includes("error")) {
      throw new Error("ShrinkMe API failed");
    }
    await env.DB.prepare("INSERT INTO unlocks (user_id, unlock_token, last_unlock_at) VALUES (?, ?, ?)")
      .bind(userId, token, new Date(0).toISOString()).run();
    return Response.json({ success: true, shortLink, token });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Failed to generate unlock link" }, { status: 500 });
  }
}

async function handleConfirmUnlock(request: Request, env: Env): Promise<Response> {
  const { userId, token } = await request.json() as { userId: string; token: string };
  if (!userId || !token) return Response.json({ error: "Missing params" }, { status: 400 });
  const record = await env.DB.prepare("SELECT * FROM unlocks WHERE user_id = ? AND unlock_token = ?").bind(userId, token).first();
  if (!record) return Response.json({ error: "Invalid or expired token" }, { status: 400 });
  await env.DB.prepare("UPDATE unlocks SET last_unlock_at = CURRENT_TIMESTAMP WHERE user_id = ? AND unlock_token = ?").bind(userId, token).run();
  return Response.json({ success: true });
}

async function handleUnlockStatus(request: Request, env: Env): Promise<Response> {
  const { userId } = await request.json() as { userId: string };
  if (!userId) return Response.json({ error: "userId required" }, { status: 400 });
  const record = await env.DB.prepare("SELECT last_unlock_at FROM unlocks WHERE user_id = ? ORDER BY last_unlock_at DESC LIMIT 1").bind(userId).first();
  if (!record) return Response.json({ unlocked: false });
  const last = new Date(record.last_unlock_at);
  const now = new Date();
  const diffHours = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return Response.json({ unlocked: diffHours < 24 });
}

async function handleSpin(request: Request, env: Env): Promise<Response> {
  const { userId, bet } = await request.json() as { userId: string; bet: number };
  if (!bet || bet < 1 || bet > 10) return Response.json({ error: "Bet must be 1-10" }, { status: 400 });
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });
  if (user.coins < bet) return Response.json({ error: "Insufficient coins" }, { status: 400 });

  const unlockRecord = await env.DB.prepare("SELECT last_unlock_at FROM unlocks WHERE user_id = ? ORDER BY last_unlock_at DESC LIMIT 1").bind(userId).first();
  let isUnlocked = false;
  if (unlockRecord) {
    const last = new Date(unlockRecord.last_unlock_at);
    const now = new Date();
    const diffHours = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
    isUnlocked = diffHours < 24;
  }
  if (!isUnlocked) {
    return Response.json({ error: "Spin locked. Please unlock first." }, { status: 403 });
  }

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

// ======================= FRONTEND HTML (Fixed template literal) =======================
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
  -webkit-touch-callout: none !important;
  -webkit-user-select: none !important;
  user-select: none !important;
  -webkit-tap-highlight-color: transparent;
  touch-action: pan-y;
}
html, body {
  overscroll-behavior: none;
  overflow: hidden;
  position: fixed;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  margin: 0;
  padding: 0;
}
body {
  margin: 0;
  padding: 0;
  font-family: 'Orbitron', sans-serif;
  background: url('https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/bg.jpg') no-repeat center center fixed;
  background-size: cover;
  height: 100vh;
  overflow: hidden;
  touch-action: pan-y;
}
img, button, .sidebtn, .action-btn img, .casino-btn, .collect-btn {
  -webkit-touch-callout: none !important;
  pointer-events: auto;
  -webkit-user-drag: none !important;
  user-drag: none !important;
  user-select: none !important;
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
.swipe-container {
  width: 100%;
  height: calc(100% - 180px);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}
.machine-wrapper {
  width: 100%;
  display: flex;
  justify-content: center;
  transition: transform 0.3s ease-out;
  will-change: transform;
}
.machine-container {
  display: flex;
  justify-content: center;
  align-items: center;
  position: relative;
  width: 350px;
  margin: 0 auto;
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
  font-family: 'Orbitron', sans-serif;
}
.refer-panel {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: linear-gradient(145deg, #1a1a2e, #0f0f1a);
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 25px;
  padding: 20px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
  backdrop-filter: blur(5px);
}
.refer-panel.visible {
  opacity: 1;
  pointer-events: auto;
}
.refer-panel h2 {
  font-size: 32px;
  background: linear-gradient(135deg, #ffd966, #ffb347);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  margin: 0;
}
.refer-panel p {
  color: #ffec9f;
  text-align: center;
  font-size: 16px;
}
.refer-link-box {
  background: rgba(0,0,0,0.7);
  border: 1px solid #ffd700;
  border-radius: 50px;
  padding: 12px 20px;
  width: 90%;
  max-width: 300px;
  text-align: center;
  font-size: 14px;
  color: #ffd966;
  word-break: break-all;
  font-family: monospace;
}
.refer-buttons {
  display: flex;
  gap: 20px;
  justify-content: center;
}
.refer-btn {
  background: linear-gradient(180deg, #ffb300, #fb8c00);
  border: none;
  border-radius: 50px;
  padding: 12px 25px;
  font-weight: bold;
  font-family: 'Orbitron', monospace;
  color: #1f1a0a;
  cursor: pointer;
  transition: transform 0.05s linear;
  font-size: 16px;
}
.refer-btn:active {
  transform: scale(0.96);
}
.close-panel {
  background: rgba(255,255,255,0.1);
  border: 1px solid #ffd700;
  color: #ffd966;
  margin-top: 20px;
}
.loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0,0,0,0.85);
  backdrop-filter: blur(8px);
  z-index: 10000;
  display: flex;
  justify-content: center;
  align-items: center;
  flex-direction: column;
  gap: 20px;
  transition: opacity 0.3s ease;
}
.loading-spinner {
  width: 80px;
  height: 80px;
  border: 6px solid rgba(255,215,0,0.2);
  border-top: 6px solid #ffd700;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
.loading-text {
  font-size: 18px;
  letter-spacing: 2px;
  color: #ffd966;
  font-weight: bold;
}
@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
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
.action-btn {
  position: absolute;
  right: 15px;
  bottom: -25px;
  width: 28%;
  max-width: 180px;
  z-index: 20;
}
.action-btn img {
  width: 100%;
  cursor: pointer;
  pointer-events: auto;
}
.bet-controls {
  display: flex;
  gap: 15px;
  background: rgba(0,0,0,0.7);
  border-radius: 50px;
  padding: 5px 15px;
  border: 1px solid gold;
  z-index: 5;
  margin-top: -75px;
}
.bet-controls button {
  background: none;
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
  z-index: 5;
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
@keyframes popIn {
  0% { transform: scale(0.2); opacity: 0; }
  80% { transform: scale(1.05); }
  100% { transform: scale(1); opacity: 1; }
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
</style>
</head>
<body oncontextmenu="return false" ontouchstart="return true">
<div class="loading-overlay" id="loadingOverlay">
  <div class="loading-spinner"></div>
  <div class="loading-text">LOADING GEMS...</div>
</div>
<div class="topbar">
  <div>👤 <span id="username">Player</span></div>
  <div class="coins">💰 <span id="coins">0.00</span></div>
</div>
<div class="swipe-container" id="swipeContainer">
  <div class="machine-wrapper" id="machineWrapper">
    <div class="machine-container">
      <div class="machine">
        <img src="https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/frame.png" class="frame" draggable="false" oncontextmenu="return false">
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
  </div>
  <div class="refer-panel" id="referPanel">
    <h2>🔗 REFER & EARN</h2>
    <p>Invite your friends<br>and earn gems</p>
    <div class="refer-link-box" id="panelReferLink">Loading...</div>
    <div class="refer-buttons">
      <button class="refer-btn" id="panelCopyBtn">COPY LINK</button>
      <button class="refer-btn" id="panelShareBtn">SHARE</button>
    </div>
    <button class="refer-btn close-panel" id="closePanelBtn">CLOSE</button>
  </div>
</div>
<div class="controls">
  <div class="bet-bar">
    <img src="https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/bet-bar.png" draggable="false" oncontextmenu="return false">
    <div class="bet-text">BET</div>
    <div class="bet-controls">
      <button id="betMinus">-</button>
      <span id="betValue">1</span>
      <button id="betPlus">+</button>
    </div>
  </div>
  <div class="action-btn" id="spinBtn" style="display: none;">
    <img src="https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/spin-btn.png" draggable="false" oncontextmenu="return false">
  </div>
  <div class="action-btn" id="unlockBtn">
    <img src="https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/spin-btn.png" draggable="false" oncontextmenu="return false" style="cursor:pointer;">
  </div>
</div>
<div id="winOverlay"><div class="win-box"><h1 class="win-title">BIG WIN!</h1><div class="win-amount" id="winLabel">+0</div><button class="collect-btn" id="collectBtn">COLLECT</button></div></div>
<div id="referModal" class="modal"><div class="modal-content"><div style="font-size:24px;">🔗 YOUR REFERRAL LINK</div><div class="refer-code-box" id="referLinkDisplay">Loading...</div><button class="casino-btn" id="copyReferLink">COPY LINK</button><button class="casino-btn" id="closeReferModal">CLOSE</button></div></div>
<div id="redeemModal" class="modal"><div class="modal-content"><div style="font-size:24px;">🎁 REDEEM</div>
<select id="redeemType" class="casino-select"><option value="amazon">Amazon Gift Voucher (500 coins)</option><option value="googleplay">Google Play Voucher (500 coins)</option><option value="freediamond">Free Fire 500 Diamonds (420 coins)</option></select>
<div id="emailField"><input type="email" id="redeemEmail" placeholder="Email" class="casino-input"></div>
<div id="uidField" style="display:none"><input type="text" id="redeemUid" placeholder="Free Fire UID" class="casino-input"></div>
<button id="submitRedeem" class="casino-btn">REDEEM</button><button id="closeRedeemModal" class="casino-btn">CANCEL</button><p id="redeemMsg"></p></div></div>
<script>
const tg = window.Telegram.WebApp;
tg.expand();
tg.ready();

// ---------- Swipe to reveal referral panel ----------
let touchStartX = 0;
let touchMoveX = 0;
let isDragging = false;
let startTransform = 0;
const machineWrapper = document.getElementById('machineWrapper');
const panel = document.getElementById('referPanel');
let panelVisible = false;

function openPanel() {
  if (isSpinning) return;
  panelVisible = true;
  panel.classList.add('visible');
  machineWrapper.style.transform = 'translateX(-100%)';
}
function closePanel() {
  panelVisible = false;
  panel.classList.remove('visible');
  machineWrapper.style.transform = 'translateX(0)';
}
const swipeContainer = document.getElementById('swipeContainer');
swipeContainer.addEventListener('touchstart', (e) => {
  if (isSpinning) return;
  touchStartX = e.touches[0].clientX;
  startTransform = panelVisible ? -100 : 0;
  isDragging = true;
});
swipeContainer.addEventListener('touchmove', (e) => {
  if (isSpinning || !isDragging) return;
  touchMoveX = e.touches[0].clientX;
  let delta = touchMoveX - touchStartX;
  let newTransform = startTransform + (delta / window.innerWidth) * 100;
  newTransform = Math.min(0, Math.max(-100, newTransform));
  machineWrapper.style.transform = 'translateX(' + newTransform + '%)';
  let panelOpacity = Math.abs(newTransform) / 100;
  if (panelOpacity > 0.1) {
    panel.classList.add('visible');
    panel.style.opacity = panelOpacity;
  } else {
    panel.style.opacity = 0;
  }
});
swipeContainer.addEventListener('touchend', (e) => {
  if (isSpinning) return;
  isDragging = false;
  let finalTransform = parseFloat(machineWrapper.style.transform.replace('translateX(', '').replace('%)', '')) || 0;
  if (finalTransform < -50) {
    openPanel();
  } else {
    closePanel();
  }
  panel.style.opacity = '';
});
document.getElementById('closePanelBtn').addEventListener('click', () => {
  closePanel();
});

// ---------- Global long press prevention ----------
document.addEventListener('contextmenu', function(e) {
  e.preventDefault();
  e.stopPropagation();
  return false;
}, true);
document.addEventListener('dragstart', function(e) {
  e.preventDefault();
  return false;
}, true);
document.body.oncontextmenu = function(e) { e.preventDefault(); return false; };

function disableLongPress(el) {
  if (!el) return;
  el.setAttribute('draggable', 'false');
  el.setAttribute('oncontextmenu', 'return false');
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); return false; });
  el.addEventListener('dragstart', (e) => { e.preventDefault(); return false; });
}
document.querySelectorAll('img, .sidebtn, .action-btn img, .casino-btn, .collect-btn, button').forEach(disableLongPress);
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node.nodeType === 1) {
        if (node.tagName === 'IMG') disableLongPress(node);
        node.querySelectorAll && node.querySelectorAll('img, .sidebtn, .action-btn img, .casino-btn, .collect-btn, button').forEach(disableLongPress);
      }
    });
  });
});
observer.observe(document.body, { childList: true, subtree: true });

// ---------- Loading overlay ----------
const loadingOverlay = document.getElementById('loadingOverlay');
function showLoading() { loadingOverlay.style.display = 'flex'; }
function hideLoading() { loadingOverlay.style.opacity = '0'; setTimeout(() => { loadingOverlay.style.display = 'none'; }, 300); }

let userId = null;
let currentCoins = 0;
let currentBet = 1;
let isSpinning = false;
let bigWinAmount = 0;
let spinSoundTimeout = null;

const gemsList = ${JSON.stringify(GEMS)};

let audioCtx = null;
let tickInterval = null;

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}
function playClickSound() {
  try {
    initAudio();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = 800;
    gain.gain.value = 0.2;
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    osc.start();
    osc.stop(now + 0.06);
  } catch(e) { console.log("Click sound error", e); }
}
function startSpinTicks() {
  try {
    initAudio();
    if (!audioCtx) return;
    stopSpinTicks();
    let tickCount = 0;
    const maxTicks = 25;
    tickInterval = setInterval(() => {
      if (tickCount >= maxTicks) {
        clearInterval(tickInterval);
        tickInterval = null;
        return;
      }
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = 1200;
      gain.gain.value = 0.12;
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.start();
      osc.stop(now + 0.05);
      tickCount++;
    }, 100);
  } catch(e) { console.log("Tick sound error", e); }
}
function stopSpinTicks() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}
function playWinSound() {
  try {
    initAudio();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.value = 0.25;
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5 + i*0.08);
      osc.start(now + i * 0.08);
      osc.stop(now + 0.5 + i*0.08);
    });
    setTimeout(() => {
      if (audioCtx) {
        const osc2 = audioCtx.createOscillator();
        const gain2 = audioCtx.createGain();
        osc2.connect(gain2);
        gain2.connect(audioCtx.destination);
        osc2.frequency.value = 1318.52;
        gain2.gain.value = 0.18;
        gain2.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
        osc2.start();
        osc2.stop(audioCtx.currentTime + 0.3);
      }
    }, 200);
  } catch(e) { console.log("Win sound error", e); }
}
function createReel(id, arr) {
  const reel = document.getElementById(id);
  reel.innerHTML = "";
  arr.forEach(src => {
    let img = document.createElement("img");
    img.src = src;
    img.draggable = false;
    img.setAttribute('oncontextmenu', 'return false');
    img.addEventListener('contextmenu', (e) => e.preventDefault());
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
  for (let i = 1; i <= 3; i++) createReel('r' + i, randomReel());
}
initReels();
function updateCoins() {
  document.getElementById("coins").innerText = currentCoins.toFixed(2);
}
function enableSpin(en) {
  const spinBtn = document.getElementById("spinBtn");
  const unlockBtn = document.getElementById("unlockBtn");
  if (en) {
    spinBtn.style.display = "block";
    unlockBtn.style.display = "none";
  } else {
    spinBtn.style.display = "none";
    unlockBtn.style.display = "block";
  }
}
function animateReel(id, delay, finalImages) {
  return new Promise((resolve) => {
    const reel = document.getElementById(id);
    const imgHeight = 85 + 18;
    const totalHeight = imgHeight * reel.children.length;
    let start = null;
    const duration = 2500 + delay;
    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
    function step(timestamp) {
      if (!start) start = timestamp;
      let progress = timestamp - start;
      let t = Math.min(progress / duration, 1);
      let eased = easeOut(t);
      let move = eased * (totalHeight * 3);
      reel.style.transform = 'translateY(' + (-move % totalHeight) + 'px)';
      if (progress < duration) {
        requestAnimationFrame(step);
      } else {
        reel.style.transform = 'translateY(0)';
        createReel(id, finalImages);
        resolve();
      }
    }
    setTimeout(() => requestAnimationFrame(step), delay);
  });
}
async function spin() {
  if (isSpinning) return;
  showLoading();
  spinSoundTimeout = setTimeout(() => { startSpinTicks(); }, 250);
  isSpinning = true;
  const spinImg = document.querySelector("#spinBtn img");
  if (spinImg) spinImg.style.pointerEvents = "none";
  if (currentCoins < currentBet) {
    alert("Not enough coins!");
    isSpinning = false;
    if (spinImg) spinImg.style.pointerEvents = "auto";
    if (spinSoundTimeout) clearTimeout(spinSoundTimeout);
    hideLoading();
    return;
  }
  currentCoins -= currentBet;
  updateCoins();
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
    const finalReels = [];
    for (let col = 0; col < 3; col++) {
      let colImgs = [];
      for (let row = 0; row < 3; row++) colImgs.push(data.matrix[row][col]);
      let full = [...colImgs, ...colImgs, ...colImgs, ...colImgs, ...colImgs].slice(0, 15);
      finalReels.push(full);
    }
    await Promise.all([
      animateReel('r1', 0, finalReels[0]),
      animateReel('r2', 200, finalReels[1]),
      animateReel('r3', 400, finalReels[2])
    ]);
    if (spinSoundTimeout) clearTimeout(spinSoundTimeout);
    stopSpinTicks();
    highlightWins(data.matrix);
    if (data.win > 0) {
      playWinSound();
      if (data.win >= 15) showBigWin(data.win);
      else smoothCoins(currentCoins + data.win, () => {
        isSpinning = false;
        if (spinImg) spinImg.style.pointerEvents = "auto";
        document.querySelectorAll('.glow').forEach(el => el.classList.remove('glow'));
        hideLoading();
      });
    } else {
      isSpinning = false;
      if (spinImg) spinImg.style.pointerEvents = "auto";
      document.querySelectorAll('.glow').forEach(el => el.classList.remove('glow'));
      hideLoading();
    }
  } catch (e) {
    alert("Spin error: " + e.message);
    console.error(e);
    isSpinning = false;
    if (spinImg) spinImg.style.pointerEvents = "auto";
    if (spinSoundTimeout) clearTimeout(spinSoundTimeout);
    stopSpinTicks();
    hideLoading();
  }
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
  smoothCoins(currentCoins + bigWinAmount, () => {});
  bigWinAmount = 0;
}
async function checkUnlockStatus() {
  try {
    const res = await fetch('/api/unlock/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    const data = await res.json();
    if (data.unlocked) {
      enableSpin(true);
    } else {
      enableSpin(false);
    }
  } catch(e) { console.log(e); }
}
async function unlock() {
  playClickSound();
  showLoading();
  try {
    const res = await fetch('/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    const data = await res.json();
    if (data.shortLink) {
      window.open(data.shortLink, '_blank');
    } else {
      alert("Unlock failed: " + (data.error || "Unknown error"));
    }
  } catch(e) {
    alert("Network error");
  }
  hideLoading();
}
async function initAuth() {
  showLoading();
  const u = tg.initDataUnsafe?.user;
  if (!u) { alert("Open from Telegram"); hideLoading(); return; }
  const telegramId = u.id.toString();
  const urlParams = new URLSearchParams(location.search);
  const ref = urlParams.get('startapp');
  try {
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
    const fullReferralLink = "https://t.me/" + botUsername + "?startapp=" + data.referralCode;
    window.referralLink = fullReferralLink;
    const panelLink = document.getElementById('panelReferLink');
    if (panelLink) panelLink.innerText = fullReferralLink;
    const urlToken = urlParams.get('unlock_token');
    const urlUserId = urlParams.get('userId');
    if (urlToken && urlUserId && urlUserId === userId) {
      const confirmRes = await fetch('/api/confirm-unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, token: urlToken })
      });
      const confirmData = await confirmRes.json();
      if (confirmData.success) {
        alert("Spin unlocked for 24 hours!");
        history.replaceState(null, '', window.location.pathname);
      }
    }
    await checkUnlockStatus();
  } catch(e) {
    console.error(e);
  } finally {
    hideLoading();
  }
}
// Bet controls
document.getElementById("betPlus").onclick = () => {
  playClickSound();
  if (currentBet < 10) { currentBet++; document.getElementById("betValue").innerText = currentBet; }
};
document.getElementById("betMinus").onclick = () => {
  playClickSound();
  if (currentBet > 1) { currentBet--; document.getElementById("betValue").innerText = currentBet; }
};
// Panel buttons
document.getElementById("panelCopyBtn").onclick = () => {
  playClickSound();
  const link = window.referralLink;
  if (link) {
    navigator.clipboard.writeText(link);
    alert("Referral link copied!");
  } else {
    alert("Loading, please try again.");
  }
};
document.getElementById("panelShareBtn").onclick = () => {
  playClickSound();
  const link = window.referralLink;
  if (link) {
    if (tg.shareToStory) {
      tg.shareToStory(link);
    } else {
      navigator.clipboard.writeText(link);
      alert("Link copied! You can now share it.");
    }
  } else {
    alert("Loading, please wait.");
  }
};
// Old refer modal buttons (keep for compatibility)
document.getElementById("referBtn").onclick = () => {
  playClickSound();
  document.getElementById("referLinkDisplay").innerText = window.referralLink || "Loading...";
  document.getElementById("referModal").style.display = "flex";
};
document.getElementById("copyReferLink").onclick = () => {
  playClickSound();
  const link = window.referralLink;
  if (link) { navigator.clipboard.writeText(link); alert("Referral link copied!"); }
  else alert("Loading, please try again.");
};
document.getElementById("closeReferModal").onclick = () => {
  playClickSound();
  document.getElementById("referModal").style.display = "none";
};
// Redeem modal
document.getElementById("redeemBtn").onclick = () => {
  playClickSound();
  document.getElementById("redeemModal").style.display = "flex";
  document.getElementById("redeemMsg").innerText = "";
};
document.getElementById("closeRedeemModal").onclick = () => {
  playClickSound();
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
  playClickSound();
  showLoading();
  const type = document.getElementById("redeemType").value;
  let email = null, uid = null;
  if (type === "freediamond") {
    uid = document.getElementById("redeemUid").value;
    if (!uid) { alert("Enter UID"); hideLoading(); return; }
  } else {
    email = document.getElementById("redeemEmail").value;
    if (!email) { alert("Enter email"); hideLoading(); return; }
  }
  try {
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
    } else alert(data.error);
  } catch(e) { alert("Network error"); }
  hideLoading();
};
document.getElementById("spinBtn").addEventListener("click", spin);
document.getElementById("unlockBtn").addEventListener("click", unlock);
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
    if (path === "/api/unlock" && request.method === "POST") return handleUnlock(request, env);
    if (path === "/api/confirm-unlock" && request.method === "POST") return handleConfirmUnlock(request, env);
    if (path === "/api/unlock/status" && request.method === "POST") return handleUnlockStatus(request, env);
    if (path === "/webhook" && request.method === "POST") return handleTelegramWebhook(request, env);

    return new Response("Not Found", { status: 404 });
  }
};
