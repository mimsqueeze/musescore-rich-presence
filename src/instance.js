// Keeps only one copy running (e.g. the startup copy and a manual `npm start`),
// and lets other commands ask the running copy to stop. Uses a named pipe on
// Windows, which is released automatically if the process dies, and a Unix
// socket elsewhere, which can be left behind and is cleaned up on the next start.
const fs = require("fs");
const net = require("net");

function pipePathFor(name) {
    return process.platform === "win32"
        ? `\\\\.\\pipe\\${name}`
        : `/tmp/${name}-${process.getuid()}.sock`;
}

const PIPE = pipePathFor("musescore-rich-presence");
const LEGACY_PIPE = pipePathFor("musescore-studio-rich-presence");

/** Resolves true if this is the only running copy. `onStop` is called when asked to stop. */
function acquireLock(onStop) {
    return new Promise((resolve) => {
        const server = net.createServer((socket) => {
            socket.on("data", (data) => {
                if (data.toString().trim() === "stop") {
                    socket.end("ok");
                    onStop();
                }
            });
            socket.on("error", () => {});
        });
        server.once("error", async (e) => {
            if (process.platform === "win32" || e.code !== "EADDRINUSE" || (await isCurrentRunning())) return resolve(false);
            // A socket left behind by a copy that didn't exit cleanly.
            try {
                fs.unlinkSync(PIPE);
            } catch {
                return resolve(false);
            }
            server.once("error", () => resolve(false));
            server.listen(PIPE, () => resolve(true));
        });
        server.listen(PIPE, () => resolve(true));
    });
}

function stopOnPipe(pipePath) {
    return new Promise((resolve) => {
        const socket = net.connect(pipePath, () => socket.write("stop"));
        socket.on("data", () => {
            socket.destroy();
            resolve(true);
        });
        socket.on("error", () => resolve(false));
    });
}

function isRunningOnPipe(pipePath) {
    return new Promise((resolve) => {
        const socket = net.connect(pipePath, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on("error", () => resolve(false));
    });
}

async function stopAndWaitOnPipe(pipePath, timeoutMs = 10_000) {
    if (!(await stopOnPipe(pipePath))) return false;
    const deadline = Date.now() + timeoutMs;
    while ((await isRunningOnPipe(pipePath)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
    }
    return true;
}

/** Resolves true if a current-name copy is running. */
function isCurrentRunning() {
    return isRunningOnPipe(PIPE);
}

/** Resolves true if a pre-rename (MuseScore Studio Rich Presence) copy is running. */
function isLegacyRunning() {
    return isRunningOnPipe(LEGACY_PIPE);
}

/** Resolves true if either a current or legacy copy is currently running. */
async function isRunning() {
    const [current, legacy] = await Promise.all([isCurrentRunning(), isLegacyRunning()]);
    return current || legacy;
}

/** Asks a running current-name copy to stop. Resolves true if one was running. */
function stopCurrent() {
    return stopOnPipe(PIPE);
}

/** Asks a running current-name copy to stop and waits until it exits. */
function stopCurrentAndWait(timeoutMs = 10_000) {
    return stopAndWaitOnPipe(PIPE, timeoutMs);
}

/** Stops any pre-rename copy, waits for it to exit, and removes any stale legacy socket file. */
async function stopLegacyAndWait(timeoutMs = 10_000) {
    const stopped = await stopAndWaitOnPipe(LEGACY_PIPE, timeoutMs);
    if (process.platform !== "win32" && fs.existsSync(LEGACY_PIPE) && !(await isLegacyRunning())) {
        try {
            fs.unlinkSync(LEGACY_PIPE);
        } catch {
            // Best-effort cleanup of stale Unix socket.
        }
    }
    return stopped;
}

/** Asks any running copy (current or legacy) to stop. Resolves true if one was running. */
async function stopRunning() {
    const [current, legacy] = await Promise.all([stopCurrent(), stopOnPipe(LEGACY_PIPE)]);
    return current || legacy;
}

/** Asks any running copy (current or legacy) to stop and waits until exited. */
async function stopAndWait(timeoutMs = 10_000) {
    const [current, legacy] = await Promise.all([
        stopCurrentAndWait(timeoutMs),
        stopLegacyAndWait(timeoutMs),
    ]);
    return current || legacy;
}

module.exports = {
    acquireLock,
    isRunning,
    isCurrentRunning,
    isLegacyRunning,
    stopCurrent,
    stopCurrentAndWait,
    stopLegacyAndWait,
    stopRunning,
    stopAndWait,
};
