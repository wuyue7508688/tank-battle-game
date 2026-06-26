# 坦克大战小游戏架构分析

> 分析日期：2026-06-26  
> 范围：`server.js`、`public/client.js`、`public/game.js`、`scripts/smoke-test.js`、`scripts/ui-test.js`

## 结论先看

这个项目已经是一个完整可玩的局域网坦克大战小游戏。当前架构最明显的特点是：功能集中在少数几个大文件里。

## 执行状态

本报告中的六个优化方向已经开始落地：

- 后端新增 `src/game-room.js`，集中战斗规则。
- 后端新增 `src/maps.js`，集中地图定义、地形判断和墙体碰撞辅助。
- 后端新增 `src/room-lifecycle.js`，集中房间创建、加入、离开、重连和重开规则。
- 前端新增 `public/ui-renderers.js`，集中大厅、队伍、记分板和结算页的 DOM 输出。
- 前端新增 `public/game-input.js` 和 `public/game-renderers.js`，把 Phaser 输入处理和渲染辅助从 Scene 中拆出。
- 测试新增 `scripts/rules-test.js`，并接入 `npm test`。

当前完整验证命令已通过：

```bash
NODE_OPTIONS="--max-old-space-size=4096" npm test
```

- `server.js` 同时负责服务器启动、Socket.IO 事件、房间规则、地图生成、碰撞、炮弹、重生、胜负结算和对外数据格式。
- `public/client.js` 同时负责页面切换、DOM 更新、Socket.IO 事件、本地状态和 HUD。
- `public/game.js` 同时负责 Phaser 初始化、输入采集、网络输入发送、插值、地图绘制、坦克绘制、子弹绘制、FPS 统计和测试调试接口。

这不是错误。对第一版小游戏来说，这样写很直接，也容易快速做出来。

但如果之后继续加功能，比如道具、更多地图、观战、不同武器、AI 机器人、更多测试，当前结构会越来越难改。主要原因是很多规则没有集中在明确的 **Module** 后面，测试也只能穿过 Socket.IO 和浏览器做整条流程验证。

这里的建议不是一次性大重构，而是把几个高变化区域逐步变成更深的 **Module**。更深的意思是：调用者只学一个小 **Interface**，但这个 **Interface** 背后能处理更多行为。这样能带来更好的 **Leverage** 和 **Locality**。

## 项目现状概览

### 主要 Module

| Module | 当前职责 | 当前 Interface |
| --- | --- | --- |
| `server.js` | 后端服务器、房间、玩家、战斗、地图、Socket.IO | Socket.IO 事件和一批文件内函数 |
| `public/client.js` | 大厅、房间、结算页、HUD、Socket.IO 事件 | `window.TankClient` 和 DOM 事件 |
| `public/game.js` | Phaser 游戏画面、输入、渲染、调试快照 | `window.TankGame` |
| `scripts/smoke-test.js` | 后端流程验收 | 真实启动服务器后用 Socket.IO 测试 |
| `scripts/ui-test.js` | 浏览器 UI 验收 | Playwright 加真实服务器 |

### 当前优点

- 文件少，新人能比较快找到入口。
- 需求覆盖完整，README 和 REQUIREMENTS 写得清楚。
- 已有自动验收测试，覆盖房间、选队、开始、地图、胜负、重连和 UI。
- 服务端是权威状态，客户端只负责显示和输入，这个方向是对的。

### 当前主要摩擦

- 一个概念要在多个位置一起理解。比如“地图”同时影响 `createMapDefinition`、移动减速、冰面滑动、草丛透明、地图绘制和测试断言。
- 很多规则只能通过真实网络流程测试。比如分数制结束、时间制结束、断线重连，都要先启动服务器、连 socket、建房间、选队、开始游戏。
- `server.js` 的函数互相依赖全局 `players`、`rooms`、`io`、`Date.now()`，这让单独测试一个规则比较难。
- 前端 DOM 字符串拼接和状态切换绑在一起，修改页面时容易误伤流程状态。
- `game.js` 的 Phaser Scene 很大，输入、绘制和调试都在一个 **Implementation** 里，后续加画面效果或输入规则时容易互相影响。

## 优化候选 1：把后端战斗规则沉到 Game Room Module

**Recommendation strength：Strong**

### Files

- `server.js`
- 未来可以拆出：`src/game-room.js` 或 `src/domain/game-room.js`

