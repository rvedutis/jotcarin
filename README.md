# Taskule

Local notes + tasks. Folders, a rich-text editor, inline to-dos, natural-language dates, a Tasks panel with every task in one place, and global search. Everything saves as you type.

## Desktop app (Windows)

Open **Taskule** from the Start menu or the Desktop shortcut. It opens in its own window.

- **Password:** the app starts locked every time you open it. The first time, it asks you to create a password. The lock is enforced by the server, so it applies in a browser at http://localhost:4747 too.
- **Lock now:** gear at the bottom of the sidebar → **Lock now** saves everything and locks immediately.
- **Change the password:** `npm run set-password -- "new password"`. It takes effect immediately and locks anyone currently unlocked. The password is stored hashed (scrypt) in `data/password.json`, which is never committed. Forgot it? Stop Taskule, delete that file, and you'll be asked to create a new one.
- **Server:** if the server is already running (for example from auto-start, below), the app uses it. Otherwise the app starts its own and stops it when you quit. Either way it uses the same notes in this folder's `data/`. The app checks every few seconds that a server is answering and starts one if not.
- **System tray:** the **X** button hides the window to the system tray; Taskule keeps running and stays unlocked. Click the tray icon, or open Taskule from any shortcut, to bring the window back. Right-click the tray icon for **Open**, **Lock** and **Quit Taskule**. Quitting saves everything first and asks if it can't. Minimize works as usual.
- **Taskbar:** to pin it, open Taskule, right-click its taskbar button and choose **Pin to taskbar**. Clicking the pin while it's running switches to the open window, and the shortcuts are set up so Windows treats the pin and the window as one button.
- **Desktop extras:** right-click gives Cut/Copy/Paste and spelling suggestions. `Ctrl +`/`Ctrl -`/`Ctrl 0` zoom, `F11` toggles full screen, and links open in your normal browser. Downloads ask where to save, starting in Downloads.

### Building the app

The app is built into `dist\Taskule-win32-x64\Taskule.exe` (Electron). After changing any code, quit the app (tray icon → Quit Taskule) and rebuild. The rebuild updates that folder in place, so a taskbar pin survives:

```bash
npm run app:build
```

This also (re)creates the Start menu and Desktop shortcuts (`-- --no-shortcuts` to skip). `npm run app` runs it straight from source without building.

## Run in a browser

