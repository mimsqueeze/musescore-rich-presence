// Keeps only one copy running (e.g. the startup copy and a manual `npm start`),
// and lets other commands ask the running copy to stop. Uses a named pipe on
// Windows, which is released automatically if the process dies, and a Unix
// socket elsewhere, which can be left behind and is cleaned up on the next start.
const fs = require("fs");
const net = require("net");

const PIPE =
    process.platform === "win32"
        ? "\\\\.\\pipe\\musescore-studio-rich-presence"
        : `/tmp/musescore-studio-rich-presence-${process.getuid()}.sock`;

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
            if (process.platform === "win32" || e.code !== "EADDRINUSE" || (await isRunning())) return resolve(false);
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

/** Asks a running copy to stop. Resolves true if one was running. */
function stopRunning() {
    return new Promise((resolve) => {
        const socket = net.connect(PIPE, () => socket.write("stop"));
        socket.on("data", () => {
            socket.destroy();
            resolve(true);
        });
        socket.on("error", () => resolve(false));
    });
}

/** Resolves true if a copy is currently running. */
function isRunning() {
    return new Promise((resolve) => {
        const socket = net.connect(PIPE, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on("error", () => resolve(false));
    });
}

/** Asks a running copy to stop and waits (up to `timeoutMs`) until it has exited. */
async function stopAndWait(timeoutMs = 10_000) {
    if (!(await stopRunning())) return false;
    const deadline = Date.now() + timeoutMs;
    while ((await isRunning()) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
    }
    return true;
}

module.exports = { acquireLock, isRunning, stopRunning, stopAndWait };
