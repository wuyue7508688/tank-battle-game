const { spawn } = require("child_process");
const { chromium } = require("playwright");

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

async function fillNickname(page, name) {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.fill("#nicknameInput", name);
  await page.click("#nicknameForm button");
  await page.waitForSelector("#lobbyView:not(.hidden)");
}

async function main() {
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
  const guest = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    await fillNickname(host, "红方UI");
    await host.click("#createRoomForm button");
    await host.waitForSelector("#roomView:not(.hidden)");
    const roomCode = await host.textContent("#roomCodeLabel");
    if (!roomCode || roomCode.trim().length !== 4) {
      throw new Error(`房间码异常: ${roomCode}`);
    }

    await fillNickname(guest, "蓝方UI");
    await guest.fill("#roomCodeInput", roomCode.trim());
    await guest.click("#joinCodeForm button");
    await guest.waitForSelector("#roomView:not(.hidden)");

    await host.click("#joinRedButton");
    await guest.click("#joinBlueButton");
    await host.waitForFunction(() => document.querySelector("#redPlayers")?.textContent.includes("红方UI"));
    await guest.waitForFunction(() => document.querySelector("#bluePlayers")?.textContent.includes("蓝方UI"));

    await host.click("#startGameButton");
    await host.waitForSelector("#gameView:not(.hidden)", { timeout: 5000 });
    await guest.waitForSelector("#gameView:not(.hidden)", { timeout: 5000 });
    await host.waitForSelector("canvas", { timeout: 8000 });
    await guest.waitForSelector("canvas", { timeout: 8000 });

    await host.keyboard.down("D");
    await host.mouse.move(900, 450);
    await host.mouse.down();
    await host.waitForTimeout(800);
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

    await host.keyboard.down("Tab");
    await host.waitForSelector("#scoreboard:not(.hidden)");
    await host.keyboard.up("Tab");
  } finally {
    await browser.close();
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
