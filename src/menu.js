const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFileSync, spawn } = require("child_process");
const { APP_NAME, isSea } = require("./paths");
const {
    DEFAULTS,
    STATE_OPTIONS,
    STARTER_CONFIG,
    loadConfig,
    saveConfigPatch,
    resetConfig,
} = require("./config");
const {
    installStartup,
    startBackground,
    uninstallStartup,
    scheduleDeferredDirCleanup,
    getStartupStatus,
    stopRunning,
} = require("./startup");
const { version } = require("../package.json");

function ensureStarterConfig(configPath) {
    if (!fs.existsSync(configPath)) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(STARTER_CONFIG, null, 2) + "\n", "utf8");
        return true;
    }
    return false;
}

function openFileInDefaultApp(filePath) {
    if (process.platform === "win32") {
        spawn("cmd.exe", ["/c", "start", "", filePath], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        }).unref();
    } else if (process.platform === "darwin") {
        spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
    } else {
        spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
    }
}

function readTail(filePath, maxLines = 25) {
    if (!fs.existsSync(filePath)) return null;
    const lines = fs.readFileSync(filePath, "utf8").trimEnd().split(/\r?\n/);
    return lines.slice(-maxLines).join("\n");
}

function printHelp() {
    const exeName = isSea() ? path.basename(process.execPath) : "node src/index.js";
    console.log(`${APP_NAME} v${version}

Usage: ${exeName} [option]

Options:
  (no option)          ${isSea() ? "Open the interactive setup menu" : "Run the plugin with live logs"}
  --run, --foreground  Run the plugin with live logs in this window
  --background         Run the plugin silently (logs to file)
  --install            Install plugin, add to login startup, and start it
  --uninstall          Remove plugin from login startup and stop it
  --stop               Stop the running plugin
  --status             Show current plugin status and file paths
  --menu               Open the interactive setup menu
  -h, --help           Show this help message`);
}

async function runCliFlag(flag) {
    switch (flag) {
        case "--help":
        case "-h":
            printHelp();
            return true;

        case "--install":
        case "--install-startup": {
            const res = await installStartup();
            if (res.legacy?.migratedConfig) console.log("✓ Migrated config.json from previous install.");
            if (res.legacy?.cleaned) console.log("✓ Cleaned up previous MuseScore Studio Rich Presence install.");
            if (res.installedPath) console.log(`✓ Installed plugin: ${res.installedPath}`);
            console.log(`✓ Added plugin to ${res.os} startup: ${res.startupFile}`);
            console.log(`✓ ${res.restarted ? "Restarted" : "Started"} plugin.`);
            console.log(`  Log file: ${res.logPath}`);
            if (process.platform === "darwin") {
                console.log(
                    "  Note: On macOS, grant Accessibility permission in System Settings > Privacy & Security > Accessibility if prompted."
                );
            }
            return true;
        }

        case "--uninstall":
        case "--uninstall-startup": {
            const res = await uninstallStartup();
            console.log(res.removedStartup ? "✓ Removed plugin from login startup." : `· Plugin wasn't set to start with ${res.os}.`);
            if (res.stopped) console.log("✓ Stopped plugin.");
            return true;
        }

        case "--stop":
            console.log((await stopRunning()) ? "✓ Stopped plugin." : "· Plugin is not currently running.");
            return true;

        case "--status": {
            const s = await getStartupStatus();
            console.log(`${APP_NAME} v${version}`);
            console.log(`  Running:       ${s.running ? "Yes" : "No"}`);
            console.log(`  Login startup: ${s.startupEnabled ? `Enabled (${s.startupFile})` : "Disabled"}`);
            if (s.installedPath) console.log(`  Installed at:  ${s.installedPath}`);
            console.log(`  Config file:   ${s.configPath}`);
            console.log(`  Log file:      ${s.logPath}`);
            return true;
        }

        default:
            return false;
    }
}

function formatSettingsSummary(cfg) {
    if (cfg.privateMode) return "Private mode (Composing)";
    const states = Array.isArray(cfg.states) ? cfg.states : [];
    if (states.length === 0) return "None (title only)";
    if (states.length === 1) return states[0];
    return `${states.join(", ")} (every ${cfg.rotateInterval}s)`;
}

