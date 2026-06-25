const { spawn } = require("child_process");
const { io } = require("socket.io-client");

const PORT = 3210;
const URL = `http://127.0.0.1:${PORT}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function connectPlayer(name) {
  const socket = io(URL, {
    transports: ["websocket"],
    reconnection: false,
  });
  await once(socket, "connect");
  const response = await emitAck(socket, "setNickname", name);
  if (!response || !response.ok) {
    throw new Error(`设置昵称失败: ${name}`);
  }
  return socket;
}

async function connectPlayerExpectRoom(name, previousPlayerId) {
  const socket = io(URL, {
    transports: ["websocket"],
    reconnection: false,
  });
  await once(socket, "connect");
  const roomStatePromise = once(socket, "roomState");
  const response = await emitAck(socket, "setNickname", { nickname: name, previousPlayerId });
  if (!response || !response.ok) {
    throw new Error(`设置昵称失败: ${name}`);
  }
  return { socket, roomState: await roomStatePromise };
}

async function createReadyRoom(red, blue, config) {
  const roomCreated = await emitAck(red, "createRoom", config);
  if (!roomCreated || !roomCreated.ok) throw new Error("创建房间失败");

  const room = roomCreated.room;
  if (!room || !room.code) throw new Error("创建房间没有返回房间码");

  const joined = await emitAck(blue, "joinRoomByCode", room.code);
  if (!joined || !joined.ok) throw new Error("蓝方加入房间失败");

  return room;
}

function latestRoomState(socket) {
  return once(socket, "roomState");
}

async function main() {
  const sockets = [];
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", ALLOW_TEST_LIMITS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForOutput(() => serverOutput, /本机访问地址/);
    if (server.exitCode !== null) {
      throw new Error(`服务器启动失败:\n${serverOutput}`);
    }

    const red = await connectPlayer("红方");
    const blue = await connectPlayer("蓝方");
    sockets.push(red, blue);

    const longName = await emitAck(red, "setNickname", "这是一个超过十二个字符的昵称");
    if (longName && longName.ok) throw new Error("超长昵称不应通过");

    const invalidStartRoom = await createReadyRoom(red, blue, {
      map: "snow",
      mode: "score",
      scoreLimit: 10,
      timeLimit: 180,
    });
    const missingTeamError = once(red, "errorMessage");
    const invalidStart = await emitAck(red, "startGame");
    if (invalidStart && invalidStart.ok) throw new Error("未选队时不应允许开始");
    if ((await missingTeamError) !== "有玩家未选择队伍。") {
      throw new Error("未选队开始提示错误");
    }

    red.emit("leaveRoom");
    blue.emit("leaveRoom");
    await wait(200);

    const mapChecks = [
      ["snow", "ice"],
      ["desert", "quicksand"],
      ["jungle", "grass"],
    ];
    for (const [map, zoneType] of mapChecks) {
      const mapRoom = await createReadyRoom(red, blue, {
        map,
        mode: "score",
        scoreLimit: 10,
        timeLimit: 180,
      });
      if (mapRoom.map !== map) throw new Error(`${map} 地图创建失败`);
      red.emit("chooseTeam", "red");
      blue.emit("chooseTeam", "blue");
      await wait(100);
      const countdownPromise = once(red, "countdown");
      const started = await emitAck(red, "startGame");
      if (!started || !started.ok) throw new Error(`${map} 地图开始失败`);
      await countdownPromise;
      await once(red, "gameStarted", 5000);
      const mapState = await once(red, "gameState", 3000);
      if (!mapState.zones.some((zone) => zone.type === zoneType)) {
        throw new Error(`${map} 地图缺少 ${zoneType} 特殊地形`);
      }
      red.emit("leaveRoom");
      blue.emit("leaveRoom");
      await wait(200);
    }

    const scoreLimitRoom = await createReadyRoom(red, blue, {
      map: "snow",
      mode: "score",
      scoreLimit: 1,
      timeLimit: 180,
    });
    red.emit("chooseTeam", "red");
    blue.emit("chooseTeam", "blue");
    await wait(100);
    let countdownPromise = once(red, "countdown");
    let started = await emitAck(red, "startGame");
    if (!started || !started.ok) throw new Error("分数制测试房间开始失败");
    await countdownPromise;
    await once(red, "gameStarted", 5000);
    const scoreEndPromise = once(red, "gameEnded", 5000);
    const awardPoint = await emitAck(red, "testAwardPoint", "red");
    if (!awardPoint || !awardPoint.ok) throw new Error("测试计分事件失败");
    const scoreEnd = await scoreEndPromise;
    if (scoreEnd.winner !== "red" || scoreEnd.redScore < 1) {
      throw new Error("分数制达到目标分后没有正确结束");
    }

    const endedConfigError = once(red, "errorMessage");
    red.emit("updateRoomConfig", { map: "jungle" });
    if ((await endedConfigError) !== "只有等待中可以修改房间配置。") {
      throw new Error("已结束房间不应允许直接改配置");
    }

    const endedTeamError = once(red, "errorMessage");
    red.emit("chooseTeam", "blue");
    if ((await endedTeamError) !== "只有等待中可以换队。") {
      throw new Error("已结束房间不应允许直接换队");
    }

    const endedStartError = once(red, "errorMessage");
    const endedStart = await emitAck(red, "startGame");
    if (endedStart && endedStart.ok) throw new Error("已结束房间不应直接开始");
    if ((await endedStartError) !== "只有等待中的房间可以开始游戏。") {
      throw new Error("已结束房间直接开始提示错误");
    }

    const afterRestartPromise = once(red, "roomState");
    const restarted = await emitAck(red, "restartGame");
    if (!restarted || !restarted.ok) throw new Error("再来一局失败");
    const afterRestart = await afterRestartPromise;
    if (afterRestart.status !== "waiting") throw new Error("再来一局后房间没有回到等待中");

    red.emit("leaveRoom");
    blue.emit("leaveRoom");
    await wait(200);

    const timeLimitRoom = await createReadyRoom(red, blue, {
      map: "snow",
      mode: "time",
      scoreLimit: 10,
      timeLimit: 1,
    });
    red.emit("chooseTeam", "red");
    blue.emit("chooseTeam", "blue");
    await wait(100);
    countdownPromise = once(red, "countdown");
    started = await emitAck(red, "startGame");
    if (!started || !started.ok) throw new Error("时间制测试房间开始失败");
    await countdownPromise;
    await once(red, "gameStarted", 5000);
    const timeEnd = await once(red, "gameEnded", 5000);
    if (timeEnd.winner !== null || timeEnd.redScore !== 0 || timeEnd.blueScore !== 0) {
      throw new Error("时间制平局结束不正确");
    }
    red.emit("leaveRoom");
    blue.emit("leaveRoom");
    await wait(200);

    const roomCreated = await emitAck(red, "createRoom", {
      map: "snow",
      mode: "score",
      scoreLimit: 10,
      timeLimit: 180,
    });
    if (!roomCreated || !roomCreated.ok) throw new Error("创建房间失败");

    const firstRoom = roomCreated.room;
    if (!firstRoom || !firstRoom.code) throw new Error("创建房间没有返回房间码");

    const joined = await emitAck(blue, "joinRoomByCode", firstRoom.code);
    if (!joined || !joined.ok) throw new Error("蓝方加入房间失败");

    const nonHostConfigError = once(blue, "errorMessage");
    blue.emit("updateRoomConfig", { map: "jungle" });
    if ((await nonHostConfigError) !== "只有房主可以修改房间配置。") {
      throw new Error("非房主配置校验失败");
    }

    red.emit("chooseTeam", "red");
    blue.emit("chooseTeam", "blue");
    await wait(250);

    const finalCountdownPromise = once(red, "countdown");
    const start = await emitAck(red, "startGame");
    if (!start || !start.ok) throw new Error("开始游戏失败");

    const countdown = await finalCountdownPromise;
    if (!countdown.endsAt) throw new Error("没有收到倒计时结束时间");

    const gameStarted = once(red, "gameStarted", 5000);
    await gameStarted;

    red.emit("playerInput", { up: false, down: false, left: false, right: true, angle: 0, firing: true });
    blue.emit("playerInput", { up: false, down: false, left: true, right: false, angle: Math.PI, firing: true });

    const state = await once(red, "gameState", 3000);
    if (state.status !== "playing") throw new Error(`游戏状态错误: ${state.status}`);
    if (!state.players || state.players.length !== 2) throw new Error("游戏玩家数量错误");
    if (!Array.isArray(state.walls) || !state.walls.length) throw new Error("地图墙体未下发");
    if (!Array.isArray(state.zones) || !state.zones.length) throw new Error("特殊地形未下发");

    const latePlayer = await connectPlayer("迟到玩家");
    sockets.push(latePlayer);
    const lateJoinError = once(latePlayer, "errorMessage");
    const lateJoin = await emitAck(latePlayer, "joinRoomByCode", firstRoom.code);
    if (lateJoin && lateJoin.ok) throw new Error("游戏中不应允许加入");
    if ((await lateJoinError) !== "游戏已经开始，不能加入。") {
      throw new Error("游戏中禁止加入提示错误");
    }

    red.disconnect();
    await wait(200);
    const previousRedId = state.players.find((player) => player.nickname === "红方").id;
    const reconnectResult = await connectPlayerExpectRoom("红方", previousRedId);
    const reconnecting = reconnectResult.socket;
    sockets.push(reconnecting);
    const restoredRoom = reconnectResult.roomState;
    const restored = restoredRoom.players.find((player) => player.nickname === "红方");
    if (!restored || restored.team !== "red") {
      throw new Error("重连没有恢复原队伍");
    }
  } finally {
    for (const socket of sockets) {
      socket.disconnect();
    }
    server.kill("SIGTERM");
  }
}

main()
  .then(() => {
    console.log("冒烟测试通过");
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