### Problem

`server.js` 里战斗相关规则分散在很多函数中：

- `resetRoomForMatch`
- `endGame`
- `validateStart`
- `chooseSpawn`
- `spawnPlayer`
- `movePlayer`
- `tryFire`
- `damagePlayer`
- `updateBullets`
- `updateRespawns`
- `updateEmptyTeams`
- `updateTimeLimit`
- `tickRoom`

这些函数看起来是小函数，但它们共享同一个房间对象、玩家 Map、时间、Socket.IO 发送逻辑和全局常量。调用者必须知道很多隐含顺序：

1. 先校验能否开始。
2. 再重置房间。
3. 倒计时结束后切到 playing。
4. 每帧先移动，再开火，再更新炮弹，再重生，再检查胜负。
5. 结束游戏时还要广播 roomState 和 gameEnded。

这个 **Interface** 不是一个明确函数，而是一组调用顺序和共享状态。它偏 **Shallow**：外部和测试需要知道的细节，接近内部 **Implementation** 的复杂度。

### Solution

建立一个“房间战斗规则” **Module**。

它不一定一开始就要用 class。可以先从普通函数开始，把纯规则集中起来。例如：

- 创建一局比赛。
- 处理一帧 tick。
- 应用玩家输入。
- 结算炮弹命中。
- 判断是否结束。
- 生成对外 gameState。

Socket.IO 层只负责：

- 接收事件。
- 找到玩家和房间。
- 调用房间战斗规则。
- 把结果广播出去。

### Benefits

- **Locality**：移动、开火、命中、重生、胜负结算集中在一个地方。以后改武器或重生规则，不需要在 Socket.IO 事件和定时器之间来回找。
- **Leverage**：测试可以直接构造房间状态，然后调用 tick，不必每次启动真实服务器。
- **Interface** 更小：调用者只需要知道“给房间、输入、时间，得到更新后的状态和事件”，不用知道每个内部步骤。
- **The interface is the test surface**：以后可以用单元测试直接测分数制、时间制、重生、冰面、流沙和炮弹命中。

### Before

```text
Socket.IO event
  |
  v
server.js
  |-- players Map
  |-- rooms Map
  |-- Date.now()
  |-- io.emit()
  |-- movePlayer()
  |-- tryFire()
  |-- updateBullets()
  |-- endGame()
  |-- publicGameState()
```

### After

```text
Socket.IO Adapter
  |
  v
Game Room Module
  |-- startMatch()
  |-- applyInput()
  |-- tick()
  |-- toPublicState()
  |
  v
Broadcast results
```

### Deletion test

如果删除这个新 **Module**，战斗规则会重新散回 Socket.IO 事件、定时器和测试辅助事件里。所以它不是空转包装，而是能真正集中复杂度。

## 优化候选 2：把地图定义和地图效果集中成 Map Module

**Recommendation strength：Strong**

### Files

- `server.js`
- `public/game.js`
- 未来可以拆出：`src/maps.js`，前端可有对应的 `public/map-rendering.js`

### Problem

地图这个概念现在分散在两边：

- 后端 `createMapDefinition` 决定出生点、墙、特殊地形。
- 后端 `movePlayer` 知道冰面和流沙效果。
- 后端 `updateBullets` 知道砖墙可破坏。
- 前端 `MAP_PALETTES` 知道地图颜色。
- 前端 `tankAlpha` 知道雨林草丛半隐藏。
- 测试通过检查 `mapState.zones` 来确认特殊地形存在。

这说明“地图”不是只用来显示的配置。它同时影响规则和画面。

当前 **Seam** 不清晰。新增地图时，维护者必须记得改后端定义、移动规则、前端颜色、草丛显示和测试。知识分散，**Locality** 不够。

### Solution

把地图定义做成一个更深的 **Module**。

它可以先提供这些能力：

- 根据地图 key 创建地图状态。
- 判断一个坦克是否在某类地形里。
- 根据地形返回移动修正，比如流沙减速、冰面摩擦。
- 判断墙是否挡住坦克或炮弹。
- 提供前端需要的地图展示数据。

注意：不建议马上做很复杂的插件系统。现在只有 3 张地图，一个简单对象表就够。

### Benefits

