export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
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

function calculateWin(matrix: string[][]): number {
  let win = 0;
  for (let row = 0; row < 3; row++) {
    const [a, b, c] = matrix[row];
    if (a === b && b === c) win += 5;
    else if (a === b || b === c || a === c) win += 0.5;
  }
  return win;
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
  const { userId } = await request.json() as any;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });
  if (user.coins < 1) return Response.json({ error: "Insufficient coins" }, { status: 400 });

  let newCoins = user.coins - 1;
  await env.DB.prepare("UPDATE users SET coins = ?, total_spins = total_spins + 1 WHERE id = ?").bind(newCoins, userId).run();

  const matrix = generateMatrix();
  const win = calculateWin(matrix);
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
      replyText = `✨ Welcome back ${message.from?.first_name || "Player"}!\n💰 Coins: ${user.coins}\n🔗 Referral code: \`${user.referral_code}\`\n\nShare code – you both get 10 coins!`;
    }
    const webappUrl = `${env.WEBAPP_URL}?startapp=${user?.referral_code || ""}`;
    const payload = {
      method: "sendMessage",
      chat_id: chatId,
      text: replyText,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "🎰 PLAY LUCKY GEMS", web_app: { url: webappUrl } }]]
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

// HTML_CONTENT – fixed nested backticks issue (using string concatenation instead of template literals inside)
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="hi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Lucky Gems Slot</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;user-select:none;}
body{margin:0;background:url('bg.jpg') no-repeat center center fixed;background-size:cover;height:100vh;overflow:hidden;font-family:'Orbitron',sans-serif;}
.topbar{display:flex;justify-content:space-between;padding:10px 15px;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);color:white;}
.coins{background:#111;padding:5px 18px;border-radius:40px;border:1px solid #ffd700;}
.machine-container{display:flex;justify-content:center;margin-top:180px;position:relative;}
.machine{position:relative;width:350px;height:350px;}
.frame{position:absolute;top:0;left:0;width:100%;height:100%;z-index:3;pointer-events:none;transform:scale(1.25);}
.reels{position:absolute;top:28px;left:-8px;width:365px;height:350px;display:flex;gap:10px;z-index:2;}
.reel{display:flex;flex-direction:column;width:85px;align-items:center;}
.reel img{width:85px;height:85px;object-fit:contain;margin-bottom:18px;border-radius:12px;}
.sidebar-new{position:absolute;right:-70px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:20px;z-index:15;}
.sidebar-btn{background:linear-gradient(145deg,#2a2418,#1a1207);padding:14px 12px;border-radius:60px;font-weight:bold;font-size:14px;text-align:center;color:#ffec9f;border:2px solid #e4b83e;box-shadow:0 8px 0 #5a3e1a;cursor:pointer;width:80px;}
.sidebar-btn:active{transform:translateY(4px);}
.controls{position:fixed;bottom:50px;width:100%;display:flex;justify-content:center;}
.bet-bar{position:relative;width:90%;max-width:520px;}
.bet-bar img{width:100%;transform:scale(1.5);}
.bet-text{position:absolute;width:100%;top:50%;transform:translateY(-50%);text-align:center;color:white;font-weight:bold;font-size:20px;}
.spin-btn{position:absolute;right:15px;bottom:15px;width:28%;max-width:180px;z-index:20;}
.spin-btn img{width:100%;cursor:pointer;}
#winOverlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:1000;justify-content:center;align-items:center;}
.win-box{background:linear-gradient(145deg,#2a1f0e,#1a1207);padding:30px 50px;border-radius:70px;border:3px solid gold;text-align:center;}
.win-title{font-size:54px;background:linear-gradient(to bottom,#fff700,#ff8c00);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.win-amount{font-size:40px;color:white;margin:20px 0;}
.collect-btn{padding:15px 50px;background:linear-gradient(180deg,#ffb300,#fb8c00);border:none;border-radius:50px;font-weight:bold;cursor:pointer;}
.glow{filter:drop-shadow(0 0 15px gold) brightness(1.2);transform:scale(1.05);}
.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);z-index:2000;justify-content:center;align-items:center;}
.modal-content{background:linear-gradient(145deg,#2a2418,#1a1408);border:2px solid #f5bc70;border-radius:50px;padding:30px;text-align:center;width:90%;max-width:380px;}
.refer-code-box{background:#000;font-size:28px;letter-spacing:4px;padding:15px;border-radius:30px;border:1px solid gold;color:gold;margin:15px 0;}
.casino-input,.casino-select{width:100%;padding:12px;margin:10px 0;background:#1e1a0e;border:1px solid #e4b83e;border-radius:40px;color:white;text-align:center;}
.casino-btn{background:linear-gradient(180deg,#ffb300,#fb8c00);border:none;border-radius:40px;padding:12px 25px;margin:8px;font-weight:bold;cursor:pointer;}
</style>
</head>
<body>
<div class="topbar"><div>👤 <span id="username">Player</span></div><div class="coins">💰 <span id="coins">0.00</span></div></div>
<div class="machine-container">
  <div class="machine"><img src="frame.png" class="frame"><div class="reels"><div class="reel" id="r1"></div><div class="reel" id="r2"></div><div class="reel" id="r3"></div></div></div>
  <div class="sidebar-new"><div class="sidebar-btn" id="referBtn">🔗 REFER</div><div class="sidebar-btn" id="redeemBtn">🎁 REDEEM</div></div>
</div>
<div class="controls"><div class="bet-bar"><img src="bet-bar.png"><div class="bet-text">BET 1</div></div><div class="spin-btn" id="spinBtn"><img src="spin-btn.png"></div></div>
<div id="winOverlay"><div class="win-box"><h1 class="win-title">BIG WIN!</h1><div class="win-amount" id="winLabel">+0</div><button class="collect-btn" id="collectBtn">COLLECT</button></div></div>
<div id="referModal" class="modal"><div class="modal-content"><div style="font-size:24px;">🔗 YOUR CODE</div><div class="refer-code-box" id="referCodeDisplay">XXXXXX</div><button class="casino-btn" id="closeReferModal">CLOSE</button></div></div>
<div id="redeemModal" class="modal"><div class="modal-content"><div style="font-size:24px;">🎁 REDEEM</div>
<select id="redeemType" class="casino-select"><option value="amazon">Amazon Voucher (500)</option><option value="googleplay">Google Play (500)</option><option value="freediamond">Free Fire 500💎 (420)</option></select>
<div id="emailField"><input type="email" id="redeemEmail" placeholder="Email" class="casino-input"></div>
<div id="uidField" style="display:none"><input type="text" id="redeemUid" placeholder="Free Fire UID" class="casino-input"></div>
<button id="submitRedeem" class="casino-btn">REDEEM</button><button id="closeRedeemModal" class="casino-btn">CANCEL</button><p id="redeemMsg"></p></div></div>
<script>
const tg = window.Telegram.WebApp; tg.expand(); tg.ready();
let userId = null, currentCoins = 0, isSpinning = false, bigWinAmount = 0;
const gemsList = ${JSON.stringify(GEMS)};
function createReelDom(id, arr) { const reel = document.getElementById(id); reel.innerHTML = ""; arr.forEach(src => { let img = document.createElement("img"); img.src = src; reel.appendChild(img); }); }
function randomReel() { let count = {}; gemsList.forEach(g=>count[g]=0); let arr=[]; while(arr.length<15){ let g=gemsList[Math.floor(Math.random()*gemsList.length)]; if(count[g]<3){arr.push(g); count[g]++;}} arr.sort(()=>Math.random()-0.5); return arr; }
function initReels() { for(let i=1;i<=3;i++) createReelDom('r'+i, randomReel()); } initReels();
function updateCoins() { document.getElementById("coins").innerText = currentCoins.toFixed(2); }
function enableSpin(en) { const btn = document.getElementById("spinBtn"); btn.style.pointerEvents = en ? "auto" : "none"; btn.style.opacity = en ? "1" : "0.6"; }
async function animateSpin(finalMatrix) { return new Promise(resolve => { let spins=0; const int=setInterval(()=>{ for(let i=1;i<=3;i++) createReelDom('r'+i, randomReel()); spins++; if(spins>=20){ clearInterval(int); for(let col=0;col<3;col++){ let colImgs=[]; for(let row=0;row<3;row++) colImgs.push(finalMatrix[row][col]); let full=[...colImgs,...colImgs,...colImgs,...colImgs,...colImgs].slice(0,15); createReelDom('r'+(col+1), full); } resolve(); } },50); }); }
function highlightWins(mat){ document.querySelectorAll('.glow').forEach(el=>el.classList.remove('glow')); for(let row=0;row<3;row++){ const [a,b,c]=mat[row]; if(a===b&&b===c){ for(let col=0;col<3;col++) document.getElementById('r'+(col+1)).children[row]?.classList.add('glow'); } else if(a===b||b===c||a===c){ let pairs=[]; if(a===b) pairs.push([0,1]); if(b===c) pairs.push([1,2]); if(a===c) pairs.push([0,2]); for(let p of pairs) for(let col of p) document.getElementById('r'+(col+1)).children[row]?.classList.add('glow'); } } }
function smoothCoins(target,cb){ let start=currentCoins, step=Math.max(0.05,(target-start)/20); let it=setInterval(()=>{ start+=step; if(start>=target){ clearInterval(it); currentCoins=target; updateCoins(); if(cb)cb(); } else { currentCoins=start; updateCoins(); } },30); }
function showBigWin(amt){ document.getElementById("winLabel").innerText = "+"+amt.toFixed(2)+" COINS"; document.getElementById("winOverlay").style.display="flex"; bigWinAmount=amt; }
function closeWin(){ document.getElementById("winOverlay").style.display="none"; smoothCoins(currentCoins+bigWinAmount,()=>{ isSpinning=false; enableSpin(true); }); bigWinAmount=0; }
async function spin(){ if(isSpinning) return; isSpinning=true; enableSpin(false); try{ const res=await fetch('/api/spin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId})}); const data=await res.json(); if(!res.ok) throw new Error(data.error); currentCoins=data.newCoins-data.win; updateCoins(); await animateSpin(data.matrix); highlightWins(data.matrix); if(data.win>0){ if(data.win>=15) showBigWin(data.win); else smoothCoins(currentCoins+data.win,()=>{ isSpinning=false; enableSpin(true); document.querySelectorAll('.glow').forEach(el=>el.classList.remove('glow')); }); } else { isSpinning=false; enableSpin(true); document.querySelectorAll('.glow').forEach(el=>el.classList.remove('glow')); } } catch(e){ alert("Spin error"); console.error(e); isSpinning=false; enableSpin(true); } }
async function initAuth(){ const u=tg.initDataUnsafe?.user; if(!u){ alert("Open from Telegram"); return; } const telegramId=u.id.toString(); const urlParams=new URLSearchParams(location.search); const ref=urlParams.get('startapp'); const res=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telegramId,referCode:ref})}); const data=await res.json(); userId=data.userId; currentCoins=data.coins; updateCoins(); document.getElementById("username").innerText=u.first_name||"Player"; window.myRefCode=data.referralCode; }
document.getElementById("referBtn").onclick=()=>{ document.getElementById("referCodeDisplay").innerText=window.myRefCode||"LOAD"; document.getElementById("referModal").style.display="flex"; };
document.getElementById("closeReferModal").onclick=()=>document.getElementById("referModal").style.display="none";
document.getElementById("redeemBtn").onclick=()=>document.getElementById("redeemModal").style.display="flex";
document.getElementById("closeRedeemModal").onclick=()=>document.getElementById("redeemModal").style.display="none";
document.getElementById("redeemType").onchange=function(){ if(this.value==="freediamond"){ document.getElementById("emailField").style.display="none"; document.getElementById("uidField").style.display="block"; } else { document.getElementById("emailField").style.display="block"; document.getElementById("uidField").style.display="none"; } };
document.getElementById("submitRedeem").onclick=async()=>{ const type=document.getElementById("redeemType").value; let email=null,uid=null; if(type==="freediamond"){ uid=document.getElementById("redeemUid").value; if(!uid){ alert("Enter UID"); return; } } else { email=document.getElementById("redeemEmail").value; if(!email){ alert("Enter email"); return; } } const res=await fetch('/api/redeem',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,type,email,uid})}); const data=await res.json(); if(res.ok){ currentCoins=data.newCoins; updateCoins(); alert("Redeem request submitted!"); document.getElementById("redeemModal").style.display="none"; } else alert(data.error); };
document.getElementById("spinBtn").addEventListener("click",spin);
document.getElementById("collectBtn").addEventListener("click",closeWin);
initAuth();
</script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/bg.jpg" || path === "/frame.png" || path === "/bet-bar.png" || path === "/spin-btn.png") {
      const object = await env.ASSETS.get(path.slice(1));
      if (!object) return new Response("Not Found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Cache-Control", "public, max-age=86400");
      return new Response(object.body, { headers });
    }

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
