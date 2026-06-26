export type Team = "red" | "blue";
export type GameMode = "score" | "time";
export type RoomStatus = "waiting" | "countdown" | "playing" | "ended";
export type MapKey = "snow" | "desert" | "jungle";
export type WallType = "hard" | "brick";
export type ZoneType = "ice" | "quicksand" | "grass";

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  w: number;
  h: number;
}

export interface Wall extends Rect {
  id: string;
  type: WallType;
  alive: boolean;
}

export interface Zone extends Rect {
  type: ZoneType;
}

export interface MapDefinition {
  key: MapKey;
  name: string;
  spawnPoints: Record<Team, Point[]>;
  walls: Wall[];
  zones: Zone[];
}

export interface PlayerInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  angle: number;
  firing: boolean;
}

export interface Player extends Point {
  id: string;
  socketId: string;
  nickname: string;
  roomId: string | null;
  team: Team | null;
  isHost: boolean;
  joinedAt: number;
  online: boolean;
  disconnectedAt: number | null;
  angle: number;
  hp: number;
  alive: boolean;
  invincibleUntil: number;
  kills: number;
  deaths: number;
  lastInput: PlayerInput;
  lastFireAt: number;
  respawnAt: number;
  velocityX: number;
  velocityY: number;
}

export interface Bullet extends Point {
  id: string;
  ownerId: string;
  team: Team;
  angle: number;
  traveled: number;
}

export interface EndedInfo {
  winner: Team | null;
  reason: string;
  redScore: number;
  blueScore: number;
  players: PublicPlayer[];
}

export interface Room {
  id: string;
  code: string;
  hostId: string | null;
  players: Set<string>;
  map: MapKey;
  mode: GameMode;
  timeLimit: number;
  scoreLimit: number;
  status: RoomStatus;
  redScore: number;
  blueScore: number;
  startedAt: number | null;
  endedAt: number | null;
  endedInfo: EndedInfo | null;
  bullets: Bullet[];
  mapState: MapDefinition;
  mapVersion: number;
  mapDirty: boolean;
  countdownEndsAt: number | null;
  emptyTeamSince: Record<Team, number | null>;
  createdAt: number;
}

export interface PublicPlayer extends Point {
  id: string;
  nickname: string;
  shortName: string;
  team: Team | null;
  isHost: boolean;
  joinedAt: number;
  online: boolean;
  angle: number;
  hp: number;
  alive: boolean;
  invincible: boolean;
  kills: number;
  deaths: number;
}

export interface PublicRoom {
  id: string;
  code: string;
  hostId: string | null;
  map: MapKey;
  mapName: string;
  mode: GameMode;
  modeName: string;
  timeLimit: number;
  scoreLimit: number;
  status: RoomStatus;
  redScore: number;
  blueScore: number;
  maxPlayers: number;
  players: PublicPlayer[];
  countdownEndsAt: number | null;
  endedInfo: EndedInfo | null;
}

export interface PublicMapState {
  roomId: string;
  map: MapKey;
  mapName: string;
  mapVersion: number;
  walls: Wall[];
  zones: Zone[];
}

export interface PublicGameState {
  roomId: string;
  status: RoomStatus;
  map: MapKey;
  mapName: string;
  mode: GameMode;
  timeLimit: number;
  scoreLimit: number;
  remainingSeconds: number | null;
  redScore: number;
  blueScore: number;
  players: Array<{
    id: string;
    nickname: string;
    shortName: string;
    team: Team | null;
    x: number;
    y: number;
    angle: number;
    hp: number;
    alive: boolean;
    invincible: boolean;
    kills: number;
    deaths: number;
  }>;
  bullets: Array<{
    id: string;
    team: Team;
    x: number;
    y: number;
  }>;
  mapVersion: number;
  countdownEndsAt: number | null;
  endedInfo: EndedInfo | null;
}

export interface GameEvent {
  type: "countdown" | "gameStarted" | "gameEnded" | "roomState" | "mapState";
  endsAt?: number;
  info?: EndedInfo;
}
