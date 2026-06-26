const {
  MAP_NAMES,
  TANK_RADIUS,
  TANK_SIZE,
} = require("./game-constants");

let nextWallId = 1;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function normalizeMapKey(value) {
  return ["snow", "desert", "jungle"].includes(value) ? value : "snow";
}

function createMapDefinition(key) {
  const normalizedKey = normalizeMapKey(key);
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

  if (normalizedKey === "desert") {
    return {
      key: normalizedKey,
      name: MAP_NAMES[normalizedKey],
      spawnPoints,
      walls: [...commonHardWalls, ...mirroredHardWalls, ...bricks],
      zones: [
        createZone(512, 192, 256, 112, "quicksand"),
        createZone(512, 432, 256, 112, "quicksand"),
      ],
    };
  }

  if (normalizedKey === "jungle") {
    return {
      key: normalizedKey,
      name: MAP_NAMES[normalizedKey],
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

function markMapDirty(room) {
  room.mapVersion += 1;
  room.mapDirty = true;
}

function publicMapState(room) {
  return {
    roomId: room.id,
    map: room.map,
    mapName: MAP_NAMES[room.map],
    mapVersion: room.mapVersion,
    walls: room.mapState.walls,
    zones: room.mapState.zones,
  };
}

function isTankInZone(room, player, type) {
  const rect = tankRect(player);
  return room.mapState.zones.some((zone) => zone.type === type && rectsOverlap(rect, zone));
}

function collidesWithWall(room, x, y) {
  const rect = { x: x - TANK_RADIUS, y: y - TANK_RADIUS, w: TANK_SIZE, h: TANK_SIZE };
  return room.mapState.walls.some((wall) => wall.alive && rectsOverlap(rect, wall));
}

function movementModifiers(room, player) {
  return {
    onIce: room.map === "snow" && isTankInZone(room, player, "ice"),
    onQuicksand: room.map === "desert" && isTankInZone(room, player, "quicksand"),
  };
}

function hitWallWithBullet(room, bullet, bulletRadius) {
  for (const wall of room.mapState.walls) {
    if (!wall.alive) continue;
    if (!circleRectCollides(bullet.x, bullet.y, bulletRadius, wall)) continue;
    if (wall.type === "brick") {
      wall.alive = false;
      markMapDirty(room);
    }
    return true;
  }
  return false;
}

module.exports = {
  clamp,
  circleRectCollides,
  rectsOverlap,
  tankRect,
  normalizeMapKey,
  createMapDefinition,
  markMapDirty,
  publicMapState,
  isTankInZone,
  collidesWithWall,
  movementModifiers,
  hitWallWithBullet,
};
