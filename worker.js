// Cloudflare Workers с Durable Objects для мультиплеерной игры

export class GameRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.sessions = new Map();
        this.players = {};
        this.bullets = [];
        this.bulletId = 0;
        this.lastUpdate = Date.now();
        
        // Цвета кораблей
        this.shipColors = ['#0ff', '#f0f', '#ff0', '#0f0', '#f80', '#80f', '#08f', '#f00'];
        this.colorIndex = 0;
    }

    async fetch(request) {
        const url = new URL(request.url);
        
        if (url.pathname === '/ws') {
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected WebSocket', { status: 400 });
            }
            
            const pair = new WebSocketPair();
            await this.handleSession(pair[1]);
            
            return new Response(null, { status: 101, webSocket: pair[0] });
        }
        
        return new Response('Not found', { status: 404 });
    }

    async handleSession(webSocket) {
        webSocket.accept();
        
        const playerId = crypto.randomUUID();
        const session = { 
            webSocket, 
            id: playerId,
            lastInput: null
        };
        
        this.sessions.set(playerId, session);
        
        webSocket.addEventListener('message', async (event) => {
            try {
                const data = JSON.parse(event.data);
                await this.handleMessage(playerId, data);
            } catch (e) {
                console.error('Error handling message:', e);
            }
        });
        
        webSocket.addEventListener('close', () => {
            this.sessions.delete(playerId);
            delete this.players[playerId];
            this.broadcast({ type: 'update', players: this.players, bullets: this.bullets });
        });
        
        webSocket.addEventListener('error', () => {
            this.sessions.delete(playerId);
            delete this.players[playerId];
        });
    }

    async handleMessage(playerId, data) {
        const session = this.sessions.get(playerId);
        if (!session) return;
        
        switch (data.type) {
            case 'join':
                // Создаем нового игрока
                const spawnX = 500 + Math.random() * 1000;
                const spawnY = 500 + Math.random() * 1000;
                
                this.players[playerId] = {
                    id: playerId,
                    name: data.name?.substring(0, 15) || 'Пилот',
                    x: spawnX,
                    y: spawnY,
                    angle: 0,
                    vx: 0,
                    vy: 0,
                    health: 100,
                    score: 0,
                    kills: 0,
                    color: this.shipColors[this.colorIndex++ % this.shipColors.length],
                    thrust: false,
                    lastShot: 0
                };
                
                // Отправляем игроку его данные
                session.webSocket.send(JSON.stringify({
                    type: 'init',
                    id: playerId,
                    player: this.players[playerId],
                    players: this.players
                }));
                
                // Запускаем игровой цикл если не запущен
                this.startGameLoop();
                break;
                
            case 'input':
                session.lastInput = data;
                break;
                
            case 'shoot':
                this.playerShoot(playerId);
                break;
        }
    }

    playerShoot(playerId) {
        const player = this.players[playerId];
        if (!player) return;
        
        const now = Date.now();
        if (now - player.lastShot < 200) return; // Cooldown
        player.lastShot = now;
        
        const speed = 15;
        this.bullets.push({
            id: this.bulletId++,
            owner: playerId,
            x: player.x + Math.cos(player.angle) * 30,
            y: player.y + Math.sin(player.angle) * 30,
            vx: Math.cos(player.angle) * speed + player.vx * 0.3,
            vy: Math.sin(player.angle) * speed + player.vy * 0.3,
            life: 100
        });
    }

    startGameLoop() {
        if (this.gameLoopRunning) return;
        this.gameLoopRunning = true;
        
        const tick = async () => {
            if (this.sessions.size === 0) {
                this.gameLoopRunning = false;
                return;
            }
            
            this.update();
            this.broadcast({ type: 'update', players: this.players, bullets: this.bullets });
            
            // ~30 FPS
            setTimeout(tick, 33);
        };
        
        tick();
    }

    update() {
        const thrust = 0.3;
        const friction = 0.98;
        const maxSpeed = 12;
        
        // Обновляем игроков
        for (const [playerId, session] of this.sessions) {
            const player = this.players[playerId];
            if (!player) continue;
            
            const input = session.lastInput;
            if (input) {
                player.angle = input.angle || 0;
                player.thrust = false;
                
                if (input.keys) {
                    if (input.keys.up) { 
                        player.vy -= thrust; 
                        player.thrust = true; 
                    }
                    if (input.keys.down) { 
                        player.vy += thrust; 
                    }
                    if (input.keys.left) { 
                        player.vx -= thrust; 
                    }
                    if (input.keys.right) { 
                        player.vx += thrust; 
                    }
                    if (input.keys.boost) {
                        player.vx += Math.cos(player.angle) * 0.5;
                        player.vy += Math.sin(player.angle) * 0.5;
                        player.thrust = true;
                    }
                }
            }
            
            // Физика
            player.vx *= friction;
            player.vy *= friction;
            
            // Ограничение скорости
            const speed = Math.sqrt(player.vx ** 2 + player.vy ** 2);
            if (speed > maxSpeed) {
                player.vx = (player.vx / speed) * maxSpeed;
                player.vy = (player.vy / speed) * maxSpeed;
            }
            
            player.x += player.vx;
            player.y += player.vy;
            
            // Границы карты
            player.x = Math.max(0, Math.min(2000, player.x));
            player.y = Math.max(0, Math.min(2000, player.y));
        }
        
        // Обновляем пули
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const bullet = this.bullets[i];
            bullet.x += bullet.vx;
            bullet.y += bullet.vy;
            bullet.life--;
            
            if (bullet.life <= 0 || bullet.x < -100 || bullet.x > 2100 || 
                bullet.y < -100 || bullet.y > 2100) {
                this.bullets.splice(i, 1);
                continue;
            }
            
            // Проверка попаданий
            for (const [playerId, player] of Object.entries(this.players)) {
                if (playerId === bullet.owner) continue;
                
                const dx = bullet.x - player.x;
                const dy = bullet.y - player.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                
                if (dist < 25) {
                    player.health -= 15;
                    this.bullets.splice(i, 1);
                    
                    // Отправляем событие попадания
                    this.broadcast({ type: 'hit', x: bullet.x, y: bullet.y });
                    
                    if (player.health <= 0) {
                        // Игрок убит
                        const killer = this.players[bullet.owner];
                        if (killer) {
                            killer.kills++;
                            killer.score += 100;
                        }
                        
                        this.broadcast({ 
                            type: 'kill', 
                            killer: killer?.name || 'Unknown',
                            victim: player.name,
                            x: player.x,
                            y: player.y
                        });
                        
                        // Респавн
                        player.x = 500 + Math.random() * 1000;
                        player.y = 500 + Math.random() * 1000;
                        player.health = 100;
                        player.vx = 0;
                        player.vy = 0;
                    }
                    break;
                }
            }
        }
    }

    broadcast(message) {
        const data = JSON.stringify(message);
        for (const [, session] of this.sessions) {
            try {
                session.webSocket.send(data);
            } catch (e) {
                // Ignore send errors
            }
        }
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        
        // Serve static files
        if (url.pathname === '/' || url.pathname === '/index.html') {
            return new Response(HTML_CONTENT, {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }
        
        // WebSocket connection
        if (url.pathname === '/ws') {
            const roomId = env.GAME_ROOM.idFromName('main-room');
            const room = env.GAME_ROOM.get(roomId);
            return room.fetch(request);
        }
        
        return new Response('Not Found', { status: 404 });
    }
};

// HTML будет встроен при сборке или можно использовать отдельно
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Space Battle Online</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #000; overflow: hidden; font-family: 'Segoe UI', sans-serif; }
        #gameCanvas { display: block; background: radial-gradient(ellipse at center, #1a1a2e 0%, #0f0f1a 100%); }
        #ui { position: fixed; top: 20px; left: 20px; color: #0ff; font-size: 16px; text-shadow: 0 0 10px #0ff; z-index: 100; }
        #health-bar { width: 200px; height: 20px; background: rgba(255,0,0,0.3); border: 2px solid #f00; border-radius: 10px; overflow: hidden; margin-top: 10px; }
        #health-fill { height: 100%; background: linear-gradient(90deg, #f00, #ff0); transition: width 0.3s; }
        #scoreboard { position: fixed; top: 20px; right: 20px; color: #0f0; font-size: 14px; text-shadow: 0 0 10px #0f0; text-align: right; }
        #connection-status { position: fixed; bottom: 20px; left: 20px; padding: 10px 20px; border-radius: 20px; font-size: 14px; }
        .connected { background: rgba(0,255,0,0.3); color: #0f0; }
        .disconnected { background: rgba(255,0,0,0.3); color: #f00; }
        #start-screen { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); display: flex; flex-direction: column; justify-content: center; align-items: center; z-index: 200; }
        #start-screen h1 { font-size: 60px; color: #0ff; text-shadow: 0 0 30px #0ff, 0 0 60px #0ff; margin-bottom: 20px; }
        #start-screen p { color: #888; margin-bottom: 30px; }
        #name-input { padding: 15px 30px; font-size: 18px; background: rgba(0,255,255,0.1); border: 2px solid #0ff; color: #0ff; border-radius: 10px; outline: none; margin-bottom: 20px; text-align: center; }
        #start-btn { padding: 15px 50px; font-size: 20px; background: linear-gradient(135deg, #0ff, #00f); border: none; color: #fff; border-radius: 30px; cursor: pointer; transition: all 0.3s; }
        #start-btn:hover { transform: scale(1.1); box-shadow: 0 0 30px #0ff; }
        #controls { margin-top: 40px; color: #666; font-size: 14px; text-align: center; }
        #kill-feed { position: fixed; bottom: 100px; left: 20px; color: #ff0; font-size: 14px; }
        .kill-msg { opacity: 0; animation: fadeIn 0.3s forwards, fadeOut 0.5s 3s forwards; margin-bottom: 5px; }
        @keyframes fadeIn { to { opacity: 1; } }
        @keyframes fadeOut { to { opacity: 0; } }
    </style>
</head>
<body>
    <div id="start-screen">
        <h1>🚀 SPACE BATTLE</h1>
        <p>Многопользовательские космические бои</p>
        <input type="text" id="name-input" placeholder="Ваше имя" maxlength="15">
        <button id="start-btn">ИГРАТЬ</button>
        <div id="controls"><p>WASD - движение | ЛКМ - стрелять | SPACE - ускорение</p></div>
    </div>
    <canvas id="gameCanvas"></canvas>
    <div id="ui">
        <div id="player-name">Игрок</div>
        <div>Очки: <span id="score">0</span></div>
        <div>Убийства: <span id="kills">0</span></div>
        <div id="health-bar"><div id="health-fill" style="width: 100%"></div></div>
    </div>
    <div id="scoreboard"></div>
    <div id="connection-status" class="disconnected">Отключено</div>
    <div id="kill-feed"></div>
    <script>
        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        let ws = null, playerId = null, playerName = 'Игрок', players = {}, bullets = [], stars = [], explosions = [], myShip = null, keys = {}, mousePos = { x: 0, y: 0 }, gameStarted = false, lastShot = 0;
        const SHOOT_COOLDOWN = 200;
        for (let i = 0; i < 200; i++) stars.push({ x: Math.random() * 3000 - 500, y: Math.random() * 3000 - 500, size: Math.random() * 2 + 0.5, brightness: Math.random() });
        const shipColors = ['#0ff', '#f0f', '#ff0', '#0f0', '#f80', '#80f', '#0ff', '#f00'];
        function connect() {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + location.host + '/ws');
            ws.onopen = () => { document.getElementById('connection-status').textContent = 'Подключено'; document.getElementById('connection-status').className = 'connected'; ws.send(JSON.stringify({ type: 'join', name: playerName })); };
            ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
            ws.onclose = () => { document.getElementById('connection-status').textContent = 'Отключено'; document.getElementById('connection-status').className = 'disconnected'; setTimeout(connect, 2000); };
            ws.onerror = () => { if (!playerId) { playerId = 'local_' + Math.random().toString(36).substr(2, 9); myShip = { id: playerId, name: playerName, x: canvas.width / 2, y: canvas.height / 2, angle: 0, vx: 0, vy: 0, health: 100, score: 0, kills: 0, color: shipColors[Math.floor(Math.random() * shipColors.length)] }; players[playerId] = myShip; } };
        }
        function handleMessage(data) {
            switch(data.type) {
                case 'init': playerId = data.id; myShip = data.player; players = data.players; break;
                case 'update': players = data.players; bullets = data.bullets || []; if (players[playerId]) { myShip = players[playerId]; document.getElementById('score').textContent = myShip.score; document.getElementById('kills').textContent = myShip.kills; document.getElementById('health-fill').style.width = myShip.health + '%'; } break;
                case 'kill': addKillMessage(data.killer, data.victim); createExplosion(data.x, data.y); break;
                case 'hit': createSmallExplosion(data.x, data.y); break;
            }
            updateScoreboard();
        }
        function addKillMessage(killer, victim) { const feed = document.getElementById('kill-feed'); const msg = document.createElement('div'); msg.className = 'kill-msg'; msg.innerHTML = '<span style="color:#0f0">' + killer + '</span> уничтожил <span style="color:#f00">' + victim + '</span>'; feed.appendChild(msg); setTimeout(() => msg.remove(), 4000); }
        function createExplosion(x, y) { for (let i = 0; i < 30; i++) explosions.push({ x, y, vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.5) * 10, life: 60, color: ['#ff0', '#f80', '#f00', '#fff'][Math.floor(Math.random() * 4)], size: Math.random() * 5 + 2 }); }
        function createSmallExplosion(x, y) { for (let i = 0; i < 10; i++) explosions.push({ x, y, vx: (Math.random() - 0.5) * 5, vy: (Math.random() - 0.5) * 5, life: 20, color: '#ff0', size: Math.random() * 3 + 1 }); }
        function updateScoreboard() { const sorted = Object.values(players).sort((a, b) => b.score - a.score).slice(0, 5); let html = '<h3 style="margin-bottom:10px">🏆 Таблица лидеров</h3>'; sorted.forEach((p, i) => { html += '<div style="color:' + (p.id === playerId ? '#0ff' : '#0f0') + '">' + (i+1) + '. ' + p.name + ': ' + p.score + '</div>'; }); document.getElementById('scoreboard').innerHTML = html; }
        function sendInput() { if (!ws || ws.readyState !== WebSocket.OPEN || !myShip) return; ws.send(JSON.stringify({ type: 'input', keys: { up: keys['w'] || keys['ц'], down: keys['s'] || keys['ы'], left: keys['a'] || keys['ф'], right: keys['d'] || keys['в'], boost: keys[' '] }, angle: Math.atan2(mousePos.y - canvas.height/2, mousePos.x - canvas.width/2) })); }
        function shoot() { const now = Date.now(); if (now - lastShot < SHOOT_COOLDOWN) return; lastShot = now; if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'shoot' })); } else if (myShip) { const angle = Math.atan2(mousePos.y - canvas.height/2, mousePos.x - canvas.width/2); bullets.push({ x: myShip.x + Math.cos(angle) * 30, y: myShip.y + Math.sin(angle) * 30, vx: Math.cos(angle) * 15, vy: Math.sin(angle) * 15, owner: playerId, life: 60 }); } }
        function drawShip(player) { ctx.save(); ctx.translate(player.x - (myShip ? myShip.x - canvas.width/2 : 0), player.y - (myShip ? myShip.y - canvas.height/2 : 0)); ctx.rotate(player.angle); ctx.shadowColor = player.color; ctx.shadowBlur = 20; ctx.beginPath(); ctx.moveTo(25, 0); ctx.lineTo(-15, -15); ctx.lineTo(-10, 0); ctx.lineTo(-15, 15); ctx.closePath(); ctx.fillStyle = player.color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); if (player.thrust) { ctx.beginPath(); ctx.moveTo(-10, -5); ctx.lineTo(-25 - Math.random() * 10, 0); ctx.lineTo(-10, 5); ctx.fillStyle = '#f80'; ctx.fill(); } ctx.restore(); ctx.save(); ctx.font = '12px Arial'; ctx.fillStyle = player.color; ctx.textAlign = 'center'; ctx.shadowColor = player.color; ctx.shadowBlur = 10; const sx = player.x - (myShip ? myShip.x - canvas.width/2 : 0), sy = player.y - (myShip ? myShip.y - canvas.height/2 : 0); ctx.fillText(player.name, sx, sy - 35); ctx.fillStyle = '#300'; ctx.fillRect(sx - 25, sy - 30, 50, 5); ctx.fillStyle = player.health > 30 ? '#0f0' : '#f00'; ctx.fillRect(sx - 25, sy - 30, player.health / 2, 5); ctx.restore(); }
        function drawBullet(b) { const sx = b.x - (myShip ? myShip.x - canvas.width/2 : 0), sy = b.y - (myShip ? myShip.y - canvas.height/2 : 0); ctx.save(); ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fillStyle = '#ff0'; ctx.shadowColor = '#ff0'; ctx.shadowBlur = 15; ctx.fill(); ctx.restore(); }
        function drawStars() { stars.forEach(s => { const sx = s.x - (myShip ? myShip.x - canvas.width/2 : 0) * 0.5, sy = s.y - (myShip ? myShip.y - canvas.height/2 : 0) * 0.5; ctx.beginPath(); ctx.arc(sx, sy, s.size, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,' + (0.3 + s.brightness * 0.7) + ')'; ctx.fill(); }); }
        function updateExplosions() { explosions.forEach((e, i) => { e.x += e.vx; e.y += e.vy; e.life--; e.vx *= 0.95; e.vy *= 0.95; if (e.life <= 0) { explosions.splice(i, 1); return; } const sx = e.x - (myShip ? myShip.x - canvas.width/2 : 0), sy = e.y - (myShip ? myShip.y - canvas.height/2 : 0); ctx.beginPath(); ctx.arc(sx, sy, e.size * (e.life / 60), 0, Math.PI * 2); ctx.fillStyle = e.color; ctx.globalAlpha = e.life / 60; ctx.fill(); ctx.globalAlpha = 1; }); }
        function offlineUpdate() { if (!myShip || (ws && ws.readyState === WebSocket.OPEN)) return; const angle = Math.atan2(mousePos.y - canvas.height/2, mousePos.x - canvas.width/2); myShip.angle = angle; const thrust = 0.3; if (keys['w'] || keys['ц']) { myShip.vy -= thrust; myShip.thrust = true; } else if (keys['s'] || keys['ы']) { myShip.vy += thrust; } else { myShip.thrust = false; } if (keys['a'] || keys['ф']) myShip.vx -= thrust; if (keys['d'] || keys['в']) myShip.vx += thrust; if (keys[' ']) { myShip.vx += Math.cos(angle) * 0.5; myShip.vy += Math.sin(angle) * 0.5; myShip.thrust = true; } myShip.vx *= 0.98; myShip.vy *= 0.98; myShip.x += myShip.vx; myShip.y += myShip.vy; players[playerId] = myShip; bullets.forEach((b, i) => { b.x += b.vx; b.y += b.vy; b.life--; if (b.life <= 0) bullets.splice(i, 1); }); }
        function gameLoop() { if (!gameStarted) { requestAnimationFrame(gameLoop); return; } ctx.fillStyle = '#0a0a15'; ctx.fillRect(0, 0, canvas.width, canvas.height); drawStars(); offlineUpdate(); bullets.forEach(drawBullet); Object.values(players).forEach(p => drawShip(p)); updateExplosions(); sendInput(); requestAnimationFrame(gameLoop); }
        document.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
        document.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);
        document.addEventListener('mousemove', e => { mousePos.x = e.clientX; mousePos.y = e.clientY; });
        document.addEventListener('mousedown', e => { if (e.button === 0 && gameStarted) shoot(); });
        document.getElementById('start-btn').addEventListener('click', startGame);
        document.getElementById('name-input').addEventListener('keypress', e => { if (e.key === 'Enter') startGame(); });
        function startGame() { playerName = document.getElementById('name-input').value || 'Пилот'; document.getElementById('player-name').textContent = playerName; document.getElementById('start-screen').style.display = 'none'; gameStarted = true; connect(); }
        window.addEventListener('resize', () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });
        gameLoop();
    </script>
</body>
</html>`;
