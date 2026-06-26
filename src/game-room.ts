import {
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
} from "./game-constants";
import {
  clamp,
  collidesWithWall,
  createMapDefinition,
  hitWallWithBullet,
  markMapDirty,
  movementModifiers,
} from "./maps";
import type {
  GameEvent,
  Player,
  Point,
  PublicGameState,
  PublicPlayer,
  PublicRoom,
  Room,
  Team,
} from "./types";

type GetPlayer = (playerId: string) => Player | undefined;

let nextBulletId = 1;

export function distanceSq(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function normalizeVector(x: number, y: number): Point {
  const length = Math.hypot(x, y);
  if (length === 0) return { x: 0, y: 0 };
  return { x: x / length, y: y / length };
}

export function shortName(name: string): string {
  return name.length > 6 ? `${name.slice(0, 3)}...` : name;
}

export function publicPlayer(player: Player, now = Date.now()): PublicPlayer {
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

function presentPlayer(player: Player | undefined): player is Player {
  return Boolean(player);
}

function onlinePlayer(player: Player | undefined): player is Player {
  return Boolean(player && player.online);
}

export function publicRoom(room: Room, getPlayer: GetPlayer, now = Date.now()): PublicRoom {
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
    players: [...room.players].map((id) => getPlayer(id)).filter(presentPlayer).map((player) => publicPlayer(player, now)),
    countdownEndsAt: room.countdownEndsAt,
    endedInfo: room.endedInfo,
  };
}

export function publicGameState(room: Room, getPlayer: GetPlayer, now = Date.now()): PublicGameState {
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
      .filter(onlinePlayer)
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

export function clearPlayerCombatState(player: Player): void {
  player.hp = 3;
  player.alive = true;
  player.invincibleUntil = 0;
  player.respawnAt = 0;
  player.lastFireAt = 0;
  player.velocityX = 0;
  player.velocityY = 0;
  player.lastInput = { up: false, down: false, left: false, right: false, angle: 0, firing: false };
}

export function getTeamCounts(room: Room, getPlayer: GetPlayer): Record<Team, number> {
  const counts: Record<Team, number> = { red: 0, blue: 0 };
  for (const playerId of room.players) {
    const player = getPlayer(playerId);
    if (player && player.online && player.team) {
      counts[player.team] += 1;
    }
  }
  return counts;
}

export function getOnlinePlayers(room: Room, getPlayer: GetPlayer): Player[] {
  return [...room.players].map((id) => getPlayer(id)).filter(onlinePlayer);
}

export function playerCanCollide(player: Player): boolean {
  return Boolean(player.online && player.alive && player.team);
}

export function chooseSpawn(room: Room, team: Team, getPlayer: GetPlayer): Point {
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

export function spawnPlayer(room: Room, player: Player, getPlayer: GetPlayer, now = Date.now(), invincible = true): void {
  if (!player.team) return;
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

export function resetRoomForMatch(room: Room, getPlayer: GetPlayer, now = Date.now()): void {
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

export function endGame(room: Room, winner: Team | null, reason: string, getPlayer: GetPlayer, now = Date.now()): GameEvent | null {
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
    players: [...room.players].map((id) => getPlayer(id)).filter(presentPlayer).map((player) => publicPlayer(player, now)),
  };
  return { type: "gameEnded", info: room.endedInfo };
}

export function validateStart(room: Room, getPlayer: GetPlayer): string {
  const onlinePlayers = getOnlinePlayers(room, getPlayer);
  if (onlinePlayers.length < 2) return "至少 2 人才能开始。";
  if (onlinePlayers.some((player) => !player.team)) return "有玩家未选择队伍。";
  const counts = getTeamCounts(room, getPlayer);
  if (counts.red < 1 || counts.blue < 1) return "红蓝队都至少需要 1 人。";
  return "";
}

function collidesWithTank(room: Room, player: Player, x: number, y: number, getPlayer: GetPlayer): boolean {
  return getOnlinePlayers(room, getPlayer).some((other) => {
    if (other.id === player.id || !playerCanCollide(other)) return false;
    return distanceSq({ x, y }, other) < TANK_SIZE * TANK_SIZE;
  });
}

export function movePlayer(room: Room, player: Player, dt: number, getPlayer: GetPlayer): void {
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

export function tryFire(room: Room, player: Player, now: number): void {
  if (!playerCanCollide(player) || !player.team) return;
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

export function damagePlayer(
  room: Room,
  target: Player,
  attackerId: string,
  now: number,
  getPlayer: GetPlayer,
): { damaged: boolean; events: GameEvent[] } {
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

  const events: GameEvent[] = [];
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

export function updateBullets(room: Room, dt: number, now: number, getPlayer: GetPlayer): GameEvent[] {
  const nextBullets = [];
  const events: GameEvent[] = [];

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

export function updateRespawns(room: Room, now: number, getPlayer: GetPlayer): void {
  for (const player of getOnlinePlayers(room, getPlayer)) {
    if (!player.team || player.alive || !player.respawnAt) continue;
    if (now >= player.respawnAt) {
      spawnPlayer(room, player, getPlayer, now, true);
    }
  }
}

export function updateEmptyTeams(room: Room, now: number, getPlayer: GetPlayer): GameEvent[] {
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

export function updateTimeLimit(room: Room, now: number, getPlayer: GetPlayer): GameEvent[] {
  if (room.status !== ROOM_STATUS.PLAYING || room.mode !== "time" || !room.startedAt) return [];
  const elapsed = (now - room.startedAt) / 1000;
  if (elapsed < room.timeLimit) return [];
  let winner: Team | null = null;
  if (room.redScore > room.blueScore) winner = "red";
  if (room.blueScore > room.redScore) winner = "blue";
  const event = endGame(room, winner, "timeLimit", getPlayer, now);
  return event ? [event] : [];
}

export function startCountdownIfReady(room: Room, getPlayer: GetPlayer, now = Date.now()): { ok: true; events: GameEvent[] } | { ok: false; error: string; events: GameEvent[] } {
  const error = validateStart(room, getPlayer);
  if (error) return { ok: false, error, events: [] };
  resetRoomForMatch(room, getPlayer, now);
  return {
    ok: true,
    events: [
      { type: "countdown", endsAt: room.countdownEndsAt ?? undefined },
      { type: "roomState" },
      { type: "mapState" },
    ],
  };
}

export function tickRoom(room: Room, now: number, getPlayer: GetPlayer): GameEvent[] {
  const events: GameEvent[] = [];

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

export function awardPointForTest(room: Room, team: string, getPlayer: GetPlayer, now = Date.now()): GameEvent[] {
  if (team !== "red" && team !== "blue") return [];
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
