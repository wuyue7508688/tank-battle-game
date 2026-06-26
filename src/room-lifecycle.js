const {
  MODE_NAMES,
  ROOM_STATUS,
  TEAMS,
} = require("./game-constants");
const {
  createMapDefinition,
  markMapDirty,
  normalizeMapKey,
} = require("./maps");
const {
  clearPlayerCombatState,
  getOnlinePlayers,
  getTeamCounts,
  spawnPlayer,
} = require("./game-room");

function sanitizeNickname(value) {
  return String(value || "").trim();
}

function validateNickname(value) {
  const nickname = sanitizeNickname(value);
  if (!nickname) return { ok: false, message: "昵称不能为空。" };
  if (nickname.length > 12) return { ok: false, message: "昵称长度不能超过 12 个字符。" };
  return { ok: true, nickname };
}

function normalizeScoreLimit(value, allowTestLimits = false) {
  const number = Number(value);
  if ([10, 20, 30].includes(number)) return number;
  if (allowTestLimits && Number.isInteger(number) && number >= 1 && number <= 30) return number;
  return 10;
}

function normalizeTimeLimit(value, allowTestLimits = false) {
  const number = Number(value);
  if ([180, 300, 600].includes(number)) return number;
  if (allowTestLimits && Number.isInteger(number) && number >= 1 && number <= 600) return number;
  return 180;
}

function makeUniqueNickname(room, desired, playerId, getPlayer, allPlayers = []) {
  const base = sanitizeNickname(desired);
  const existing = room
    ? [...room.players]
        .map((id) => getPlayer(id))
        .filter((player) => player && player.id !== playerId)
        .map((player) => player.nickname)
    : allPlayers.filter((player) => player.id !== playerId).map((player) => player.nickname);

  if (!existing.includes(base)) return base;

  let index = 2;
  let next = `${base}#${index}`;
  while (existing.includes(next)) {
    index += 1;
    next = `${base}#${index}`;
  }
  return next;
}

