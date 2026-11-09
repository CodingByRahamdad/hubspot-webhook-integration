# 06 - Testing with Postman

## What is it?
Postman is a desktop app for sending HTTP requests and viewing responses. It lets us act as the webhook sender.

## Why do we need it?
A browser can only easily send GET requests. Postman lets us send POST requests with JSON bodies and custom headers, exactly like a real webhook.

## How it works
You choose a method and URL, optionally add a body, click **Send**, and Postman shows the status code and response. Meanwhile, your server's terminal shows what it received.

## Setup
1. Start the server: `npm run dev`
2. Open Postman and create a new request (**New > HTTP**).

## Test 1: Health check
- Method: `GET`
- URL: `http://localhost:3000/health`
- Click **Send**.
- Expect: status `200 OK` and
```json
{ "status": "success", "message": "Webhook server is running." }
```

## Test 2: Valid webhook
- Method: `POST`
- URL: `http://localhost:3000/webhooks/test`
- Tab **Body** > choose **raw** > choose **JSON** in the dropdown. (This also sets `Content-Type: application/json`.)
- Body:
```json
{
  "event": "contact.created",
  "id": 123,
  "email": "test@example.com"
}
```
- Click **Send**.
- Expect: `200 OK` and `{ "status": "success", "message": "Webhook received." }`.
- Check your **server terminal**: it should print the method, headers, and payload.

## Test 3: Invalid JSON
- Same request as Test 2, but change the body to `{ "event": ` (broken).
- Expect: `400 Bad Request` and `{ "status": "error", "message": "Invalid JSON payload." }`.

## Test 4: Unknown route
- Method: `GET`, URL: `http://localhost:3000/nope`.
- Expect: `404 Not Found` and `{ "status": "error", "message": "Route not found: GET /nope" }`.

## Troubleshooting
| Problem | Likely cause |
|---|---|
| "Could not get any response" | Server not running, or wrong port. |
| Body is empty in terminal | Body type not set to raw + JSON. |
| `EADDRINUSE` on start | Port 3000 already used by another program. |
