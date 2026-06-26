const {
  BULLET_RANGE,
  BULLET_RADIUS,
  BULLET_SPEED,
  DT,
  EMPTY_TEAM_GRACE_MS,
  FIRE_COOLDOWN_MS,
  INVINCIBLE_MS,
  MAP_NAMES,
  MODE_NAMES,
  RESPAWN_DELAY_MS,
  ROOM_STATUS,
  TANK_RADIUS,
  TANK_SIZE,
  TANK_SPEED,
  TEAMS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} = require("./game-constants");
const {
  clamp,
  collidesWithWall,
  createMapDefinition,
  hitWallWithBullet,
  markMapDirty,
  movementModifiers,
} = require("./maps");

let nextBulletId = 1;

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function normalizeVector(x, y) {
  const length = Math.hypot(x, y);
  if (length === 0) return { x: 0, y: 0 };
  return { x: x / length, y: y / length };
}

function shortName(name) {
  return name.length > 6 ? `${name.slice(0, 3)}...` : name;
}

function publicPlayer(player, now = Date.now()) {
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
    invincible: now < player.invincibleUntil,
    kills: player.kills,
    deaths: player.deaths,
  };
}

function publicRoom(room, getPlayer, now = Date.now()) {
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
    players: [...room.players].map((id) => getPlayer(id)).filter(Boolean).map((player) => publicPlayer(player, now)),
    countdownEndsAt: room.countdownEndsAt,
    endedInfo: room.endedInfo,
  };
}

function publicGameState(room, getPlayer, now = Date.now()) {
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
    players: [...room.players]
      .map((id) => getPlayer(id))
      .filter((player) => player && player.online)
      .map((player) => ({
        id: player.id,
        nickname: player.nickname,
        shortName: shortName(player.nickname),
        team: player.team,
        x: Math.round(player.x * 10) / 10,
        y: Math.round(player.y * 10) / 10,
        angle: Math.round(player.angle * 1000) / 1000,
        hp: player.hp,
        alive: player.alive,
        invincible: now < player.invincibleUntil,
        kills: player.kills,
        deaths: player.deaths,
      })),
    bullets: room.bullets.map((bullet) => ({
      id: bullet.id,
      team: bullet.team,
      x: Math.round(bullet.x * 10) / 10,
      y: Math.round(bullet.y * 10) / 10,
    })),
    mapVersion: room.mapVersion,
    countdownEndsAt: room.countdownEndsAt,
    endedInfo: room.endedInfo,
  };
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

function getTeamCounts(room, getPlayer) {
  const counts = { red: 0, blue: 0 };
  for (const playerId of room.players) {
    const player = getPlayer(playerId);
    if (player && player.online && player.team) {
      counts[player.team] += 1;
    }
  }
  return counts;
}

function getOnlinePlayers(room, getPlayer) {
  return [...room.players].map((id) => getPlayer(id)).filter((player) => player && player.online);
}

function playerCanCollide(player) {
  return player.online && player.alive && player.team;
}

