// Watches which window is in the foreground, so the presence can follow the
// MuseScore window you're actually using. Uses a small helper script: PowerShell
// calling the Win32 GetForegroundWindow API on Windows, or JXA asking NSWorkspace
// for the frontmost app on macOS. No native modules or admin rights needed.
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const RESTART_DELAY = 10_000;

const HELPER =
    process.platform === "darwin"
        ? ["osascript", ["-l", "JavaScript", path.join(__dirname, "foreground.jxa")]]
        : [
              "powershell.exe",
              [
                  "-NoProfile",
                  "-NonInteractive",
                  "-ExecutionPolicy", "Bypass",
                  "-File", path.join(__dirname, "foreground.ps1"),
                  "-ParentPid", String(process.pid),
              ],
          ];

/** Calls `onChange({ pid, name })` whenever the foreground window changes. */
function watchForeground(onChange) {
    const [command, args] = HELPER;
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });

    readline.createInterface({ input: child.stdout }).on("line", (line) => {
        const [pid, name = ""] = line.split("\t");
        if (pid) onChange({ pid: Number(pid), name });
    });

    child.on("error", (e) => console.warn(`! Foreground window tracking unavailable: ${e.message}`));
    child.on("exit", () => setTimeout(() => watchForeground(onChange), RESTART_DELAY).unref());
}

module.exports = { watchForeground };
