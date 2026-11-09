# 08 - HTTP Headers

## What is it?
An HTTP request has two parts: the **body** (the payload) and the **headers**. Headers are labelled pieces of information *about* the request, written as `Name: value`.

## Why is it important?
- `Content-Type` tells the server how to read the body. Without `application/json`, `express.json()` ignores the body and `req.body` will not hold your data.
- `User-Agent` tells you what kind of client sent the request.
- Real webhook senders often add headers used to prove a request is genuine (signature headers). We do **not** validate signatures yet. That comes in a later lesson.
- Headers can contain sensitive values (authorization tokens, signatures), so you should be careful what you print.

## How it works
Express exposes headers as an object, `req.headers`. Names are always **lower-case**.

```js
req.headers['content-type'];  // "application/json"
req.headers['user-agent'];    // e.g. "PostmanRuntime/7.x"
```
Use square brackets because `content-type` contains a hyphen and can't be written as `req.headers.content-type`.

Common headers:

| Header | Meaning |
|---|---|
| `Content-Type` | Format of the body (`application/json`). |
| `User-Agent` | Software that sent the request. |
| `Host` | Server and port being called. |
| `Content-Length` | Size of the body in bytes. |

## How we implemented it
Two routes handle headers differently on purpose:

- `/webhooks/test` (Lesson 2) prints headers, but since Lesson 19 sensitive ones (authorization, cookies, signatures, tokens, keys) show as `[REDACTED]`, and the route only works locally (see docs/19).
- `/webhooks/simulate` (Lesson 3) prints **only two** harmless headers:

```js
console.log('Content-Type:', req.headers['content-type']);
console.log('User-Agent:', req.headers['user-agent']);
```
This is a safer habit: choose what to log instead of dumping everything.

## Testing with Postman
1. `POST http://localhost:3000/webhooks/simulate` with a valid JSON array (see doc 07) and Body set to raw > JSON.
2. In the terminal you should see:
```
Content-Type: application/json
User-Agent: PostmanRuntime/...
```
No other headers are printed.
3. Compare: send any JSON object to `/webhooks/test` and notice that it prints the header list, with sensitive values replaced by `[REDACTED]`.
4. Experiment: in Postman's **Headers** tab, temporarily set `Content-Type` to `text/plain` for a request to `/webhooks/simulate`. `express.json()` will skip the body, so the server answers 400 "Payload must be a JSON array of events." (`req.body` is not an array). Set it back to `application/json` afterwards.
