const express = require("express");
const http = require("http");
const os = require("os");
const path = require("path");
const { Server } = require("socket.io");

const {
  RECONNECT_MS,
  ROOM_STATUS,
  STATE_BROADCAST_INTERVAL_MS,
  TICK_RATE,
  TEAMS,
} = require("./src/game-constants");
const {
  publicGameState,
  publicRoom,
  startCountdownIfReady,
  tickRoom,
  awardPointForTest,
} = require("./src/game-room");
const {
  publicMapState,
} = require("./src/maps");
const {
  addPlayerToRoom,
  assignHost,
  chooseTeam,
  createPlayer,
  createRoom,
  lobbyRoom,
  makeUniqueNickname,
  removePlayerFromRoom: removePlayerFromRoomState,
  restoreDisconnectedPlayer: restoreDisconnectedPlayerState,
  restartRoom,
  updateRoomConfig,
  validateNickname,
} = require("./src/room-lifecycle");

const PORT = Number(process.env.PORT || 3000);
const ALLOW_TEST_LIMITS = process.env.NODE_ENV === "test" && process.env.ALLOW_TEST_LIMITS === "1";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 5000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/phaser", express.static(path.join(__dirname, "node_modules/phaser/dist")));

const players = new Map();
const rooms = new Map();
const disconnectedPlayers = new Map();
const usedRoomCodes = new Set();

let nextRoomId = 1;
let lastStateBroadcastAt = 0;

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function createRoomCode() {
  let code = randomCode();
  while (usedRoomCodes.has(code)) {
    code = randomCode();
  }
  usedRoomCodes.add(code);
  return code;
}

function createRoomId() {
  return `room-${nextRoomId++}`;
}

function getPlayer(playerId) {
  return players.get(playerId);
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function getRoomByCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  return [...rooms.values()].find((room) => room.code === normalized);
}

function disconnectKey(roomId, nickname) {
  return `${roomId}:${nickname}`;
}

function findDisconnectedPlayer(nickname, previousPlayerId) {
  const now = Date.now();
  const candidates = [...disconnectedPlayers.entries()]
    .filter(([, saved]) => saved.nickname === nickname && now - saved.disconnectedAt <= RECONNECT_MS)
    .sort((a, b) => b[1].disconnectedAt - a[1].disconnectedAt);
  const exact = candidates.find(([, saved]) => previousPlayerId && saved.playerId === previousPlayerId);
  if (exact) return exact;
  return candidates.length === 1 ? candidates[0] : null;
}

function sendError(socket, message) {
  socket.emit("errorMessage", message);
}

function emitLobbyState() {
  io.emit("lobbyState", [...rooms.values()].map((room) => lobbyRoom(room, getPlayer)));
}

function emitRoomState(room) {
  io.to(room.id).emit("roomState", publicRoom(room, getPlayer));
  emitLobbyState();
}

function emitMapState(room, target = io.to(room.id)) {
  target.emit("mapState", publicMapState(room));
  room.mapDirty = false;
}

function emitGameEvents(room, events) {
  for (const event of events) {
    if (event.type === "countdown") {
      io.to(room.id).emit("countdown", { endsAt: event.endsAt });
    }
    if (event.type === "gameStarted") {
      io.to(room.id).emit("gameStarted", publicRoom(room, getPlayer));
    }
    if (event.type === "gameEnded") {
      io.to(room.id).emit("gameEnded", event.info);
      emitRoomState(room);
    }
    if (event.type === "roomState") {
      emitRoomState(room);
    }
    if (event.type === "mapState") {
      emitMapState(room);
    }
  }
}

function saveDisconnected(room, player) {
  disconnectedPlayers.set(disconnectKey(room.id, player.nickname), {
    playerId: player.id,
    roomId: room.id,
    team: player.team,
    kills: player.kills,
    deaths: player.deaths,
    nickname: player.nickname,
    disconnectedAt: player.disconnectedAt,
  });
}

function removePlayerFromRoom(player, markDisconnected = false) {
  const result = removePlayerFromRoomState(player, {
    getRoom,
    getPlayer,
    saveDisconnected,
    deleteRoom: (roomId) => rooms.delete(roomId),
    now: Date.now(),
  }, markDisconnected);

  if (result.deletedRoom) {
    emitLobbyState();
  } else if (result.room) {
    emitRoomState(result.room);
  }

  return result;
}