Requires **Node.js 22.13+** (uses Node's built-in SQLite). Nothing to install to run it.

```bash
npm start
```

Then open **http://localhost:4747** and enter the password.

### Start automatically with Windows

```bash
npm run autostart:on
```

This adds an **Taskule server** shortcut to your Windows **Startup** folder. It runs the server hidden (no window) every time you log in, and starts it right away. If the server ever stops unexpectedly it's started again. Output goes to `data/server.log`. The shortcut runs `wscript.exe` directly, so it works even if `.vbs` files are set to open in an editor.

| Command | What it does |
| --- | --- |
| `npm run autostart:status` | Shows whether auto-start is on and whether the server is running |
| `npm run autostart:off` | Removes auto-start (a running server keeps running) |
| `npm run stop` | Stops the running server, and the auto-start loop that would restart it (e.g. before restoring a backup) |
| `npm run autostart:on` | Re-enables it, and starts the server if it isn't running |

After changing `server.js`, restart with `npm run stop` then `npm run autostart:on`. (Changes to files in `public/` only need a browser refresh.)

- Different port: `PORT=5000 npm start` (PowerShell: `$env:PORT=5000; npm start`)
- Data lives in `data/taskule.db` (SQLite) and `data/images/`, with automatic backups in `data/backups/` (see [Backups](#backups-and-restoring)). `data/` is never committed.
- The server only listens on `127.0.0.1`, so nothing on your network can reach it.

## How it works

**Scratchpad** (top of the sidebar, or `Alt+S` from anywhere) is one permanent note for capturing things fast in meetings, then sorting them later. It can't be deleted, renamed or moved into a folder.
- `Alt+S` opens it with the cursor on a fresh line at the end, ready to type. To-dos work as usual (`[ ] `) and appear near the top of the Tasks panel; the green badge counts its open ones.
- **Move to note…** (`Ctrl+Shift+M`) moves the selected lines (or just the line the cursor is on) to the end of another note. Pick a note (most recently edited first, type to filter) or **New note**, which is titled from the first line and created in the selected folder. Moved to-dos join a to-do list at the end of that note. **Undo** is in the toast.
- **⋯ → Clear Scratchpad** empties it (undoable).

**Sidebar** — the panel button at the top of the sidebar (or `Ctrl+\`) hides it to give notes the full window. While it's hidden, move the mouse to the left edge (or over the small panel button at top left) and it slides out; it stays while you're using it (typing in search, a menu, renaming) and slides away when you click back in the page. Click the **pin** in it, the small button, or `Ctrl+\` again to keep it open. Your choice is remembered. The Tasks panel on the right works the same way.

**Gear menu** (bottom of the sidebar): **Settings…**, **Download a copy…**, **Lock now** and **Wipe database…**, all in one place.

**Settings** (gear → Settings…, or `Ctrl+,`):
- **Appearance:** Light, Dark, or Match system (follows Windows' light/dark setting as it changes).
- **Keyboard shortcuts:** click a shortcut and press new keys to change it; Backspace removes it, Esc cancels. Keys the editor or window already use (like `Ctrl+B` or `F11`) can't be taken, and plain letters need `Ctrl` or `Alt`. Picking keys another action uses moves them to the new action, and you're told which one lost them. **Reset** puts one back; **Reset all shortcuts** puts them all back.
- Settings are kept per device: the desktop app and each browser remember their own.

**Notes** live in the left column inside nested folders.
- `+` buttons create notes/folders inside the selected folder (click **NOTES** to select top level).
- **Arrange them your way:** drag a note or folder and drop it on the top or bottom edge of another to put it before or after it (a blue line shows where); drop it on the middle of a folder to put it inside. Or right-click → **Move up** / **Move down** (`Alt+↑` / `Alt+↓` on a selected row), or **Move to…** for another folder. Folders stay above notes at each level. Items you haven't arranged are listed alphabetically after the arranged ones. Reordering or moving a note doesn't count as editing it. The Tasks panel and downloads follow the same order.
- Double-click a folder (or F2) to rename.

**Editor** — a normal WYSIWYG editor: headings, bold, italic, underline, strikethrough, code, links, bullet/numbered lists, quotes, code blocks, dividers and to-dos. Markdown-style shortcuts also work as you type (`# ` heading, `- ` bullet, `1. ` numbered, `[ ] ` to-do, `**bold**`, `> ` quote).

The toolbar also has **highlight**, **clear formatting**, **images** and **tables** (click the table button inside a table for add/delete row/column options).

**@ menu** — type `@` to insert things: Date, To-do, Image, Table, Link, Heading 1–3, lists, Quote, Code block, Divider. Keep typing to filter (`@ta` → Table), Enter to pick. `@` followed by anything that isn't a command (e.g. `@dana`) stays plain text.

**Images** — paste them (screenshots, "Copy image"), drag image files in, use the image toolbar button or `@image`. Click an image and drag a corner to resize (proportions are kept). Images are stored in `data/images/`; pictures pasted from Google Docs or web pages are downloaded and saved there too, so notes don't depend on links that can expire.

**Moving notes from Google Docs** — just copy in Docs and paste into a note. Formatting is kept:
- headings, bold, italic, underline, strikethrough, links (Google's redirect links are unwrapped to the real URL)
- bulleted and numbered lists, including nested levels
- Google Docs checklists → to-dos (ticked items stay ticked, and they appear in the Tasks panel)
- tables, highlights and coloured text
- images (saved locally)
- written dates with a year — `Mar 6, 2026`, `March 6th 2026`, `06/10/2025` (month/day/year), `2026-03-06` — become date tags. Dates without a year are left as text.

Intentionally dropped so everything looks consistent: fonts, font sizes, line spacing, black/grey text colours and table cell shading.

Already pasted a note before date tagging existed? Open it, click **⋯ → Tag dates in this note** (undoable).

Other ways in:
- **Copy as Markdown** in Google Docs (right-click → *Copy as Markdown*, needs *Tools → Preferences → Enable Markdown*) also pastes fully formatted, including tables and checkboxes. Any Markdown pasted as plain text is converted.
- Lines starting with ☐ / ☑ become to-dos.
- `Ctrl+Shift+V` pastes as plain text (no formatting).

**Tasks panel** (right side) — every task in one place, next to whatever note you're writing:
- *Standalone tasks* — type into **Add a task** at the top of the panel.
- *Note to-dos* — type `[ ] ` at the start of a line in any note (or click **To-do** in the toolbar). They're grouped by note in the panel.
- **Due soon:** open tasks with a due date coming up are gathered at the top under **Overdue**, **Today**, **Tomorrow** and **Later this week** (through Sunday), each showing which note it's from. A group only appears when something is in it. These tasks also stay in their normal group below.
- **Completed** sits at the bottom, below a darker divider, on a faintly shaded background.
- **When it was added:** each task shows a faint **Added …** date next to its title (hover for the exact time, and when it was last changed). This is separate from the due date. To-dos written in notes before this was added have no recorded date, so they show none. A note's footer shows when it was created and last edited.
- **Edit right in the panel:** click a task's title to change it (Enter saves, Esc cancels). **Details**: free text under the title (hover a task and click the lines icon to add some). **Due date**: hover and click the calendar, then type plain English (“tomorrow”, “next fri”, “12/1”), pick a suggestion, or use the calendar. Overdue dates are red, today's green.
- For a note to-do, its details are the lines written under it inside the note, and its due date shows as a badge at the end of the line. Click the badge to change it. Details that hold formatting (a table, code block…) are edited in the note instead.
- Checking a task anywhere (the panel, the note, or `Ctrl+Enter` in the editor) moves it to **Completed**, still grouped the same way. Deletes can be undone from the toast.
- **Show/hide** works like the sidebar. The panel button at its top right hides it. While it's hidden, a small panel button at the top right of the window shows the number of open tasks; hover it and the panel slides out (click the pin to keep it open), or click it to keep it open. `Ctrl+]` shows or hides it, and `Alt+T` opens it with the cursor in **Add a task**. Your choice is remembered.

**Dates** — type `@date` then plain English (or type `@` and pick **Date**); a picker shows the exact date before you insert it:

| You type | You get (if today is Fri, Nov 13) |
| --- | --- |
| `@date`, `@date today` | Fri, Nov 13 |
| `@date tomorrow`, `@date yesterday` | Sat, Nov 14 / Thu, Nov 12 |
| `@date last thursday` | Thu, Nov 12 (most recent one before today) |
| `@date thursday`, `@date this thu` | Thu, Nov 19 (next one, today counts) |
| `@date next friday` | Fri, Nov 20 — or pick Nov 27 ("the week after") |
| `@date thursday next week` | Thu, Nov 19 |
| `@date in 3 days`, `@date 2 weeks from now`, `@date 3 days ago`, `@date +5` | relative dates |
| `@date next week`, `@date next month`, `@date end of month`, `@date this weekend` | … |
| `@date nov 20`, `@date 20th of november`, `@date 11/20`, `@date 2026-12-01` | absolute dates (nearest year if you leave it out) |

- `Ctrl+;` inserts today's date instantly; the **Date** toolbar button opens the picker.
- "Today" is always computed in **US Eastern time** (EST/EDT handled automatically), whatever your computer's clock zone.
- Press `Esc` to dismiss the picker and keep what you typed.
- In open to-dos, overdue dates show **red** and today's show **green** — in the note and in the Tasks panel. `@date` also works in the **Add a task** box.

**Search** (`/` or `Ctrl+Shift+F`) matches note titles, note text, dates, tasks and folder names. Clicking a note result opens it with the match selected.

**Download** (gear → Download a copy…) saves a copy of everything — pick one:

| Option | You get |
| --- | --- |
| **Word document (.docx)** | One formatted document: a To-dos summary (open and completed, grouped by note, with due dates and details), then every note grouped by folder — headings, lists, checkboxes, tables, images, links, highlights, colours. Opens in Word, Google Docs or Pages. |
| **Markdown (.zip)** | One `.md` file per note in your folder structure, an `images/` folder, and `To-dos.md`. |
| **PDF (.pdf)** | A print-ready copy of the same content as the Word export, with page numbers. |
| **Database backup (.zip)** | An exact snapshot of `taskule.db` plus all images and a `RESTORE.txt`. Safe to take while the app is running. |

**Wipe database** (gear → Wipe database…) deletes everything after you type `delete`. A safety backup is always made first (no backup, no wipe), and image files are kept for 30 days so that backup can be restored with its pictures.

### Backups and restoring

Taskule backs itself up automatically to `data/backups/`: when the server starts (if the newest backup is over 12 hours old), once a day while it runs, and right before any wipe. Each backup is checked after it's written; the newest 20 are kept. The Download dialog shows when the last one ran, and you're alerted if a backup ever fails. **Download → Database backup** gives you a zip you can keep elsewhere.

To restore:
1. Quit the app (tray icon → Quit Taskule) and run `npm run stop`.
2. Rename `data/taskule.db` to `taskule-damaged.db` (keep it), and delete `taskule.db-wal` / `taskule.db-shm` if present.
3. Copy the backup you want (e.g. `data/backups/taskule-2026-11-20-090000-auto.db`, or `taskule.db` from a downloaded zip) to `data/taskule.db`. From a zip, also copy its `images/` into `data/images/`.
4. Start Taskule again.

### Shortcuts

The first group can be changed in **Settings**. These are the defaults.

| Key | Action |
| --- | --- |
| `Alt+N` | New note |
| `Alt+T` | Open the Tasks panel and start a new task |
| `Ctrl+]` | Show / hide the Tasks panel |
| `Ctrl+,` | Settings |
| `Alt+S` | Scratchpad (cursor on a new line, ready to type) |
| `Ctrl+Shift+M` | In the Scratchpad: move selected lines to a note |
| `Ctrl+\` | Show / hide the sidebar |
| — | Lock (no key unless you set one) |
| `Ctrl+Shift+F` | Search |
| **Always** | |
| `/` | Search (when you are not typing) |
| `@` | Insert menu (date, image, table, …) |
| `@date` … | Insert a date |
| `Ctrl+;` | Insert today's date |
| `Ctrl+Enter` | Check/uncheck the to-do at the cursor (or make the line a to-do) |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+U` | Bold / italic / underline |
| `Ctrl+Shift+S` | Strikethrough |
| `Ctrl+Shift+H` | Highlight |
| `Ctrl+Shift+V` | Paste as plain text |
| `Ctrl+E` | Inline code |
| `Ctrl+K` | Link (Ctrl+click a link to open it) |
| `Ctrl+Alt+1/2/3` | Heading 1/2/3 |
| `Ctrl+Shift+7/8/9` | Numbered / bulleted / to-do list |
| `Tab` / `Shift+Tab` | Indent / outdent list item |

## Development

The editor ([TipTap](https://tiptap.dev)) and the exporters ([docx](https://docx.js.org), [pdfmake](https://pdfmake.github.io), [fflate](https://github.com/101arrowz/fflate)) are pre-bundled into `public/vendor/`, so running the app needs no `npm install`. To change them:

```bash
npm install
npm run build
```

`npm test` runs the date-parser tests, the to-do helper tests (details, due dates, editing), and the server tests (task details and due dates, renaming a database from the app's earlier names, password setup and lock, Scratchpad rules, content validation, version conflicts, backups, wipe safety, damaged database and password file) against throwaway servers. Paste handling lives in `editor/src/paste.js`; `test/fixtures/gdocs-paste.html` is a sample Google Docs clipboard payload for checking it.

## Reliability and data safety

**You can't work in Taskule while it can't save.** The app checks the server every few seconds, and immediately whenever a save fails. If the server can't be reached, saving keeps failing, or the database reports a problem, the window is covered with a message saying what's wrong and editing is paused until it's fixed. When the server comes back, the cover lifts by itself and everything waiting is saved. The desktop app also restarts a missing server on its own.

- **Nothing typed is lost.** Every note edit is kept on this computer until the server confirms it's saved. If the app or browser closes while the server is down, those edits are restored (with a notice) the next time you open Taskule.
- **Problems are never quiet.** A save the server refuses, a conflict, or a failed backup shows a message that stays until you close it.
- **Two windows can't overwrite each other.** Each note has a version number. If a note was changed in another window or tab since this one loaded it, the save is refused instead of overwriting. Both texts are kept: the other version stays, and this window's edits are saved as a "(my copy …)" note next to it.
- **The database is protected.** SQLite runs in WAL mode with `synchronous=FULL`, so a change is on disk before it's reported saved, and it survives a crash or power cut. Every write is a transaction. Note content is checked to be a valid document before it's stored. All writes are idempotent, so retries can't duplicate anything.
- **Damage is caught, not spread.** The database's structure is checked at startup and every 6 hours. If a check fails, the server refuses all changes so a damaged file isn't made worse, the app shows "Your database needs attention", and no automatic backup is taken from it, so it can't push out good backups. Restore from `data/backups/` (above).
- **Automatic, verified backups** run daily, at startup and before a wipe (see [Backups](#backups-and-restoring)).
- **Images are never deleted early.** An image file is only removed after no note has used it for 30 days, so undo and restored backups still find their pictures.
- **The server keeps running.** An unexpected error in one request is logged to `data/server.log` and the server carries on. The auto-start launcher restarts the server if it stops.
- Note edits are sent ~0.4 s after you stop typing, and immediately on blur, navigation, tab switch or close.
- **Earlier names.** Taskule was called Jotcairn, and before that Actionbase. The first time the server starts after a rename, `data/jotcairn.db` (or `data/actionbase.db`) becomes `data/taskule.db`: pending writes are folded in first, and the file is renamed rather than copied. Older `jotcairn-*.db` and `actionbase-*.db` backups still count as backups. Browser-stored settings and unsaved-edit backups carry over, and the desktop app copies its settings from the old profile.
- Notes written with the earlier markdown editor are converted to rich text automatically the first time the app loads.
- The API rejects cross-origin requests, so other websites open in your browser can't touch your data.
- If the lock appears mid-edit (password changed, or a 30-day-old session), whatever you were saving waits behind the lock screen and is sent once you unlock. Nothing is dropped.
