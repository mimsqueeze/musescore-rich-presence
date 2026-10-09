// Makes the app start when you log in: a shortcut in the Startup folder on Windows,
// or a LaunchAgent on macOS.
//   node scripts/startup.js install    add it to startup and (re)start the app now
//   node scripts/startup.js uninstall  remove it from startup and stop the app
//   node scripts/startup.js stop       stop the running app
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { stopRunning, stopAndWait } = require("../src/instance");

const ROOT = path.join(__dirname, "..");

function windowsStartup() {
    const startupDir = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    const shortcut = path.join(startupDir, "MuseScore Studio Rich Presence.lnk");
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

    return {
        os: "Windows",
        file: shortcut,
        add() {
            // Values go through environment variables so paths with spaces or quotes need no escaping.
            const script = `
                $s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK_PATH)
                $s.TargetPath = $env:LNK_TARGET
                $s.Arguments = $env:LNK_ARGS
                $s.WorkingDirectory = $env:LNK_DIR
                $s.WindowStyle = 7
                $s.Description = "Shows your current MuseScore Studio score on Discord"
                $s.Save()`;
            execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
                env: {
                    ...process.env,
                    LNK_PATH: shortcut,
                    LNK_TARGET: powershell,
                    LNK_ARGS: `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${path.join(ROOT, "scripts", "start-hidden.ps1")}" -Node "${process.execPath}"`,
                    LNK_DIR: ROOT,
                },
                stdio: "inherit",
            });
        },
        start() {
            spawn(process.execPath, ["src/index.js", "--background"], {
                cwd: ROOT,
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            }).unref();
        },
        remove() {
            if (!fs.existsSync(shortcut)) return false;
            fs.unlinkSync(shortcut);
            return true;
        },
    };
}

function macStartup() {
    const label = "com.github.mimsqueeze.musescore-studio-rich-presence";
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const domain = `gui/${process.getuid()}`;
    const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const launchctl = (...args) => {
        try {
            execFileSync("launchctl", args, { stdio: "ignore" });
            return true;
        } catch {
            return false;
        }
    };

    return {
        os: "macOS",
        file: plist,
        add() {
            fs.mkdirSync(path.dirname(plist), { recursive: true });
            fs.writeFileSync(
                plist,
                `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(process.execPath)}</string>
        <string>src/index.js</string>
        <string>--background</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(ROOT)}</string>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`
            );
        },
        start() {
            // Unload any previous version of the agent, then load this one; RunAtLoad starts it right away.
            launchctl("bootout", `${domain}/${label}`);
            if (!launchctl("bootstrap", domain, plist)) throw new Error(`launchctl couldn't load ${plist}`);
        },
        remove() {
            launchctl("bootout", `${domain}/${label}`); // also stops the copy it started
            if (!fs.existsSync(plist)) return false;
            fs.unlinkSync(plist);
            return true;
        },
    };
}

async function main() {
    const command = process.argv[2];
    const startup = command === "install" || command === "uninstall"
        ? (process.platform === "darwin" ? macStartup() : windowsStartup())
        : null;

    switch (command) {
        case "install": {
            startup.add(); // overwrites the existing entry, so running this again is safe
            console.log(`✓ Added to startup: ${startup.file}`);
            // Restart any running copy so it picks up code or config changes.
            const restarted = await stopAndWait();
            startup.start();
            console.log(`✓ ${restarted ? "Restarted" : "Started"} in the background. Messages go to logs/presence.log.`);
            break;
        }
        case "uninstall":
            console.log(startup.remove() ? "✓ Removed from startup." : `· It wasn't set to start with ${startup.os}.`);
            if (await stopRunning()) console.log("✓ Stopped the running copy.");
            break;
        case "stop":
            console.log((await stopRunning()) ? "✓ Stopped." : "· It wasn't running.");
            break;
        default:
            console.log("Usage: node scripts/startup.js <install|uninstall|stop>");
            process.exitCode = 1;
    }
}

main();