- **Locality**：新增“火山地图”时，地图出生点、特殊地形、移动效果和渲染提示可以更集中。
- **Leverage**：战斗规则只问 Map Module：“这里怎么移动？”而不是自己判断 snow/desert/jungle。
- 测试更简单：可以单独测试冰面、流沙、草丛、墙体，不需要完整开一局。
- 前后端更容易对齐：地图 key、zone type、wall type 不容易出现拼写漂移。

### Before

```text
Map concept
  |-- server.js createMapDefinition()
  |-- server.js movePlayer()
  |-- server.js updateBullets()
  |-- public/game.js MAP_PALETTES
  |-- public/game.js tankAlpha()
  |-- scripts/smoke-test.js zone checks
```

### After

```text
Map Module
  |-- definition
  |-- terrain effects
  |-- collision helpers
  |-- public map snapshot
       |
       +--> Game Room Module
       +--> Phaser rendering
       +--> tests
```

### Deletion test

如果删除 Map Module，地图规则又会分散回移动、炮弹、渲染和测试。这个 **Module** 能集中真实复杂度。

## 优化候选 3：把 Socket.IO 事件层变成薄 Adapter

**Recommendation strength：Worth exploring**

### Files

- `server.js`
- 未来可以拆出：`src/socket-handlers.js`、`src/lobby.js`

### Problem

`server.js` 的 Socket.IO 事件处理既做网络输入校验，也直接修改房间和玩家状态。

例如：

- `setNickname` 会创建玩家、恢复断线玩家、广播大厅和房间。
- `createRoom` 会创建房间、加入 socket room、广播 roomState。
- `restartGame` 直接重置大量房间字段。
- `testAwardPoint` 是测试专用入口，但也直接改真实分数和触发结束。

这让网络 **Adapter** 和游戏规则 **Module** 混在一起。以后如果想加 HTTP 管理接口、机器人、或者命令行测试入口，会发现没有一个稳定的非 Socket.IO **Interface** 可以复用。

### Solution

让 Socket.IO 事件层变薄。

它只做这些事：

- 从 socket 里拿 playerId。
- 校验事件参数格式。
- 调用房间或大厅 **Module**。
- 根据返回结果调用 `emit`。

真正的房间创建、加入、离开、换队、开始、重开、重连，放到更清晰的房间生命周期 **Module** 里。

### Benefits

- **Locality**：房间生命周期规则集中，不再散在 socket handler 里。
- **Leverage**：同一套规则可以被 Socket.IO、测试、未来机器人共同调用。
- 测试不必只靠网络事件。网络测试保留少量，规则测试可以更多。
- `server.js` 会变成启动入口，更容易读。

### Before

```text
socket.on("restartGame")
  |
  |-- check host
  |-- check status
  |-- reset room fields
  |-- reset players
  |-- assign host
  |-- emit room state
```

### After

```text
socket.on("restartGame")
  |
  v
Room Lifecycle Module.restart()
  |
  v
{ ok, events, publicRoom }
  |
  v
Socket.IO Adapter broadcasts
```

### Deletion test

如果只拆出一堆一行函数，这会是 **Shallow**。只有当“房间生命周期规则”真的搬进去，并让 socket handler 变薄时，这个 **Module** 才值得存在。

## 优化候选 4：把前端页面状态和 DOM 渲染分开

**Recommendation strength：Worth exploring**

### Files

- `public/client.js`
- `public/index.html`
- 未来可以拆出：`public/ui-renderers.js` 或 `public/views.js`

### Problem

`public/client.js` 同时处理：

- Socket.IO 事件。
- 本地 state。
- 页面切换。
- DOM 字符串拼接。
- 表单事件。
- HUD 更新。
- 结算页和记分板渲染。
- 调用 `window.TankGame`。

比如 `renderRoom` 不只是渲染房间，它还会根据房间状态决定跳到游戏页、结算页或房间页，并启动 Phaser。这个函数的 **Interface** 看起来只是 `renderRoom(room)`，但调用它会产生很多副作用。

这会增加维护风险。以后调整“结束后是否自动跳结算页”或“返回房间按钮逻辑”时，需要理解页面状态、Socket.IO 推送和 Phaser 启动之间的关系。

### Solution

先不要引入 React。需求文档明确第一版不使用 React。

更简单的做法是把 `client.js` 分成两个层次：

- 页面状态层：决定当前应该显示 lobby、room、game、results。
- DOM 渲染层：只负责把数据画到对应 DOM 上。

