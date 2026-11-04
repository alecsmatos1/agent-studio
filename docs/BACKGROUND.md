# Running in the background

Closing the Agent Studio window keeps the desktop app running in the system tray (the menu bar
on macOS), the way the Claude and Codex desktop apps do. The window only hides, so everything the
app does on this computer carries on:

- Replies that are running keep going and save as they finish, and queued messages still send.
- Desktop alerts and the chime still announce finished replies, questions and input requests.
  Clicking an alert shows the window at its chat.
- Paired phones and other computers can still start chats that run here, because relay sync and
  presence continue.
- Parked CLI processes stay ready for the next reply until you move their chat to History,
  delete it or quit, and app and CLI update checks continue.

## Getting back and quitting

- **Windows:** click the Agent Studio icon in the system tray, or right-click it and choose
  **Open Agent Studio**. Windows 11 puts new icons in the hidden-icons flyout (the arrow beside
  the tray); drag the icon onto the taskbar, or turn it on in **Settings → Personalization →
  Taskbar → Other system tray icons**, to keep it in view.
- **Linux:** the icon opens a menu with **Open Agent Studio** and **Quit Agent Studio**; desktops
  report no clicks on the icon itself.
- **macOS:** the menu bar icon opens the same menu, and clicking the Dock icon shows the window.
- **Everywhere:** opening Agent Studio again (Start menu, taskbar, desktop shortcut) shows the
  running window instead of starting a second copy. Two copies would share one workspace file,
  drafts and parked processes, so a second launch hands over and exits.

**Quit Agent Studio** in the tray menu ends the app the way closing the window did before: it
stops replies running on this computer, releases parked CLI processes, and installs a downloaded
update when no reply runs, without reopening the app. Hiding the window never stops work or
installs an update; **Restart to update** in the sidebar still installs one at any time. macOS's
own **Quit** (⌘Q) in the app menu is unchanged.

## Turning it off

**Settings → Background → Keep running in the system tray when the window closes** is on by
default. Turning it off removes the icon and makes closing the window quit again. The choice
belongs to this computer: it is saved as `tray.json` in the app's local data folder, never synced
or exported, and the Viewer has no such setting because a browser tab has no window of its own to
keep running.

Linux shows a tray icon only with an AppIndicator library (`libayatana-appindicator3` or
`libappindicator3`). The app checks for one before adding its icon, because the tray library would
otherwise end the app; without one, closing quits and Settings explains why. The `.deb`, `.rpm`
and AppImage packages bring the library along. GNOME shows AppIndicator icons only with an
extension, such as Ubuntu's AppIndicator support; without it, open Agent Studio again to show a
hidden window.

## Shut down when chats finish

The power button beside Connections and Settings at the foot of the sidebar turns this computer
off once its chats finish (requested 2026-11-03, to leave the computer working through the
night). Click it to turn the watch on; it stays pressed, and its hover says what it waits for,
such as Waiting for 2 chats and 1 workflow. Click it again to turn it off.

- **What it waits for:** everything this computer would still do by itself. Replies running here:
  the window's own, those another device or a workflow started here, and those still waiting for
  background work or for an answer to a question. Messages queued behind a running reply, on any
  computer, since this window sends them. Chats a usage limit stopped that go on here once it
  resets, however far off that is, while their account can answer. Workflow runs this computer
  drives. A reply running on another computer holds nothing
  unless messages wait for it here, and neither do servers and monitors a reply left running,
  screens' jobs, messages kept after a stopped or failed reply, or paused workflow runs.
- **Staying awake:** while the watch is on, the computer does not sleep, though the display may
  turn off. Windows' power plans put a computer without input to sleep after a while, however
  busy its programs are, which would stop the chats it waits for.
- **The countdown:** once nothing is left, the window counts down a minute, with Cancel and Shut
  down now, and a desktop alert when the window is hidden or another app is in front. Work that
  begins meanwhile ends the countdown, and the watch waits again. Cancel turns the watch off.
- **Turning off:** the window saves drafts and chats and publishes them through the relay, the app
  releases parked CLIs as Quit does (without installing a downloaded update) and stops screens'
  jobs, then turns the computer off. It refuses while a reply runs here, and the watch then waits
  for it. Apps still open close without saving, since an app asking about unsaved work would
  otherwise keep the computer on all night. If the computer is still on two minutes later, the
  window says so and the watch is off.
- **Kept where:** the watch lives in the app's memory, so a reload of the window, or the window
  rebuilt after WebView2 ended, takes it up again; every start of the app begins with it off. A
  server host has no button, and the Viewer cannot turn a computer off.

