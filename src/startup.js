const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const {
    APP_NAME,
    MAC_LABEL,
    isSea,
    getRepoRoot,
    getMacAppBundlePath,
    getDataDir,
    getPortableConfigPath,
    getConfigPath,
    getLogPath,
    getInstallTarget,
} = require("./paths");
const { isRunning, stopRunning, stopAndWait } = require("./instance");

function getLaunchSpec() {
    if (!isSea()) {
        const root = getRepoRoot();
        return {
            command: process.execPath,
            args: ["src/index.js", "--background"],
            cwd: root,
            installedPath: null,
        };
    }

    const target = getInstallTarget();
    const dataDir = getDataDir();
    if (process.platform === "darwin") {
        const exePath = target.endsWith(".app")
            ? path.join(target, "Contents", "MacOS", path.basename(process.execPath))
            : target;
        return {
            command: exePath,
            args: ["--background"],
            cwd: dataDir,
            installedPath: target,
        };
    }

    return {
        command: target,
        args: ["--background"],
        cwd: dataDir,
        installedPath: target,
    };
}

function encodePowershell(script) {
    return Buffer.from(script, "utf16le").toString("base64");
}

function psQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsStartup() {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const startupDir = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    const shortcut = path.join(startupDir, `${APP_NAME}.lnk`);
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

    return {
        os: "Windows",
        file: shortcut,
        add(spec) {
            fs.mkdirSync(startupDir, { recursive: true });
            const script = `
                $s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK_PATH)
                $s.TargetPath = $env:LNK_TARGET
                $s.Arguments = $env:LNK_ARGS
                $s.WorkingDirectory = $env:LNK_DIR
                $s.WindowStyle = 7
                $s.Description = "Shows your current MuseScore Studio score on Discord"
                $s.Save()`;

            let lnkArgs;
            if (isSea()) {
                const launchScript = `Start-Process -FilePath ${psQuote(spec.command)} -ArgumentList '--background' -WorkingDirectory ${psQuote(spec.cwd)} -WindowStyle Hidden`;
                lnkArgs = `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodePowershell(launchScript)}`;
            } else {
                lnkArgs = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${path.join(getRepoRoot(), "scripts", "start-hidden.ps1")}" -Node "${spec.command}"`;
            }

            execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
                env: {
                    ...process.env,
                    LNK_PATH: shortcut,
                    LNK_TARGET: powershell,
                    LNK_ARGS: lnkArgs,
                    LNK_DIR: spec.cwd,
                },
                stdio: "ignore",
            });
        },
        start(spec) {
            fs.mkdirSync(spec.cwd, { recursive: true });
            spawn(spec.command, spec.args, {
                cwd: spec.cwd,
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
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
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
        add(spec) {
            fs.mkdirSync(spec.cwd, { recursive: true });
            fs.mkdirSync(path.dirname(plist), { recursive: true });
            const programArgs = [spec.command, ...spec.args]
                .map((arg) => `        <string>${xml(arg)}</string>`)
                .join("\n");
            fs.writeFileSync(
                plist,
                `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${MAC_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(spec.cwd)}</string>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`
            );
        },
        start(spec) {
            if (fs.existsSync(plist)) {
                launchctl("bootout", `${domain}/${MAC_LABEL}`);
                if (!launchctl("bootstrap", domain, plist)) {
                    throw new Error(`launchctl couldn't load ${plist}`);
                }
                return;
            }
            fs.mkdirSync(spec.cwd, { recursive: true });
            spawn(spec.command, spec.args, {
                cwd: spec.cwd,
                detached: true,
                stdio: "ignore",
            }).unref();
        },
        remove() {
            launchctl("bootout", `${domain}/${MAC_LABEL}`);
            if (!fs.existsSync(plist)) return false;
            fs.unlinkSync(plist);
            return true;
        },
    };
}

function getPlatformStartup() {
    return process.platform === "darwin" ? macStartup() : windowsStartup();
}

/** Copies the standalone binary / `.app` bundle into its install location when needed. */
function installBinaryIfNeeded(spec) {
    if (!isSea()) return false;

    const dataDir = getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });

    // Preserve a portable config.json placed beside the downloaded binary.
    const portableConfig = getPortableConfigPath();
    const dataConfig = path.join(dataDir, "config.json");
    if (portableConfig && fs.existsSync(portableConfig) && !fs.existsSync(dataConfig)) {
        fs.copyFileSync(portableConfig, dataConfig);
    }

    if (process.platform === "darwin") {
        const bundle = getMacAppBundlePath();
        if (bundle && bundle.includes("/AppTranslocation/")) {
            throw new Error(
                `Please move ${APP_NAME}.app into your Applications folder first, then open it from there.`
            );
        }
        if (bundle && path.resolve(bundle) !== path.resolve(spec.installedPath)) {
            fs.mkdirSync(path.dirname(spec.installedPath), { recursive: true });
            fs.rmSync(spec.installedPath, { recursive: true, force: true });
            execFileSync("cp", ["-R", bundle, spec.installedPath], { stdio: "ignore" });
            return true;
        }
        if (!bundle && path.resolve(process.execPath) !== path.resolve(spec.command)) {
            fs.copyFileSync(process.execPath, spec.command);
            fs.chmodSync(spec.command, 0o755);
            return true;
        }
        return false;
    }

    if (path.resolve(process.execPath).toLowerCase() !== path.resolve(spec.command).toLowerCase()) {
        fs.mkdirSync(path.dirname(spec.command), { recursive: true });
        fs.copyFileSync(process.execPath, spec.command);
        return true;
    }
    return false;
}

