import { MODE_NAMES, ROOM_STATUS, TEAMS } from "./game-constants";
import {
  createMapDefinition,
  markMapDirty,
  normalizeMapKey,
} from "./maps";
import {
  clearPlayerCombatState,
  getOnlinePlayers,
  getTeamCounts,
  spawnPlayer,
} from "./game-room";
import type { GameMode, MapKey, Player, Room, Team } from "./types";

type GetPlayer = (playerId: string) => Player | undefined;
type GetRoom = (roomId: string | null) => Room | undefined;

interface DisconnectedPlayer {
  playerId: string;
  roomId: string;
  team: Team;
  kills: number;
  deaths: number;
  nickname: string;
  disconnectedAt: number;
}

interface CreateRoomConfig {
  map?: unknown;
  mode?: unknown;
  timeLimit?: unknown;
  scoreLimit?: unknown;
}

interface CreateRoomOptions {
  allowTestLimits: boolean;
  createRoomCode: () => string;
  createRoomId: () => string;
  getPlayer: GetPlayer;
  now: number;
}

interface AddPlayerOptions {
  getPlayer: GetPlayer;
  now: number;
  removePlayerFromRoom: (player: Player, markDisconnected?: boolean) => void;
}

interface RemovePlayerOptions {
  getRoom: GetRoom;
  getPlayer: GetPlayer;
  saveDisconnected: (room: Room, player: Player) => void;
  deleteRoom: (roomId: string) => void;
  now: number;
}

interface RestoreOptions {
  getRoom: GetRoom;
  getPlayer: GetPlayer;
  deletePlayer: (playerId: string) => void;
  now: number;
}

interface RoomMutationOptions {
  getRoom: GetRoom;
  getPlayer: GetPlayer;
  allowTestLimits?: boolean;
}

interface LobbyRoom {
  id: string;
  code: string;
  map: MapKey;
  mapName: string;
  mode: GameMode;
  modeName: string;
  status: Room["status"];
  playerCount: number;
  maxPlayers: number;
  canJoin: boolean;
}

export function sanitizeNickname(value: unknown): string {
  return String(value || "").trim();
}

export function validateNickname(value: unknown): { ok: true; nickname: string } | { ok: false; message: string } {
  const nickname = sanitizeNickname(value);
  if (!nickname) return { ok: false, message: "昵称不能为空。" };
  if (nickname.length > 12) return { ok: false, message: "昵称长度不能超过 12 个字符。" };
  return { ok: true, nickname };
}

export function normalizeScoreLimit(value: unknown, allowTestLimits = false): number {
  const number = Number(value);
  if ([10, 20, 30].includes(number)) return number;
  if (allowTestLimits && Number.isInteger(number) && number >= 1 && number <= 30) return number;
  return 10;
}

export function normalizeTimeLimit(value: unknown, allowTestLimits = false): number {
  const number = Number(value);
  if ([180, 300, 600].includes(number)) return number;
  if (allowTestLimits && Number.isInteger(number) && number >= 1 && number <= 600) return number;
  return 180;
}

export function makeUniqueNickname(room: Room | null, desired: string, playerId: string, getPlayer: GetPlayer, allPlayers: Player[] = []): string {
  const base = sanitizeNickname(desired);
  const existing = room
    ? [...room.players]
        .map((id) => getPlayer(id))
        .filter((player): player is Player => Boolean(player && player.id !== playerId))
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

export function createPlayer(socketId: string, nickname: string, now = Date.now()): Player {
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

export function createRoom(host: Player, config: CreateRoomConfig, options: CreateRoomOptions): Room {
  const now = options.now || Date.now();
  const mapKey = normalizeMapKey(config.map);
  const mode: GameMode = config.mode === "time" ? "time" : "score";
  const room: Room = {
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

export function lobbyRoom(room: Room, getPlayer: GetPlayer): LobbyRoom {
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

export function canJoinRoom(room: Room): boolean {
  return room.status === ROOM_STATUS.WAITING || room.status === ROOM_STATUS.ENDED;
}

export function assignHost(room: Room, getPlayer: GetPlayer): void {
  const onlinePlayers = getOnlinePlayers(room, getPlayer).sort((a, b) => a.joinedAt - b.joinedAt);
  const nextHost = onlinePlayers[0];
  room.hostId = nextHost ? nextHost.id : null;
  for (const playerId of room.players) {
    const player = getPlayer(playerId);
    if (player) player.isHost = player.id === room.hostId;
  }
}

export function addPlayerToRoom(player: Player, room: Room, options: AddPlayerOptions): { ok: true } | { ok: false; error: string } {
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

export function removePlayerFromRoom(player: Player, options: RemovePlayerOptions, markDisconnected = false): { room: Room | null; deletedRoom: boolean } {
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

export function restoreDisconnectedPlayer(player: Player, saved: DisconnectedPlayer, options: RestoreOptions): { ok: true; room: Room; shouldSpawn: boolean } | { ok: false } {
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

  const shouldSpawn = (room.status === ROOM_STATUS.PLAYING || room.status === ROOM_STATUS.COUNTDOWN) && Boolean(player.team);
  if (shouldSpawn) {
    spawnPlayer(room, player, options.getPlayer, options.now || Date.now(), true);
  }

  return { ok: true, room, shouldSpawn };
}

export function updateRoomConfig(player: Player, data: Record<string, unknown>, options: RoomMutationOptions): { ok: true; room: Room } | { ok: false; error: string } {
  const room = options.getRoom(player.roomId);
  if (!room) return { ok: false, error: "房间不存在。" };
  if (room.hostId !== player.id) return { ok: false, error: "只有房主可以修改房间配置。" };
  if (room.status !== ROOM_STATUS.WAITING) {
    return { ok: false, error: "只有等待中可以修改房间配置。" };
  }

  if (data.map === "snow" || data.map === "desert" || data.map === "jungle") room.map = data.map;
  if (data.mode === "score" || data.mode === "time") room.mode = data.mode;
  room.scoreLimit = normalizeScoreLimit(data.scoreLimit ?? room.scoreLimit, options.allowTestLimits);
  room.timeLimit = normalizeTimeLimit(data.timeLimit ?? room.timeLimit, options.allowTestLimits);
  room.mapState = createMapDefinition(room.map);
  markMapDirty(room);
  return { ok: true, room };
}

export function chooseTeam(player: Player, team: unknown, options: RoomMutationOptions): { ok: true; room: Room } | { ok: false; error: string } {
  const room = options.getRoom(player.roomId);
  if (!room) return { ok: false, error: "房间不存在。" };
  if (team !== "red" && team !== "blue") return { ok: false, error: "请选择队伍。" };
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

export function restartRoom(player: Player, options: RoomMutationOptions): { ok: true; room: Room } | { ok: false; error: string } {
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

export type { DisconnectedPlayer };
