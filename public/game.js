(function () {
  const WORLD_WIDTH = 1280;
  const WORLD_HEIGHT = 720;
  const TANK_SIZE = 48;
  const TANK_RADIUS = 24;
  const TANK_SPEED = 180;
  const MAX_FRAME_DELTA = 0.05;
  const SELF_IDLE_CORRECTION = 0.25;
  const SELF_MOVING_CORRECTION = 0.08;
  const SELF_MOVING_CORRECTION_DISTANCE = 36;
  const SELF_SNAP_DISTANCE = 96;
  const REMOTE_INTERPOLATION = 14;

  const TEAM_COLORS = {
    red: 0xe24b4b,
    blue: 0x3d8cff,
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function normalizeVector(x, y) {
    const length = Math.hypot(x, y);
    if (!length) return { x: 0, y: 0 };
    return { x: x / length, y: y / length };
  }

  const TEAM_DARK = {
    red: 0x7b2020,
    blue: 0x1f4c94,
  };

  const MAP_PALETTES = {
    snow: {
      floor: 0xcfe7ef,
      grid: 0xb6d4de,
      hard: 0x6f8791,
      brick: 0xbdd5da,
      zone: 0x9bd8f0,
      zoneAlpha: 0.36,
    },
    desert: {
      floor: 0xd9b66b,
      grid: 0xbf9854,
      hard: 0x8a6742,
      brick: 0xb9834d,
      zone: 0xa9793d,
      zoneAlpha: 0.44,
    },
    jungle: {
      floor: 0x426c4a,
      grid: 0x355a3e,
      hard: 0x324235,
      brick: 0x6c5938,
      zone: 0x1f8c52,
      zoneAlpha: 0.42,
    },
  };

  class TankBattleScene extends Phaser.Scene {
    constructor() {
      super("TankBattleScene");
      this.socket = null;
      this.playerId = null;
      this.latestState = null;
      this.latestMapState = null;
      this.keys = null;
      this.tabKey = null;
      this.pointerDown = false;
      this.tankSprites = new Map();
      this.tankBarrels = new Map();
      this.nameTexts = new Map();
      this.hpBars = new Map();
      this.bulletSprites = new Map();
      this.renderPlayers = new Map();
      this.mapImage = null;
      this.mapTextureKey = "";
      this.lastMapKey = "";
      this.lastMapVersion = 0;
      this.lastWallsVersion = "";
      this.fpsSamples = [];
      this.lastFrameAt = 0;
      this.lastFpsUpdate = 0;
      this.currentFps = 0;
      this.mouseClient = { x: 0, y: 0 };
      this.inputPayload = {
        up: false,
        down: false,
        left: false,
        right: false,
        angle: 0,
        firing: false,
      };
    }

    init(data) {
      this.socket = data.socket;
      this.playerId = data.playerId;
    }

    create() {
      this.cameras.main.setBackgroundColor("#11181b");
      this.keys = this.input.keyboard.addKeys({
        up: "W",
        down: "S",
        left: "A",
        right: "D",
        arrowUp: "UP",
        arrowDown: "DOWN",
        arrowLeft: "LEFT",
        arrowRight: "RIGHT",
      });
      this.tabKey = this.input.keyboard.addKey("TAB");
      this.input.keyboard.on("keydown-TAB", (event) => {
        event.preventDefault();
        window.TankClient.setScoreboardVisible(true);
      });
      this.input.keyboard.on("keyup-TAB", (event) => {
        event.preventDefault();
        window.TankClient.setScoreboardVisible(false);
      });
      this.input.on("pointerdown", (pointer) => {
        if (pointer.leftButtonDown()) this.pointerDown = true;
      });
      this.input.on("pointerup", () => {
        this.pointerDown = false;
      });
      window.addEventListener("mousemove", (event) => {
        this.mouseClient.x = event.clientX;
        this.mouseClient.y = event.clientY;
      });
      window.addEventListener("blur", () => {
        this.pointerDown = false;
        this.sendInput(true);
      });
      this.createSpriteTextures();
      this.drawStaticMap();
    }

    setState(state) {
      this.latestState = state;
      this.syncRenderPlayers(state);
      if (state.mapVersion && this.latestMapState && state.mapVersion !== this.latestMapState.mapVersion) {
        this.lastMapVersion = 0;
      }
    }

    setMapState(mapState) {
      this.latestMapState = mapState;
      this.drawStaticMap();
    }

    setPlayerId(playerId) {
      this.playerId = playerId;
    }

    update(time, delta = 1000 / 60) {
      this.updateFps();
      this.sendInput(false);
      const dt = Math.min(delta / 1000, MAX_FRAME_DELTA);
      this.predictLocalPlayer(dt);
      this.interpolateRemotePlayers(dt);
      this.renderState();
    }

    syncRenderPlayers(state) {
      const seenIds = new Set();
      for (const player of state.players) {
        seenIds.add(player.id);
        let render = this.renderPlayers.get(player.id);
        const wasAlive = render ? render.alive : false;
        if (!render) {
          render = {
            x: player.x,
            y: player.y,
            angle: player.angle,
            targetX: player.x,
            targetY: player.y,
            targetAngle: player.angle,
            velocityX: 0,
            velocityY: 0,
            alive: player.alive,
          };
          this.renderPlayers.set(player.id, render);
        }

        render.targetX = player.x;
        render.targetY = player.y;
        render.targetAngle = player.angle;
        render.alive = player.alive;

        const distance = Math.hypot(player.x - render.x, player.y - render.y);
        const isSelf = player.id === this.playerId;
        const movingSelf = isSelf && (this.hasMovementInput() || Math.hypot(render.velocityX, render.velocityY) > 8);
        const shouldSnap = !player.alive || !wasAlive || distance > SELF_SNAP_DISTANCE;
        if (shouldSnap) {
          render.x = player.x;
          render.y = player.y;
          render.angle = player.angle;
          render.velocityX = 0;
          render.velocityY = 0;
        } else if (isSelf) {
          if (movingSelf) {
            if (distance > SELF_MOVING_CORRECTION_DISTANCE) {
              render.x += (player.x - render.x) * SELF_MOVING_CORRECTION;
              render.y += (player.y - render.y) * SELF_MOVING_CORRECTION;
            }
          } else {
            render.x += (player.x - render.x) * SELF_IDLE_CORRECTION;
            render.y += (player.y - render.y) * SELF_IDLE_CORRECTION;
            render.angle = player.angle;
          }
        }
      }

      for (const id of this.renderPlayers.keys()) {
        if (!seenIds.has(id)) this.renderPlayers.delete(id);
      }
    }

    hasMovementInput() {
      return Boolean(this.inputPayload.up || this.inputPayload.down || this.inputPayload.left || this.inputPayload.right);
    }

    predictLocalPlayer(dt) {
      if (!this.latestState || this.latestState.status !== "playing") return;
      const player = this.latestState.players.find((item) => item.id === this.playerId);
      if (!player || !player.alive || !player.team) return;

      let render = this.renderPlayers.get(player.id);
      if (!render) {
        render = {
          x: player.x,
          y: player.y,
          angle: player.angle,
          targetX: player.x,
          targetY: player.y,
          targetAngle: player.angle,
          velocityX: 0,
          velocityY: 0,
          alive: player.alive,
        };
        this.renderPlayers.set(player.id, render);
      }

      let mx = 0;
      let my = 0;
      if (this.inputPayload.left) mx -= 1;
      if (this.inputPayload.right) mx += 1;
      if (this.inputPayload.up) my -= 1;
      if (this.inputPayload.down) my += 1;

      render.angle = Number.isFinite(this.inputPayload.angle) ? this.inputPayload.angle : render.angle;
      const direction = normalizeVector(mx, my);
      const onIce = this.latestState.map === "snow" && this.isInLocalZone(render.x, render.y, "ice");
      const onQuicksand = this.latestState.map === "desert" && this.isInLocalZone(render.x, render.y, "quicksand");
      const speed = TANK_SPEED * (onQuicksand ? 0.7 : 1);

      if (direction.x || direction.y) {
        render.velocityX = direction.x * speed;
        render.velocityY = direction.y * speed;
      } else if (onIce) {
        render.velocityX *= 0.94;
        render.velocityY *= 0.94;
        if (Math.hypot(render.velocityX, render.velocityY) < 8) {
          render.velocityX = 0;
          render.velocityY = 0;
        }
      } else {
        render.velocityX = 0;
        render.velocityY = 0;
      }

      const nextX = clamp(render.x + render.velocityX * dt, TANK_RADIUS, WORLD_WIDTH - TANK_RADIUS);
      const nextY = clamp(render.y + render.velocityY * dt, TANK_RADIUS, WORLD_HEIGHT - TANK_RADIUS);

      if (!this.collidesWithLocalWall(nextX, render.y)) {
        render.x = nextX;
      } else {
        render.velocityX = 0;
      }

      if (!this.collidesWithLocalWall(render.x, nextY)) {
        render.y = nextY;
      } else {
        render.velocityY = 0;
      }
    }

    interpolateRemotePlayers(dt) {
      const blend = Math.min(1, dt * REMOTE_INTERPOLATION);
      for (const [id, render] of this.renderPlayers) {
        if (id === this.playerId || !render.alive) continue;
        const distance = Math.hypot(render.targetX - render.x, render.targetY - render.y);
        if (distance > TANK_SIZE * 3) {
          render.x = render.targetX;
          render.y = render.targetY;
        } else {
          render.x += (render.targetX - render.x) * blend;
          render.y += (render.targetY - render.y) * blend;
        }
        render.angle = render.targetAngle;
      }
    }

    collidesWithLocalWall(x, y) {
      if (!this.latestMapState) return false;
      const rect = { x: x - TANK_RADIUS, y: y - TANK_RADIUS, w: TANK_SIZE, h: TANK_SIZE };
      return this.latestMapState.walls.some((wall) => wall.alive && rectsOverlap(rect, wall));
    }

    isInLocalZone(x, y, type) {
      if (!this.latestMapState) return false;
      const rect = { x: x - TANK_RADIUS, y: y - TANK_RADIUS, w: TANK_SIZE, h: TANK_SIZE };
      return this.latestMapState.zones.some((zone) => zone.type === type && rectsOverlap(rect, zone));
    }

    clearSceneObjects() {
      for (const child of [...this.children.list]) {
        child.destroy();
      }
      this.tankSprites.clear();
      this.tankBarrels.clear();
      this.nameTexts.clear();
      this.hpBars.clear();
      this.bulletSprites.clear();
      this.renderPlayers.clear();
      this.mapImage = null;
    }

    drawStaticMap() {
      if (!this.latestMapState) {
        this.drawEmptyMap();
        return;
      }

      const wallsVersion = this.latestMapState.walls
        .map((wall) => `${wall.id}:${wall.alive ? 1 : 0}`)
        .join("|");
      if (
        this.lastMapKey === this.latestMapState.map &&
        this.lastMapVersion === this.latestMapState.mapVersion &&
        this.lastWallsVersion === wallsVersion
      ) return;
      this.lastMapKey = this.latestMapState.map;
      this.lastMapVersion = this.latestMapState.mapVersion;
      this.lastWallsVersion = wallsVersion;

      this.clearSceneObjects();

      const palette = MAP_PALETTES[this.latestMapState.map] || MAP_PALETTES.snow;
      const textureKey = `map-${this.latestMapState.map}-${this.latestMapState.mapVersion}`;
      if (this.mapTextureKey && this.mapTextureKey !== textureKey && this.mapTextureKey !== "map-empty" && this.textures.exists(this.mapTextureKey)) {
        this.textures.remove(this.mapTextureKey);
      }
      if (this.textures.exists(textureKey)) {
        this.textures.remove(textureKey);
      }
      const bg = this.add.graphics();
      bg.fillStyle(palette.floor, 1);
      bg.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
      bg.lineStyle(1, palette.grid, 0.32);
      for (let x = 0; x <= WORLD_WIDTH; x += 32) bg.lineBetween(x, 0, x, WORLD_HEIGHT);
      for (let y = 0; y <= WORLD_HEIGHT; y += 32) bg.lineBetween(0, y, WORLD_WIDTH, y);

      for (const zone of this.latestMapState.zones) {
        bg.fillStyle(palette.zone, palette.zoneAlpha);
        bg.fillRect(zone.x, zone.y, zone.w, zone.h);
        bg.lineStyle(2, palette.zone, 0.5);
        bg.strokeRect(zone.x, zone.y, zone.w, zone.h);
      }

      for (const wall of this.latestMapState.walls) {
        if (!wall.alive) continue;
        const color = wall.type === "hard" ? palette.hard : palette.brick;
        bg.fillStyle(color, 1);
        bg.fillRect(wall.x, wall.y, wall.w, wall.h);
        bg.lineStyle(3, 0x172025, 0.72);
        bg.strokeRect(wall.x, wall.y, wall.w, wall.h);
        if (wall.type === "brick") {
          bg.lineStyle(1, 0xffffff, 0.18);
          for (let y = wall.y + 16; y < wall.y + wall.h; y += 16) bg.lineBetween(wall.x, y, wall.x + wall.w, y);
          for (let x = wall.x + 24; x < wall.x + wall.w; x += 24) bg.lineBetween(x, wall.y, x, wall.y + wall.h);
        }
      }

      bg.generateTexture(textureKey, WORLD_WIDTH, WORLD_HEIGHT);
      bg.destroy();
      this.mapImage = this.add.image(0, 0, textureKey);
      this.mapImage.setOrigin(0, 0);
      this.mapImage.setDepth(0);
      this.mapTextureKey = textureKey;
    }

    drawEmptyMap() {
      if (this.lastMapKey === "empty") return;
      this.lastMapKey = "empty";
      this.clearSceneObjects();
      const textureKey = "map-empty";
      if (!this.textures.exists(textureKey)) {
        const bg = this.add.graphics();
        bg.fillStyle(0x11181b, 1);
        bg.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
        bg.generateTexture(textureKey, WORLD_WIDTH, WORLD_HEIGHT);
        bg.destroy();
      }
      this.mapImage = this.add.image(0, 0, textureKey);
      this.mapImage.setOrigin(0, 0);
      this.mapImage.setDepth(0);
    }

    renderState() {
      if (!this.latestState) return;
      this.renderTanks();
      this.renderBullets();
    }

    renderTanks() {
      const aliveIds = new Set();
      for (const player of this.latestState.players) {
        if (!player.alive || !player.team) continue;
        const render = this.renderPlayers.get(player.id) || player;
        const x = render.x;
        const y = render.y;
        const angle = render.angle;
        aliveIds.add(player.id);
        let tank = this.tankSprites.get(player.id);
        if (!tank) {
          tank = this.add.image(x, y, this.tankTextureKey(player));
          tank.setDepth(10);
          this.tankSprites.set(player.id, tank);
        }
        if (tank.texture.key !== this.tankTextureKey(player)) {
          tank.setTexture(this.tankTextureKey(player));
        }
        tank.setPosition(x, y);
        tank.setAlpha(this.tankAlpha(player));

        let barrel = this.tankBarrels.get(player.id);
        if (!barrel) {
          barrel = this.add.image(x, y, `tank-barrel-${player.team}`);
          barrel.setOrigin(5 / 48, 0.5);
          barrel.setDepth(11);
          this.tankBarrels.set(player.id, barrel);
        }
        if (barrel.texture.key !== `tank-barrel-${player.team}`) {
          barrel.setTexture(`tank-barrel-${player.team}`);
        }
        barrel.setPosition(x, y);
        barrel.setRotation(angle);
        barrel.setAlpha(tank.alpha);

        let name = this.nameTexts.get(player.id);
        if (!name) {
          name = this.add.text(0, 0, "", {
            fontFamily: "Trebuchet MS, Microsoft YaHei, sans-serif",
            fontSize: "13px",
            color: "#f1f5ef",
            stroke: "#101417",
            strokeThickness: 3,
          });
          name.setOrigin(0.5, 1);
          name.setDepth(14);
          name.lastText = "";
          this.nameTexts.set(player.id, name);
        }
        const displayName = player.shortName || player.nickname;
        if (name.lastText !== displayName) {
          name.setText(displayName);
          name.lastText = displayName;
        }
        name.setPosition(x, y - 32);
        name.setAlpha(tank.alpha);

        let hp = this.hpBars.get(player.id);
        if (!hp) {
          hp = this.add.graphics();
          hp.setDepth(13);
          hp.lastHp = null;
          this.hpBars.set(player.id, hp);
        }
        if (hp.lastHp !== player.hp) {
          hp.clear();
          hp.fillStyle(0x11181b, 0.8);
          hp.fillRect(-22, 0, 44, 5);
          hp.fillStyle(player.hp >= 2 ? 0x5ac08e : 0xff6a4f, 1);
          hp.fillRect(-22, 0, (44 * Math.max(player.hp, 0)) / 3, 5);
          hp.lastHp = player.hp;
        }
        hp.setPosition(x, y + 29);
      }

      for (const [id, sprite] of this.tankSprites) {
        if (!aliveIds.has(id)) {
          sprite.destroy();
          this.tankSprites.delete(id);
        }
      }
      for (const [id, sprite] of this.tankBarrels) {
        if (!aliveIds.has(id)) {
          sprite.destroy();
          this.tankBarrels.delete(id);
        }
      }
      for (const [id, text] of this.nameTexts) {
        if (!aliveIds.has(id)) {
          text.destroy();
          this.nameTexts.delete(id);
        }
      }
      for (const [id, hp] of this.hpBars) {
        if (!aliveIds.has(id)) {
          hp.destroy();
          this.hpBars.delete(id);
        }
      }
    }

    createSpriteTextures() {
      for (const team of Object.keys(TEAM_COLORS)) {
        this.createTankBodyTexture(`tank-body-${team}`, team, false);
        this.createTankBodyTexture(`tank-body-${team}-self`, team, true);
        this.createTankBarrelTexture(`tank-barrel-${team}`, team);
        this.createBulletTexture(`bullet-${team}`, team);
      }
    }

    createTankBodyTexture(key, team, isSelf) {
      if (this.textures.exists(key)) return;
      const mainColor = TEAM_COLORS[team] || 0xffffff;
      const darkColor = TEAM_DARK[team] || 0x888888;
      const g = this.add.graphics();
      g.lineStyle(isSelf ? 4 : 2, isSelf ? 0xf3c969 : 0x172025, 1);
      g.fillStyle(darkColor, 1);
      g.fillRoundedRect(3, 5, 50, 42, 5);
      g.fillStyle(mainColor, 1);
      g.fillRoundedRect(9, 10, 38, 32, 4);
      g.fillStyle(0x1b2226, 1);
      g.fillRect(4, 3, 48, 8);
      g.fillRect(4, 41, 48, 8);
      g.fillStyle(0x11181b, 1);
      g.fillCircle(28, 26, 9);
      g.generateTexture(key, 56, 52);
      g.destroy();
    }

    createTankBarrelTexture(key, team) {
      if (this.textures.exists(key)) return;
      const mainColor = TEAM_COLORS[team] || 0xffffff;
      const g = this.add.graphics();
      g.lineStyle(7, mainColor, 1);
      g.lineBetween(5, 7, 44, 7);
      g.lineStyle(2, 0x101417, 0.78);
      g.lineBetween(5, 7, 44, 7);
      g.generateTexture(key, 48, 14);
      g.destroy();
    }

    createBulletTexture(key, team) {
      if (this.textures.exists(key)) return;
      const g = this.add.graphics({ x: 7, y: 7 });
      g.fillStyle(team === "red" ? 0xffb1a7 : 0xaed2ff, 1);
      g.fillCircle(0, 0, 5);
      g.lineStyle(2, 0x11181b, 0.85);
      g.strokeCircle(0, 0, 5);
      g.generateTexture(key, 14, 14);
      g.destroy();
    }

    tankTextureKey(player) {
      return `tank-body-${player.team}${player.id === this.playerId ? "-self" : ""}`;
    }

    tankAlpha(player) {
      if (this.latestState.map === "jungle" && this.latestMapState) {
        const inGrass = this.latestMapState.zones.some((zone) => {
          return zone.type === "grass" && player.x >= zone.x && player.x <= zone.x + zone.w && player.y >= zone.y && player.y <= zone.y + zone.h;
        });
        if (inGrass) return 0.48;
      }
      if (player.invincible) return 0.62 + Math.sin(Date.now() / 80) * 0.18;
      return 1;
    }

    updateFps() {
      const now = performance.now();
      if (this.lastFrameAt) {
        const delta = now - this.lastFrameAt;
        if (delta > 0) {
          this.fpsSamples.push(1000 / delta);
          if (this.fpsSamples.length > 120) this.fpsSamples.shift();
        }
      }
      this.lastFrameAt = now;
      if (this.fpsSamples.length > 120) this.fpsSamples.shift();
      if (now - this.lastFpsUpdate >= 250) {
        this.currentFps = this.fpsSamples.reduce((sum, fps) => sum + fps, 0) / this.fpsSamples.length;
        window.TankGame.lastFps = this.currentFps;
        this.lastFpsUpdate = now;
      }
    }

    renderBullets() {
      const ids = new Set();
      for (const bullet of this.latestState.bullets) {
        ids.add(bullet.id);
        let sprite = this.bulletSprites.get(bullet.id);
        const textureKey = `bullet-${bullet.team}`;
        if (!sprite) {
          sprite = this.add.image(bullet.x, bullet.y, textureKey);
          sprite.setDepth(9);
          this.bulletSprites.set(bullet.id, sprite);
        }
        if (sprite.texture.key !== textureKey) sprite.setTexture(textureKey);
        sprite.setPosition(bullet.x, bullet.y);
      }

      for (const [id, sprite] of this.bulletSprites) {
        if (!ids.has(id)) {
          sprite.destroy();
          this.bulletSprites.delete(id);
        }
      }
    }

    sendInput(forceClear) {
      if (!this.socket || !this.latestState) return;
      const pointer = this.input.activePointer;
      const self = this.latestState.players.find((player) => player.id === this.playerId);
      let angle = this.inputPayload.angle;
      if (self) {
        const canvas = this.game.canvas;
        const rect = canvas.getBoundingClientRect();
        const localX = ((this.mouseClient.x - rect.left) / rect.width) * WORLD_WIDTH;
        const localY = ((this.mouseClient.y - rect.top) / rect.height) * WORLD_HEIGHT;
        const worldPoint = Number.isFinite(localX) && Number.isFinite(localY)
          ? { x: localX, y: localY }
          : this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        angle = Math.atan2(worldPoint.y - self.y, worldPoint.x - self.x);
      }

      const payload = forceClear
        ? { up: false, down: false, left: false, right: false, angle, firing: false }
        : {
            up: Boolean(this.keys.up.isDown || this.keys.arrowUp.isDown),
            down: Boolean(this.keys.down.isDown || this.keys.arrowDown.isDown),
            left: Boolean(this.keys.left.isDown || this.keys.arrowLeft.isDown),
            right: Boolean(this.keys.right.isDown || this.keys.arrowRight.isDown),
            angle,
            firing: this.pointerDown,
          };

      const changed = Object.keys(payload).some((key) => payload[key] !== this.inputPayload[key]);
      if (changed || payload.firing) {
        this.inputPayload = payload;
        this.socket.emit("playerInput", payload);
      }
    }
  }

  let phaserGame = null;
  let scene = null;

  window.TankGame = {
    lastFps: 0,
    start(socket, playerId) {
      if (phaserGame) {
        scene.setPlayerId(playerId);
        return;
      }
      phaserGame = new Phaser.Game({
        type: Phaser.CANVAS,
        parent: "gameCanvasWrap",
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
        pixelArt: true,
        backgroundColor: "#11181b",
        fps: {
          target: 60,
          forceSetTimeOut: false,
        },
        scale: {
          mode: Phaser.Scale.FIT,
          autoCenter: Phaser.Scale.CENTER_BOTH,
        },
        scene: TankBattleScene,
      });
      phaserGame.events.once("ready", () => {
        scene = phaserGame.scene.getScene("TankBattleScene");
        scene.socket = socket;
        scene.playerId = playerId;
      });
      phaserGame.scene.start("TankBattleScene", { socket, playerId });
      scene = phaserGame.scene.getScene("TankBattleScene");
    },
    updateState(state) {
      if (scene) scene.setState(state);
    },
    updateMapState(mapState) {
      if (scene) scene.setMapState(mapState);
    },
    setPlayerId(playerId) {
      if (scene) scene.setPlayerId(playerId);
    },
    getPerformanceStats() {
      if (!scene || !scene.fpsSamples.length) return { avgFps: 0, minFps: 0, sampleCount: 0 };
      const samples = scene.fpsSamples.filter((fps) => Number.isFinite(fps) && fps > 0);
      const avgFps = samples.reduce((sum, fps) => sum + fps, 0) / samples.length;
      const minFps = Math.min(...samples);
      const sorted = [...samples].sort((a, b) => a - b);
      const p95LowFps = sorted[Math.floor(sorted.length * 0.05)] || minFps;
      return { avgFps, minFps, p95LowFps, sampleCount: samples.length };
    },
    getDebugSnapshot() {
      if (!scene) return null;
      const players = [];
      for (const [id, render] of scene.renderPlayers) {
        const body = scene.tankSprites.get(id);
        const barrel = scene.tankBarrels.get(id);
        players.push({
          id,
          x: render.x,
          y: render.y,
          targetX: render.targetX,
          targetY: render.targetY,
          bodyX: body ? body.x : null,
          bodyY: body ? body.y : null,
          bodyWidth: body ? body.displayWidth : null,
          bodyHeight: body ? body.displayHeight : null,
          barrelX: barrel ? barrel.x : null,
          barrelY: barrel ? barrel.y : null,
          barrelWidth: barrel ? barrel.displayWidth : null,
          barrelHeight: barrel ? barrel.displayHeight : null,
        });
      }
      return { status: scene.latestState ? scene.latestState.status : null, playerId: scene.playerId, players };
    },
  };
})();
