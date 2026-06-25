(function () {
  const WORLD_WIDTH = 1280;
  const WORLD_HEIGHT = 720;

  const TEAM_COLORS = {
    red: 0xe24b4b,
    blue: 0x3d8cff,
  };

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
      this.keys = null;
      this.tabKey = null;
      this.pointerDown = false;
      this.tankGraphics = new Map();
      this.nameTexts = new Map();
      this.hpBars = new Map();
      this.bulletGraphics = new Map();
      this.wallGraphics = new Map();
      this.zoneGraphics = [];
      this.lastMapKey = "";
      this.lastWallsVersion = "";
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
      this.drawStaticMap();
    }

    setState(state) {
      this.latestState = state;
      this.drawStaticMap();
    }

    setPlayerId(playerId) {
      this.playerId = playerId;
    }

    update() {
      this.renderState();
      this.sendInput(false);
    }

    drawStaticMap() {
      if (!this.latestState) {
        this.drawEmptyMap();
        return;
      }

      const wallsVersion = this.latestState.walls
        .map((wall) => `${wall.id}:${wall.alive ? 1 : 0}`)
        .join("|");
      if (this.lastMapKey === this.latestState.map && this.lastWallsVersion === wallsVersion) return;
      this.lastMapKey = this.latestState.map;
      this.lastWallsVersion = wallsVersion;

      this.children.removeAll();
      this.tankGraphics.clear();
      this.nameTexts.clear();
      this.hpBars.clear();
      this.bulletGraphics.clear();
      this.wallGraphics.clear();
      this.zoneGraphics = [];

      const palette = MAP_PALETTES[this.latestState.map] || MAP_PALETTES.snow;
      const bg = this.add.graphics();
      bg.fillStyle(palette.floor, 1);
      bg.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
      bg.lineStyle(1, palette.grid, 0.32);
      for (let x = 0; x <= WORLD_WIDTH; x += 32) bg.lineBetween(x, 0, x, WORLD_HEIGHT);
      for (let y = 0; y <= WORLD_HEIGHT; y += 32) bg.lineBetween(0, y, WORLD_WIDTH, y);

      for (const zone of this.latestState.zones) {
        const g = this.add.graphics();
        g.fillStyle(palette.zone, palette.zoneAlpha);
        g.fillRect(zone.x, zone.y, zone.w, zone.h);
        g.lineStyle(2, palette.zone, 0.5);
        g.strokeRect(zone.x, zone.y, zone.w, zone.h);
        this.zoneGraphics.push(g);
      }

      for (const wall of this.latestState.walls) {
        if (!wall.alive) continue;
        const g = this.add.graphics();
        const color = wall.type === "hard" ? palette.hard : palette.brick;
        g.fillStyle(color, 1);
        g.fillRect(wall.x, wall.y, wall.w, wall.h);
        g.lineStyle(3, 0x172025, 0.72);
        g.strokeRect(wall.x, wall.y, wall.w, wall.h);
        if (wall.type === "brick") {
          g.lineStyle(1, 0xffffff, 0.18);
          for (let y = wall.y + 16; y < wall.y + wall.h; y += 16) g.lineBetween(wall.x, y, wall.x + wall.w, y);
          for (let x = wall.x + 24; x < wall.x + wall.w; x += 24) g.lineBetween(x, wall.y, x, wall.y + wall.h);
        }
        this.wallGraphics.set(wall.id, g);
      }
    }

    drawEmptyMap() {
      if (this.lastMapKey === "empty") return;
      this.lastMapKey = "empty";
      this.children.removeAll();
      const bg = this.add.graphics();
      bg.fillStyle(0x11181b, 1);
      bg.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
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
        aliveIds.add(player.id);
        let tank = this.tankGraphics.get(player.id);
        if (!tank) {
          tank = this.add.graphics();
          this.tankGraphics.set(player.id, tank);
        }
        tank.clear();
        tank.setPosition(player.x, player.y);
        tank.setAlpha(this.tankAlpha(player));
        tank.setDepth(10);

        const mainColor = TEAM_COLORS[player.team] || 0xffffff;
        const darkColor = TEAM_DARK[player.team] || 0x888888;
        const isSelf = player.id === this.playerId;

        tank.lineStyle(isSelf ? 4 : 2, isSelf ? 0xf3c969 : 0x172025, 1);
        tank.fillStyle(darkColor, 1);
        tank.fillRoundedRect(-25, -21, 50, 42, 5);
        tank.fillStyle(mainColor, 1);
        tank.fillRoundedRect(-19, -16, 38, 32, 4);
        tank.fillStyle(0x1b2226, 1);
        tank.fillRect(-24, -23, 48, 8);
        tank.fillRect(-24, 15, 48, 8);
        tank.lineStyle(7, mainColor, 1);
        tank.lineBetween(0, 0, Math.cos(player.angle) * 39, Math.sin(player.angle) * 39);
        tank.fillStyle(0x11181b, 1);
        tank.fillCircle(0, 0, 9);

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
          this.nameTexts.set(player.id, name);
        }
        name.setText(player.shortName || player.nickname);
        name.setPosition(player.x, player.y - 32);
        name.setAlpha(tank.alpha);

        let hp = this.hpBars.get(player.id);
        if (!hp) {
          hp = this.add.graphics();
          hp.setDepth(13);
          this.hpBars.set(player.id, hp);
        }
        hp.clear();
        hp.fillStyle(0x11181b, 0.8);
        hp.fillRect(player.x - 22, player.y + 29, 44, 5);
        hp.fillStyle(player.hp >= 2 ? 0x5ac08e : 0xff6a4f, 1);
        hp.fillRect(player.x - 22, player.y + 29, (44 * Math.max(player.hp, 0)) / 3, 5);
      }

      for (const [id, graphic] of this.tankGraphics) {
        if (!aliveIds.has(id)) {
          graphic.destroy();
          this.tankGraphics.delete(id);
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

    tankAlpha(player) {
      if (this.latestState.map === "jungle") {
        const inGrass = this.latestState.zones.some((zone) => {
          return zone.type === "grass" && player.x >= zone.x && player.x <= zone.x + zone.w && player.y >= zone.y && player.y <= zone.y + zone.h;
        });
        if (inGrass) return 0.48;
      }
      if (player.invincible) return 0.62 + Math.sin(Date.now() / 80) * 0.18;
      return 1;
    }

    renderBullets() {
      const ids = new Set();
      for (const bullet of this.latestState.bullets) {
        ids.add(bullet.id);
        let g = this.bulletGraphics.get(bullet.id);
        if (!g) {
          g = this.add.graphics();
          g.setDepth(9);
          this.bulletGraphics.set(bullet.id, g);
        }
        g.clear();
        g.fillStyle(bullet.team === "red" ? 0xffb1a7 : 0xaed2ff, 1);
        g.fillCircle(bullet.x, bullet.y, 5);
        g.lineStyle(2, 0x11181b, 0.85);
        g.strokeCircle(bullet.x, bullet.y, 5);
      }

      for (const [id, graphic] of this.bulletGraphics) {
        if (!ids.has(id)) {
          graphic.destroy();
          this.bulletGraphics.delete(id);
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
    start(socket, playerId) {
      if (phaserGame) {
        scene.setPlayerId(playerId);
        return;
      }
      phaserGame = new Phaser.Game({
        type: Phaser.AUTO,
        parent: "gameCanvasWrap",
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
        pixelArt: true,
        backgroundColor: "#11181b",
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
    setPlayerId(playerId) {
      if (scene) scene.setPlayerId(playerId);
    },
  };
})();