function chooseSpawn(room, team, getPlayer) {
  const points = room.mapState.spawnPoints[team];
  const livePlayers = getOnlinePlayers(room, getPlayer).filter((player) => player.alive);
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

function spawnPlayer(room, player, getPlayer, now = Date.now(), invincible = true) {
  const spawn = chooseSpawn(room, player.team, getPlayer);
  player.x = spawn.x;
  player.y = spawn.y;
  player.angle = player.team === "red" ? 0 : Math.PI;
  player.hp = 3;
  player.alive = true;
  player.respawnAt = 0;
  player.invincibleUntil = invincible ? now + INVINCIBLE_MS : 0;
  player.velocityX = 0;
  player.velocityY = 0;
}

function resetRoomForMatch(room, getPlayer, now = Date.now()) {
  room.status = ROOM_STATUS.COUNTDOWN;
  room.redScore = 0;
  room.blueScore = 0;
  room.startedAt = null;
  room.endedAt = null;
  room.endedInfo = null;
  room.bullets = [];
  room.mapState = createMapDefinition(room.map);
  markMapDirty(room);
  room.countdownEndsAt = now + 3000;
  room.emptyTeamSince = { red: null, blue: null };

  for (const playerId of room.players) {
    const player = getPlayer(playerId);
    if (!player || !player.online || !player.team) continue;
    player.kills = 0;
    player.deaths = 0;
    clearPlayerCombatState(player);
    spawnPlayer(room, player, getPlayer, now, false);
  }
}

function endGame(room, winner, reason, getPlayer, now = Date.now()) {
  if (room.status === ROOM_STATUS.ENDED) return null;
  room.status = ROOM_STATUS.ENDED;
  room.endedAt = now;
  room.countdownEndsAt = null;
  room.bullets = [];
  room.endedInfo = {
    winner,
    reason,
    redScore: room.redScore,
    blueScore: room.blueScore,
    players: [...room.players].map((id) => getPlayer(id)).filter(Boolean).map((player) => publicPlayer(player, now)),
  };
  return { type: "gameEnded", info: room.endedInfo };
}

function validateStart(room, getPlayer) {
  const onlinePlayers = getOnlinePlayers(room, getPlayer);
  if (onlinePlayers.length < 2) return "至少 2 人才能开始。";
  if (onlinePlayers.some((player) => !player.team)) return "有玩家未选择队伍。";
  const counts = getTeamCounts(room, getPlayer);
  if (counts.red < 1 || counts.blue < 1) return "红蓝队都至少需要 1 人。";
  return "";
}

function collidesWithTank(room, player, x, y, getPlayer) {
  return getOnlinePlayers(room, getPlayer).some((other) => {
    if (other.id === player.id || !playerCanCollide(other)) return false;
    return distanceSq({ x, y }, other) < TANK_SIZE * TANK_SIZE;
  });
}

function movePlayer(room, player, dt, getPlayer) {
  if (!playerCanCollide(player)) return;

  const input = player.lastInput;
  let mx = 0;
  let my = 0;
  if (input.left) mx -= 1;
  if (input.right) mx += 1;
  if (input.up) my -= 1;
  if (input.down) my += 1;

  player.angle = Number.isFinite(input.angle) ? input.angle : player.angle;

  const { onIce, onQuicksand } = movementModifiers(room, player);
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

  if (!collidesWithWall(room, nextX, player.y) && !collidesWithTank(room, player, nextX, player.y, getPlayer)) {
    player.x = nextX;
  } else {
    player.velocityX = 0;
  }

  if (!collidesWithWall(room, player.x, nextY) && !collidesWithTank(room, player, player.x, nextY, getPlayer)) {
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

function damagePlayer(room, target, attackerId, now, getPlayer) {
  if (now < target.invincibleUntil || !target.alive) return { damaged: false, events: [] };

  target.hp -= 1;
  if (target.hp > 0) return { damaged: true, events: [] };

  target.alive = false;
  target.hp = 0;
  target.deaths += 1;
  target.respawnAt = now + RESPAWN_DELAY_MS;
  target.velocityX = 0;
  target.velocityY = 0;

  const attacker = getPlayer(attackerId);
  if (attacker && attacker.team && attacker.team !== target.team) {
    attacker.kills += 1;
    if (attacker.team === "red") room.redScore += 1;
    if (attacker.team === "blue") room.blueScore += 1;
  }

  const events = [];
  if (room.mode === "score") {
    if (room.redScore >= room.scoreLimit) {
      const event = endGame(room, "red", "scoreLimit", getPlayer, now);
      if (event) events.push(event);
    }
    if (room.blueScore >= room.scoreLimit) {
      const event = endGame(room, "blue", "scoreLimit", getPlayer, now);
      if (event) events.push(event);
    }
  }
  return { damaged: true, events };
}

function updateBullets(room, dt, now, getPlayer) {
  const nextBullets = [];
  const events = [];

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

    if (hitWallWithBullet(room, bullet, BULLET_RADIUS)) continue;

    let consumed = false;
    for (const target of getOnlinePlayers(room, getPlayer)) {
      if (!playerCanCollide(target)) continue;
      if (target.team === bullet.team) continue;
      if (now < target.invincibleUntil) continue;
      if (distanceSq(target, bullet) <= (TANK_RADIUS + BULLET_RADIUS) ** 2) {
        const result = damagePlayer(room, target, bullet.ownerId, now, getPlayer);
        events.push(...result.events);
        consumed = true;
        break;
      }
    }
    if (room.status !== ROOM_STATUS.PLAYING) break;
    if (!consumed) nextBullets.push(bullet);
  }

  room.bullets = nextBullets;
  return events;
}

function updateRespawns(room, now, getPlayer) {
  for (const player of getOnlinePlayers(room, getPlayer)) {
    if (!player.team || player.alive || !player.respawnAt) continue;
    if (now >= player.respawnAt) {
      spawnPlayer(room, player, getPlayer, now, true);
    }
  }
}

function updateEmptyTeams(room, now, getPlayer) {
  if (room.status !== ROOM_STATUS.PLAYING) return [];
  const counts = getTeamCounts(room, getPlayer);

  for (const team of TEAMS) {
    if (counts[team] === 0) {
      if (!room.emptyTeamSince[team]) room.emptyTeamSince[team] = now;
    } else {
      room.emptyTeamSince[team] = null;
    }
  }

  const redEmptyLongEnough = room.emptyTeamSince.red && now - room.emptyTeamSince.red >= EMPTY_TEAM_GRACE_MS;
  const blueEmptyLongEnough = room.emptyTeamSince.blue && now - room.emptyTeamSince.blue >= EMPTY_TEAM_GRACE_MS;

  const event = redEmptyLongEnough && blueEmptyLongEnough
    ? endGame(room, null, "allPlayersLeft", getPlayer, now)
    : redEmptyLongEnough
      ? endGame(room, "blue", "enemyTeamLeft", getPlayer, now)
      : blueEmptyLongEnough
        ? endGame(room, "red", "enemyTeamLeft", getPlayer, now)
        : null;
  return event ? [event] : [];
}

function updateTimeLimit(room, now, getPlayer) {
  if (room.status !== ROOM_STATUS.PLAYING || room.mode !== "time" || !room.startedAt) return [];
  const elapsed = (now - room.startedAt) / 1000;
  if (elapsed < room.timeLimit) return [];
  let winner = null;
  if (room.redScore > room.blueScore) winner = "red";
  if (room.blueScore > room.redScore) winner = "blue";
  const event = endGame(room, winner, "timeLimit", getPlayer, now);
  return event ? [event] : [];
}

function startCountdownIfReady(room, getPlayer, now = Date.now()) {
  const error = validateStart(room, getPlayer);
  if (error) return { ok: false, error, events: [] };
  resetRoomForMatch(room, getPlayer, now);
  return {
    ok: true,
    events: [
      { type: "countdown", endsAt: room.countdownEndsAt },
      { type: "roomState" },
      { type: "mapState" },
    ],
  };
}

function tickRoom(room, now, getPlayer) {
  const events = [];

  if (room.status === ROOM_STATUS.COUNTDOWN && room.countdownEndsAt && now >= room.countdownEndsAt) {
    room.status = ROOM_STATUS.PLAYING;
    room.startedAt = now;
    room.countdownEndsAt = null;
    events.push({ type: "gameStarted" }, { type: "roomState" });
  }

  if (room.status !== ROOM_STATUS.PLAYING) return events;

  for (const player of getOnlinePlayers(room, getPlayer)) {
    movePlayer(room, player, DT, getPlayer);
    tryFire(room, player, now);
  }

  events.push(...updateBullets(room, DT, now, getPlayer));
  updateRespawns(room, now, getPlayer);
  events.push(...updateTimeLimit(room, now, getPlayer));
  events.push(...updateEmptyTeams(room, now, getPlayer));

  return events;
}

function awardPointForTest(room, team, getPlayer, now = Date.now()) {
  if (!TEAMS.includes(team)) return [];
  if (team === "red") room.redScore += 1;
  if (team === "blue") room.blueScore += 1;
  if (room.mode !== "score") return [];

  const event = team === "red" && room.redScore >= room.scoreLimit
    ? endGame(room, "red", "scoreLimit", getPlayer, now)
    : team === "blue" && room.blueScore >= room.scoreLimit
      ? endGame(room, "blue", "scoreLimit", getPlayer, now)
      : null;
  return event ? [event] : [];
}

module.exports = {
  distanceSq,
  normalizeVector,
  shortName,
  publicPlayer,
  publicRoom,
  publicGameState,
  clearPlayerCombatState,
  getTeamCounts,
  getOnlinePlayers,
  playerCanCollide,
  chooseSpawn,
  spawnPlayer,
  resetRoomForMatch,
  endGame,
  validateStart,
  movePlayer,
  tryFire,
  damagePlayer,
  updateBullets,
  updateRespawns,
  updateEmptyTeams,
  updateTimeLimit,
  startCountdownIfReady,
  tickRoom,
  awardPointForTest,
};
