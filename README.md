# Inkwell — your custom note-taking app

A fast, local, multi-user note app. Each person signs in and gets their own private
projects (folders) and notes (pages). Type with the keyboard, annotate with a
pen/stylus, drop in images, pick a page style (blank / ruled / grid), and switch
between light and dark themes. Everything is stored as plain files next to the app —
you own the data.

Built for a small group: **up to 10 user accounts**.

## How to start

You need **Node.js** installed (https://nodejs.org — the LTS installer). No other setup,
no database to install.

**Easiest:** double-click **`Start Inkwell.bat`** — it starts the server and opens the app.

**Or manually**, open a terminal in this folder and run:

```
node server.js
```

Then open http://localhost:4321.

## First run

1. The app opens to a **sign-in / create-account** page.
2. Click **Create account**, enter a name, email, and password (6+ characters).
3. You're in. Create a folder (＋ under "Folders"), then add a note.

Up to 10 accounts can be created on one instance. Others sign up the same way.

## Using it

- **Folders** (left): ＋ creates a project folder. Rename/delete on hover.
- **Notes**: select a folder, ＋ adds a note. Pick Blank / Ruled / Grid at the top.
- **Type** anywhere. `Ctrl+B / I / U` = bold / italic / underline. `Ctrl+S` saves now.
- **✒️ Pen** toggles stylus/mouse drawing: ink color, size, **🩹 Erase**, **↶ Undo**.
  Toggle Pen off to type again.
- **🖼️ Image** inserts a picture; you can also paste or drag-and-drop images.
- **Top bar**: 🌙 toggles dark mode; ⚙️ / your name opens **Settings** to edit your
  display name, change your password, switch theme, or log out.
- Saving is automatic ("Saved" shows in the toolbar).

## Where data lives

```
data/
  users.json              accounts (passwords are scrypt-hashed, never stored in plain text)
  .secret                 key used to sign login cookies — keep private
  u_<userId>/             one folder per user
    <project>/
      project.json
      notes/*.json        text + vector pen strokes
      assets/*            inserted images
```

Back up by copying the `data` folder. To move the app to another machine, copy the whole
folder (including `data`) and run `node server.js` there.

## Security notes (for a small trusted group)

- Passwords are hashed with scrypt; sessions are signed, HttpOnly cookies (30 days).
- This runs over plain HTTP on your local network. That's fine for personal use or a
  trusted LAN. If you ever expose it to the public internet, put it behind HTTPS
  (a reverse proxy like Caddy or nginx) first.
- Change the port with `PORT` (e.g. `set PORT=5000 && node server.js`).

## Scaling later
The file storage comfortably handles ~10 users. If you grow into a real hosted product,
the natural next steps are swapping file storage for Postgres and moving images to cloud
object storage — the API is structured so that's a contained change.
