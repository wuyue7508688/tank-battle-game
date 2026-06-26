"use strict";
// @ts-nocheck
(function () {
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
    function tankTextureKey(player, playerId) {
        return `tank-body-${player.team}${player.id === playerId ? "-self" : ""}`;
    }
    function tankAlpha(player, latestState, latestMapState) {
        if (latestState.map === "jungle" && latestMapState) {
            const inGrass = latestMapState.zones.some((zone) => {
                return zone.type === "grass" && player.x >= zone.x && player.x <= zone.x + zone.w && player.y >= zone.y && player.y <= zone.y + zone.h;
            });
            if (inGrass)
                return 0.48;
        }
        if (player.invincible)
            return 0.62 + Math.sin(Date.now() / 80) * 0.18;
        return 1;
    }
    function wallsVersion(mapState) {
        return mapState.walls.map((wall) => `${wall.id}:${wall.alive ? 1 : 0}`).join("|");
    }
    window.TankGameRenderers = {
        TEAM_COLORS,
        TEAM_DARK,
        MAP_PALETTES,
        tankTextureKey,
        tankAlpha,
        wallsVersion,
    };
})();
