// @ts-nocheck
(function () {
  const WORLD_WIDTH = 1280;
  const WORLD_HEIGHT = 720;

  function createInitialInputPayload() {
    return {
      up: false,
      down: false,
      left: false,
      right: false,
      angle: 0,
      firing: false,
    };
  }

  class GameInput {
    constructor(scene) {
      this.scene = scene;
      this.pointerDown = false;
      this.mouseClient = { x: 0, y: 0 };
      this.payload = createInitialInputPayload();
      this.keys = null;
    }

    create() {
      this.keys = this.scene.input.keyboard.addKeys({
        up: "W",
        down: "S",
        left: "A",
        right: "D",
        arrowUp: "UP",
        arrowDown: "DOWN",
        arrowLeft: "LEFT",
        arrowRight: "RIGHT",
      });
      this.scene.input.on("pointerdown", (pointer) => {
        if (pointer.leftButtonDown()) this.pointerDown = true;
      });
      this.scene.input.on("pointerup", () => {
        this.pointerDown = false;
      });
      window.addEventListener("mousemove", (event) => {
        this.mouseClient.x = event.clientX;
        this.mouseClient.y = event.clientY;
      });
      window.addEventListener("blur", () => {
        this.pointerDown = false;
        this.send(true);
      });
    }

    send(forceClear) {
      const scene = this.scene;
      if (!scene.socket || !scene.latestState) return;
      const pointer = scene.input.activePointer;
      const self = scene.latestState.players.find((player) => player.id === scene.playerId);
      let angle = this.payload.angle;
      if (self) {
        const canvas = scene.game.canvas;
        const rect = canvas.getBoundingClientRect();
        const localX = ((this.mouseClient.x - rect.left) / rect.width) * WORLD_WIDTH;
        const localY = ((this.mouseClient.y - rect.top) / rect.height) * WORLD_HEIGHT;
        const worldPoint = Number.isFinite(localX) && Number.isFinite(localY)
          ? { x: localX, y: localY }
          : scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
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

      const changed = Object.keys(payload).some((key) => payload[key] !== this.payload[key]);
      if (changed || payload.firing) {
        this.payload = payload;
        scene.socket.emit("playerInput", payload);
      }
    }
  }

  window.TankGameInput = {
    GameInput,
    createInitialInputPayload,
  };
})();
