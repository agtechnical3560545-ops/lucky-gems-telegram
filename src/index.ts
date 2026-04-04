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
  if (!bet || bet < 1 || bet > 10) return Response.json({ error: "Invalid bet (1-10)" }, { status: 400 });
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
      replyText = `✨ Welcome back ${message.from?.first_name || "Player"}!\n💰 Coins: ${user.coins}\n🔗 Your referral code: \`${user.referral_code}\`\n\nShare this link with friends – you both get 10 coins!`;
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

// ====================== HTML CONTENT as regular string (no nested backticks) ======================
const HTML_CONTENT = "<!DOCTYPE html>\n<html lang=\"hi\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\">\n<title>Lucky Gems Slot</title>\n<script src=\"https://telegram.org/js/telegram-web-app.js\"></script>\n<link href=\"https://fonts.googleapis.com/css2?family=Orbitron:wght@600;900&display=swap\" rel=\"stylesheet\">\n<style>\n* {\n  box-sizing: border-box;\n  -webkit-touch-callout: none;\n  -webkit-user-select: none;\n  user-select: none;\n  -webkit-tap-highlight-color: transparent;\n  touch-action: manipulation;\n}\nbody {\n  margin: 0;\n  padding: 0;\n  font-family: 'Orbitron', sans-serif;\n  background: url('https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/bg.jpg') no-repeat center center fixed;\n  background-size: cover;\n  height: 100vh;\n  overflow: hidden;\n}\n.topbar {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  padding: 10px 15px;\n  background: rgba(0,0,0,0.6);\n  backdrop-filter: blur(8px);\n  color: white;\n}\n.coins {\n  background: #111;\n  padding: 5px 18px;\n  border-radius: 40px;\n  border: 1px solid #ffd700;\n}\n.machine-container {\n  display: flex;\n  justify-content: center;\n  align-items: center;\n  margin-top: 180px;\n  position: relative;\n}\n.machine {\n  position: relative;\n  width: 350px;\n  height: 350px;\n}\n.frame {\n  position: absolute;\n  top: 0;\n  left: 0;\n  width: 100%;\n  height: 100%;\n  z-index: 3;\n  pointer-events: none;\n  transform: scale(1.25);\n  transform-origin: center;\n}\n.reels {\n  position: absolute;\n  top: 28px;\n  left: -8px;\n  width: 365px;\n  height: 350px;\n  display: flex;\n  gap: 10px;\n  overflow: hidden;\n  z-index: 2;\n}\n.reel {\n  display: flex;\n  flex-direction: column;\n  width: 85px;\n  align-items: center;\n}\n.reel img {\n  width: 85px;\n  height: 85px;\n  object-fit: contain;\n  margin-bottom: 18px;\n  border-radius: 12px;\n}\n.sidebar {\n  position: absolute;\n  right: 5px;\n  top: 50%;\n  transform: translateY(-50%);\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  z-index: 4;\n}\n.sidebtn {\n  background: linear-gradient(180deg, #9c27b0, #4a148c);\n  padding: 12px 8px;\n  border-radius: 8px;\n  color: white;\n  text-align: center;\n  font-size: 12px;\n  border: 1px solid #ffffff50;\n  cursor: pointer;\n}\n.controls {\n  position: fixed;\n  bottom: 50px;\n  width: 100%;\n  display: flex;\n  justify-content: center;\n  align-items: center;\n  padding: 10px 15px;\n  z-index: 10;\n}\n.bet-bar {\n  position: relative;\n  width: 90%;\n  max-width: 520px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 10px;\n}\n.bet-bar img {\n  width: 70%;\n  transform: scale(1.5);\n}\n.bet-controls {\n  display: flex;\n  gap: 15px;\n  background: rgba(0,0,0,0.7);\n  border-radius: 50px;\n  padding: 5px 15px;\n  border: 1px solid gold;\n}\n.bet-controls button {\n  background: none;\n  border: none;\n  font-size: 28px;\n  font-weight: bold;\n  color: #ffd966;\n  cursor: pointer;\n  font-family: 'Orbitron', monospace;\n  width: 40px;\n  text-align: center;\n}\n.bet-controls span {\n  font-size: 24px;\n  font-weight: bold;\n  color: white;\n  min-width: 50px;\n  text-align: center;\n}\n.bet-text {\n  position: absolute;\n  width: 100%;\n  top: 50%;\n  transform: translateY(-50%);\n  text-align: center;\n  color: white;\n  font-weight: bold;\n  font-size: 20px;\n  pointer-events: none;\n}\n.spin-btn {\n  position: absolute;\n  right: 15px;\n  bottom: 15px;\n  width: 28%;\n  max-width: 180px;\n  z-index: 20;\n}\n.spin-btn img {\n  width: 100%;\n  cursor: pointer;\n}\n#winOverlay {\n  display: none;\n  position: fixed;\n  top: 0;\n  left: 0;\n  width: 100%;\n  height: 100%;\n  background: rgba(0,0,0,0.9);\n  z-index: 1000;\n  flex-direction: column;\n  justify-content: center;\n  align-items: center;\n}\n.win-box {\n  text-align: center;\n  animation: popIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);\n  background: linear-gradient(145deg,#2a1f0e,#1a1207);\n  padding: 30px 50px;\n  border-radius: 70px;\n  border: 3px solid gold;\n}\n.win-title {\n  font-size: 54px;\n  background: linear-gradient(to bottom,#fff700,#ff8c00);\n  -webkit-background-clip: text;\n  -webkit-text-fill-color: transparent;\n  margin: 0;\n}\n.win-amount {\n  font-size: 40px;\n  color: white;\n  margin: 20px 0;\n}\n.collect-btn {\n  padding: 15px 50px;\n  background: linear-gradient(180deg,#ffb300,#fb8c00);\n  border: none;\n  border-radius: 50px;\n  font-weight: bold;\n  cursor: pointer;\n}\n.glow {\n  filter: drop-shadow(0 0 15px gold) brightness(1.2);\n  transform: scale(1.05);\n}\n.modal {\n  display: none;\n  position: fixed;\n  top: 0;\n  left: 0;\n  width: 100%;\n  height: 100%;\n  background: rgba(0,0,0,0.85);\n  backdrop-filter: blur(8px);\n  z-index: 2000;\n  justify-content: center;\n  align-items: center;\n}\n.modal-content {\n  background: linear-gradient(145deg,#2a2418,#1a1408);\n  border: 2px solid #f5bc70;\n  border-radius: 50px;\n  padding: 30px;\n  text-align: center;\n  width: 90%;\n  max-width: 380px;\n}\n.refer-code-box {\n  background: #000;\n  font-size: 28px;\n  letter-spacing: 4px;\n  padding: 15px;\n  border-radius: 30px;\n  border: 1px solid gold;\n  color: gold;\n  margin: 15px 0;\n}\n.casino-input, .casino-select {\n  width: 100%;\n  padding: 12px;\n  margin: 10px 0;\n  background: #1e1a0e;\n  border: 1px solid #e4b83e;\n  border-radius: 40px;\n  color: white;\n  text-align: center;\n}\n.casino-btn {\n  background: linear-gradient(180deg,#ffb300,#fb8c00);\n  border: none;\n  border-radius: 40px;\n  padding: 12px 25px;\n  margin: 8px;\n  font-weight: bold;\n  cursor: pointer;\n}\n@keyframes popIn {\n  0% { transform: scale(0.2); opacity: 0; }\n  80% { transform: scale(1.05); }\n  100% { transform: scale(1); opacity: 1; }\n}\n</style>\n</head>\n<body oncontextmenu=\"return false;\">\n<div class=\"topbar\">\n  <div>👤 <span id=\"username\">Player</span></div>\n  <div class=\"coins\">💰 <span id=\"coins\">0.00</span></div>\n</div>\n<div class=\"machine-container\">\n  <div class=\"machine\">\n    <img src=\"https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/frame.png\" class=\"frame\">\n    <div class=\"reels\">\n      <div class=\"reel\" id=\"r1\"></div>\n      <div class=\"reel\" id=\"r2\"></div>\n      <div class=\"reel\" id=\"r3\"></div>\n    </div>\n  </div>\n  <div class=\"sidebar\">\n    <div class=\"sidebtn\" id=\"referBtn\">🔗 REFER</div>\n    <div class=\"sidebtn\" id=\"redeemBtn\">🎁 REDEEM</div>\n  </div>\n</div>\n<div class=\"controls\">\n  <div class=\"bet-bar\">\n    <img src=\"https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/bet-bar.png\">\n    <div class=\"bet-text\">BET</div>\n    <div class=\"bet-controls\">\n      <button id=\"betMinus\">-</button>\n      <span id=\"betValue\">1</span>\n      <button id=\"betPlus\">+</button>\n    </div>\n  </div>\n  <div class=\"spin-btn\" id=\"spinBtn\">\n    <img src=\"https://cdn.jsdelivr.net/gh/agtechnical3560545-ops/lucky-gems-telegram@main/spin-btn.png\">\n  </div>\n</div>\n<div id=\"winOverlay\">\n  <div class=\"win-box\">\n    <h1 class=\"win-title\">BIG WIN!</h1>\n    <div class=\"win-amount\" id=\"winLabel\">+0</div>\n    <button class=\"collect-btn\" id=\"collectBtn\">COLLECT</button>\n  </div>\n</div>\n<div id=\"referModal\" class=\"modal\">\n  <div class=\"modal-content\">\n    <div style=\"font-size:24px;\">🔗 YOUR REFERRAL LINK</div>\n    <div class=\"refer-code-box\" id=\"referLinkDisplay\">Loading...</div>\n    <button class=\"casino-btn\" id=\"copyReferLink\">COPY LINK</button>\n    <button class=\"casino-btn\" id=\"closeReferModal\">CLOSE</button>\n  </div>\n</div>\n<div id=\"redeemModal\" class=\"modal\">\n  <div class=\"modal-content\">\n    <div style=\"font-size:24px;\">🎁 REDEEM</div>\n    <select id=\"redeemType\" class=\"casino-select\">\n      <option value=\"amazon\">Amazon Gift Voucher (500 coins)</option>\n      <option value=\"googleplay\">Google Play Voucher (500 coins)</option>\n      <option value=\"freediamond\">Free Fire 500 Diamonds (420 coins)</option>\n    </select>\n    <div id=\"emailField\"><input type=\"email\" id=\"redeemEmail\" placeholder=\"Email\" class=\"casino-input\"></div>\n    <div id=\"uidField\" style=\"display:none\"><input type=\"text\" id=\"redeemUid\" placeholder=\"Free Fire UID\" class=\"casino-input\"></div>\n    <button id=\"submitRedeem\" class=\"casino-btn\">REDEEM</button>\n    <button id=\"closeRedeemModal\" class=\"casino-btn\">CANCEL</button>\n    <p id=\"redeemMsg\"></p>\n  </div>\n</div>\n<script>\nconst tg = window.Telegram.WebApp;\ntg.expand();\ntg.ready();\n\nlet userId = null;\nlet currentCoins = 0;\nlet currentBet = 1;\nlet isSpinning = false;\nlet bigWinAmount = 0;\n\nconst gemsList = " + JSON.stringify(GEMS) + ";\n\nfunction createReelDom(id, arr) {\n  const reel = document.getElementById(id);\n  reel.innerHTML = \"\";\n  arr.forEach(src => {\n    let img = document.createElement(\"img\");\n    img.src = src;\n    reel.appendChild(img);\n  });\n}\n\nfunction randomReel() {\n  let count = {};\n  gemsList.forEach(g => count[g] = 0);\n  let arr = [];\n  while (arr.length < 15) {\n    let g = gemsList[Math.floor(Math.random() * gemsList.length)];\n    if (count[g] < 3) {\n      arr.push(g);\n      count[g]++;\n    }\n  }\n  arr.sort(() => Math.random() - 0.5);\n  return arr;\n}\n\nfunction initReels() {\n  for (let i = 1; i <= 3; i++) createReelDom('r' + i, randomReel());\n}\ninitReels();\n\nfunction updateCoins() {\n  document.getElementById(\"coins\").innerText = currentCoins.toFixed(2);\n}\n\nfunction enableSpin(en) {\n  const btn = document.getElementById(\"spinBtn\");\n  btn.style.pointerEvents = en ? \"auto\" : \"none\";\n  btn.style.opacity = en ? \"1\" : \"0.6\";\n}\n\nasync function animateSpin(finalMatrix) {\n  return new Promise(resolve => {\n    let spins = 0;\n    const interval = setInterval(() => {\n      for (let i = 1; i <= 3; i++) {\n        createReelDom('r' + i, randomReel());\n      }\n      spins++;\n      if (spins >= 20) {\n        clearInterval(interval);\n        for (let col = 0; col < 3; col++) {\n          let colImgs = [];\n          for (let row = 0; row < 3; row++) {\n            colImgs.push(finalMatrix[row][col]);\n          }\n          let full = [...colImgs, ...colImgs, ...colImgs, ...colImgs, ...colImgs].slice(0, 15);\n          createReelDom('r' + (col + 1), full);\n        }\n        resolve();\n      }\n    }, 50);\n  });\n}\n\nfunction highlightWins(mat) {\n  document.querySelectorAll('.glow').forEach(el => el.classList.remove('glow'));\n  for (let row = 0; row < 3; row++) {\n    const [a, b, c] = mat[row];\n    if (a === b && b === c) {\n      for (let col = 0; col < 3; col++) {\n        let el = document.getElementById('r' + (col + 1)).children[row];\n        if (el) el.classList.add('glow');\n      }\n    } else if (a === b || b === c || a === c) {\n      let pairs = [];\n      if (a === b) pairs.push([0, 1]);\n      if (b === c) pairs.push([1, 2]);\n      if (a === c) pairs.push([0, 2]);\n      for (let pair of pairs) {\n        for (let col of pair) {\n          let el = document.getElementById('r' + (col + 1)).children[row];\n          if (el) el.classList.add('glow');\n        }\n      }\n    }\n  }\n}\n\nfunction smoothCoins(target, cb) {\n  let start = currentCoins;\n  let step = Math.max(0.05, (target - start) / 20);\n  let it = setInterval(() => {\n    start += step;\n    if (start >= target) {\n      clearInterval(it);\n      currentCoins = target;\n      updateCoins();\n      if (cb) cb();\n    } else {\n      currentCoins = start;\n      updateCoins();\n    }\n  }, 30);\n}\n\nfunction showBigWin(amt) {\n  document.getElementById(\"winLabel\").innerText = \"+\" + amt.toFixed(2) + \" COINS\";\n  document.getElementById(\"winOverlay\").style.display = \"flex\";\n  bigWinAmount = amt;\n}\n\nfunction closeWin() {\n  document.getElementById(\"winOverlay\").style.display = \"none\";\n  smoothCoins(currentCoins + bigWinAmount, () => {\n    isSpinning = false;\n    enableSpin(true);\n  });\n  bigWinAmount = 0;\n}\n\nasync function spin() {\n  if (isSpinning) return;\n  isSpinning = true;\n  enableSpin(false);\n  try {\n    const res = await fetch('/api/spin', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ userId, bet: currentBet })\n    });\n    const data = await res.json();\n    if (!res.ok) throw new Error(data.error);\n    currentCoins = data.newCoins - data.win;\n    updateCoins();\n    await animateSpin(data.matrix);\n    highlightWins(data.matrix);\n    if (data.win > 0) {\n      if (data.win >= 15) showBigWin(data.win);\n      else smoothCoins(currentCoins + data.win, () => {\n        isSpinning = false;\n        enableSpin(true);\n        document.querySelectorAll('.glow').forEach(el => el.classList.remove('glow'));\n      });\n    } else {\n      isSpinning = false;\n      enableSpin(true);\n      document.querySelectorAll('.glow').forEach(el => el.classList.remove('glow'));\n    }\n  } catch (e) {\n    alert(\"Spin error: \" + e.message);\n    console.error(e);\n    isSpinning = false;\n    enableSpin(true);\n  }\n}\n\nasync function initAuth() {\n  const u = tg.initDataUnsafe?.user;\n  if (!u) {\n    alert(\"Open from Telegram\");\n    return;\n  }\n  const telegramId = u.id.toString();\n  const urlParams = new URLSearchParams(location.search);\n  const ref = urlParams.get('startapp');\n  const res = await fetch('/api/auth', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ telegramId, referCode: ref })\n  });\n  const data = await res.json();\n  userId = data.userId;\n  currentCoins = data.coins;\n  updateCoins();\n  document.getElementById(\"username\").innerText = u.first_name || \"Player\";\n  const botUsername = u.username || \"lucky_gems_bot\";\n  window.referralLink = `https://t.me/${botUsername}?startapp=${data.referralCode}`;\n}\n\n// Bet controls\ndocument.getElementById(\"betPlus\").onclick = () => {\n  if (currentBet < 10) {\n    currentBet++;\n    document.getElementById(\"betValue\").innerText = currentBet;\n  }\n};\ndocument.getElementById(\"betMinus\").onclick = () => {\n  if (currentBet > 1) {\n    currentBet--;\n    document.getElementById(\"betValue\").innerText = currentBet;\n  }\n};\n\n// Referral modal\ndocument.getElementById(\"referBtn\").onclick = () => {\n  document.getElementById(\"referLinkDisplay\").innerText = window.referralLink || \"Loading...\";\n  document.getElementById(\"referModal\").style.display = \"flex\";\n};\ndocument.getElementById(\"copyReferLink\").onclick = () => {\n  const link = window.referralLink;\n  if (link) {\n    navigator.clipboard.writeText(link);\n    alert(\"Referral link copied!\");\n  } else {\n    alert(\"Loading, please try again.\");\n  }\n};\ndocument.getElementById(\"closeReferModal\").onclick = () => {\n  document.getElementById(\"referModal\").style.display = \"none\";\n};\n\n// Redeem modal\ndocument.getElementById(\"redeemBtn\").onclick = () => {\n  document.getElementById(\"redeemModal\").style.display = \"flex\";\n  document.getElementById(\"redeemMsg\").innerText = \"\";\n};\ndocument.getElementById(\"closeRedeemModal\").onclick = () => {\n  document.getElementById(\"redeemModal\").style.display = \"none\";\n};\ndocument.getElementById(\"redeemType\").onchange = function() {\n  if (this.value === \"freediamond\") {\n    document.getElementById(\"emailField\").style.display = \"none\";\n    document.getElementById(\"uidField\").style.display = \"block\";\n  } else {\n    document.getElementById(\"emailField\").style.display = \"block\";\n    document.getElementById(\"uidField\").style.display = \"none\";\n  }\n};\ndocument.getElementById(\"submitRedeem\").onclick = async () => {\n  const type = document.getElementById(\"redeemType\").value;\n  let email = null, uid = null;\n  if (type === \"freediamond\") {\n    uid = document.getElementById(\"redeemUid\").value;\n    if (!uid) { alert(\"Enter UID\"); return; }\n  } else {\n    email = document.getElementById(\"redeemEmail\").value;\n    if (!email) { alert(\"Enter email\"); return; }\n  }\n  const res = await fetch('/api/redeem', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ userId, type, email, uid })\n  });\n  const data = await res.json();\n  if (res.ok) {\n    currentCoins = data.newCoins;\n    updateCoins();\n    alert(\"Redemption request submitted!\");\n    document.getElementById(\"redeemModal\").style.display = \"none\";\n  } else {\n    alert(data.error);\n  }\n};\n\ndocument.getElementById(\"spinBtn\").addEventListener(\"click\", spin);\ndocument.getElementById(\"collectBtn\").addEventListener(\"click\", closeWin);\n\ninitAuth();\n</script>\n</body>\n</html>";

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