- **Windows** turns off with `shutdown.exe /s /f /t 0` and stays awake through
  `SetThreadExecutionState` (`ES_SYSTEM_REQUIRED`).
- **macOS** turns off with System Events' `shut down`, which needs permission to control System
  Events once and which an app can cancel, and stays awake with `caffeinate -i -w <app>`.
- **Linux** turns off with `systemctl --no-ask-password poweroff` and stays awake with
  `systemd-inhibit --what=sleep`.

Debug builds never turn the computer off: they record the request in `shutdown-dry-run.txt` in
the app's data folder instead, so development and native QA follow the whole path safely.

## How it works

- `src-tauri/src/tray.rs` owns the setting, the icon and its menu. The close request in
  `src-tauri/src/lib.rs` hides the window while the icon is shown; otherwise, and after Quit, it
  takes the original path in `release_owned_work`, then closes the window and ends the app.
- A hidden window keeps its page running: WebView2 still considers it visible, so timers and
  relay polls are not throttled, while the window loses focus. Alerts are suppressed only for the
  chat on screen in a visible, focused window, so they appear, and the relay stops suppressing
  that chat's phone pushes.
- Tray menu handlers are app-wide and never removed, so the menu handler is registered once at
  startup, and the icon is built and removed on the main thread.
- On Windows the icon loads the small drawings from the application icon (`icons/icon.ico`, the
  executable's icon resource) at the tray's size, 24 pixels at 150% scaling, instead of scaling
  the 32-pixel window icon.
- `tauri-plugin-single-instance` is the first plugin, so a second launch signals the running app
  and exits before it opens a window or reads saved data. The running app shows, restores and
  focuses its window.
- Shut down when chats finish: `src/lib/shutdown-watch.ts` holds its rules (`unfinishedChats`,
  `watchStep`), `src/lib/shutdown-watch.svelte.ts` looks at the work left every two seconds while
  it waits and every second while it counts down, and `ShutdownCountdown.svelte` is the countdown.
  `src-tauri/src/shutdown.rs` keeps the watch and the request that holds the computer awake,
  reports the chats of the replies in the run registry (`shutdown_watch`), and turns the computer
  off (`shut_down_computer`) after `release_for_shutdown` in `src-tauri/src/lib.rs`, which leaves
  replies alone. The countdown's desktop alert is the `shutdown` notification kind.

## Development

Development builds use the release identifier `com.vinicius.agentstudio`, so they share the
installed app's data and its single-instance lock. Starting one while the installed app runs,
even hidden in the tray, shows the installed window and exits: quit the installed app from its
tray icon first. Native QA identifiers such as `com.vinicius.agentstudio.tray-qa` are separate.

## Verification

- `src-tauri/src/tray.rs` tests: the setting defaults on and keeps a saved choice, closing hides
  only while the icon can bring the window back and never after Quit, and the reported status
  serializes without an empty reason.
- `src/lib/window-behavior.test.ts`: where the icon lives on each platform, whether closing keeps
  the app running (turned off, or no tray), and the reported shape.
- `tests/background.spec.ts`: the Settings switch saves, survives a reload and restores itself
  when saving fails; an unavailable tray disables it with the reason, the only line Settings adds
  to it; macOS names the menu bar.
  `tests/app-updates.spec.ts` checks that the Viewer has no Background section.
- `scripts/tray-native-smoke.mjs` drives an isolated build of
  `scripts/native-tray.tauri.json` (CDP 19751). `scripts/tray-native-helper.ps1` sends the tray
  icon's own callback messages, as Explorer does, so the pointer never moves, and chooses menu
  items with the menu's keyboard handling. `npm run start:windows -- -SecondInstance` launches a
  second copy and reports whether it handed over. Pass `--reply` for one real Claude reply that
  must finish while the window is hidden and leave its alert in Windows' notification history.
- Shut down when chats finish: `src/lib/shutdown-watch.test.ts` (what holds the watch, its states
  and the time left), `src-tauri/src/shutdown.rs` tests (running chats counted once, shutdown.exe's
  exit codes, the reported shapes, the thread that keeps the computer awake) and the `shutdown`
  notice in `src-tauri/src/notifications.rs`. `tests/shutdown-watch.spec.ts` follows the button
  through a running reply, the countdown, Cancel, a reply that begins during the countdown, Shut
  down now, a reload, a refused shutdown and a server host. `scripts/shutdown-native-smoke.mjs`
  drives a debug build of `scripts/native-shutdown.tauri.json` (CDP 19893) through the same path
  to its dry run, and checks that the computer is held awake whenever no other program holds it.
