import assert from "assert";

import { ROOM_STATUS } from "../src/game-constants";
import { createMapDefinition } from "../src/maps";
import {
  damagePlayer,
  movePlayer,
  publicGameState,
  startCountdownIfReady,
  tickRoom,
  validateStart,
} from "../src/game-room";
import type { Player, Room, Team } from "../src/types";

function makePlayer(id: string, team: Team | null = null): Player {
  return {
    id,
    socketId: id,
    nickname: id,
    roomId: "room-1",
    team,
    isHost: id === "red",
    joinedAt: id === "red" ? 1 : 2,
    online: true,
    disconnectedAt: null,
    x: team === "blue" ? 1184 : 96,
    y: 140,
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

function makeRoom(overrides: Partial<Room> = {}): Room {
  const room: Room = {
    id: "room-1",
    code: "ABCD",
    hostId: "red",
    players: new Set(["red", "blue"]),
    map: "snow",
    mode: "score",
    timeLimit: 180,
    scoreLimit: 1,
    status: ROOM_STATUS.WAITING,
    redScore: 0,
    blueScore: 0,
    startedAt: null,
    endedAt: null,
    endedInfo: null,
    bullets: [],
    mapState: createMapDefinition("snow"),
    mapVersion: 1,
    mapDirty: true,
    countdownEndsAt: null,
    emptyTeamSince: { red: null, blue: null },
    createdAt: 0,
  };
  return Object.assign(room, overrides);
}

function makeStore(players: Player[]): { getPlayer: (id: string) => Player | undefined } {
  const map = new Map(players.map((player) => [player.id, player]));
  return {
    getPlayer(id: string) {
      return map.get(id);
    },
  };
}

function testStartValidationAndCountdown(): void {
  const red = makePlayer("red", "red");
  const blue = makePlayer("blue", null);
  const room = makeRoom();
  const { getPlayer } = makeStore([red, blue]);

  assert.strictEqual(validateStart(room, getPlayer), "有玩家未选择队伍。");

  blue.team = "blue";
  const result = startCountdownIfReady(room, getPlayer, 1000);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(room.status, ROOM_STATUS.COUNTDOWN);
  assert.strictEqual(room.countdownEndsAt, 4000);

  const events = tickRoom(room, 4000, getPlayer);
  assert.strictEqual(room.status, ROOM_STATUS.PLAYING);
  assert.ok(events.some((event) => event.type === "gameStarted"));
}

function testScoreLimitEndsGame(): void {
  const red = makePlayer("red", "red");
  const blue = makePlayer("blue", "blue");
  const room = makeRoom({ status: ROOM_STATUS.PLAYING, scoreLimit: 1 });
  const { getPlayer } = makeStore([red, blue]);

  blue.hp = 1;
  const result = damagePlayer(room, blue, red.id, 5000, getPlayer);
  assert.strictEqual(result.damaged, true);
  assert.strictEqual(room.status, ROOM_STATUS.ENDED);
  assert.strictEqual(room.redScore, 1);
  assert.strictEqual(red.kills, 1);
  assert.strictEqual(blue.deaths, 1);
  assert.strictEqual(room.endedInfo?.winner, "red");
}

function testTimeLimitDraw(): void {
  const red = makePlayer("red", "red");
  const blue = makePlayer("blue", "blue");
  const room = makeRoom({
    mode: "time",
    status: ROOM_STATUS.PLAYING,
    startedAt: 1000,
    timeLimit: 1,
  });
  const { getPlayer } = makeStore([red, blue]);

  const events = tickRoom(room, 2100, getPlayer);
  assert.strictEqual(room.status, ROOM_STATUS.ENDED);
  assert.strictEqual(room.endedInfo?.winner, null);
  assert.ok(events.some((event) => event.type === "gameEnded"));
}

function testTerrainMovement(): void {
  const red = makePlayer("red", "red");
  const blue = makePlayer("blue", "blue");
  const desertRoom = makeRoom({
    map: "desert",
    mapState: createMapDefinition("desert"),
    status: ROOM_STATUS.PLAYING,
  });
  const { getPlayer } = makeStore([red, blue]);

  red.x = 560;
  red.y = 240;
  red.lastInput.right = true;
  movePlayer(desertRoom, red, 1, getPlayer);
  assert.strictEqual(Math.round(red.x), 686);

  const state = publicGameState(desertRoom, getPlayer, 1000);
  assert.strictEqual(state.players.find((player) => player.id === "red")?.x, 686);
}

testStartValidationAndCountdown();
testScoreLimitEndsGame();
testTimeLimitDraw();
testTerrainMovement();

console.log("规则测试通过");