async function installStartup() {
    const startup = getPlatformStartup();
    const spec = getLaunchSpec();

    // Stop any running copy first so Windows doesn't lock the installed executable during copy.
    const restarted = await stopAndWait();
    const copied = installBinaryIfNeeded(spec);
    startup.add(spec);
    startup.start(spec);

    return {
        os: startup.os,
        startupFile: startup.file,
        installedPath: spec.installedPath,
        copied,
        restarted,
        logPath: getLogPath(),
    };
}

async function startBackground() {
    if (await isRunning()) {
        return { started: false, alreadyRunning: true };
    }

    const startup = getPlatformStartup();
    const spec = getLaunchSpec();

    // On Windows/macOS, if running standalone from Downloads before installing, run current executable directly.
    if (isSea() && !fs.existsSync(spec.command)) {
        fs.mkdirSync(spec.cwd, { recursive: true });
        spawn(process.execPath, ["--background"], {
            cwd: spec.cwd,
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        }).unref();
        return { started: true, alreadyRunning: false, logPath: getLogPath() };
    }

    startup.start(spec);
    return { started: true, alreadyRunning: false, logPath: getLogPath() };
}

async function uninstallStartup({ removeData = false } = {}) {
    const startup = getPlatformStartup();
    const removedStartup = startup.remove();
    const stopped = await stopAndWait();

    let removedData = false;
    let deferredCleanupDir = null;

    if (removeData && isSea()) {
        const dataDir = getDataDir();
        if (fs.existsSync(dataDir)) {
            const runningFromDataDir =
                path.resolve(process.execPath).toLowerCase().startsWith(path.resolve(dataDir).toLowerCase() + path.sep);

            if (process.platform === "win32" && runningFromDataDir) {
                for (const sub of ["logs", "helpers", "config.json"]) {
                    fs.rmSync(path.join(dataDir, sub), { recursive: true, force: true });
                }
                deferredCleanupDir = dataDir;
                removedData = true;
            } else {
                fs.rmSync(dataDir, { recursive: true, force: true });
                removedData = true;
            }
        }
    }

    return {
        os: startup.os,
        removedStartup,
        stopped,
        removedData,
        deferredCleanupDir,
    };
}

function scheduleDeferredDirCleanup(dir) {
    if (!dir || process.platform !== "win32") return;
    const quoted = `"${dir.replace(/"/g, "")}"`;
    spawn("cmd.exe", ["/c", `ping -n 2 127.0.0.1 >nul & rmdir /s /q ${quoted}`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    }).unref();
}

async function getStartupStatus() {
    const startup = getPlatformStartup();
    const spec = getLaunchSpec();
    const running = await isRunning();
    return {
        os: startup.os,
        running,
        startupEnabled: fs.existsSync(startup.file),
        startupFile: startup.file,
        installed: spec.installedPath ? fs.existsSync(spec.installedPath) : true,
        installedPath: spec.installedPath,
        configPath: getConfigPath(),
        logPath: getLogPath(),
        isSea: isSea(),
    };
}

module.exports = {
    installStartup,
    startBackground,
    uninstallStartup,
    scheduleDeferredDirCleanup,
    getStartupStatus,
    stopRunning,
};
