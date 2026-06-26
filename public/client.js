"use strict";
(function () {
    const socket = io({
        transports: ["websocket"],
    });
    function element(id) {
        const found = document.getElementById(id);
        if (!found)
            throw new Error(`Missing element: ${id}`);
        return found;
    }
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
        nickname: element("nicknameView"),
        lobby: element("lobbyView"),
        room: element("roomView"),
        game: element("gameView"),
        results: element("resultsView"),
    };
    const els = {
        nicknameForm: element("nicknameForm"),
        nicknameInput: element("nicknameInput"),
        lobbyNickname: element("lobbyNickname"),
        createRoomForm: element("createRoomForm"),
        createMap: element("createMap"),
        createMode: element("createMode"),
        createScoreLimit: element("createScoreLimit"),
        createTimeLimit: element("createTimeLimit"),
        joinCodeForm: element("joinCodeForm"),
        roomCodeInput: element("roomCodeInput"),
        roomList: element("roomList"),
        roomCodeLabel: element("roomCodeLabel"),
        roomTitle: element("roomTitle"),
        leaveRoomButton: element("leaveRoomButton"),
        roomMapSelect: element("roomMapSelect"),
        roomModeSelect: element("roomModeSelect"),
        roomScoreSelect: element("roomScoreSelect"),
        roomTimeSelect: element("roomTimeSelect"),
        startGameButton: element("startGameButton"),
        joinRedButton: element("joinRedButton"),
        joinBlueButton: element("joinBlueButton"),
        redPlayers: element("redPlayers"),
        bluePlayers: element("bluePlayers"),
        hudRedScore: element("hudRedScore"),
        hudBlueScore: element("hudBlueScore"),
        hudObjective: element("hudObjective"),
        hudHealth: element("hudHealth"),
        hudTeam: element("hudTeam"),
        hudMap: element("hudMap"),
        hudFps: element("hudFps"),
        countdownOverlay: element("countdownOverlay"),
        scoreboard: element("scoreboard"),
        resultTitle: element("resultTitle"),
        resultScore: element("resultScore"),
        resultPlayers: element("resultPlayers"),
        restartButton: element("restartButton"),
        backToRoomButton: element("backToRoomButton"),
        toast: element("toast"),
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
    const { STATUS_NAMES, TEAM_NAMES } = window.TankUiRenderers;
    function showView(name) {
        for (const [viewName, element] of Object.entries(views)) {
            element.classList.toggle("hidden", viewName !== name);
        }
    }
    let toastTimer = 0;
    function toast(message) {
        els.toast.textContent = message;
        els.toast.classList.remove("hidden");
        clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => els.toast.classList.add("hidden"), 2600);
    }
    function currentPlayer(room = state.currentRoom) {
        if (!room)
            return null;
        return room.players.find((player) => player.id === state.playerId) || null;
    }
    function isHost(room = state.currentRoom) {
        return Boolean(room && room.hostId === state.playerId);
    }
    function setNickname(nickname) {
        const trimmed = nickname.trim();
        if (!trimmed) {
            toast("昵称不能为空。");
            return;
        }
        socket.emit("setNickname", { nickname: trimmed, previousPlayerId: state.playerId }, (response) => {
            if (!response || !response.ok || !response.playerId || !response.nickname)
                return;
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
        els.roomList.innerHTML = window.TankUiRenderers.renderRoomListHtml(rooms);
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
        }
        else if (room.status === "ended" && !state.forceRoomView) {
            renderResults(room.endedInfo || {
                winner: null,
                redScore: room.redScore,
                blueScore: room.blueScore,
                players: room.players,
            });
            showView("results");
        }
        else {
            showView("room");
        }
    }
    function renderTeamList(team, element, players) {
        element.innerHTML = window.TankUiRenderers.renderTeamListHtml(team, players);
    }
    function updateRoomConfig() {
        if (!state.currentRoom || !isHost())
            return;
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
        setTextIfChanged(els.hudObjective, "objective", gameState.mode === "time"
            ? `剩余 ${formatTime(gameState.remainingSeconds || gameState.timeLimit)}`
            : `目标分数 ${gameState.scoreLimit}`);
        const player = gameState.players.find((item) => item.id === state.playerId);
        setTextIfChanged(els.hudHealth, "health", `生命 ${player && player.alive ? player.hp : 0}`);
        setTextIfChanged(els.hudTeam, "team", `队伍 ${player && player.team ? TEAM_NAMES[player.team] : "-"}`);
        setTextIfChanged(els.hudMap, "map", `地图 ${gameState.mapName || MAP_NAMES[gameState.map] || "-"}`);
        if (gameState.status === "countdown" && gameState.countdownEndsAt) {
            const seconds = Math.max(1, Math.ceil((gameState.countdownEndsAt - Date.now()) / 1000));
            els.countdownOverlay.textContent = String(seconds);
            els.countdownOverlay.classList.remove("hidden");
        }
        else {
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
        els.scoreboard.innerHTML = window.TankUiRenderers.renderScoreboardHtml(gameState.players);
    }
    function renderResults(info) {
        if (!info)
            return;
        const winnerText = info.winner ? `${TEAM_NAMES[info.winner]}获胜` : "平局";
        els.resultTitle.textContent = winnerText;
        els.resultScore.textContent = `${info.redScore} : ${info.blueScore}`;
        const players = info.players || [];
        els.resultPlayers.innerHTML = window.TankUiRenderers.renderResultsHtml(players);
    }
    function formatTime(seconds) {
        const value = Math.max(0, Number(seconds) || 0);
        const min = Math.floor(value / 60);
        const sec = Math.floor(value % 60);
        return `${min}:${String(sec).padStart(2, "0")}`;
    }
    function setTextIfChanged(element, key, value) {
        const text = String(value);
        if (state.hudCache[key] === text)
            return;
        state.hudCache[key] = text;
        element.textContent = text;
    }
    function initEvents() {
        els.nicknameInput.value = state.nickname;
        if (state.nickname)
            setTimeout(() => els.nicknameInput.select(), 0);
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
            const target = event.target instanceof Element ? event.target : null;
            const button = target?.closest("button[data-room-id]");
            if (!button)
                return;
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
            else
                showView("lobby");
        });
        for (const select of [els.roomMapSelect, els.roomModeSelect, els.roomScoreSelect, els.roomTimeSelect]) {
            select.addEventListener("change", updateRoomConfig);
        }
    }
    setInterval(() => {
        const stats = window.TankGame.getPerformanceStats ? window.TankGame.getPerformanceStats() : null;
        if (!stats || !stats.sampleCount)
            return;
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
        els.countdownOverlay.textContent = String(Math.max(1, Math.ceil((payload.endsAt - Date.now()) / 1000)));
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
