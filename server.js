const express = require("express");
const http = require("http");
const os = require("os");
const path = require("path");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const WORLD_WIDTH = 1280;
const WORLD_HEIGHT = 720;
const TILE = 32;
const TANK_SIZE = 48;
const TANK_RADIUS = 24;
const BULLET_SIZE = 8;
const BULLET_RADIUS = 4;
const TANK_SPEED = 180;
const BULLET_SPEED = 520;
const BULLET_RANGE = 900;
const FIRE_COOLDOWN_MS = 600;
const RESPAWN_DELAY_MS = 2000;
const INVINCIBLE_MS = 1500;
const RECONNECT_MS = 10000;
const EMPTY_TEAM_GRACE_MS = 10000;
const ALLOW_TEST_LIMITS = process.env.NODE_ENV === "test" && process.env.ALLOW_TEST_LIMITS === "1";

const MAP_NAMES = {
  snow: "冰雪",
  desert: "沙漠",
  jungle: "雨林",
};

const MODE_NAMES = {
  score: "分数制",
  time: "时间制",
};

const ROOM_STATUS = {
  WAITING: "waiting",
  COUNTDOWN: "countdown",
  PLAYING: "playing",
  ENDED: "ended",
};

const TEAMS = ["red", "blue"];

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
let nextBulletId = 1;
let nextWallId = 1;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function circleRectCollides(cx, cy, radius, rect) {
  const nearestX = clamp(cx, rect.x, rect.x + rect.w);
  const nearestY = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function tankRect(player) {
  return {
    x: player.x - TANK_RADIUS,
    y: player.y - TANK_RADIUS,
    w: TANK_SIZE,
    h: TANK_SIZE,
  };
}

function normalizeVector(x, y) {
  const length = Math.hypot(x, y);
  if (length === 0) return { x: 0, y: 0 };
  return { x: x / length, y: y / length };
}

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

function sanitizeNickname(value) {
  return String(value || "").trim();
}

function validateNickname(value) {
  const nickname = sanitizeNickname(value);
  if (!nickname) return { ok: false, message: "昵称不能为空。" };
  if (nickname.length > 12) return { ok: false, message: "昵称长度不能超过 12 个字符。" };
  return { ok: true, nickname };
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

function normalizeScoreLimit(value) {
  const number = Number(value);
  if ([10, 20, 30].includes(number)) return number;
  if (ALLOW_TEST_LIMITS && Number.isInteger(number) && number >= 1 && number <= 30) return number;
  return 10;
}

function normalizeTimeLimit(value) {
  const number = Number(value);
  if ([180, 300, 600].includes(number)) return number;
  if (ALLOW_TEST_LIMITS && Number.isInteger(number) && number >= 1 && number <= 600) return number;
  return 180;
}

function makeUniqueNickname(room, desired, socketId) {
  const base = sanitizeNickname(desired);
  const existing = room
    ? [...room.players]
        .map((id) => players.get(id))
        .filter((player) => player && player.id !== socketId)
        .map((player) => player.nickname)
    : [...players.values()].filter((player) => player.id !== socketId).map((player) => player.nickname);

  if (!existing.includes(base)) return base;

  let index = 2;
  let next = `${base}#${index}`;
  while (existing.includes(next)) {
    index += 1;
    next = `${base}#${index}`;
  }
  return next;
}

function shortName(name) {
  return name.length > 6 ? `${name.slice(0, 3)}...` : name;
}

function getTeamCounts(room) {
  const counts = { red: 0, blue: 0 };
  for (const playerId of room.players) {
    const player = players.get(playerId);
    if (player && player.online && player.team) {
      counts[player.team] += 1;
    }
  }
  return counts;
}

function getOnlinePlayers(room) {
  return [...room.players].map((id) => players.get(id)).filter((player) => player && player.online);
}

function getRoomByCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  return [...rooms.values()].find((room) => room.code === normalized);
}

function createWall(x, y, w, h, type) {
  return {
    id: `wall-${nextWallId++}`,
    x,
    y,
    w,
    h,
    type,
    alive: true,
  };
}

function createZone(x, y, w, h, type) {
  return { x, y, w, h, type };
}

function createMapDefinition(key) {
  const commonHardWalls = [
    createWall(608, 0, 64, 128, "hard"),
    createWall(608, 592, 64, 128, "hard"),
    createWall(320, 288, 96, 64, "hard"),
    createWall(864, 368, 96, 64, "hard"),
  ];
  const mirroredHardWalls = [
    createWall(864, 288, 96, 64, "hard"),
    createWall(320, 368, 96, 64, "hard"),
  ];
  const bricks = [
    createWall(416, 160, 96, 32, "brick"),
    createWall(768, 160, 96, 32, "brick"),
    createWall(416, 528, 96, 32, "brick"),
    createWall(768, 528, 96, 32, "brick"),
    createWall(576, 320, 32, 96, "brick"),
    createWall(672, 304, 32, 96, "brick"),
    createWall(160, 224, 96, 32, "brick"),
    createWall(1024, 464, 96, 32, "brick"),
    createWall(160, 464, 96, 32, "brick"),
    createWall(1024, 224, 96, 32, "brick"),
  ];

  const spawnPoints = {
    red: [
      { x: 96, y: 140 },
      { x: 96, y: 300 },
      { x: 96, y: 460 },
      { x: 160, y: 580 },
    ],
    blue: [
      { x: 1184, y: 140 },
      { x: 1184, y: 300 },
      { x: 1184, y: 460 },
      { x: 1120, y: 580 },
    ],
  };

  if (key === "desert") {
    return {
      key,
      name: MAP_NAMES[key],
      spawnPoints,
      walls: [...commonHardWalls, ...mirroredHardWalls, ...bricks],
      zones: [
        createZone(512, 192, 256, 112, "quicksand"),
        createZone(512, 432, 256, 112, "quicksand"),
      ],
    };
  }

  if (key === "jungle") {
    return {
      key,
      name: MAP_NAMES[key],
      spawnPoints,
      walls: [...commonHardWalls, ...mirroredHardWalls, ...bricks],
      zones: [
        createZone(288, 128, 224, 112, "grass"),
        createZone(768, 480, 224, 112, "grass"),
        createZone(768, 128, 224, 112, "grass"),
        createZone(288, 480, 224, 112, "grass"),
      ],
    };
  }

  return {
    key: "snow",
    name: MAP_NAMES.snow,
    spawnPoints,
    walls: [...commonHardWalls, ...mirroredHardWalls, ...bricks],
    zones: [
      createZone(480, 224, 320, 96, "ice"),
      createZone(480, 400, 320, 96, "ice"),
    ],
  };
}

function createPlayer(socket, nickname) {
  return {
    id: socket.id,
    socketId: socket.id,
    nickname,
    roomId: null,
    team: null,
    isHost: false,
    joinedAt: Date.now(),
    online: true,
    disconnectedAt: null,
    x: 0,
    y: 0,
    angle: 0,
    hp: 3,
    alive: true,
    invincibleUntil: 0,
    kills: 0,
    deaths: 0,
    lastInput: { up: false, down: false, left: false, right: false, angle: 0, firing: false },
    lastFireAt: 0,
    respawnAt: 0,
    velocityX: 0,
    velocityY: 0,
  };
}

function createRoom(host, config) {
  const now = Date.now();
  const mapKey = ["snow", "desert", "jungle"].includes(config.map) ? config.map : "snow";
  const mode = config.mode === "time" ? "time" : "score";
  const room = {
    id: `room-${nextRoomId++}`,
    code: createRoomCode(),
    hostId: host.id,
    players: new Set([host.id]),
    map: mapKey,
    mode,
    timeLimit: normalizeTimeLimit(config.timeLimit),
    scoreLimit: normalizeScoreLimit(config.scoreLimit),
    status: ROOM_STATUS.WAITING,
    redScore: 0,
    blueScore: 0,
    startedAt: null,
    endedAt: null,
    endedInfo: null,
    bullets: [],
    mapState: createMapDefinition(mapKey),
    countdownEndsAt: null,
    emptyTeamSince: { red: null, blue: null },
    createdAt: now,
  };
  rooms.set(room.id, room);
  host.roomId = room.id;
  host.isHost = true;
  host.joinedAt = now;
  host.nickname = makeUniqueNickname(room, host.nickname, host.id);
  return room;
}

function publicPlayer(player) {
  return {
    id: player.id,
    nickname: player.nickname,
    shortName: shortName(player.nickname),
    team: player.team,
    isHost: player.isHost,
    joinedAt: player.joinedAt,
    online: player.online,
    x: player.x,
    y: player.y,
    angle: player.angle,
    hp: player.hp,
    alive: player.alive,
    invincible: Date.now() < player.invincibleUntil,
    kills: player.kills,
    deaths: player.deaths,
  };
}

function publicRoom(room) {
  return {
    id: room.id,
    code: room.code,
    hostId: room.hostId,
    map: room.map,
    mapName: MAP_NAMES[room.map],
    mode: room.mode,
    modeName: MODE_NAMES[room.mode],
    timeLimit: room.timeLimit,
    scoreLimit: room.scoreLimit,
    status: room.status,
    redScore: room.redScore,
    blueScore: room.blueScore,
    maxPlayers: 8,
    players: [...room.players].map((id) => players.get(id)).filter(Boolean).map(publicPlayer),
    countdownEndsAt: room.countdownEndsAt,
    endedInfo: room.endedInfo,
  };
}

function lobbyRoom(room) {
  const playerCount = [...room.players].filter((id) => {
    const player = players.get(id);
    return player && player.online;
  }).length;

  return {
    id: room.id,
    code: room.code,
    map: room.map,
    mapName: MAP_NAMES[room.map],
    mode: room.mode,
    modeName: MODE_NAMES[room.mode],
    status: room.status,
    playerCount,
    maxPlayers: 8,
    canJoin: room.status === ROOM_STATUS.WAITING || room.status === ROOM_STATUS.ENDED,
  };
}

function sendError(socket, message) {
  socket.emit("errorMessage", message);
}

function emitLobbyState() {
  io.emit("lobbyState", [...rooms.values()].map(lobbyRoom));
}

function emitRoomState(room) {
  io.to(room.id).emit("roomState", publicRoom(room));
  emitLobbyState();
}

function leaveSocketRoom(socket, room) {
  if (room) socket.leave(room.id);
}

function assignHost(room) {
  const onlinePlayers = getOnlinePlayers(room).sort((a, b) => a.joinedAt - b.joinedAt);
  const nextHost = onlinePlayers[0];
  room.hostId = nextHost ? nextHost.id : null;
  for (const playerId of room.players) {
    const player = players.get(playerId);
    if (player) player.isHost = player.id === room.hostId;
  }
}

function clearPlayerCombatState(player) {
  player.hp = 3;
  player.alive = true;
  player.invincibleUntil = 0;
  player.respawnAt = 0;
  player.lastFireAt = 0;
  player.velocityX = 0;
  player.velocityY = 0;
  player.lastInput = { up: false, down: false, left: false, right: false, angle: 0, firing: false };
}

function chooseSpawn(room, team) {
  const map = room.mapState;
  const points = map.spawnPoints[team];
  const livePlayers = getOnlinePlayers(room).filter((player) => player.alive);
  const enemies = livePlayers.filter((player) => player.team !== team);

  for (const point of points) {
    const occupied = livePlayers.some((player) => distanceSq(player, point) < TANK_SIZE * TANK_SIZE);
    if (!occupied) return point;
  }

  let best = points[0];
  let bestDistance = -Infinity;
  for (const point of points) {
    const nearestEnemy = enemies.length
      ? Math.min(...enemies.map((enemy) => distanceSq(enemy, point)))
      : Number.POSITIVE_INFINITY;
    if (nearestEnemy > bestDistance) {
      bestDistance = nearestEnemy;
      best = point;
    }
  }
  return best;
}

function spawnPlayer(room, player, invincible = true) {
  const spawn = chooseSpawn(room, player.team);
  player.x = spawn.x;
  player.y = spawn.y;
  player.angle = player.team === "red" ? 0 : Math.PI;
  player.hp = 3;
  player.alive = true;
  player.respawnAt = 0;
  player.invincibleUntil = invincible ? Date.now() + INVINCIBLE_MS : 0;
  player.velocityX = 0;
  player.velocityY = 0;
}

function resetRoomForMatch(room) {
  room.status = ROOM_STATUS.COUNTDOWN;
  room.redScore = 0;
  room.blueScore = 0;
  room.startedAt = null;
  room.endedAt = null;
  room.endedInfo = null;
  room.bullets = [];
  room.mapState = createMapDefinition(room.map);
  room.countdownEndsAt = Date.now() + 3000;
  room.emptyTeamSince = { red: null, blue: null };

  for (const playerId of room.players) {
    const player = players.get(playerId);
    if (!player || !player.online || !player.team) continue;
    player.kills = 0;
    player.deaths = 0;
    clearPlayerCombatState(player);
    spawnPlayer(room, player, false);
  }
}

function endGame(room, winner, reason) {
  if (room.status === ROOM_STATUS.ENDED) return;
  room.status = ROOM_STATUS.ENDED;
  room.endedAt = Date.now();
  room.countdownEndsAt = null;
  room.bullets = [];
  room.endedInfo = {
    winner,
    reason,
    redScore: room.redScore,
    blueScore: room.blueScore,
    players: [...room.players].map((id) => players.get(id)).filter(Boolean).map(publicPlayer),
  };
  io.to(room.id).emit("gameEnded", room.endedInfo);
  emitRoomState(room);
}

function validateStart(room) {
  const onlinePlayers = getOnlinePlayers(room);
  if (onlinePlayers.length < 2) return "至少 2 人才能开始。";
  if (onlinePlayers.some((player) => !player.team)) return "有玩家未选择队伍。";
  const counts = getTeamCounts(room);
  if (counts.red < 1 || counts.blue < 1) return "红蓝队都至少需要 1 人。";
  return "";
}

function canJoinRoom(room) {
  return room.status === ROOM_STATUS.WAITING || room.status === ROOM_STATUS.ENDED;
}

function addPlayerToRoom(socket, player, room) {
  if (!canJoinRoom(room)) {
    sendError(socket, "游戏已经开始，不能加入。");
    return false;
  }

  if (room.players.size >= 8) {
    sendError(socket, "房间已满。");
    return false;
  }

  if (player.roomId && player.roomId !== room.id) {
    removePlayerFromRoom(player, false);
  }

  room.players.add(player.id);
  player.roomId = room.id;
  player.team = null;
  player.joinedAt = Date.now();
  player.isHost = !room.hostId;
  player.nickname = makeUniqueNickname(room, player.nickname, player.id);
  if (!room.hostId) room.hostId = player.id;
  assignHost(room);
  socket.join(room.id);
  emitRoomState(room);
  return true;
}

function removePlayerFromRoom(player, markDisconnected = false) {
  const room = rooms.get(player.roomId);
  if (!room) {
    player.roomId = null;
    player.team = null;
    player.isHost = false;
    return;
  }

  if (markDisconnected) {
    player.online = false;
    player.disconnectedAt = Date.now();
    player.alive = false;
    player.respawnAt = 0;
    disconnectedPlayers.set(disconnectKey(room.id, player.nickname), {
      playerId: player.id,
      roomId: room.id,
      team: player.team,
      kills: player.kills,
      deaths: player.deaths,
      nickname: player.nickname,
      disconnectedAt: player.disconnectedAt,
    });
  } else {
    room.players.delete(player.id);
    player.roomId = null;
    player.team = null;
    player.isHost = false;
  }

  if (player.id === room.hostId) {
    assignHost(room);
  }

  if (room.players.size === 0 || getOnlinePlayers(room).length === 0) {
    if (room.status !== ROOM_STATUS.PLAYING && room.status !== ROOM_STATUS.COUNTDOWN) {
      rooms.delete(room.id);
      emitLobbyState();
      return;
    }
  }

  emitRoomState(room);
}

function restoreDisconnectedPlayer(socket, player, previousPlayerId) {
  const found = findDisconnectedPlayer(player.nickname, previousPlayerId);
  if (!found) return false;
  const [savedKey, saved] = found;
  if (Date.now() - saved.disconnectedAt > RECONNECT_MS) {
    disconnectedPlayers.delete(savedKey);
    return false;
  }

  const room = rooms.get(saved.roomId);
  if (!room) {
    disconnectedPlayers.delete(savedKey);
    return false;
  }

  const oldPlayer = players.get(saved.playerId);
  if (oldPlayer) {
    players.delete(oldPlayer.id);
    room.players.delete(oldPlayer.id);
  }

  const teamCount = getTeamCounts(room)[saved.team] || 0;
  if (room.players.size >= 8 || teamCount >= 4) {
    disconnectedPlayers.delete(savedKey);
    return false;
  }

  player.roomId = room.id;
  player.team = saved.team;
  player.kills = saved.kills;
  player.deaths = saved.deaths;
  player.joinedAt = oldPlayer ? oldPlayer.joinedAt : Date.now();
  player.isHost = saved.playerId === room.hostId;
  player.online = true;
  player.disconnectedAt = null;
  room.players.add(player.id);
  if (room.hostId === saved.playerId) room.hostId = player.id;
  assignHost(room);
  socket.join(room.id);
  disconnectedPlayers.delete(savedKey);

  if ((room.status === ROOM_STATUS.PLAYING || room.status === ROOM_STATUS.COUNTDOWN) && player.team) {
    spawnPlayer(room, player, true);
  }

  emitRoomState(room);
  return true;
}

function updateRoomConfig(socket, player, data) {
  const room = rooms.get(player.roomId);
  if (!room) return sendError(socket, "房间不存在。");
  if (room.hostId !== player.id) return sendError(socket, "只有房主可以修改房间配置。");
  if (room.status !== ROOM_STATUS.WAITING) {
    return sendError(socket, "只有等待中可以修改房间配置。");
  }

  if (["snow", "desert", "jungle"].includes(data.map)) room.map = data.map;
  if (["score", "time"].includes(data.mode)) room.mode = data.mode;
  room.scoreLimit = normalizeScoreLimit(data.scoreLimit ?? room.scoreLimit);
  room.timeLimit = normalizeTimeLimit(data.timeLimit ?? room.timeLimit);
  room.mapState = createMapDefinition(room.map);
  emitRoomState(room);
}

function chooseTeam(socket, player, team) {
  const room = rooms.get(player.roomId);
  if (!room) return sendError(socket, "房间不存在。");
  if (!TEAMS.includes(team)) return sendError(socket, "请选择队伍。");
  if (room.status !== ROOM_STATUS.WAITING) {
    return sendError(socket, "只有等待中可以换队。");
  }

  const counts = getTeamCounts(room);
  if (player.team !== team && counts[team] >= 4) {
    return sendError(socket, "队伍已满。");
  }

  player.team = team;
  clearPlayerCombatState(player);
  emitRoomState(room);
}

function playerCanCollide(player) {
  return player.online && player.alive && player.team;
}

function isInZone(player, type, room) {
  const rect = tankRect(player);
  return room.mapState.zones.some((zone) => zone.type === type && rectsOverlap(rect, zone));
}

function collidesWithWall(room, player, x, y) {
  const rect = { x: x - TANK_RADIUS, y: y - TANK_RADIUS, w: TANK_SIZE, h: TANK_SIZE };
  return room.mapState.walls.some((wall) => wall.alive && rectsOverlap(rect, wall));
}

function collidesWithTank(room, player, x, y) {
  return getOnlinePlayers(room).some((other) => {
    if (other.id === player.id || !playerCanCollide(other)) return false;
    return distanceSq({ x, y }, other) < TANK_SIZE * TANK_SIZE;
  });
}

function movePlayer(room, player, dt) {
  if (!playerCanCollide(player)) return;

  const input = player.lastInput;
  let mx = 0;
  let my = 0;
  if (input.left) mx -= 1;
  if (input.right) mx += 1;
  if (input.up) my -= 1;
  if (input.down) my += 1;

  player.angle = Number.isFinite(input.angle) ? input.angle : player.angle;

  const onIce = room.map === "snow" && isInZone(player, "ice", room);
  const onQuicksand = room.map === "desert" && isInZone(player, "quicksand", room);
  const direction = normalizeVector(mx, my);
  const speed = TANK_SPEED * (onQuicksand ? 0.7 : 1);

  if (direction.x !== 0 || direction.y !== 0) {
    player.velocityX = direction.x * speed;
    player.velocityY = direction.y * speed;
  } else if (onIce) {
    player.velocityX *= 0.94;
    player.velocityY *= 0.94;
    if (Math.hypot(player.velocityX, player.velocityY) < 8) {
      player.velocityX = 0;
      player.velocityY = 0;
    }
  } else {
    player.velocityX = 0;
    player.velocityY = 0;
  }

  const nextX = clamp(player.x + player.velocityX * dt, TANK_RADIUS, WORLD_WIDTH - TANK_RADIUS);
  const nextY = clamp(player.y + player.velocityY * dt, TANK_RADIUS, WORLD_HEIGHT - TANK_RADIUS);

  if (!collidesWithWall(room, player, nextX, player.y) && !collidesWithTank(room, player, nextX, player.y)) {
    player.x = nextX;
  } else {
    player.velocityX = 0;
  }

  if (!collidesWithWall(room, player, player.x, nextY) && !collidesWithTank(room, player, player.x, nextY)) {
    player.y = nextY;
  } else {
    player.velocityY = 0;
  }
}

function tryFire(room, player, now) {
  if (!playerCanCollide(player)) return;
  if (now < player.invincibleUntil) return;
  if (!player.lastInput.firing) return;
  if (now - player.lastFireAt < FIRE_COOLDOWN_MS) return;

  player.lastFireAt = now;
  const angle = player.angle;
  const startDistance = TANK_RADIUS + BULLET_RADIUS + 4;
  room.bullets.push({
    id: `bullet-${nextBulletId++}`,
    ownerId: player.id,
    team: player.team,
    x: player.x + Math.cos(angle) * startDistance,
    y: player.y + Math.sin(angle) * startDistance,
    angle,
    traveled: 0,
  });
}

function damagePlayer(room, target, attackerId, now) {
  if (now < target.invincibleUntil || !target.alive) return false;

  target.hp -= 1;
  if (target.hp > 0) return true;

  target.alive = false;
  target.hp = 0;
  target.deaths += 1;
  target.respawnAt = now + RESPAWN_DELAY_MS;
  target.velocityX = 0;
  target.velocityY = 0;

  const attacker = players.get(attackerId);
  if (attacker && attacker.team && attacker.team !== target.team) {
    attacker.kills += 1;
    if (attacker.team === "red") room.redScore += 1;
    if (attacker.team === "blue") room.blueScore += 1;
  }

  if (room.mode === "score") {
    if (room.redScore >= room.scoreLimit) endGame(room, "red", "scoreLimit");
    if (room.blueScore >= room.scoreLimit) endGame(room, "blue", "scoreLimit");
  }
  return true;
}

function updateBullets(room, dt, now) {
  const nextBullets = [];

  for (const bullet of room.bullets) {
    if (room.status !== ROOM_STATUS.PLAYING) break;
    bullet.x += Math.cos(bullet.angle) * BULLET_SPEED * dt;
    bullet.y += Math.sin(bullet.angle) * BULLET_SPEED * dt;
    bullet.traveled += BULLET_SPEED * dt;

    if (
      bullet.x < -BULLET_RADIUS ||
      bullet.y < -BULLET_RADIUS ||
      bullet.x > WORLD_WIDTH + BULLET_RADIUS ||
      bullet.y > WORLD_HEIGHT + BULLET_RADIUS ||
      bullet.traveled > BULLET_RANGE
    ) {
      continue;
    }

    let consumed = false;
    for (const wall of room.mapState.walls) {
      if (!wall.alive) continue;
      if (!circleRectCollides(bullet.x, bullet.y, BULLET_RADIUS, wall)) continue;
      if (wall.type === "brick") wall.alive = false;
      consumed = true;
      break;
    }
    if (consumed) continue;

    for (const target of getOnlinePlayers(room)) {
      if (!playerCanCollide(target)) continue;
      if (target.team === bullet.team) continue;
      if (now < target.invincibleUntil) continue;
      if (distanceSq(target, bullet) <= (TANK_RADIUS + BULLET_RADIUS) ** 2) {
        damagePlayer(room, target, bullet.ownerId, now);
        consumed = true;
        break;
      }
    }
    if (room.status !== ROOM_STATUS.PLAYING) break;
    if (!consumed) nextBullets.push(bullet);
  }

  room.bullets = nextBullets;
}

function updateRespawns(room, now) {
  for (const player of getOnlinePlayers(room)) {
    if (!player.team || player.alive || !player.respawnAt) continue;
    if (now >= player.respawnAt) {
      spawnPlayer(room, player, true);
    }
  }
}

function updateEmptyTeams(room, now) {
  if (room.status !== ROOM_STATUS.PLAYING) return;
  const counts = getTeamCounts(room);

  for (const team of TEAMS) {
    if (counts[team] === 0) {
      if (!room.emptyTeamSince[team]) room.emptyTeamSince[team] = now;
    } else {
      room.emptyTeamSince[team] = null;
    }
  }

  const redEmptyLongEnough = room.emptyTeamSince.red && now - room.emptyTeamSince.red >= EMPTY_TEAM_GRACE_MS;
  const blueEmptyLongEnough = room.emptyTeamSince.blue && now - room.emptyTeamSince.blue >= EMPTY_TEAM_GRACE_MS;

  if (redEmptyLongEnough && blueEmptyLongEnough) endGame(room, null, "allPlayersLeft");
  else if (redEmptyLongEnough) endGame(room, "blue", "enemyTeamLeft");
  else if (blueEmptyLongEnough) endGame(room, "red", "enemyTeamLeft");
}

function updateTimeLimit(room, now) {
  if (room.status !== ROOM_STATUS.PLAYING || room.mode !== "time" || !room.startedAt) return;
  const elapsed = (now - room.startedAt) / 1000;
  if (elapsed < room.timeLimit) return;
  let winner = null;
  if (room.redScore > room.blueScore) winner = "red";
  if (room.blueScore > room.redScore) winner = "blue";
  endGame(room, winner, "timeLimit");
}

function startCountdownIfReady(room) {
  const error = validateStart(room);
  if (error) return error;
  resetRoomForMatch(room);
  io.to(room.id).emit("countdown", { endsAt: room.countdownEndsAt });
  emitRoomState(room);
  return "";
}

function publicGameState(room) {
  const now = Date.now();
  const remainingSeconds = room.mode === "time" && room.startedAt
    ? Math.max(0, Math.ceil(room.timeLimit - (now - room.startedAt) / 1000))
    : null;

  return {
    roomId: room.id,
    status: room.status,
    map: room.map,
    mapName: MAP_NAMES[room.map],
    mode: room.mode,
    timeLimit: room.timeLimit,
    scoreLimit: room.scoreLimit,
    remainingSeconds,
    redScore: room.redScore,
    blueScore: room.blueScore,
    players: [...room.players].map((id) => players.get(id)).filter((player) => player && player.online).map(publicPlayer),
    bullets: room.bullets,
    walls: room.mapState.walls,
    zones: room.mapState.zones,
    countdownEndsAt: room.countdownEndsAt,
    endedInfo: room.endedInfo,
  };
}

function tickRoom(room, now) {
  if (room.status === ROOM_STATUS.COUNTDOWN && room.countdownEndsAt && now >= room.countdownEndsAt) {
    room.status = ROOM_STATUS.PLAYING;
    room.startedAt = now;
    room.countdownEndsAt = null;
    io.to(room.id).emit("gameStarted", publicRoom(room));
    emitRoomState(room);
  }

  if (room.status !== ROOM_STATUS.PLAYING) return;

  for (const player of getOnlinePlayers(room)) {
    movePlayer(room, player, DT);
    tryFire(room, player, now);
  }

  updateBullets(room, DT, now);
  updateRespawns(room, now);
  updateTimeLimit(room, now);
  updateEmptyTeams(room, now);
}

function cleanupDisconnected(now) {
  for (const [savedKey, saved] of disconnectedPlayers) {
    if (now - saved.disconnectedAt <= RECONNECT_MS) continue;
    disconnectedPlayers.delete(savedKey);
    const player = players.get(saved.playerId);
    const room = rooms.get(saved.roomId);
    if (room) {
      room.players.delete(saved.playerId);
      if (room.hostId === saved.playerId) assignHost(room);
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
    tickRoom(room, now);
  }
  cleanupDisconnected(now);

  for (const room of rooms.values()) {
    if (room.status === ROOM_STATUS.PLAYING || room.status === ROOM_STATUS.COUNTDOWN) {
      io.to(room.id).emit("gameState", publicGameState(room));
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
      player.nickname = room ? makeUniqueNickname(room, nickname, player.id) : nickname;
      socket.emit("nicknameSet", { nickname: player.nickname, playerId: player.id });
      if (ack) ack({ ok: true, nickname: player.nickname, playerId: player.id });
      if (room) emitRoomState(room);
      emitLobbyState();
      return;
    }

    player = createPlayer(socket, nickname);
    players.set(player.id, player);
    restoreDisconnectedPlayer(socket, player, previousPlayerId);
    socket.emit("nicknameSet", { nickname: player.nickname, playerId: player.id });
    emitLobbyState();
    if (player.roomId) socket.emit("roomState", publicRoom(rooms.get(player.roomId)));
    if (ack) ack({ ok: true, nickname: player.nickname, playerId: player.id });
  });

  socket.on("createRoom", (config = {}, ack) => {
    if (!player) {
      sendError(socket, "请先输入昵称。");
      if (ack) ack({ ok: false });
      return;
    }
    const room = createRoom(player, config);
    socket.join(room.id);
    emitRoomState(room);
    if (ack) ack({ ok: true, room: publicRoom(room) });
  });

  socket.on("joinRoom", (roomId, ack) => {
    if (!player) return sendError(socket, "请先输入昵称。");
    const room = rooms.get(roomId);
    if (!room) {
      sendError(socket, "房间不存在。");
      if (ack) ack({ ok: false });
      return;
    }
    const ok = addPlayerToRoom(socket, player, room);
    if (ack) ack({ ok });
  });

  socket.on("joinRoomByCode", (code, ack) => {
    if (!player) return sendError(socket, "请先输入昵称。");
    const room = getRoomByCode(code);
    if (!room) {
      sendError(socket, "房间不存在。");
      if (ack) ack({ ok: false });
      return;
    }
    const ok = addPlayerToRoom(socket, player, room);
    if (ack) ack({ ok });
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
    chooseTeam(socket, player, team);
  });

  socket.on("updateRoomConfig", (data) => {
    if (!player) return;
    updateRoomConfig(socket, player, data || {});
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
    const error = startCountdownIfReady(room);
    if (error) {
      sendError(socket, error);
      if (ack) ack({ ok: false });
      return;
    }
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
    if (room.status !== ROOM_STATUS.ENDED) {
      sendError(socket, "只有游戏结束后可以再来一局。");
      if (ack) ack({ ok: false });
      return;
    }
    room.status = ROOM_STATUS.WAITING;
    room.redScore = 0;
    room.blueScore = 0;
    room.startedAt = null;
    room.endedAt = null;
    room.endedInfo = null;
    room.bullets = [];
    room.mapState = createMapDefinition(room.map);
    room.countdownEndsAt = null;
    for (const playerId of [...room.players]) {
      const roomPlayer = players.get(playerId);
      if (!roomPlayer || !roomPlayer.online) {
        room.players.delete(playerId);
        continue;
      }
      roomPlayer.kills = 0;
      roomPlayer.deaths = 0;
      clearPlayerCombatState(roomPlayer);
    }
    assignHost(room);
    emitRoomState(room);
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
    if (team === "red") room.redScore += 1;
    if (team === "blue") room.blueScore += 1;
    if (room.mode === "score") {
      if (room.redScore >= room.scoreLimit) endGame(room, "red", "scoreLimit");
      if (room.blueScore >= room.scoreLimit) endGame(room, "blue", "scoreLimit");
    }
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