function toggleStateKey(currentStates, key) {
    const active = new Set(Array.isArray(currentStates) ? currentStates : []);
    if (active.has(key)) active.delete(key);
    else active.add(key);
    const known = STATE_OPTIONS.map((o) => o.key).filter((k) => active.has(k));
    const extra = [...active].filter((k) => !STATE_OPTIONS.some((o) => o.key === k));
    return [...known, ...extra];
}

async function runTerminalSettingsMenu(ask, pause, configPath) {
    let notice = "";
    while (true) {
        const cfg = loadConfig();
        const active = new Set(Array.isArray(cfg.states) ? cfg.states : []);
        console.clear();
        console.log("==================================================");
        console.log(`  Settings — ${APP_NAME}`);
        console.log("==================================================");
        console.log("  Second line details (enter 1-7 to toggle):");
        STATE_OPTIONS.forEach((opt, idx) => {
            const mark = active.has(opt.key) ? "x" : " ";
            const label = opt.label.padEnd(25);
            console.log(`    ${idx + 1}. [${mark}] ${label} (${opt.example})`);
        });
        console.log("--------------------------------------------------");
        console.log(`    8. Rotation interval:  ${cfg.rotateInterval}s`);
        console.log(`    9. Private mode:       ${cfg.privateMode ? "On (shows \"Composing\")" : "Off"}`);
        console.log(`   10. Activity name:      ${cfg.activityName || DEFAULTS.activityName}`);
        console.log("   11. Reset to defaults");
        console.log("   12. Open raw config.json (advanced)");
        console.log("    0. Back");
        console.log("--------------------------------------------------");
        console.log("  Changes save immediately and apply automatically.");
        if (notice) console.log(`  ${notice}`);
        console.log("");

        const choice = (await ask("Choose an option [0]: ")).trim() || "0";
        notice = "";

        if (choice === "0" || choice === "b" || choice === "back") return;

        const num = Number(choice);
        if (Number.isInteger(num) && num >= 1 && num <= STATE_OPTIONS.length) {
            const opt = STATE_OPTIONS[num - 1];
            const nextStates = toggleStateKey(cfg.states, opt.key);
            saveConfigPatch({ states: nextStates }, configPath);
            notice = `✓ ${opt.label}: ${nextStates.includes(opt.key) ? "Enabled" : "Disabled"}`;
            continue;
        }

        switch (choice) {
            case "8": {
                const raw = (await ask(`\nSeconds between rotations [${cfg.rotateInterval}] (blank to cancel): `)).trim();
                if (!raw) break;
                const secs = Number(raw);
                if (!Number.isInteger(secs) || secs < 5 || secs > 3600) {
                    notice = "X Enter a whole number between 5 and 3600.";
                } else {
                    saveConfigPatch({ rotateInterval: secs }, configPath);
                    notice = `✓ Rotation interval set to ${secs}s.`;
                }
                break;
            }
            case "9": {
                const next = !cfg.privateMode;
                saveConfigPatch({ privateMode: next }, configPath);
                notice = `✓ Private mode ${next ? "enabled" : "disabled"}.`;
                break;
            }
            case "10": {
                const cur = cfg.activityName || DEFAULTS.activityName;
                const raw = (await ask(`\nName shown after "Playing" [${cur}] (type "default" to reset, blank to cancel): `)).trim();
                if (!raw) break;
                if (raw.toLowerCase() === "default") {
                    saveConfigPatch({ activityName: undefined }, configPath);
                    notice = `✓ Activity name reset to "${DEFAULTS.activityName}".`;
                } else {
                    saveConfigPatch({ activityName: raw }, configPath);
                    notice = `✓ Activity name set to "${raw}".`;
                }
                break;
            }
            case "11": {
                resetConfig(configPath);
                notice = "✓ Settings reset to defaults.";
                break;
            }
            case "12": {
                ensureStarterConfig(configPath);
                openFileInDefaultApp(configPath);
                notice = `✓ Opened ${configPath}`;
                break;
            }
            default:
                console.log("\nInvalid choice. Please enter 0-12.");
                await pause();
        }
    }
}

