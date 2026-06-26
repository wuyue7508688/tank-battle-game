const { spawn } = require("child_process");
const { chromium } = require("playwright");
const { io } = require("socket.io-client");

const PORT = Number(process.env.UI_TEST_PORT || 3211);
const URL = process.env.TEST_URL || `http://127.0.0.1:${PORT}`;

function waitForOutput(getOutput, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (pattern.test(getOutput())) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待服务器启动超时:\n${getOutput()}`));
      }
    }, 50);
  });
}

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待 ${event} 超时`));
    }, timeoutMs);
    function handler(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, handler);
  });
}

function emitAck(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`等待 ${event} ack 超时`));
    }, timeoutMs);
    const done = (response) => {
      clearTimeout(timer);
      resolve(response);
    };
    if (payload === undefined) socket.emit(event, done);
    else socket.emit(event, payload, done);
  });
}

async function fillNickname(page, name) {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.fill("#nicknameInput", name);
  await page.click("#nicknameForm button");
  await page.waitForSelector("#lobbyView:not(.hidden)");
}

async function main() {
  let guestSocket = null;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  await waitForOutput(() => serverOutput, /本机访问地址/);

  const browser = await chromium.launch({ headless: true });
  const host = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    await fillNickname(host, "红方UI");
    await host.click("#createRoomForm button");
    await host.waitForSelector("#roomView:not(.hidden)");
    const roomCode = await host.textContent("#roomCodeLabel");
    if (!roomCode || roomCode.trim().length !== 4) {
      throw new Error(`房间码异常: ${roomCode}`);
    }

    guestSocket = io(URL, {
      transports: ["websocket"],
      reconnection: false,
    });
    await once(guestSocket, "connect");
    const nickname = await emitAck(guestSocket, "setNickname", "蓝方UI");
    if (!nickname || !nickname.ok) throw new Error("蓝方设置昵称失败");
    const joined = await emitAck(guestSocket, "joinRoomByCode", roomCode.trim());
    if (!joined || !joined.ok) throw new Error("蓝方加入房间失败");

    await host.click("#joinRedButton");
    guestSocket.emit("chooseTeam", "blue");
    await host.waitForFunction(() => document.querySelector("#redPlayers")?.textContent.includes("红方UI"));
    await host.waitForFunction(() => document.querySelector("#bluePlayers")?.textContent.includes("蓝方UI"));

    await host.click("#startGameButton");
    await host.waitForSelector("#gameView:not(.hidden)", { timeout: 5000 });
    await host.waitForSelector("canvas", { timeout: 8000 });

    await host.waitForFunction(() => {
      const snapshot = window.TankGame.getDebugSnapshot && window.TankGame.getDebugSnapshot();
      return snapshot && snapshot.status === "playing";
    }, { timeout: 6000 });

    await host.waitForFunction(() => {
      const snapshot = window.TankGame.getDebugSnapshot && window.TankGame.getDebugSnapshot();
      const self = snapshot && snapshot.players.find((player) => player.id === snapshot.playerId);
      return self && self.bodyWidth >= 48 && self.bodyHeight >= 44 && Math.abs(self.bodyX - self.barrelX) < 1 && Math.abs(self.bodyY - self.barrelY) < 1;
    }, { timeout: 8000 });

    const beforeInput = await host.evaluate(() => {
      const snapshot = window.TankGame.getDebugSnapshot();
      return snapshot.players.find((player) => player.id === snapshot.playerId);
    });
    await host.keyboard.down("D");
    await host.mouse.move(900, 450);
    const movementSamples = [];
    for (let i = 0; i < 10; i += 1) {
      await host.waitForTimeout(80);
      movementSamples.push(await host.evaluate(() => {
        const snapshot = window.TankGame.getDebugSnapshot();
        const self = snapshot.players.find((player) => player.id === snapshot.playerId);
        return { x: self.x, y: self.y };
      }));
    }
    const firstMoveDistance = Math.hypot(movementSamples[1].x - beforeInput.x, movementSamples[1].y - beforeInput.y);
    if (firstMoveDistance < 10) {
      throw new Error(`输入响应太慢: 160ms 内只移动 ${firstMoveDistance.toFixed(2)}px`);
    }
    let backwardSteps = 0;
    for (let i = 1; i < movementSamples.length; i += 1) {
      if (movementSamples[i].x < movementSamples[i - 1].x - 1) backwardSteps += 1;
    }
    if (backwardSteps > 0) {
      throw new Error(`移动抖动: 按住 D 时 x 坐标出现 ${backwardSteps} 次明显倒退 ${JSON.stringify(movementSamples)}`);
    }

    await host.mouse.down();
    await host.waitForTimeout(200);
    await host.mouse.up();
    await host.keyboard.up("D");

    const canvasBox = await host.locator("canvas").boundingBox();
    if (!canvasBox || canvasBox.width < 600 || canvasBox.height < 300) {
      throw new Error("Canvas 尺寸异常");
    }

    const scoreText = await host.textContent("#gameHud");
    if (!scoreText.includes("生命") || !scoreText.includes("地图")) {
      throw new Error("HUD 没有显示生命或地图信息");
    }

    await host.waitForFunction(() => {
      const text = document.querySelector("#hudFps")?.textContent || "";
      return /FPS\s+\d+/.test(text);
    }, { timeout: 6000 });

    await host.waitForTimeout(5000);
    const perfStats = await host.evaluate(() => window.TankGame.getPerformanceStats());
    if (perfStats.sampleCount < 60) {
      throw new Error(`FPS 采样不足: ${JSON.stringify(perfStats)}`);
    }
    if (perfStats.avgFps < 58 || perfStats.p95LowFps < 56 || perfStats.minFps < 50) {
      throw new Error(`FPS 未达标: ${JSON.stringify(perfStats)}`);
    }
    console.log(`FPS 验收: ${JSON.stringify(perfStats)}`);

    await host.keyboard.down("Tab");
    await host.waitForSelector("#scoreboard:not(.hidden)");
    await host.keyboard.up("Tab");
  } finally {
    await browser.close();
    if (guestSocket) guestSocket.disconnect();
    server.kill("SIGTERM");
  }
}

main()
  .then(() => {
    console.log("UI 验收通过");
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
