# 01 - Project Setup

## What is it?
A Node.js project is a folder with a `package.json` file. That file describes your project: its name, the packages it uses (dependencies), and shortcut commands (scripts).

## Why do we need it?
- `package.json` lets anyone run `npm install` and get the exact packages your project needs.
- Scripts give us short commands like `npm run dev`.
- `.gitignore` keeps junk and secrets out of Git.

## How it works
`npm` (Node Package Manager) downloads packages from the internet into a `node_modules/` folder and records them in `package.json`. Packages come in two kinds:
- **dependencies**: needed when the app runs (Express).
- **devDependencies**: only needed while developing (Nodemon).

## How we implemented it
Commands run from the project root:

```bash
npm init -y
npm install express
npm install --save-dev nodemon
```

| Command | What it does |
|---|---|
| `npm init -y` | Creates `package.json` with default answers (`-y` = "yes to everything"). |
| `npm install express` | Downloads Express and adds it to `dependencies`. |
| `npm install --save-dev nodemon` | Downloads Nodemon and adds it to `devDependencies`. |

We then edited `package.json` to set `"main": "src/server.js"` and add scripts.

### Final `package.json` (important parts)
```json
{
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js"
  },
  "type": "commonjs",
  "dependencies": { "express": "^5.3.0" },
  "devDependencies": { "nodemon": "^3.1.14" }
}
```

- `start`: runs the server once with plain Node. Use this in production.
- `dev`: runs the server with Nodemon, which restarts automatically when you save a file.
- `"type": "commonjs"`: we use `require(...)` (not `import`).

### `.gitignore`
```
node_modules
.env
```
- `node_modules` is huge and can be recreated with `npm install`.
- `.env` will later hold secrets (API keys), which must never be committed.

### Files and their purpose
| File | Purpose |
|---|---|
| `package.json` | Project description, dependencies, scripts. |
| `package-lock.json` | Auto-generated; locks exact package versions. |
| `src/server.js` | The Express server (see doc 02). |
| `.gitignore` | Files Git should ignore. |
| `docs/` | These learning notes. |

## Testing it
```bash
npm run dev
```
You should see `Webhook server listening on http://localhost:3000`. Stop it with `Ctrl + C`.