async function runTerminalMenu() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));
    let pendingCleanupDir = null;

    const pause = async () => {
        await ask("\nPress Enter to continue...");
    };

    try {
        while (true) {
            const s = await getStartupStatus();
            const cfg = loadConfig();
            console.clear();
            console.log("==================================================");
            console.log(`  ${APP_NAME} (v${version})`);
            console.log("==================================================");
            console.log(`  Status:        ${s.running ? "Running" : "Stopped"}`);
            console.log(`  Login startup: ${s.startupEnabled ? "Enabled" : "Disabled"}`);
            console.log(`  Second line:   ${formatSettingsSummary(cfg)}`);
            if (s.installedPath) {
                console.log(`  Install path:  ${s.installedPath}`);
            }
            console.log("--------------------------------------------------");
            console.log("  1. Install & start plugin at login (Recommended)");
            console.log("  2. Start plugin");
            console.log("  3. Run plugin with live logs");
            console.log("  4. Stop plugin");
            console.log("  5. Settings (customize what's shown)");
            console.log("  6. View recent log");
            console.log("  7. Uninstall plugin");
            console.log("  0. Exit");
            console.log("--------------------------------------------------");

            const choice = (await ask("Choose an option [1]: ")).trim() || "1";
            console.log("");

            try {
                switch (choice) {
                    case "1": {
                        const res = await installStartup();
                        pendingCleanupDir = null;
                        if (res.legacy?.migratedConfig) console.log("✓ Migrated config.json from previous install.");
                        if (res.legacy?.cleaned) console.log("✓ Cleaned up previous MuseScore Studio Rich Presence install.");
                        if (res.installedPath) console.log(`✓ Installed plugin to: ${res.installedPath}`);
                        console.log(`✓ Added plugin to ${res.os} login startup.`);
                        console.log(`✓ ${res.restarted ? "Restarted" : "Started"} plugin.`);
                        if (process.platform === "darwin") {
                            console.log("\nNote: On macOS, allow Accessibility access in System Settings >");
                            console.log("Privacy & Security > Accessibility so MuseScore window titles can be read.");
                        }
                        await pause();
                        break;
                    }
                    case "2": {
                        const res = await startBackground();
                        if (res.legacy?.migratedConfig) console.log("✓ Migrated config.json from previous install.");
                        if (res.legacy?.cleaned) console.log("✓ Cleaned up previous MuseScore Studio Rich Presence install.");
                        if (res.alreadyRunning) {
                            console.log("· Plugin is already running.");
                        } else {
                            console.log(`✓ Started plugin. Logs: ${res.logPath}`);
                        }
                        await pause();
                        break;
                    }
                    case "3": {
                        if (s.running) {
                            console.log("· Stopping existing plugin first...");
                            await stopRunning();
                        }
                        rl.close();
                        return "run";
                    }
                    case "4": {
                        console.log((await stopRunning()) ? "✓ Stopped plugin." : "· Plugin is not currently running.");
                        await pause();
                        break;
                    }
                    case "5": {
                        await runTerminalSettingsMenu(ask, pause, s.configPath);
                        break;
                    }
                    case "6": {
                        const tail = readTail(s.logPath);
                        if (!tail) {
                            console.log(`· No log file yet at ${s.logPath}`);
                        } else {
                            console.log(`--- Last lines of ${s.logPath} ---`);
                            console.log(tail);
                            console.log("--- End of log ---");
                        }
                        await pause();
                        break;
                    }
                    case "7": {
                        const wipe = isSea()
                            ? (await ask("Also delete installed plugin files & config? [y/N]: ")).trim().toLowerCase() === "y"
                            : false;
                        const res = await uninstallStartup({ removeData: wipe });
                        console.log(res.removedStartup ? "✓ Removed plugin from login startup." : "· Plugin wasn't in login startup.");
                        if (res.stopped) console.log("✓ Stopped plugin.");
                        if (res.removedData) console.log("✓ Removed installed plugin files & data.");
                        pendingCleanupDir = res.deferredCleanupDir;
                        await pause();
                        break;
                    }
                    case "0":
                    case "q":
                    case "exit":
                        rl.close();
                        scheduleDeferredDirCleanup(pendingCleanupDir);
                        return "exit";
                    default:
                        console.log("Invalid choice. Please enter 0–7.");
                        await pause();
                }
            } catch (e) {
                console.error(`X ${e.message}`);
                await pause();
            }
        }
    } catch {
        // Closed stdin (e.g. Ctrl+C)
        rl.close();
        scheduleDeferredDirCleanup(pendingCleanupDir);
        return "exit";
    }
}

