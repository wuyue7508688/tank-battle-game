"use strict";
// @ts-nocheck
(function () {
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
    function escapeHtml(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }
    function renderRoomListHtml(rooms) {
        return rooms
            .map((room) => {
            const disabled = room.canJoin ? "" : "disabled";
            const action = room.status === "ended" ? "进入" : "加入";
            return `
          <div class="room-row">
            <div><strong>${escapeHtml(room.code)}</strong><br><span>${escapeHtml(room.mapName)} / ${escapeHtml(room.modeName)}</span></div>
            <span>${room.playerCount}/${room.maxPlayers} 人</span>
            <span>${STATUS_NAMES[room.status]}</span>
            <span>${room.canJoin ? "可加入" : "禁止加入"}</span>
            <span>${room.mode === "score" ? "目标分" : "时间制"}</span>
            <button type="button" data-room-id="${escapeHtml(room.id)}" ${disabled}>${action}</button>
          </div>
        `;
        })
            .join("");
    }
    function renderTeamListHtml(team, players) {
        const teamPlayers = players.filter((player) => player.team === team);
        if (!teamPlayers.length) {
            return `<div class="player-row"><span>空位</span><span>0/4</span></div>`;
        }
        return teamPlayers
            .map((player) => `
        <div class="player-row ${player.online ? "" : "offline"}">
          <span>${escapeHtml(player.nickname)} ${player.online ? "" : "（离线）"}</span>
          <span>${player.isHost ? '<b class="host">房主</b>' : ""}</span>
        </div>
      `)
            .join("");
    }
    function renderScoreboardHtml(players) {
        const sortedPlayers = [...players].sort((a, b) => {
            if (a.team === b.team)
                return b.kills - a.kills;
            return a.team === "red" ? -1 : 1;
        });
        return `
      <div class="scoreboard-row header"><span>玩家</span><span>队伍</span><span>击杀</span><span>死亡</span></div>
      ${sortedPlayers
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
    function renderResultsHtml(players) {
        return `
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
    window.TankUiRenderers = {
        STATUS_NAMES,
        TEAM_NAMES,
        escapeHtml,
        renderRoomListHtml,
        renderTeamListHtml,
        renderScoreboardHtml,
        renderResultsHtml,
    };
})();
