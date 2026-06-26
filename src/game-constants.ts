import type { GameMode, MapKey, RoomStatus, Team } from "./types";

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const STATE_BROADCAST_RATE = 60;
export const STATE_BROADCAST_INTERVAL_MS = 1000 / STATE_BROADCAST_RATE;

export const WORLD_WIDTH = 1280;
export const WORLD_HEIGHT = 720;
export const TANK_SIZE = 48;
export const TANK_RADIUS = 24;
export const BULLET_RADIUS = 4;
export const TANK_SPEED = 180;
export const BULLET_SPEED = 520;
export const BULLET_RANGE = 900;
export const FIRE_COOLDOWN_MS = 600;
export const RESPAWN_DELAY_MS = 2000;
export const INVINCIBLE_MS = 1500;
export const RECONNECT_MS = 10000;
export const EMPTY_TEAM_GRACE_MS = 10000;

export const MAP_NAMES: Record<MapKey, string> = {
  snow: "冰雪",
  desert: "沙漠",
  jungle: "雨林",
};

export const MODE_NAMES: Record<GameMode, string> = {
  score: "分数制",
  time: "时间制",
};

export const ROOM_STATUS: Record<"WAITING" | "COUNTDOWN" | "PLAYING" | "ENDED", RoomStatus> = {
  WAITING: "waiting",
  COUNTDOWN: "countdown",
  PLAYING: "playing",
  ENDED: "ended",
};

export const TEAMS: Team[] = ["red", "blue"];
