const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFileSync, spawn } = require("child_process");
const { APP_NAME, isSea } = require("./paths");
const { STARTER_CONFIG } = require("./config");
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
            console.clear();
            console.log("==================================================");
            console.log(`  ${APP_NAME} (v${version})`);
            console.log("==================================================");
            console.log(`  Status:        ${s.running ? "Running" : "Stopped"}`);
            console.log(`  Login startup: ${s.startupEnabled ? "Enabled" : "Disabled"}`);
            if (s.installedPath) {
                console.log(`  Install path:  ${s.installedPath}`);
            }
            console.log(`  Config file:   ${s.configPath}`);
            console.log(`  Log file:      ${s.logPath}`);
            console.log("--------------------------------------------------");
            console.log("  1. Install & start plugin at login (Recommended)");
            console.log("  2. Start plugin");
            console.log("  3. Run plugin with live logs");
            console.log("  4. Stop plugin");
            console.log("  5. Open config file");
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
                        const created = ensureStarterConfig(s.configPath);
                        if (created) console.log(`✓ Created starter config at ${s.configPath}`);
                        openFileInDefaultApp(s.configPath);
                        console.log("✓ Opened config.json. Re-run option 1 or 2 afterward to apply changes.");
                        await pause();
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

function macChoose(promptText, items) {
    const script = `on run argv
    set promptText to item 1 of argv
    set choiceList to items 2 thru -1 of argv
    set picked to choose from list choiceList with title "${APP_NAME}" with prompt promptText default items {item 1 of choiceList} OK button name "Select" cancel button name "Quit"
    if picked is false then return ""
    return item 1 of picked
end run`;
    return osascriptDialog(script, [promptText, ...items]);
}

async function runMacGuiMenu() {
    while (true) {
        const s = await getStartupStatus();
        const promptText =
            `${APP_NAME} v${version}\n\n` +
            `Status: ${s.running ? "Running" : "Stopped"}\n` +
            `Login startup: ${s.startupEnabled ? "Enabled" : "Disabled"}\n` +
            `Config: ${s.configPath}`;

        const choices = [
            "Install & Start Plugin at Login (Recommended)",
            "Start Plugin",
            "Stop Plugin",
            "Open Config File",
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
            } else if (picked.startsWith("Open Config")) {
                ensureStarterConfig(s.configPath);
                openFileInDefaultApp(s.configPath);
                macAlert(`Opened ${s.configPath}\n\nChoose "Install & Start Plugin at Login" or "Start Plugin" again after saving changes.`);
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
