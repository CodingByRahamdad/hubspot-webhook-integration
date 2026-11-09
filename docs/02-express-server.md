# 02 - Express Server

## What is it?
Express is a small Node.js library for building web servers. A server waits for HTTP requests (from a browser, Postman, or another service like HubSpot) and sends back responses.

## Why do we need it?
A webhook is just another service sending an HTTP POST request to a URL you own. To receive it, we need a server listening at that URL.

## How it works
1. The server starts and listens on a **port** (like a numbered door on your computer, here `3000`).
2. A request arrives, e.g. `GET /health`.
3. Express passes it through **middleware** (functions that run in order), then to the matching **route**.
4. The route sends a response.

Order matters: Express checks middleware and routes from top to bottom of the file.

## How we implemented it
Top of [src/server.js](../src/server.js):

```js
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
```

At the bottom:
```js
app.listen(PORT, () => {
  console.log(`Webhook server listening on http://localhost:${PORT}`);
});
```

### Code explained
- `require('express')`: loads the Express library (CommonJS style).
- `express()`: creates the app object; all routes attach to it.
- `process.env.PORT || 3000`: use the `PORT` environment variable if set, otherwise 3000.
- `app.use(express.json())`: middleware that reads the request body, and if it is JSON, converts it into a JavaScript object available as `req.body`. Without it, `req.body` would be `undefined`.
- `app.listen(PORT, callback)`: starts the server; the callback runs once it is ready.

## Testing it
```bash
npm run dev
```
Expected terminal output:
```
Webhook server listening on http://localhost:3000
```
If you see `EADDRINUSE`, something else already uses port 3000. Stop it, or run with another port (PowerShell: `$env:PORT=4000; npm run dev`).