可以先从最容易的地方开始：

- `renderRoomList`
- `renderTeamList`
- `renderScoreboard`
- `renderResults`

把这些纯 DOM 片段集中起来。页面流程逻辑留在 `client.js`。

### Benefits

- **Locality**：页面 HTML 拼接集中，流程状态集中，二者不会混在一个函数里。
- **Leverage**：渲染函数可以用简单 DOM 测试或快照检查。
- 对初学者更友好：一个文件管流程，一个文件管显示，职责更容易理解。
- 未来如果换成 React，也更容易迁移，因为渲染逻辑已经比较集中。

### Before

```text
Socket event
  |
  v
renderRoom(room)
  |-- update state
  |-- update form
  |-- render teams
  |-- decide view
  |-- start Phaser
  |-- render results
```

### After

```text
Socket event
  |
  v
Page state decision
  |
  +--> Room DOM renderer
  +--> Results DOM renderer
  +--> Game starter
```

### Deletion test

如果拆出去的文件只是把 `innerHTML` 包一层，价值不大。真正有价值的是让“页面流程”和“DOM 输出”分别有清楚的 **Interface**。

## 优化候选 5：把 Phaser Scene 内的输入和渲染拆成内部 Module

**Recommendation strength：Worth exploring**

### Files

- `public/game.js`
- 未来可以拆出：`public/game-input.js`、`public/game-renderers.js`

### Problem

`TankBattleScene` 现在承担很多职责：

- 创建 Phaser 游戏对象。
- 监听键盘和鼠标。
- 把输入转成 `playerInput`。
- 接收服务器状态。
- 做玩家位置插值。
- 绘制地图。
- 绘制坦克、炮管、血条、名字。
- 绘制子弹。
- 统计 FPS。
- 暴露 `getDebugSnapshot` 给测试。

这些职责都和 Phaser 有关，所以放在同一个文件并不奇怪。但它让 Scene 的 **Implementation** 越来越厚。以后如果要加爆炸动画、音效、不同炮弹、观战镜头，容易把 Scene 继续撑大。

### Solution

优先拆内部 **Module**，不要急着设计外部插件。

可以先拆两个最稳定的方向：

- Input Module：读取键盘和鼠标，生成 `playerInput` payload。
- Render Module：根据 `gameState` 和 `mapState` 更新 Phaser 对象。

`TankBattleScene` 保留为编排者，负责调用这些内部 **Module**。

### Benefits

- **Locality**：输入问题只看输入 Module，画面问题只看渲染 Module。
- **Leverage**：输入转换可以单独测试。例如按 D、鼠标位置和玩家位置如何变成 angle。
- `getDebugSnapshot` 可以更稳定，因为渲染对象的维护集中在渲染 Module。
- Scene 更短，更像“Phaser 生命周期入口”。

### Before

```text
TankBattleScene
  |-- keyboard/mouse
  |-- input payload
  |-- interpolation
  |-- map drawing
  |-- tank drawing
  |-- bullet drawing
  |-- FPS
  |-- debug snapshot
```

### After

```text
TankBattleScene
  |-- Game Input Module
  |-- Game Render Module
  |-- Performance stats
  |-- Debug snapshot
```

### Deletion test

如果拆出的 Input Module 只是一行 `socket.emit`，它是 **Shallow**。如果它能独立处理键盘、鼠标、失焦清空、角度计算和 payload 去重，它就有足够 **Depth**。

## 优化候选 6：把测试从“只有验收测试”补成“规则测试 + 验收测试”

**Recommendation strength：Strong**

### Files

- `scripts/smoke-test.js`
- `scripts/ui-test.js`
- 未来可以新增：`scripts/rules-test.js`

### Problem

现在测试质量不差，但主要是验收测试：

- `smoke-test.js` 启动真实服务器，用 Socket.IO 走流程。
- `ui-test.js` 启动浏览器，用 Playwright 走 UI。

验收测试适合证明整体能跑，但不适合快速定位小规则。

例如一个炮弹命中分数错误，可能要经过：

1. 启动服务器。
2. 创建房间。
3. 两个 socket 连接。
4. 设置昵称。
5. 加入房间。
6. 选队。
7. 开始倒计时。
8. 等待 gameStarted。
9. 发送输入。
10. 等待 gameState。

