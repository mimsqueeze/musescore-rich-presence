const fs = require("fs");
const path = require("path");
const { Client } = require("@xhayper/discord-rpc");
const { loadConfig, getConfigMtime } = require("./config");
const { findProcesses, resolveTitle } = require("./musescore");
const { getScoreInfo } = require("./score");
const { watchForeground } = require("./foreground");
const { acquireLock } = require("./instance");
const { isSea, getLogPath } = require("./paths");
const { cleanupLegacyInstall } = require("./startup");
const { runCliFlag, runInteractiveMenu } = require("./menu");

const RECONNECT_DELAY = 15_000;

let config;
let lastConfigMtime = 0;
let pollTimer = null;
let client = null;
let ready = false;
let lastActivityJson = null;
let lastLoggedTitle = null;
let shownPid = null; // MuseScore process currently shown on Discord
let focusedPid = null; // MuseScore process whose window was most recently in the foreground
const startTimes = new Map(); // score key -> when we first saw it open, so switching windows keeps elapsed time

/** When started at login there's no console, so write messages to logs/presence.log instead. */
function logToFile() {
    const logFile = getLogPath();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const log = fs.createWriteStream(logFile, { flags: "w" });
    const write = (...args) => log.write(`[${new Date().toLocaleString()}] ${args.join(" ")}\n`);
    console.log = console.warn = console.error = write;
}

/** Discord requires 2–128 characters for text fields. */
function fit(text) {
    if (!text) return undefined;
    let t = String(text).trim();
    if (t.length > 128) t = t.slice(0, 127) + "…";
    if (t.length < 2) t = `${t} ♪`;
    return t;
}

function describeInstruments(instruments) {
    if (instruments.length === 0) return null;
    const counts = new Map();
    for (const name of instruments) counts.set(name, (counts.get(name) || 0) + 1);
    const names = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
    if (names.length <= 3) return names.join(", ");
    return `${instruments.length} instruments: ${names.slice(0, 3).join(", ")}, …`;
}

/** The second-line texts chosen in `config.states`, skipping any this score doesn't have. */
function buildStates(info, open) {
    const builders = {
        subtitle: () => info?.subtitle,
        part: () => open.partName && `${open.partName} part`,
        composer: () => info?.composer && `by ${info.composer}`,
        instruments: () => info && describeInstruments(info.instruments),
        measures: () =>
            info?.measures > 0 &&
            [`${info.measures} measure${info.measures === 1 ? "" : "s"}`, info.timeSignature].filter(Boolean).join(" · "),
        key: () => info?.key && `Key: ${info.key}`,
        tempo: () => info?.bpm && `♩ = ${info.bpm}`,
    };
    return config.states.map((s) => builders[s]?.()).filter(Boolean);
}

const isMuseScore = (name) =>
    config.processNames.some((p) => p.replace(/\.exe$/i, "").toLowerCase() === name.toLowerCase());

/**
 * Picks the MuseScore window to report on: the one you used most recently,
 * else the one already shown, else any window with a score open.
 */
function pickProcess(windows) {
    const withScore = windows.filter((w) => w.open);
    return (
        windows.find((w) => w.pid === focusedPid) ||
        windows.find((w) => w.pid === shownPid) ||
        withScore[0] ||
        windows[0] ||
        null
    );
}

/** Start time for `key`, forgetting scores that are no longer open anywhere. */
function startTimeFor(key, openKeys) {
    for (const k of startTimes.keys()) if (!openKeys.has(k)) startTimes.delete(k);
    if (!startTimes.has(key)) startTimes.set(key, new Date());
    return startTimes.get(key);
}

async function buildActivity() {
    const windows = (await findProcesses(config.processNames)).map((p) => {
        const open = resolveTitle(p.title, config.dataDir);
        return { ...p, open, key: open ? open.filePath || open.scoreName : `home:${p.pid}` };
    });
    const win = pickProcess(windows);
    shownPid = win?.pid ?? null;
    if (!win) {
        startTimes.clear();
        return null;
    }

    const startTimestamp = startTimeFor(win.key, new Set(windows.map((w) => w.key)));
    const base = {
        name: config.activityName || undefined,
        largeImageKey: config.largeImage,
        largeImageText: config.largeImageText,
        startTimestamp,
        instance: false,
    };

    const { open } = win;
    if (!open) return { ...base, details: "Browsing scores" };
    if (config.privateMode) return { ...base, details: "Composing" };

    const info = open.filePath ? getScoreInfo(open.filePath) : null;
    const states = buildStates(info, open);
    // With more than one state, the second line rotates through them.
    const rotation = Math.floor(Date.now() / (config.rotateInterval * 1000));
    return {
        ...base,
        details: fit(info?.title || open.scoreName),
        state: fit(states.length ? states[rotation % states.length] : undefined),
    };
}

