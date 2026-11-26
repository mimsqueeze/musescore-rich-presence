const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_NAME = "MuseScore Rich Presence";
const MAC_LABEL = "com.github.mimsqueeze.musescore-rich-presence";

/** Returns true when running inside a Node.js Single Executable Application. */
function isSea() {
    try {
        return require("node:sea").isSea();
    } catch {
        return false;
    }
}

/** Root directory when running from source (`node src/index.js`). */
function getRepoRoot() {
    return path.join(__dirname, "..");
}

/** On macOS, returns the enclosing `.app` bundle directory if running inside one, else null. */
function getMacAppBundlePath() {
    if (!isSea() || process.platform !== "darwin") return null;
    const macOsDir = path.dirname(process.execPath);
    const contentsDir = path.dirname(macOsDir);
    const bundleDir = path.dirname(contentsDir);
    if (
        path.basename(macOsDir) === "MacOS" &&
        path.basename(contentsDir) === "Contents" &&
        bundleDir.endsWith(".app")
    ) {
        return bundleDir;
    }
    return null;
}

/** Directory for user-writable app data (config, logs, extracted helpers, installed binary). */
function getDataDir() {
    if (!isSea()) return getRepoRoot();
    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
        return path.join(localAppData, APP_NAME);
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
    }
    return path.join(os.homedir(), ".musescore-rich-presence");
}

/** Optional `config.json` placed right next to a portable executable or `.app` bundle. */
function getPortableConfigPath() {
    if (!isSea()) return null;
    const bundle = getMacAppBundlePath();
    const baseDir = bundle ? path.dirname(bundle) : path.dirname(process.execPath);
    return path.join(baseDir, "config.json");
}

function getConfigPath() {
    if (!isSea()) return path.join(getRepoRoot(), "config.json");
    const portable = getPortableConfigPath();
    if (
        portable &&
        path.resolve(path.dirname(portable)) !== path.resolve(getDataDir()) &&
        fs.existsSync(portable)
    ) {
        return portable;
    }
    return path.join(getDataDir(), "config.json");
}

function getLogPath() {
    return path.join(getDataDir(), "logs", "presence.log");
}

/** Target path where the standalone executable / `.app` lives when installed on this OS. */
function getInstallTarget() {
    if (!isSea()) return null;
    if (process.platform === "win32") {
        return path.join(getDataDir(), `${APP_NAME}.exe`);
    }
    if (process.platform === "darwin") {
        const bundle = getMacAppBundlePath();
        if (bundle) {
            if (bundle.startsWith("/Volumes/")) {
                return path.join(os.homedir(), "Applications", `${APP_NAME}.app`);
            }
            return bundle;
        }
        return path.join(getDataDir(), "musescore-rich-presence");
    }
    return path.join(getDataDir(), "musescore-rich-presence");
}

/**
 * Returns an on-disk path to a helper script (`.ps1` / `.jxa`).
 * In SEA mode, extracts the embedded asset to `getDataDir()/helpers/` on demand.
 */
function resolveHelperFile(filename) {
    if (!isSea()) return path.join(__dirname, filename);
    const { getAsset } = require("node:sea");
    const content = getAsset(filename, "utf8");
    const helpersDir = path.join(getDataDir(), "helpers");
    const dest = path.join(helpersDir, filename);
    let existing = null;
    try {
        existing = fs.readFileSync(dest, "utf8");
    } catch {
        // Missing or unreadable; write below.
    }
    if (existing !== content) {
        fs.mkdirSync(helpersDir, { recursive: true });
        fs.writeFileSync(dest, content, "utf8");
    }
    return dest;
}

module.exports = {
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
    resolveHelperFile,
};
