(function () {
  const socket = io();

  const state = {
    playerId: sessionStorage.getItem("tankPlayerId") || null,
    nickname: sessionStorage.getItem("tankNickname") || "",
    currentRoom: null,
    latestGameState: null,
    scoreboardVisible: false,
    forceRoomView: false,
    hudCache: {},
  };

  const views = {
    nickname: document.getElementById("nicknameView"),
    lobby: document.getElementById("lobbyView"),
    room: document.getElementById("roomView"),
    game: document.getElementById("gameView"),
    results: document.getElementById("resultsView"),
  };

  const els = {
    nicknameForm: document.getElementById("nicknameForm"),
    nicknameInput: document.getElementById("nicknameInput"),
    lobbyNickname: document.getElementById("lobbyNickname"),
    createRoomForm: document.getElementById("createRoomForm"),
    createMap: document.getElementById("createMap"),
    createMode: document.getElementById("createMode"),
    createScoreLimit: document.getElementById("createScoreLimit"),
    createTimeLimit: document.getElementById("createTimeLimit"),
    joinCodeForm: document.getElementById("joinCodeForm"),
    roomCodeInput: document.getElementById("roomCodeInput"),
    roomList: document.getElementById("roomList"),
    roomCodeLabel: document.getElementById("roomCodeLabel"),
    roomTitle: document.getElementById("roomTitle"),
    leaveRoomButton: document.getElementById("leaveRoomButton"),
    roomMapSelect: document.getElementById("roomMapSelect"),
    roomModeSelect: document.getElementById("roomModeSelect"),
    roomScoreSelect: document.getElementById("roomScoreSelect"),
    roomTimeSelect: document.getElementById("roomTimeSelect"),
    startGameButton: document.getElementById("startGameButton"),
    joinRedButton: document.getElementById("joinRedButton"),
    joinBlueButton: document.getElementById("joinBlueButton"),
    redPlayers: document.getElementById("redPlayers"),
    bluePlayers: document.getElementById("bluePlayers"),
    hudRedScore: document.getElementById("hudRedScore"),
    hudBlueScore: document.getElementById("hudBlueScore"),
    hudObjective: document.getElementById("hudObjective"),
    hudHealth: document.getElementById("hudHealth"),
    hudTeam: document.getElementById("hudTeam"),
    hudMap: document.getElementById("hudMap"),
    hudFps: document.getElementById("hudFps"),
    countdownOverlay: document.getElementById("countdownOverlay"),
    scoreboard: document.getElementById("scoreboard"),
    resultTitle: document.getElementById("resultTitle"),
    resultScore: document.getElementById("resultScore"),
    resultPlayers: document.getElementById("resultPlayers"),
    restartButton: document.getElementById("restartButton"),
    backToRoomButton: document.getElementById("backToRoomButton"),
    toast: document.getElementById("toast"),
  };

  const MAP_NAMES = {
    snow: "冰雪",
    desert: "沙漠",
    jungle: "雨林",
  };

  const MODE_NAMES = {
    score: "分数制",
    time: "时间制",
  };

  const STATUS_NAMES = {
    waiting: "等待中",
    countdown: "倒计时中",
    playing: "游戏中",
    ended: "已结束",
  };

  const TEAM_NAMES = {
    red: "红队",
    blue: "蓝队",
  };

  function showView(name) {
    for (const [viewName, element] of Object.entries(views)) {
      element.classList.toggle("hidden", viewName !== name);
    }
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.remove("hidden");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
  }

  function currentPlayer(room = state.currentRoom) {
    if (!room) return null;
    return room.players.find((player) => player.id === state.playerId) || null;
  }

  function isHost(room = state.currentRoom) {
    return room && room.hostId === state.playerId;
  }

  function setNickname(nickname) {
    const trimmed = nickname.trim();
    if (!trimmed) {
      toast("昵称不能为空。");
      return;
    }
    socket.emit("setNickname", { nickname: trimmed, previousPlayerId: state.playerId }, (response) => {
      if (!response || !response.ok) return;
      state.playerId = response.playerId;
      state.nickname = response.nickname;
      sessionStorage.setItem("tankNickname", response.nickname);
      sessionStorage.setItem("tankPlayerId", response.playerId);
      els.lobbyNickname.textContent = response.nickname;
      window.TankGame.setPlayerId(response.playerId);
      showView("lobby");
    });
  }

  function createRoom() {
    socket.emit("createRoom", {
      map: els.createMap.value,
      mode: els.createMode.value,
      scoreLimit: Number(els.createScoreLimit.value),
      timeLimit: Number(els.createTimeLimit.value),
    });
  }

  function renderRoomList(rooms) {
    if (!rooms.length) {
      els.roomList.textContent = "暂无房间";
      els.roomList.className = "room-list empty-state";
      return;
    }

    els.roomList.className = "room-list";
    els.roomList.innerHTML = rooms
      .map((room) => {
        const disabled = room.canJoin ? "" : "disabled";
        const action = room.status === "ended" ? "进入" : "加入";
        return `
          <div class="room-row">
            <div><strong>${room.code}</strong><br><span>${room.mapName} / ${room.modeName}</span></div>
            <span>${room.playerCount}/${room.maxPlayers} 人</span>
            <span>${STATUS_NAMES[room.status]}</span>
            <span>${room.canJoin ? "可加入" : "禁止加入"}</span>
            <span>${room.mode === "score" ? "目标分" : "时间制"}</span>
            <button type="button" data-room-id="${room.id}" ${disabled}>${action}</button>
          </div>
        `;
      })
      .join("");
  }

  function renderRoom(room) {
    state.currentRoom = room;
    els.roomCodeLabel.textContent = room.code;
    els.roomTitle.textContent = `${room.mapName} / ${room.modeName} / ${STATUS_NAMES[room.status]}`;
    els.roomMapSelect.value = room.map;
    els.roomModeSelect.value = room.mode;
    els.roomScoreSelect.value = String(room.scoreLimit);
    els.roomTimeSelect.value = String(room.timeLimit);

    const host = isHost(room);
    const editable = host && room.status === "waiting";
    els.roomMapSelect.disabled = !editable;
    els.roomModeSelect.disabled = !editable;
    els.roomScoreSelect.disabled = !editable;
    els.roomTimeSelect.disabled = !editable;
    els.startGameButton.disabled = !host || room.status !== "waiting";
    els.startGameButton.textContent = room.status === "ended" ? "请先再来一局" : "开始游戏";
    els.restartButton.disabled = !host;

    const player = currentPlayer(room);
    els.joinRedButton.disabled = room.status !== "waiting";
    els.joinBlueButton.disabled = room.status !== "waiting";
    els.joinRedButton.textContent = player && player.team === "red" ? "已在红队" : "加入红队";
    els.joinBlueButton.textContent = player && player.team === "blue" ? "已在蓝队" : "加入蓝队";

    renderTeamList("red", els.redPlayers, room.players);
    renderTeamList("blue", els.bluePlayers, room.players);

    if (room.status === "playing" || room.status === "countdown") {
      state.forceRoomView = false;
      showView("game");
      window.TankGame.start(socket, state.playerId);
    } else if (room.status === "ended" && !state.forceRoomView) {
      renderResults(room.endedInfo || {
        winner: null,
        redScore: room.redScore,
        blueScore: room.blueScore,
        players: room.players,
      });
      showView("results");
    } else {
      showView("room");
    }
  }

  function renderTeamList(team, element, players) {
    const teamPlayers = players.filter((player) => player.team === team);
    if (!teamPlayers.length) {
      element.innerHTML = `<div class="player-row"><span>空位</span><span>0/4</span></div>`;
      return;
    }
    element.innerHTML = teamPlayers
      .map((player) => `
        <div class="player-row ${player.online ? "" : "offline"}">
          <span>${escapeHtml(player.nickname)} ${player.online ? "" : "（离线）"}</span>
          <span>${player.isHost ? '<b class="host">房主</b>' : ""}</span>
        </div>
      `)
      .join("");
  }

  function updateRoomConfig() {
    if (!state.currentRoom || !isHost()) return;
    socket.emit("updateRoomConfig", {
      map: els.roomMapSelect.value,
      mode: els.roomModeSelect.value,
      scoreLimit: Number(els.roomScoreSelect.value),
      timeLimit: Number(els.roomTimeSelect.value),
    });
  }

  function renderGameState(gameState) {
    state.latestGameState = gameState;
    window.TankGame.start(socket, state.playerId);
    window.TankGame.updateState(gameState);

    setTextIfChanged(els.hudRedScore, "redScore", gameState.redScore);
    setTextIfChanged(els.hudBlueScore, "blueScore", gameState.blueScore);
    setTextIfChanged(
      els.hudObjective,
      "objective",
      gameState.mode === "time"
        ? `剩余 ${formatTime(gameState.remainingSeconds || gameState.timeLimit)}`
        : `目标分数 ${gameState.scoreLimit}`,
    );
    const player = gameState.players.find((item) => item.id === state.playerId);
    setTextIfChanged(els.hudHealth, "health", `生命 ${player && player.alive ? player.hp : 0}`);
    setTextIfChanged(els.hudTeam, "team", `队伍 ${player && player.team ? TEAM_NAMES[player.team] : "-"}`);
    setTextIfChanged(els.hudMap, "map", `地图 ${gameState.mapName || MAP_NAMES[gameState.map] || "-"}`);

    if (gameState.status === "countdown" && gameState.countdownEndsAt) {
      const seconds = Math.max(1, Math.ceil((gameState.countdownEndsAt - Date.now()) / 1000));
      els.countdownOverlay.textContent = seconds;
      els.countdownOverlay.classList.remove("hidden");
    } else {
      els.countdownOverlay.classList.add("hidden");
    }

    renderScoreboard();
  }

  function renderScoreboard() {
    const gameState = state.latestGameState;
    if (!state.scoreboardVisible || !gameState) {
      els.scoreboard.classList.add("hidden");
      return;
    }
    els.scoreboard.classList.remove("hidden");
    const players = [...gameState.players].sort((a, b) => {
      if (a.team === b.team) return b.kills - a.kills;
      return a.team === "red" ? -1 : 1;
    });
    els.scoreboard.innerHTML = `
      <div class="scoreboard-row header"><span>玩家</span><span>队伍</span><span>击杀</span><span>死亡</span></div>
      ${players
        .map((player) => `
          <div class="scoreboard-row">
            <span>${escapeHtml(player.nickname)}</span>
            <span>${TEAM_NAMES[player.team] || "-"}</span>
            <span>${player.kills}</span>
            <span>${player.deaths}</span>
          </div>
        `)
        .join("")}
    `;
  }

  function renderResults(info) {
    if (!info) return;
    const winnerText = info.winner ? `${TEAM_NAMES[info.winner]}获胜` : "平局";
    els.resultTitle.textContent = winnerText;
    els.resultScore.textContent = `${info.redScore} : ${info.blueScore}`;
    const players = info.players || [];
    els.resultPlayers.innerHTML = `
      <div class="result-row header"><span>玩家</span><span>队伍</span><span>击杀</span><span>死亡</span></div>
      ${players
        .map((player) => `
          <div class="result-row">
            <span>${escapeHtml(player.nickname)}</span>
            <span>${TEAM_NAMES[player.team] || "-"}</span>
            <span>${player.kills}</span>
            <span>${player.deaths}</span>
          </div>
        `)
        .join("")}
    `;
  }

  function formatTime(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const min = Math.floor(value / 60);
    const sec = Math.floor(value % 60);
    return `${min}:${String(sec).padStart(2, "0")}`;
  }

  function setTextIfChanged(element, key, value) {
    const text = String(value);
    if (state.hudCache[key] === text) return;
    state.hudCache[key] = text;
    element.textContent = text;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function initEvents() {
    els.nicknameInput.value = state.nickname;
    if (state.nickname) setTimeout(() => els.nicknameInput.select(), 0);

    els.nicknameForm.addEventListener("submit", (event) => {
      event.preventDefault();
      setNickname(els.nicknameInput.value);
    });

    els.createRoomForm.addEventListener("submit", (event) => {
      event.preventDefault();
      createRoom();
    });

    els.joinCodeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      socket.emit("joinRoomByCode", els.roomCodeInput.value.trim().toUpperCase());
    });

    els.roomList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-room-id]");
      if (!button) return;
      socket.emit("joinRoom", button.dataset.roomId);
    });

    els.leaveRoomButton.addEventListener("click", () => {
      socket.emit("leaveRoom");
      state.currentRoom = null;
      showView("lobby");
    });

    els.joinRedButton.addEventListener("click", () => socket.emit("chooseTeam", "red"));
    els.joinBlueButton.addEventListener("click", () => socket.emit("chooseTeam", "blue"));
    els.startGameButton.addEventListener("click", () => socket.emit("startGame"));
    els.restartButton.addEventListener("click", () => {
      state.forceRoomView = true;
      socket.emit("restartGame");
    });
    els.backToRoomButton.addEventListener("click", () => {
      if (state.currentRoom) {
        state.forceRoomView = true;
        showView("room");
      }
      else showView("lobby");
    });

    for (const select of [els.roomMapSelect, els.roomModeSelect, els.roomScoreSelect, els.roomTimeSelect]) {
      select.addEventListener("change", updateRoomConfig);
    }
  }

  setInterval(() => {
    const stats = window.TankGame.getPerformanceStats ? window.TankGame.getPerformanceStats() : null;
    if (!stats || !stats.sampleCount) return;
    setTextIfChanged(els.hudFps, "fps", `FPS ${Math.round(stats.avgFps)}`);
  }, 250);

  socket.on("connect", () => {
    if (state.nickname) {
      setNickname(state.nickname);
    }
  });

  socket.on("disconnect", () => {
    toast("连接断开，正在重连。");
  });

  socket.on("nicknameSet", (payload) => {
    state.playerId = payload.playerId;
    state.nickname = payload.nickname;
    sessionStorage.setItem("tankNickname", payload.nickname);
    sessionStorage.setItem("tankPlayerId", payload.playerId);
    els.lobbyNickname.textContent = payload.nickname;
    window.TankGame.setPlayerId(payload.playerId);
  });

  socket.on("lobbyState", renderRoomList);
  socket.on("roomState", renderRoom);
  socket.on("gameState", renderGameState);
  socket.on("mapState", (mapState) => {
    window.TankGame.updateMapState(mapState);
  });
  socket.on("countdown", (payload) => {
    els.countdownOverlay.textContent = Math.max(1, Math.ceil((payload.endsAt - Date.now()) / 1000));
    els.countdownOverlay.classList.remove("hidden");
    showView("game");
    window.TankGame.start(socket, state.playerId);
  });
  socket.on("gameStarted", () => {
    els.countdownOverlay.classList.add("hidden");
    showView("game");
  });
  socket.on("gameEnded", (info) => {
    renderResults(info);
    showView("results");
  });
  socket.on("errorMessage", toast);

  window.TankClient = {
    setScoreboardVisible(visible) {
      state.scoreboardVisible = visible;
      renderScoreboard();
    },
  };

  initEvents();
  showView("nickname");
})();