function osascriptDialog(script, args) {
    try {
        return execFileSync("osascript", ["-", ...args], {
            input: script,
            encoding: "utf8",
        }).trim();
    } catch {
        return null;
    }
}

function macAlert(message) {
    const script = `on run argv
    display dialog (item 1 of argv) with title "${APP_NAME}" buttons {"OK"} default button "OK"
end run`;
    osascriptDialog(script, [message]);
}

function macChoose(promptText, items, cancelLabel = "Quit") {
    const script = `on run argv
    set promptText to item 1 of argv
    set cancelLabel to item 2 of argv
    set choiceList to items 3 thru -1 of argv
    set picked to choose from list choiceList with title "${APP_NAME}" with prompt promptText default items {item 1 of choiceList} OK button name "Select" cancel button name cancelLabel
    if picked is false then return ""
    return item 1 of picked
end run`;
    return osascriptDialog(script, [promptText, cancelLabel, ...items]);
}

function macChooseMulti(promptText, items, defaultItems) {
    const script = `on run argv
    set promptText to item 1 of argv
    set itemCount to (item 2 of argv) as integer
    set choiceList to items 3 thru (2 + itemCount) of argv
    set defaultList to {}
    if (count of argv) > (2 + itemCount) then
        set defaultList to items (3 + itemCount) thru -1 of argv
    end if
    set picked to choose from list choiceList with title "${APP_NAME}" with prompt promptText default items defaultList with multiple selections allowed and empty selection allowed OK button name "Save" cancel button name "Cancel"
    if picked is false then return "__CANCEL__"
    if (count of picked) is 0 then return ""
    set AppleScript's text item delimiters to linefeed
    return picked as text
end run`;
    const out = osascriptDialog(script, [promptText, String(items.length), ...items, ...defaultItems]);
    if (out === null || out === "__CANCEL__") return null;
    if (out === "") return [];
    return out.split(/\r?\n/).filter(Boolean);
}

function macPromptText(promptText, defaultAnswer) {
    const script = `on run argv
    try
        set res to display dialog (item 1 of argv) default answer (item 2 of argv) with title "${APP_NAME}" buttons {"Cancel", "Save"} default button "Save"
        return text returned of res
    on error
        return "__CANCEL__"
    end try
end run`;
    const out = osascriptDialog(script, [promptText, defaultAnswer]);
    if (out === null || out === "__CANCEL__") return null;
    return out;
}

