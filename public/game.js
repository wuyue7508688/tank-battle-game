"use strict";
(function () {
    const WORLD_WIDTH = 1280;
    const WORLD_HEIGHT = 720;
    const TANK_SIZE = 48;
    const TANK_RADIUS = 24;
    const MAX_FRAME_DELTA = 0.05;
    const POSITION_INTERPOLATION = 24;
    const SNAP_DISTANCE = 96;
    const { GameInput } = window.TankGameInput;
    const { MAP_PALETTES, TEAM_COLORS, TEAM_DARK } = window.TankGameRenderers;
    class TankBattleScene extends Phaser.Scene {
        constructor() {
            super("TankBattleScene");
            this.socket = null;
            this.playerId = null;
            this.latestState = null;
            this.latestMapState = null;
            this.tabKey = null;
            this.gameInput = null;
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
        }
        init(data) {
            this.socket = data.socket;
            this.playerId = data.playerId;
        }
        create() {
            this.cameras.main.setBackgroundColor("#11181b");
            this.gameInput = new GameInput(this);
            this.gameInput.create();
            this.tabKey = this.input.keyboard.addKey("TAB");
            this.input.keyboard.on("keydown-TAB", (event) => {
                event.preventDefault();
                window.TankClient.setScoreboardVisible(true);
            });
            this.input.keyboard.on("keyup-TAB", (event) => {
                event.preventDefault();
                window.TankClient.setScoreboardVisible(false);
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
        update(_time, delta = 1000 / 60) {
            this.updateFps();
            this.gameInput?.send(false);
            const dt = Math.min(delta / 1000, MAX_FRAME_DELTA);
            this.interpolatePlayers(dt);
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
                const shouldSnap = !player.alive || !wasAlive || distance > SNAP_DISTANCE;
                if (isSelf || shouldSnap) {
                    render.x = player.x;
                    render.y = player.y;
                    render.angle = player.angle;
                    render.velocityX = 0;
                    render.velocityY = 0;
                }
            }
            for (const id of this.renderPlayers.keys()) {
                if (!seenIds.has(id))
                    this.renderPlayers.delete(id);
            }
        }
        interpolatePlayers(dt) {
            const blend = Math.min(1, dt * POSITION_INTERPOLATION);
            for (const [id, render] of this.renderPlayers) {
                if (!render.alive || id === this.playerId)
                    continue;
                const distance = Math.hypot(render.targetX - render.x, render.targetY - render.y);
                if (distance > TANK_SIZE * 3) {
                    render.x = render.targetX;
                    render.y = render.targetY;
                }
                else {
                    render.x += (render.targetX - render.x) * blend;
                    render.y += (render.targetY - render.y) * blend;
                }
                render.angle = render.targetAngle;
            }
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
            const wallsVersion = window.TankGameRenderers.wallsVersion(this.latestMapState);
            if (this.lastMapKey === this.latestMapState.map &&
                this.lastMapVersion === this.latestMapState.mapVersion &&
                this.lastWallsVersion === wallsVersion)
                return;
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
            for (let x = 0; x <= WORLD_WIDTH; x += 32)
                bg.lineBetween(x, 0, x, WORLD_HEIGHT);
            for (let y = 0; y <= WORLD_HEIGHT; y += 32)
                bg.lineBetween(0, y, WORLD_WIDTH, y);
            for (const zone of this.latestMapState.zones) {
                bg.fillStyle(palette.zone, palette.zoneAlpha);
                bg.fillRect(zone.x, zone.y, zone.w, zone.h);
                bg.lineStyle(2, palette.zone, 0.5);
                bg.strokeRect(zone.x, zone.y, zone.w, zone.h);
            }
            for (const wall of this.latestMapState.walls) {
                if (!wall.alive)
                    continue;
                const color = wall.type === "hard" ? palette.hard : palette.brick;
                bg.fillStyle(color, 1);
                bg.fillRect(wall.x, wall.y, wall.w, wall.h);
                bg.lineStyle(3, 0x172025, 0.72);
                bg.strokeRect(wall.x, wall.y, wall.w, wall.h);
                if (wall.type === "brick") {
                    bg.lineStyle(1, 0xffffff, 0.18);
                    for (let y = wall.y + 16; y < wall.y + wall.h; y += 16)
                        bg.lineBetween(wall.x, y, wall.x + wall.w, y);
                    for (let x = wall.x + 24; x < wall.x + wall.w; x += 24)
                        bg.lineBetween(x, wall.y, x, wall.y + wall.h);
                }
            }
            bg.generateTexture(textureKey, WORLD_WIDTH, WORLD_HEIGHT);
            bg.destroy();
            const mapImage = this.add.image(0, 0, textureKey);
            mapImage.setOrigin(0, 0);
            mapImage.setDepth(0);
            this.mapImage = mapImage;
            this.mapTextureKey = textureKey;
        }
        drawEmptyMap() {
            if (this.lastMapKey === "empty")
                return;
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
            const mapImage = this.add.image(0, 0, textureKey);
            mapImage.setOrigin(0, 0);
            mapImage.setDepth(0);
            this.mapImage = mapImage;
        }
        renderState() {
            if (!this.latestState)
                return;
            this.renderTanks();
            this.renderBullets();
        }
        renderTanks() {
            if (!this.latestState)
                return;
            const aliveIds = new Set();
            for (const player of this.latestState.players) {
                if (!player.alive || !player.team)
                    continue;
                const render = this.renderPlayers.get(player.id) || player;
                const x = render.x;
                const y = render.y;
                const angle = render.angle;
                const tankTextureKey = window.TankGameRenderers.tankTextureKey(player, this.playerId);
                const barrelTextureKey = `tank-barrel-${player.team}`;
                aliveIds.add(player.id);
                const existingTank = this.tankSprites.get(player.id);
                const tank = existingTank || this.add.image(x, y, tankTextureKey);
                if (!existingTank) {
                    tank.setDepth(10);
                    this.tankSprites.set(player.id, tank);
                }
                if (tank.texture.key !== tankTextureKey) {
                    tank.setTexture(tankTextureKey);
                }
                tank.setPosition(x, y);
                tank.setAlpha(window.TankGameRenderers.tankAlpha(player, this.latestState, this.latestMapState));
                const existingBarrel = this.tankBarrels.get(player.id);
                const barrel = existingBarrel || this.add.image(x, y, barrelTextureKey);
                if (!existingBarrel) {
                    barrel.setOrigin(5 / 48, 0.5);
                    barrel.setDepth(11);
                    this.tankBarrels.set(player.id, barrel);
                }
                if (barrel.texture.key !== barrelTextureKey) {
                    barrel.setTexture(barrelTextureKey);
                }
                barrel.setPosition(x, y);
                barrel.setRotation(angle);
                barrel.setAlpha(tank.alpha);
                const existingName = this.nameTexts.get(player.id);
                const name = existingName || this.add.text(0, 0, "", {
                    fontFamily: "Trebuchet MS, Microsoft YaHei, sans-serif",
                    fontSize: "13px",
                    color: "#f1f5ef",
                    stroke: "#101417",
                    strokeThickness: 3,
                });
                if (!existingName) {
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
                const existingHp = this.hpBars.get(player.id);
                const hp = existingHp || this.add.graphics();
                if (!existingHp) {
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
            if (this.textures.exists(key))
                return;
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
            if (this.textures.exists(key))
                return;
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
            if (this.textures.exists(key))
                return;
            const g = this.add.graphics({ x: 7, y: 7 });
            g.fillStyle(team === "red" ? 0xffb1a7 : 0xaed2ff, 1);
            g.fillCircle(0, 0, 5);
            g.lineStyle(2, 0x11181b, 0.85);
            g.strokeCircle(0, 0, 5);
            g.generateTexture(key, 14, 14);
            g.destroy();
        }
        updateFps() {
            const now = performance.now();
            if (this.lastFrameAt) {
                const delta = now - this.lastFrameAt;
                if (delta > 0) {
                    this.fpsSamples.push(1000 / delta);
                    if (this.fpsSamples.length > 120)
                        this.fpsSamples.shift();
                }
            }
            this.lastFrameAt = now;
            if (this.fpsSamples.length > 120)
                this.fpsSamples.shift();
            if (now - this.lastFpsUpdate >= 250) {
                this.currentFps = this.fpsSamples.reduce((sum, fps) => sum + fps, 0) / this.fpsSamples.length;
                window.TankGame.lastFps = this.currentFps;
                this.lastFpsUpdate = now;
            }
        }
        renderBullets() {
            if (!this.latestState)
                return;
            const ids = new Set();
            for (const bullet of this.latestState.bullets) {
                ids.add(bullet.id);
                const textureKey = `bullet-${bullet.team}`;
                const existingSprite = this.bulletSprites.get(bullet.id);
                const sprite = existingSprite || this.add.image(bullet.x, bullet.y, textureKey);
                if (!existingSprite) {
                    sprite.setDepth(9);
                    this.bulletSprites.set(bullet.id, sprite);
                }
                if (sprite.texture.key !== textureKey)
                    sprite.setTexture(textureKey);
                sprite.setPosition(bullet.x, bullet.y);
            }
            for (const [id, sprite] of this.bulletSprites) {
                if (!ids.has(id)) {
                    sprite.destroy();
                    this.bulletSprites.delete(id);
                }
            }
        }
    }
    let phaserGame = null;
    let scene = null;
    window.TankGame = {
        lastFps: 0,
        start(socket, playerId) {
            if (phaserGame) {
                scene?.setPlayerId(playerId);
                return;
            }
            const game = new Phaser.Game({
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
            phaserGame = game;
            game.events.once("ready", () => {
                scene = game.scene.getScene("TankBattleScene");
                scene.socket = socket;
                scene.playerId = playerId;
            });
            game.scene.start("TankBattleScene", { socket, playerId });
            scene = game.scene.getScene("TankBattleScene");
        },
        updateState(state) {
            if (scene)
                scene.setState(state);
        },
        updateMapState(mapState) {
            if (scene)
                scene.setMapState(mapState);
        },
        setPlayerId(playerId) {
            if (scene)
                scene.setPlayerId(playerId);
        },
        getPerformanceStats() {
            if (!scene || !scene.fpsSamples.length)
                return { avgFps: 0, minFps: 0, stableMinFps: 0, sampleCount: 0 };
            const samples = scene.fpsSamples.filter((fps) => Number.isFinite(fps) && fps > 0);
            const avgFps = samples.reduce((sum, fps) => sum + fps, 0) / samples.length;
            const minFps = Math.min(...samples);
            const sorted = [...samples].sort((a, b) => a - b);
            const p95LowFps = sorted[Math.floor(sorted.length * 0.05)] || minFps;
            const stableMinFps = sorted[Math.floor(sorted.length * 0.01)] || minFps;
            return { avgFps, minFps, stableMinFps, p95LowFps, sampleCount: samples.length };
        },
        getDebugSnapshot() {
            if (!scene)
                return null;
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