let updating = false;
let updateQueued = false;

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(update, Math.max(1, config.updateInterval) * 1000);
}

function reloadConfigIfChanged() {
    const mtime = getConfigMtime();
    if (mtime === lastConfigMtime) return;
    lastConfigMtime = mtime;

    const prev = config;
    const next = loadConfig();
    config = next;
    lastActivityJson = null;
    console.log("↻ Reloaded settings from config.json.");

    if (prev && next.updateInterval !== prev.updateInterval) {
        startPolling();
    }
    if (prev && next.clientId !== prev.clientId && client) {
        ready = false;
        client.destroy().catch(() => {}).finally(connect);
    }
}

async function update() {
    reloadConfigIfChanged();
    if (!ready) return;
    // Focus changes can trigger updates at any time; never run two at once.
    if (updating) {
        updateQueued = true;
        return;
    }
    updating = true;
    try {
        const activity = await buildActivity();
        const json = JSON.stringify(activity);
        if (json !== lastActivityJson) {
            if (activity) {
                await client.user.setActivity(activity);
                // Log score changes, not every rotation of the second line.
                if (activity.details !== lastLoggedTitle) {
                    console.log(`♪ ${activity.details}${activity.state ? ` — ${activity.state}` : ""}`);
                }
                lastLoggedTitle = activity.details;
            } else {
                lastLoggedTitle = null;
                await client.user.clearActivity();
                console.log("· MuseScore isn't running; presence cleared.");
            }
            lastActivityJson = json;
        }
    } catch (e) {
        console.error(`X Failed to update presence: ${e.message}`);
    } finally {
        updating = false;
        if (updateQueued) {
            updateQueued = false;
            update();
        }
    }
}

function connect() {
    client = new Client({ clientId: config.clientId });

    client.on("ready", () => {
        ready = true;
        lastActivityJson = null;
        console.log(`✓ Connected to Discord as ${client.user?.username ?? "unknown user"}.`);
        update();
    });

    client.on("disconnected", () => {
        if (!ready) return;
        ready = false;
        console.log(`X Lost connection to Discord. Retrying in ${RECONNECT_DELAY / 1000}s...`);
        setTimeout(connect, RECONNECT_DELAY);
    });

    client.login().catch((e) => {
        ready = false;
        console.log(`X Couldn't connect to Discord (${e.message}). Is Discord running? Retrying in ${RECONNECT_DELAY / 1000}s...`);
        setTimeout(connect, RECONNECT_DELAY);
    });
}

async function shutdown() {
    console.log("Stopping.");
    const wasReady = ready;
    ready = false; // so the disconnect below isn't treated as a lost connection
    try {
        if (wasReady) await client.user.clearActivity();
        await client?.destroy();
    } catch {
        // Exiting anyway.
    }
    try {
        await cleanupLegacyInstall({ migrateConfig: true });
    } catch {
        // Best-effort cleanup on exit.
    }
    process.exit(0);
}

async function runPresence(background) {
    const legacy = await cleanupLegacyInstall({ migrateConfig: true });
    config = loadConfig();
    lastConfigMtime = getConfigMtime();

    if (!(await acquireLock(shutdown))) {
        const stopHint = isSea() ? "Use `--stop` to stop it." : "Use `npm run stop` to stop it.";
        console.log(`MuseScore Rich Presence is already running. ${stopHint}`);
        process.exit(0);
    }
    if (background) logToFile();
    if (legacy.migratedConfig) {
        console.log("✓ Migrated config.json from previous MuseScore Studio Rich Presence install.");
    }
    if (legacy.cleaned) {
        console.log("✓ Cleaned up previous MuseScore Studio Rich Presence installation.");
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    watchForeground(({ pid, name }) => {
        if (pid !== focusedPid && isMuseScore(name)) {
            focusedPid = pid;
            update();
        }
    });

    console.log("Connecting to Discord...");
    connect();
    startPolling();
}

async function main() {
    const args = process.argv.slice(2);
    const background = args.includes("--background");
    const runDirect = args.includes("--run") || args.includes("--foreground");
    const openMenu = args.includes("--menu");

    const actionFlag = args.find((a) =>
        [
            "--help",
            "-h",
            "--install",
            "--install-startup",
            "--uninstall",
            "--uninstall-startup",
            "--stop",
            "--status",
        ].includes(a)
    );

    if (actionFlag) {
        await runCliFlag(actionFlag);
        return;
    }

    const unknown = args.find(
        (a) => a.startsWith("-") && !["--background", "--run", "--foreground", "--menu"].includes(a)
    );
    if (unknown) {
        console.error(`Unknown option: ${unknown}`);
        await runCliFlag("--help");
        process.exitCode = 1;
        return;
    }

    if (openMenu || (!background && !runDirect && args.length === 0 && isSea())) {
        const result = await runInteractiveMenu();
        if (result !== "run") return;
    }

    await runPresence(background);
}

main();