function restoreDisconnectedPlayer(socket, player, previousPlayerId) {
  const found = findDisconnectedPlayer(player.nickname, previousPlayerId);
  if (!found) return false;

  const [savedKey, saved] = found;
  const result = restoreDisconnectedPlayerState(player, saved, {
    getRoom,
    getPlayer,
    deletePlayer: (playerId) => players.delete(playerId),
    now: Date.now(),
  });

  disconnectedPlayers.delete(savedKey);
  if (!result.ok) return false;

  socket.join(result.room.id);
  if (result.shouldSpawn) emitMapState(result.room, socket);
  emitRoomState(result.room);
  return true;
}

function cleanupDisconnected(now) {
  for (const [savedKey, saved] of disconnectedPlayers) {
    if (now - saved.disconnectedAt <= RECONNECT_MS) continue;
    disconnectedPlayers.delete(savedKey);
    const player = players.get(saved.playerId);
    const room = rooms.get(saved.roomId);
    if (room) {
      room.players.delete(saved.playerId);
      if (room.hostId === saved.playerId) assignHost(room, getPlayer);
      if (room.players.size === 0 && room.status !== ROOM_STATUS.PLAYING && room.status !== ROOM_STATUS.COUNTDOWN) {
        rooms.delete(room.id);
      } else {
        emitRoomState(room);
      }
    }
    if (player) players.delete(player.id);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    emitGameEvents(room, tickRoom(room, now, getPlayer));
  }
  cleanupDisconnected(now);

  if (now - lastStateBroadcastAt >= STATE_BROADCAST_INTERVAL_MS) {
    lastStateBroadcastAt = now;
    for (const room of rooms.values()) {
      if (room.status === ROOM_STATUS.PLAYING || room.status === ROOM_STATUS.COUNTDOWN) {
        if (room.mapDirty) emitMapState(room);
        io.to(room.id).emit("gameState", publicGameState(room, getPlayer));
      }
    }
  }
}, 1000 / TICK_RATE);

