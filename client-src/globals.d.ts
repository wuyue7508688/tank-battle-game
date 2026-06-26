type Team = "red" | "blue";
type GameMode = "score" | "time";
type RoomStatus = "waiting" | "countdown" | "playing" | "ended";
type MapKey = "snow" | "desert" | "jungle";
type WallType = "hard" | "brick";
type ZoneType = "ice" | "quicksand" | "grass";

interface Point {
  x: number;
  y: number;
}

interface Rect extends Point {
  w: number;
  h: number;
}

interface Wall extends Rect {
  id: string;
  type: WallType;
  alive: boolean;
}

interface Zone extends Rect {
  type: ZoneType;
}

interface PlayerInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  angle: number;
  firing: boolean;
}

interface PublicPlayer extends Point {
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

interface EndedInfo {
  winner: Team | null;
  reason?: string;
  redScore: number;
  blueScore: number;
  players: PublicPlayer[];
}

interface PublicRoom {
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

interface LobbyRoom {
  id: string;
  code: string;
  map: MapKey;
  mapName: string;
  mode: GameMode;
  modeName: string;
  status: RoomStatus;
  playerCount: number;
  maxPlayers: number;
  canJoin: boolean;
}

interface PublicMapState {
  roomId: string;
  map: MapKey;
  mapName: string;
  mapVersion: number;
  walls: Wall[];
  zones: Zone[];
}

interface PublicGameState {
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
  players: PublicPlayer[];
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

interface CountdownPayload {
  endsAt: number;
}

interface NicknameSetPayload {
  nickname: string;
  playerId: string;
}

interface AckResponse {
  ok: boolean;
  error?: string;
  nickname?: string;
  playerId?: string;
  room?: PublicRoom;
}

interface SocketLike {
  emit(event: string, ...args: unknown[]): void;
  on<T>(event: string, handler: (payload: T) => void): void;
  on(event: string, handler: () => void): void;
}

interface SocketFactory {
  (options: { transports: string[] }): SocketLike;
}

interface PerformanceStats {
  avgFps: number;
  minFps: number;
  stableMinFps: number;
  p95LowFps?: number;
  sampleCount: number;
}

interface DebugPlayerSnapshot {
  id: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  bodyX: number | null;
  bodyY: number | null;
  bodyWidth: number | null;
  bodyHeight: number | null;
  barrelX: number | null;
  barrelY: number | null;
  barrelWidth: number | null;
  barrelHeight: number | null;
}

interface DebugSnapshot {
  status: RoomStatus | null;
  playerId: string | null;
  players: DebugPlayerSnapshot[];
}

interface TankClientApi {
  setScoreboardVisible(visible: boolean): void;
}

interface TankGameApi {
  lastFps: number;
  start(socket: SocketLike, playerId: string | null): void;
  updateState(state: PublicGameState): void;
  updateMapState(mapState: PublicMapState): void;
  setPlayerId(playerId: string | null): void;
  getPerformanceStats(): PerformanceStats;
  getDebugSnapshot(): DebugSnapshot | null;
}

interface KeyLike {
  isDown: boolean;
}

interface InputKeys {
  up: KeyLike;
  down: KeyLike;
  left: KeyLike;
  right: KeyLike;
  arrowUp: KeyLike;
  arrowDown: KeyLike;
  arrowLeft: KeyLike;
  arrowRight: KeyLike;
}

interface PhaserPointerLike {
  x: number;
  y: number;
  leftButtonDown(): boolean;
}

interface PhaserSceneLike {
  socket: SocketLike | null;
  playerId: string | null;
  latestState: PublicGameState | null;
  game: { canvas: HTMLCanvasElement };
  input: {
    keyboard: {
      addKey(key: string): unknown;
      addKeys(keys: Record<string, string>): InputKeys;
      on(event: string, handler: (event: KeyboardEvent) => void): void;
    };
    activePointer: PhaserPointerLike;
    on(event: "pointerdown", handler: (pointer: PhaserPointerLike) => void): void;
    on(event: "pointerup", handler: () => void): void;
  };
  cameras: {
    main: {
      setBackgroundColor(color: string): void;
      getWorldPoint(x: number, y: number): Point;
    };
  };
}

type SceneLike = PhaserSceneLike;

interface PhaserGameLike {
  events: {
    once(event: string, handler: () => void): void;
  };
  scene: {
    getScene(key: string): unknown;
    start(key: string, data: unknown): void;
  };
}

interface PhaserRuntime {
  Scene: new (key: string) => {};
  Game: new (config: Record<string, unknown>) => PhaserGameLike;
  CANVAS: number;
  Scale: {
    FIT: number;
    CENTER_BOTH: number;
  };
}

interface RenderPlayer extends Point {
  angle: number;
  targetX: number;
  targetY: number;
  targetAngle: number;
  velocityX: number;
  velocityY: number;
  alive: boolean;
}

interface PhaserImageLike {
  x: number;
  y: number;
  alpha: number;
  texture: { key: string };
  displayWidth: number;
  displayHeight: number;
  setDepth(depth: number): void;
  setOrigin(x: number, y: number): void;
  setPosition(x: number, y: number): void;
  setTexture(key: string): void;
  setAlpha(alpha: number): void;
  setRotation(angle: number): void;
  destroy(): void;
}

interface PhaserTextLike extends PhaserImageLike {
  lastText: string;
  setText(text: string): void;
}

interface PhaserGraphicsLike {
  lastHp?: number | null;
  setDepth(depth: number): void;
  clear(): void;
  fillStyle(color: number, alpha?: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillRoundedRect(x: number, y: number, width: number, height: number, radius: number): void;
  fillCircle(x: number, y: number, radius: number): void;
  lineStyle(width: number, color: number, alpha?: number): void;
  lineBetween(x1: number, y1: number, x2: number, y2: number): void;
  setPosition(x: number, y: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  strokeCircle(x: number, y: number, radius: number): void;
  generateTexture(key: string, width: number, height: number): void;
  destroy(): void;
}

interface TankBattleSceneLike extends PhaserSceneLike {
  socket: SocketLike | null;
  playerId: string | null;
  latestState: PublicGameState | null;
  latestMapState: PublicMapState | null;
  tabKey: unknown;
  gameInput: GameInputInstance | null;
  tankSprites: Map<string, PhaserImageLike>;
  tankBarrels: Map<string, PhaserImageLike>;
  nameTexts: Map<string, PhaserTextLike>;
  hpBars: Map<string, PhaserGraphicsLike>;
  bulletSprites: Map<string, PhaserImageLike>;
  renderPlayers: Map<string, RenderPlayer>;
  mapImage: PhaserImageLike | null;
  mapTextureKey: string;
  lastMapKey: string;
  lastMapVersion: number;
  lastWallsVersion: string;
  fpsSamples: number[];
  lastFrameAt: number;
  lastFpsUpdate: number;
  currentFps: number;
  add: {
    graphics(config?: unknown): PhaserGraphicsLike;
    image(x: number, y: number, textureKey: string): PhaserImageLike;
    text(x: number, y: number, text: string, style: Record<string, string | number>): PhaserTextLike;
  };
  children: {
    list: Array<{ destroy(): void }>;
  };
  textures: {
    exists(key: string): boolean;
    remove(key: string): void;
  };
  setState(state: PublicGameState): void;
  setMapState(mapState: PublicMapState): void;
  setPlayerId(playerId: string | null): void;
}

interface TankGameInputApi {
  GameInput: new (scene: SceneLike) => GameInputInstance;
  createInitialInputPayload(): PlayerInput;
}

interface GameInputInstance {
  create(): void;
  send(forceClear: boolean): void;
}

interface MapPalette {
  floor: number;
  grid: number;
  hard: number;
  brick: number;
  zone: number;
  zoneAlpha: number;
}

type TeamColorMap = Record<Team, number>;
type MapPaletteMap = Record<MapKey, MapPalette>;

interface TankGameRenderersApi {
  TEAM_COLORS: TeamColorMap;
  TEAM_DARK: TeamColorMap;
  MAP_PALETTES: MapPaletteMap;
  tankTextureKey(player: PublicPlayer, playerId: string | null): string;
  tankAlpha(player: PublicPlayer, latestState: PublicGameState, latestMapState: PublicMapState | null): number;
  wallsVersion(mapState: PublicMapState): string;
}

interface TankUiRenderersApi {
  STATUS_NAMES: Record<RoomStatus, string>;
  TEAM_NAMES: Record<Team, string>;
  escapeHtml(value: unknown): string;
  renderRoomListHtml(rooms: LobbyRoom[]): string;
  renderTeamListHtml(team: Team, players: PublicPlayer[]): string;
  renderScoreboardHtml(players: PublicPlayer[]): string;
  renderResultsHtml(players: PublicPlayer[]): string;
}

declare const io: SocketFactory;
declare const Phaser: PhaserRuntime;

interface Window {
  TankClient: TankClientApi;
  TankGame: TankGameApi;
  TankGameInput: TankGameInputApi;
  TankGameRenderers: TankGameRenderersApi;
  TankUiRenderers: TankUiRenderersApi;
}