async function runMacSettingsMenu(configPath) {
    while (true) {
        const cfg = loadConfig();
        const curName = cfg.activityName || DEFAULTS.activityName;
        const promptText =
            `Settings (changes apply automatically):\n\n` +
            `Second line: ${formatSettingsSummary(cfg)}\n` +
            `Rotation interval: ${cfg.rotateInterval}s\n` +
            `Private mode: ${cfg.privateMode ? "On" : "Off"}\n` +
            `Activity name: ${curName}`;

        const choices = [
            "Choose Second-Line Details...",
            `Set Rotation Interval (${cfg.rotateInterval}s)...`,
            `Private Mode: Turn ${cfg.privateMode ? "Off" : "On"}`,
            `Set Activity Name (${curName})...`,
            "Reset Settings to Defaults",
            "Open Raw Config File (Advanced)",
            "Back",
        ];

        const picked = macChoose(promptText, choices, "Back");
        if (!picked || picked === "Back") return;

        if (picked.startsWith("Choose Second-Line")) {
            const items = STATE_OPTIONS.map((o) => `${o.label} — ${o.example}`);
            const active = new Set(Array.isArray(cfg.states) ? cfg.states : []);
            const defaults = STATE_OPTIONS.filter((o) => active.has(o.key)).map((o) => `${o.label} — ${o.example}`);
            const selected = macChooseMulti(
                "Hold Command (⌘) to select multiple details.\nSelected details will rotate below the score title:",
                items,
                defaults
            );
            if (selected !== null) {
                const selectedSet = new Set(selected);
                const nextStates = STATE_OPTIONS.filter((o) => selectedSet.has(`${o.label} — ${o.example}`)).map((o) => o.key);
                saveConfigPatch({ states: nextStates }, configPath);
            }
        } else if (picked.startsWith("Set Rotation Interval")) {
            const raw = macPromptText("Seconds between rotations (5–3600):", String(cfg.rotateInterval));
            if (raw !== null) {
                const secs = Number(raw.trim());
                if (Number.isInteger(secs) && secs >= 5 && secs <= 3600) {
                    saveConfigPatch({ rotateInterval: secs }, configPath);
                } else {
                    macAlert("Please enter a whole number between 5 and 3600.");
                }
            }
        } else if (picked.startsWith("Private Mode:")) {
            saveConfigPatch({ privateMode: !cfg.privateMode }, configPath);
        } else if (picked.startsWith("Set Activity Name")) {
            const raw = macPromptText('Name shown after "Playing" (leave blank to reset to default):', curName);
            if (raw !== null) {
                const trimmed = raw.trim();
                saveConfigPatch({ activityName: trimmed || undefined }, configPath);
            }
        } else if (picked.startsWith("Reset Settings")) {
            resetConfig(configPath);
        } else if (picked.startsWith("Open Raw Config")) {
            ensureStarterConfig(configPath);
            openFileInDefaultApp(configPath);
        }
    }
}

async function runMacGuiMenu() {
    while (true) {
        const s = await getStartupStatus();
        const cfg = loadConfig();
        const promptText =
            `${APP_NAME} v${version}\n\n` +
            `Status: ${s.running ? "Running" : "Stopped"}\n` +
            `Login startup: ${s.startupEnabled ? "Enabled" : "Disabled"}\n` +
            `Second line: ${formatSettingsSummary(cfg)}`;

        const choices = [
            "Install & Start Plugin at Login (Recommended)",
            "Start Plugin",
            "Stop Plugin",
            "Settings...",
            "Open Log File",
            "Uninstall Plugin",
        ];

        const picked = macChoose(promptText, choices);
        if (!picked) return "exit";

        try {
            if (picked.startsWith("Install")) {
                const res = await installStartup();
                macAlert(
                    `Plugin installed and started!\n\n` +
                        `Login startup: ${res.startupFile}\n` +
                        `Logs: ${res.logPath}\n\n` +
                        `If MuseScore scores don't show on Discord, allow Accessibility access for ${APP_NAME} in System Settings > Privacy & Security > Accessibility.`
                );
            } else if (picked.startsWith("Start")) {
                const res = await startBackground();
                macAlert(res.alreadyRunning ? "Plugin is already running." : `Plugin started!\n\nLogs: ${res.logPath}`);
            } else if (picked.startsWith("Stop")) {
                const stopped = await stopRunning();
                macAlert(stopped ? "Plugin stopped." : "Plugin was not running.");
            } else if (picked.startsWith("Settings")) {
                await runMacSettingsMenu(s.configPath);
            } else if (picked.startsWith("Open Log")) {
                if (!fs.existsSync(s.logPath)) {
                    macAlert(`No log file yet at:\n${s.logPath}`);
                } else {
                    openFileInDefaultApp(s.logPath);
                }
            } else if (picked.startsWith("Uninstall")) {
                const res = await uninstallStartup({ removeData: false });
                macAlert(
                    `${res.removedStartup ? "Removed plugin from login startup." : "Plugin wasn't in login startup."}\n` +
                        `${res.stopped ? "Stopped plugin." : "Plugin wasn't running."}\n\n` +
                        `You can move the app to Trash to finish removing it.`
                );
            }
        } catch (e) {
            macAlert(`Error: ${e.message}`);
        }
    }
}

async function runInteractiveMenu() {
    if (process.platform === "darwin" && !process.stdin.isTTY) {
        return runMacGuiMenu();
    }
    return runTerminalMenu();
}

module.exports = { runCliFlag, runInteractiveMenu };