function createPlayer(socketId, nickname, now = Date.now()) {
  return {
    id: socketId,
    socketId,
    nickname,
    roomId: null,
    team: null,
    isHost: false,
    joinedAt: now,
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

function createRoom(host, config, options) {
  const now = options.now || Date.now();
  const mapKey = normalizeMapKey(config.map);
  const mode = config.mode === "time" ? "time" : "score";
  const room = {
    id: options.createRoomId(),
    code: options.createRoomCode(),
    hostId: host.id,
    players: new Set([host.id]),
    map: mapKey,
    mode,
    timeLimit: normalizeTimeLimit(config.timeLimit, options.allowTestLimits),
    scoreLimit: normalizeScoreLimit(config.scoreLimit, options.allowTestLimits),
    status: ROOM_STATUS.WAITING,
    redScore: 0,
    blueScore: 0,
    startedAt: null,
    endedAt: null,
    endedInfo: null,
    bullets: [],
    mapState: createMapDefinition(mapKey),
    mapVersion: 1,
    mapDirty: true,
    countdownEndsAt: null,
    emptyTeamSince: { red: null, blue: null },
    createdAt: now,
  };
  host.roomId = room.id;
  host.isHost = true;
  host.joinedAt = now;
  host.nickname = makeUniqueNickname(room, host.nickname, host.id, options.getPlayer);
  return room;
}

function lobbyRoom(room, getPlayer) {
  const playerCount = [...room.players].filter((id) => {
    const player = getPlayer(id);
    return player && player.online;
  }).length;

  return {
    id: room.id,
    code: room.code,
    map: room.map,
    mapName: room.mapState.name,
    mode: room.mode,
    modeName: MODE_NAMES[room.mode],
    status: room.status,
    playerCount,
    maxPlayers: 8,
    canJoin: canJoinRoom(room),
  };
}

function canJoinRoom(room) {
  return room.status === ROOM_STATUS.WAITING || room.status === ROOM_STATUS.ENDED;
}

function assignHost(room, getPlayer) {
  const onlinePlayers = getOnlinePlayers(room, getPlayer).sort((a, b) => a.joinedAt - b.joinedAt);
  const nextHost = onlinePlayers[0];
  room.hostId = nextHost ? nextHost.id : null;
  for (const playerId of room.players) {
    const player = getPlayer(playerId);
    if (player) player.isHost = player.id === room.hostId;
  }
}

function addPlayerToRoom(player, room, options) {
  if (!canJoinRoom(room)) return { ok: false, error: "游戏已经开始，不能加入。" };
  if (room.players.size >= 8) return { ok: false, error: "房间已满。" };

  if (player.roomId && player.roomId !== room.id) {
    options.removePlayerFromRoom(player, false);
  }

  room.players.add(player.id);
  player.roomId = room.id;
  player.team = null;
  player.joinedAt = options.now || Date.now();
  player.isHost = !room.hostId;
  player.nickname = makeUniqueNickname(room, player.nickname, player.id, options.getPlayer);
  if (!room.hostId) room.hostId = player.id;
  assignHost(room, options.getPlayer);
  return { ok: true };
}

function removePlayerFromRoom(player, options, markDisconnected = false) {
  const room = options.getRoom(player.roomId);
  if (!room) {
    player.roomId = null;
    player.team = null;
    player.isHost = false;
    return { room: null, deletedRoom: false };
  }

  if (markDisconnected) {
    player.online = false;
    player.disconnectedAt = options.now || Date.now();
    player.alive = false;
    player.respawnAt = 0;
    options.saveDisconnected(room, player);
  } else {
    room.players.delete(player.id);
    player.roomId = null;
    player.team = null;
    player.isHost = false;
  }

  if (player.id === room.hostId) {
    assignHost(room, options.getPlayer);
  }

  const shouldDelete = (room.players.size === 0 || getOnlinePlayers(room, options.getPlayer).length === 0)
    && room.status !== ROOM_STATUS.PLAYING
    && room.status !== ROOM_STATUS.COUNTDOWN;

  if (shouldDelete) {
    options.deleteRoom(room.id);
    return { room, deletedRoom: true };
  }

  return { room, deletedRoom: false };
}

function restoreDisconnectedPlayer(player, saved, options) {
  const room = options.getRoom(saved.roomId);
  if (!room) return { ok: false };

  const oldPlayer = options.getPlayer(saved.playerId);
  if (oldPlayer) {
    options.deletePlayer(oldPlayer.id);
    room.players.delete(oldPlayer.id);
  }

  const teamCount = getTeamCounts(room, options.getPlayer)[saved.team] || 0;
  if (room.players.size >= 8 || teamCount >= 4) return { ok: false };

  player.roomId = room.id;
  player.team = saved.team;
  player.kills = saved.kills;
  player.deaths = saved.deaths;
  player.joinedAt = oldPlayer ? oldPlayer.joinedAt : options.now || Date.now();
  player.isHost = saved.playerId === room.hostId;
  player.online = true;
  player.disconnectedAt = null;
  room.players.add(player.id);
  if (room.hostId === saved.playerId) room.hostId = player.id;
  assignHost(room, options.getPlayer);

  const shouldSpawn = (room.status === ROOM_STATUS.PLAYING || room.status === ROOM_STATUS.COUNTDOWN) && player.team;
  if (shouldSpawn) {
    spawnPlayer(room, player, options.getPlayer, options.now || Date.now(), true);
  }

  return { ok: true, room, shouldSpawn };
}

function updateRoomConfig(player, data, options) {
  const room = options.getRoom(player.roomId);
  if (!room) return { ok: false, error: "房间不存在。" };
  if (room.hostId !== player.id) return { ok: false, error: "只有房主可以修改房间配置。" };
  if (room.status !== ROOM_STATUS.WAITING) {
    return { ok: false, error: "只有等待中可以修改房间配置。" };
  }

  if (["snow", "desert", "jungle"].includes(data.map)) room.map = data.map;
  if (["score", "time"].includes(data.mode)) room.mode = data.mode;
  room.scoreLimit = normalizeScoreLimit(data.scoreLimit ?? room.scoreLimit, options.allowTestLimits);
  room.timeLimit = normalizeTimeLimit(data.timeLimit ?? room.timeLimit, options.allowTestLimits);
  room.mapState = createMapDefinition(room.map);
  markMapDirty(room);
  return { ok: true, room };
}

function chooseTeam(player, team, options) {
  const room = options.getRoom(player.roomId);
  if (!room) return { ok: false, error: "房间不存在。" };
  if (!TEAMS.includes(team)) return { ok: false, error: "请选择队伍。" };
  if (room.status !== ROOM_STATUS.WAITING) {
    return { ok: false, error: "只有等待中可以换队。" };
  }

  const counts = getTeamCounts(room, options.getPlayer);
  if (player.team !== team && counts[team] >= 4) {
    return { ok: false, error: "队伍已满。" };
  }

  player.team = team;
  clearPlayerCombatState(player);
  return { ok: true, room };
}

function restartRoom(player, options) {
  const room = options.getRoom(player.roomId);
  if (!room) return { ok: false, error: "房间不存在。" };
  if (room.hostId !== player.id) return { ok: false, error: "只有房主可以开始游戏。" };
  if (room.status !== ROOM_STATUS.ENDED) return { ok: false, error: "只有游戏结束后可以再来一局。" };

  room.status = ROOM_STATUS.WAITING;
  room.redScore = 0;
  room.blueScore = 0;
  room.startedAt = null;
  room.endedAt = null;
  room.endedInfo = null;
  room.bullets = [];
  room.mapState = createMapDefinition(room.map);
  markMapDirty(room);
  room.countdownEndsAt = null;

  for (const playerId of [...room.players]) {
    const roomPlayer = options.getPlayer(playerId);
    if (!roomPlayer || !roomPlayer.online) {
      room.players.delete(playerId);
      continue;
    }
    roomPlayer.kills = 0;
    roomPlayer.deaths = 0;
    clearPlayerCombatState(roomPlayer);
  }
  assignHost(room, options.getPlayer);
  return { ok: true, room };
}

module.exports = {
  sanitizeNickname,
  validateNickname,
  normalizeScoreLimit,
  normalizeTimeLimit,
  makeUniqueNickname,
  createPlayer,
  createRoom,
  lobbyRoom,
  canJoinRoom,
  assignHost,
  addPlayerToRoom,
  removePlayerFromRoom,
  restoreDisconnectedPlayer,
  updateRoomConfig,
  chooseTeam,
  restartRoom,
};
