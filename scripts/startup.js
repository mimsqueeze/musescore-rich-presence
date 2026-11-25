// Makes the app start when you log in: a shortcut in the Startup folder on Windows,
// or a LaunchAgent on macOS.
//   node scripts/startup.js install    add it to startup and (re)start the app now
//   node scripts/startup.js uninstall  remove it from startup and stop the app
//   node scripts/startup.js stop       stop the running app
const { installStartup, uninstallStartup, stopRunning } = require("../src/startup");

async function main() {
    const command = process.argv[2];

    switch (command) {
        case "install": {
            const res = await installStartup();
            console.log(`✓ Added to startup: ${res.startupFile}`);
            console.log(`✓ ${res.restarted ? "Restarted" : "Started"} in the background. Messages go to logs/presence.log.`);
            break;
        }
        case "uninstall": {
            const res = await uninstallStartup();
            console.log(res.removedStartup ? "✓ Removed from startup." : `· It wasn't set to start with ${res.os}.`);
            if (res.stopped) console.log("✓ Stopped the running copy.");
            break;
        }
        case "stop":
            console.log((await stopRunning()) ? "✓ Stopped." : "· It wasn't running.");
            break;
        default:
            console.log("Usage: node scripts/startup.js <install|uninstall|stop>");
            process.exitCode = 1;
    }
}

main();