这条链路很长。失败时不容易判断是网络、倒计时、输入、碰撞还是计分错了。

### Solution

保留现有验收测试，同时增加规则测试。

规则测试应该直接测试更深的 **Module**，比如：

- `validateStart`：人数、队伍、未选队。
- `tick`：倒计时到 playing。
- `damagePlayer`：扣血、死亡、加分、分数制结束。
- `updateTimeLimit`：时间制平局和胜负。
- `movePlayer`：流沙减速、冰面滑动、墙体碰撞。
- `restoreDisconnectedPlayer`：断线恢复队伍和房主。

### Benefits

- **The interface is the test surface**：规则测试直接穿过规则 Module 的 **Interface**。
- **Locality**：一个规则坏了，测试能直接指向这个规则。
- 验收测试可以减少重复场景，主要保留“真实 Socket.IO 和浏览器仍然打通”的信心。
- 新增玩法时，先写规则测试，再接 UI，会更稳。

### Before

```text
Tests
  |
  +--> start server
       +--> socket flow
            +--> full room lifecycle
                 +--> maybe reaches target rule
```

### After

```text
Tests
  |
  +--> rules-test.js
  |     +--> direct Game Room Module calls
  |
  +--> smoke-test.js
  |     +--> smaller end-to-end socket coverage
  |
  +--> ui-test.js
        +--> browser confidence
```

### Deletion test

如果规则测试只是复制验收测试流程，就没有新增 **Leverage**。它的价值来自更小的 **Interface** 和更短的失败路径。

## 建议优先级

### Top recommendation

优先做“优化候选 1：把后端战斗规则沉到 Game Room Module”。

原因：

- 它影响最大。战斗规则是这个游戏最核心、最容易继续增长的部分。
- 它能直接改善测试。当前很多测试必须通过 Socket.IO 走完整流程，规则 Module 能让测试更短。
- 它能带动后续优化。战斗规则集中后，Map Module、Socket.IO Adapter、规则测试都会更容易落地。

### 推荐顺序

1. 先把 `server.js` 中和战斗 tick 相关的函数集中到一个新 Module。
2. 给这个 Module 加少量规则测试，先覆盖分数制、时间制、重生和移动。
3. 再抽 Map Module，集中地图定义和地形效果。
4. 然后让 Socket.IO 事件层变薄。
5. 最后再整理前端 `client.js` 和 `game.js`。

## 可以怎么小步开始

第一步不要追求完美拆分。可以先做一个很小的改动：

```text
src/game-room.js
  先集中一小部分战斗规则：
    - 开始条件
    - 倒计时切换
    - 每帧战斗更新
    - 对外游戏状态
```

然后让 `server.js` 调用这些函数。

但要注意：如果只是移动代码，没有减少 `server.js` 必须知道的规则细节，那只是搬家，不是真正加深 **Module**。更好的目标是让 `server.js` 少知道规则顺序。

例如现在 `server.js` 知道：

```text
movePlayer -> tryFire -> updateBullets -> updateRespawns -> updateTimeLimit -> updateEmptyTeams
```

更理想的是 `server.js` 只知道：

```text
tickRoom(room, now)
```

内部顺序由 Game Room Module 自己管理。

## 需要避免的重构

- 不要马上引入 React。需求里明确第一版不用 React，当前 UI 用原生 DOM 足够。
- 不要一次性拆成很多小文件。太多小 **Shallow Module** 会让初学者更难读。
- 不要为了“看起来专业”引入复杂 class 体系。普通函数和对象已经够用。
- 不要先做抽象的事件总线。现在只有一个 Socket.IO Adapter，**One adapter = hypothetical seam**，没有必要过早加复杂 **Seam**。
- 不要把测试专用逻辑继续塞进真实 socket 事件。`testAwardPoint` 已经有环境变量保护，但长期看更适合被规则测试替代。

## 初学者版总结

现在的代码像一个大厨房：所有工具都在手边，做第一顿饭很快。

后续优化不是把厨房拆掉，而是把常用区域分清楚：

- 战斗规则放一起。
- 地图规则放一起。
- 网络事件只负责收消息和发消息。
- 页面显示和页面流程分开。
- Phaser 的输入和绘制分开。

这样以后加新功能时，你不用在 1000 多行文件里到处找，也更容易写小测试确认规则没有坏。
