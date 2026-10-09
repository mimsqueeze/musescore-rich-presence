# MuseScore Studio Rich Presence

Show the score you're working on in [MuseScore Studio](https://musescore.org) as your Discord Rich Presence.

```
Playing MuseScore Studio
Piano Sonata No. 14
Moonlight Sonata
00:42 elapsed
```

The first line is the score's title, and by default the second is its subtitle. The second line can instead rotate through other details, such as the composer, instruments or tempo. See [Configuration](#configuration).

It runs alongside MuseScore Studio on Windows and macOS, with nothing to install inside MuseScore and no admin rights needed.

## Setup

1. Install [Node.js](https://nodejs.org/) 18 or newer.
2. Clone this repository and install dependencies:
   ```powershell
   npm install
   ```
3. Start it:
   ```powershell
   npm start
   ```

It runs until you close the terminal or press Ctrl+C. Discord and MuseScore can be started before or after it. When MuseScore closes, the status is cleared.

With several MuseScore windows open, your status follows the one you used most recently. Each score keeps its own elapsed time, so switching back and forth doesn't reset it.

### macOS permissions

On macOS, reading MuseScore's window title needs Accessibility access. The first time you run `npm start`, macOS asks whether your terminal app may control System Events. Click **OK**. Then open **System Settings > Privacy & Security > Accessibility** and turn on your terminal app (Terminal, iTerm, VS Code, …). If access is missing, the app prints a warning saying what to allow.

### Start automatically at login

```powershell
npm run install-startup
```

This starts the app right away in the background, with no window, and sets it to start whenever you log in. On Windows it adds a shortcut to your Startup folder. On macOS it adds a LaunchAgent to `~/Library/LaunchAgents`. Messages go to `logs/presence.log`.

On macOS, the copy started at login runs as `node` rather than through your terminal, so `node` needs its own permissions. If `logs/presence.log` shows an Accessibility warning, add the `node` executable it names under **Accessibility**. macOS may also ask whether `node` can access your Documents folder, which is where your scores live. Allow that too.

| Command | What it does |
| --- | --- |
| `npm run install-startup` | Start at login, and start now |
| `npm run uninstall-startup` | Stop starting at login, and stop the running copy |
| `npm run stop` | Stop the running copy, including one started at login |

Only one copy runs at a time. If it's already running in the background, `npm start` tells you so and exits.

Running `npm run install-startup` again is safe. It replaces the shortcut and restarts the background copy, so use it after changing `config.json`, updating the code, moving this folder, or reinstalling Node.js.

## How it works

Everything is read from outside MuseScore:

1. **Which score is open.** MuseScore Studio sets its window title to the open score's name (`Score`, `Score - Part` in a part tab, or `MuseScore Studio` on the Home screen).
   - On Windows, the title is read with `tasklist`, which works even when MuseScore runs elevated. A small PowerShell helper ([src/foreground.ps1](src/foreground.ps1)) watches which window is in front, so the status can follow the MuseScore window you're using.
   - On macOS, small JavaScript for Automation helpers run through `osascript` do the same jobs. [src/windows.jxa](src/windows.jxa) reads the title through System Events, and [src/foreground.jxa](src/foreground.jxa) watches which app is in front.
2. **Where that score lives.** The title is matched against MuseScore's own `session/session.json` and `recent_files.json`. These are in `%LOCALAPPDATA%\MuseScore\MuseScore4` on Windows and `~/Library/Application Support/MuseScore/MuseScore4` on macOS. This resolves the full path wherever your scores are, including OneDrive or iCloud folders, and also covers cloud scores.
3. **Score details.** The `.mscz` file is a zip archive. The score XML inside it is read to get the title, subtitle and composer from the title frame at the top of the score, plus the instruments, measures, time and key signatures, and tempo. If the title frame has several lines, the one in the largest font is used as the title. Results are cached and refreshed whenever you save.

Because the details come from the saved file, edits show up in your status after you save. Switching scores updates it right away.

## Configuration

Create a `config.json` in the project root to override any default from [src/config.js](src/config.js). For example:

```json
{
  "states": ["subtitle", "composer", "instruments"],
  "rotateInterval": 20
}
```

### The second line

`states` chooses what appears below the title. With one entry, that entry stays fixed. With several, the line rotates through them every `rotateInterval` seconds. Entries a score doesn't have, like a missing subtitle, are skipped. If none apply, the second line is left out.

| Entry | Example |
| --- | --- |
| `subtitle` | Moonlight Sonata |
| `part` | Violin 1 part (only while a part tab is open) |
| `composer` | by Ludwig van Beethoven |
| `instruments` | Piano |
| `measures` | 184 measures · 4/4 |
| `key` | Key: E major / C♯ minor |
| `tempo` | ♩ = 54 |

### All options

| Option | Default | Description |
| --- | --- | --- |
| `activityName` | `"MuseScore Studio"` | The name shown after "Playing". |
| `clientId` | a shared "MuseScore" app | Discord application ID. You only need your own if you want to upload custom images to it. |
| `states` | `["subtitle"]` | What the second line shows. See above. |
| `rotateInterval` | `15` | Seconds between rotations of the second line. |
| `updateInterval` | `5` | Seconds between checks of MuseScore. |
| `privateMode` | `false` | Show "Composing" instead of any score details. |
| `largeImage` / `largeImageText` | MuseScore Studio icon | Image URL (or asset key) and its hover text. |
| `processNames` | `MuseScore4.exe`, … (Windows)<br>`mscore` (macOS) | Executables to look for. |
| `dataDir` | `%LOCALAPPDATA%\MuseScore\MuseScore4` (Windows)<br>`~/Library/Application Support/MuseScore/MuseScore4` (macOS) | Where MuseScore keeps its session and recent-files lists. |

## Limitations

- Windows and macOS only. Linux isn't supported yet.
- On macOS, System Events lists only the windows on the current Space. If MuseScore is on another Space, the status keeps showing the last score seen there until you return to it.
- Discord shows one status per app, so with several MuseScore windows open, only the most recently used one is shown.
- A new score that hasn't been saved yet shows only its name.
