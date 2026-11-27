// Default settings. Override any of these by creating a config.json file.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { getConfigPath } = require("./paths");

const IS_MAC = process.platform === "darwin";

const DEFAULTS = {
    // Discord application ID. You don't need your own: the name shown is set by `activityName`.
    clientId: "577645453429047314",

    // Shown as "Playing ..." on your profile, in place of the application's own name ("MuseScore").
    activityName: "MuseScore Studio",

    // How often to check MuseScore, in seconds. Discord rate-limits presence updates to about one per 15s,
    // but only changed activities are sent, so polling faster just makes switches feel quicker.
    updateInterval: 5,

    // What the second line (below the title) shows. With one entry it stays fixed; with several it
    // rotates through them every `rotateInterval` seconds. Entries a score doesn't have are skipped.
    // Options: "subtitle", "part", "composer", "instruments", "measures", "key", "tempo".
    states: ["subtitle"],

    // Seconds between rotations of the second line.
    rotateInterval: 15,

    // Hide the score name entirely (shows "Composing" instead).
    privateMode: false,

    largeImage: "https://raw.githubusercontent.com/musescore/MuseScore/main/share/icons/AppIcon/MS4_AppIcon_512x512.png",
    largeImageText: "MuseScore Studio",

    // Executable names to look for. MuseScore Studio 4.x is still MuseScore4.exe on Windows.
    // On macOS it's the executable inside the app bundle (MuseScore 4.app/Contents/MacOS/mscore).
    processNames: IS_MAC ? ["mscore"] : ["MuseScore4.exe", "MuseScore5.exe", "MuseScoreStudio.exe"],

    // Where MuseScore keeps session.json and recent_files.json.
    dataDir: IS_MAC
        ? path.join(os.homedir(), "Library", "Application Support", "MuseScore", "MuseScore4")
        : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "MuseScore", "MuseScore4"),
};

const STATE_OPTIONS = [
    { key: "subtitle", label: "Subtitle", example: "Moonlight Sonata" },
    { key: "part", label: "Part name", example: "Violin 1 part" },
    { key: "composer", label: "Composer", example: "by Ludwig van Beethoven" },
    { key: "instruments", label: "Instruments", example: "Piano" },
    { key: "measures", label: "Measures & time signature", example: "184 measures · 4/4" },
    { key: "key", label: "Key signature", example: "Key: E major / C♯ minor" },
    { key: "tempo", label: "Tempo", example: "♩ = 54" },
];

const STARTER_CONFIG = {
    states: ["subtitle"],
    rotateInterval: 15,
    privateMode: false,
};

function readUserConfig(file = getConfigPath()) {
    if (!fs.existsSync(file)) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function saveConfigPatch(patch, file = getConfigPath()) {
    const current = readUserConfig(file);
    const next = { ...STARTER_CONFIG, ...current, ...patch };
    for (const [k, v] of Object.entries(next)) {
        if (v === undefined) delete next[k];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
    return { ...DEFAULTS, ...next };
}

function resetConfig(file = getConfigPath()) {
    const current = readUserConfig(file);
    const next = { ...current, ...STARTER_CONFIG };
    delete next.activityName;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
    return { ...DEFAULTS, ...next };
}

function getConfigMtime(file = getConfigPath()) {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return 0;
    }
}

function loadConfig() {
    const file = getConfigPath();
    if (!fs.existsSync(file)) return { ...DEFAULTS };
    try {
        return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (e) {
        console.error(`X config.json is not valid JSON (${e.message}). Using defaults.`);
        return { ...DEFAULTS };
    }
}

module.exports = {
    DEFAULTS,
    STATE_OPTIONS,
    STARTER_CONFIG,
    loadConfig,
    readUserConfig,
    saveConfigPatch,
    resetConfig,
    getConfigPath,
    getConfigMtime,
};