io.on("connection", (socket) => {
  let player = null;

  socket.on("setNickname", (payload, ack) => {
    const rawNickname = typeof payload === "object" && payload !== null ? payload.nickname : payload;
    const previousPlayerId = typeof payload === "object" && payload !== null ? payload.previousPlayerId : null;
    const validation = validateNickname(rawNickname);
    if (!validation.ok) {
      sendError(socket, validation.message);
      if (ack) ack({ ok: false, error: validation.message });
      return;
    }
    const nickname = validation.nickname;

    if (player && player.online) {
      const room = rooms.get(player.roomId);
      player.nickname = room
        ? makeUniqueNickname(room, nickname, player.id, getPlayer)
        : nickname;
      socket.emit("nicknameSet", { nickname: player.nickname, playerId: player.id });
      if (ack) ack({ ok: true, nickname: player.nickname, playerId: player.id });
      if (room) emitRoomState(room);
      emitLobbyState();
      return;
    }

    player = createPlayer(socket.id, nickname);
    players.set(player.id, player);
    restoreDisconnectedPlayer(socket, player, previousPlayerId);
    socket.emit("nicknameSet", { nickname: player.nickname, playerId: player.id });
    emitLobbyState();
    if (player.roomId) socket.emit("roomState", publicRoom(rooms.get(player.roomId), getPlayer));
    if (ack) ack({ ok: true, nickname: player.nickname, playerId: player.id });
  });

  socket.on("createRoom", (config = {}, ack) => {
    if (!player) {
      sendError(socket, "请先输入昵称。");
      if (ack) ack({ ok: false });
      return;
    }
    const room = createRoom(player, config, {
      allowTestLimits: ALLOW_TEST_LIMITS,
      createRoomCode,
      createRoomId,
      getPlayer,
      now: Date.now(),
    });
    rooms.set(room.id, room);
    socket.join(room.id);
    emitRoomState(room);
    if (ack) ack({ ok: true, room: publicRoom(room, getPlayer) });
  });

  socket.on("joinRoom", (roomId, ack) => {
    if (!player) return sendError(socket, "请先输入昵称。");
    const room = rooms.get(roomId);
    if (!room) {
      sendError(socket, "房间不存在。");
      if (ack) ack({ ok: false });
      return;
    }
    const result = addPlayerToRoom(player, room, {
      getPlayer,
      now: Date.now(),
      removePlayerFromRoom,
    });
    if (!result.ok) sendError(socket, result.error);
    else {
      socket.join(room.id);
      emitRoomState(room);
    }
    if (ack) ack({ ok: result.ok });
  });

  socket.on("joinRoomByCode", (code, ack) => {
    if (!player) return sendError(socket, "请先输入昵称。");
    const room = getRoomByCode(code);
    if (!room) {
      sendError(socket, "房间不存在。");
      if (ack) ack({ ok: false });
      return;
    }
    const result = addPlayerToRoom(player, room, {
      getPlayer,
      now: Date.now(),
      removePlayerFromRoom,
    });
    if (!result.ok) sendError(socket, result.error);
    else {
      socket.join(room.id);
      emitRoomState(room);
    }
    if (ack) ack({ ok: result.ok });
  });

  socket.on("leaveRoom", () => {
    if (!player) return;
    const room = rooms.get(player.roomId);
    if (room) socket.leave(room.id);
    removePlayerFromRoom(player, false);
    emitLobbyState();
  });

  socket.on("chooseTeam", (team) => {
    if (!player) return;
    const result = chooseTeam(player, team, { getRoom, getPlayer });
    if (!result.ok) return sendError(socket, result.error);
    emitRoomState(result.room);
  });

  socket.on("updateRoomConfig", (data) => {
    if (!player) return;
    const result = updateRoomConfig(player, data || {}, {
      allowTestLimits: ALLOW_TEST_LIMITS,
      getRoom,
    });
    if (!result.ok) return sendError(socket, result.error);
    emitRoomState(result.room);
  });

  socket.on("startGame", (ack) => {
    if (!player) return;
    const room = rooms.get(player.roomId);
    if (!room) {
      sendError(socket, "房间不存在。");
      if (ack) ack({ ok: false });
      return;
    }
    if (room.hostId !== player.id) {
      sendError(socket, "只有房主可以开始游戏。");
      if (ack) ack({ ok: false });
      return;
    }
    if (room.status !== ROOM_STATUS.WAITING) {
      sendError(socket, "只有等待中的房间可以开始游戏。");
      if (ack) ack({ ok: false });
      return;
    }
    const result = startCountdownIfReady(room, getPlayer, Date.now());
    if (!result.ok) {
      sendError(socket, result.error);
      if (ack) ack({ ok: false });
      return;
    }
    emitGameEvents(room, result.events);
    if (ack) ack({ ok: true });
  });

  socket.on("playerInput", (input = {}) => {
    if (!player) return;
    player.lastInput = {
      up: Boolean(input.up),
      down: Boolean(input.down),
      left: Boolean(input.left),
      right: Boolean(input.right),
      angle: Number.isFinite(input.angle) ? input.angle : player.lastInput.angle,
      firing: Boolean(input.firing),
    };
  });

  socket.on("restartGame", (ack) => {
    if (!player) return;
    const result = restartRoom(player, { getRoom, getPlayer });
    if (!result.ok) {
      sendError(socket, result.error);
      if (ack) ack({ ok: false });
      return;
    }
    emitRoomState(result.room);
    if (ack) ack({ ok: true });
  });

  socket.on("testAwardPoint", (team, ack) => {
    if (!ALLOW_TEST_LIMITS || !player) {
      if (ack) ack({ ok: false });
      return;
    }
    const room = rooms.get(player.roomId);
    if (!room || room.status !== ROOM_STATUS.PLAYING || !TEAMS.includes(team)) {
      if (ack) ack({ ok: false });
      return;
    }
    emitGameEvents(room, awardPointForTest(room, team, getPlayer, Date.now()));
    if (ack) ack({ ok: true });
  });

  socket.on("disconnect", () => {
    if (!player) return;
    const room = rooms.get(player.roomId);
    if (room) socket.leave(room.id);
    removePlayerFromRoom(player, true);
    emitLobbyState();
  });
});

function getLanAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const values of Object.values(interfaces)) {
    for (const net of values || []) {
      if (net.family === "IPv4" && !net.internal) {
        addresses.push(`http://${net.address}:${PORT}`);
      }
    }
  }
  return addresses;
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`本机访问地址: http://localhost:${PORT}`);
  const lanAddresses = getLanAddresses();
  if (lanAddresses.length) {
    for (const address of lanAddresses) {
      console.log(`局域网访问地址: ${address}`);
    }
  } else {
    console.log("局域网访问地址: 未找到可用 IPv4 地址");
  }
});
