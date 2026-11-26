// Bundles the app with esbuild and builds a standalone executable via `node --build-sea` (Node >= 25.5).
// On Windows outputs `dist/MuseScore-Rich-Presence-win-<arch>.exe`.
// On macOS outputs `dist/MuseScore Rich Presence.app` and `dist/MuseScore-Rich-Presence-mac-<arch>.dmg`.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const esbuild = require("esbuild");
const { version } = require("../package.json");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const APP_NAME = "MuseScore Rich Presence";
const MAC_LABEL = "com.github.mimsqueeze.musescore-rich-presence";

function checkNodeSeaSupport() {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 25 || (major === 25 && minor < 5)) {
        throw new Error(`Node.js >= 25.5 is required for --build-sea (found ${process.version}).`);
    }
}

function bundleApp() {
    fs.mkdirSync(DIST, { recursive: true });
    const bundlePath = path.join(DIST, "bundle.cjs");
    esbuild.buildSync({
        entryPoints: [path.join(ROOT, "src", "index.js")],
        bundle: true,
        platform: "node",
        target: "node20",
        format: "cjs",
        minify: true,
        external: ["node:*"],
        outfile: bundlePath,
    });
    return bundlePath;
}

function buildSeaBinary(bundlePath, outputPath) {
    const seaConfigPath = path.join(DIST, "sea-config.json");
    fs.writeFileSync(
        seaConfigPath,
        JSON.stringify(
            {
                main: bundlePath,
                output: outputPath,
                disableExperimentalSEAWarning: true,
                assets: {
                    "foreground.ps1": path.join(ROOT, "src", "foreground.ps1"),
                    "foreground.jxa": path.join(ROOT, "src", "foreground.jxa"),
                    "windows.jxa": path.join(ROOT, "src", "windows.jxa"),
                },
            },
            null,
            2
        )
    );
    execFileSync(process.execPath, ["--build-sea", seaConfigPath], { stdio: "inherit" });
}

function packageMacApp(bundlePath) {
    const appDir = path.join(DIST, `${APP_NAME}.app`);
    const contentsDir = path.join(appDir, "Contents");
    const macOsDir = path.join(contentsDir, "MacOS");
    const binPath = path.join(macOsDir, APP_NAME);

    fs.rmSync(appDir, { recursive: true, force: true });
    fs.mkdirSync(macOsDir, { recursive: true });

    fs.writeFileSync(
        path.join(contentsDir, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${MAC_LABEL}</string>
    <key>CFBundleVersion</key>
    <string>${version}</string>
    <key>CFBundleShortVersionString</key>
    <string>${version}</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
`
    );

    buildSeaBinary(bundlePath, binPath);
    fs.chmodSync(binPath, 0o755);

    // Re-sign ad-hoc so macOS (especially Apple Silicon) allows running the modified Mach-O binary.
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appDir], { stdio: "inherit" });

    // Create a drag-and-drop DMG with an Applications symlink.
    const dmgStage = path.join(DIST, "dmg-stage");
    fs.rmSync(dmgStage, { recursive: true, force: true });
    fs.mkdirSync(dmgStage, { recursive: true });
    execFileSync("cp", ["-R", appDir, path.join(dmgStage, `${APP_NAME}.app`)], { stdio: "inherit" });
    fs.symlinkSync("/Applications", path.join(dmgStage, "Applications"));

    const dmgPath = path.join(DIST, `MuseScore-Rich-Presence-mac-${process.arch}.dmg`);
    fs.rmSync(dmgPath, { force: true });
    execFileSync(
        "hdiutil",
        ["create", "-volname", APP_NAME, "-srcfolder", dmgStage, "-ov", "-format", "UDZO", dmgPath],
        { stdio: "inherit" }
    );
    fs.rmSync(dmgStage, { recursive: true, force: true });

    console.log(`✓ Built macOS app: ${appDir}`);
    console.log(`✓ Built macOS DMG: ${dmgPath}`);
}

function main() {
    checkNodeSeaSupport();
    console.log("Bundling application...");
    const bundlePath = bundleApp();

    if (process.platform === "win32") {
        const exePath = path.join(DIST, `MuseScore-Rich-Presence-win-${process.arch}.exe`);
        fs.rmSync(exePath, { force: true });
        buildSeaBinary(bundlePath, exePath);
        console.log(`✓ Built Windows executable: ${exePath}`);
    } else if (process.platform === "darwin") {
        packageMacApp(bundlePath);
    } else {
        const binPath = path.join(DIST, `musescore-rich-presence-${process.platform}-${process.arch}`);
        fs.rmSync(binPath, { force: true });
        buildSeaBinary(bundlePath, binPath);
        fs.chmodSync(binPath, 0o755);
        console.log(`✓ Built binary: ${binPath}`);
    }
}

main();
