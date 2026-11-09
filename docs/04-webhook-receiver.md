# 04 - Webhook Receiver

## What is it?
A **webhook** is an automatic HTTP POST request one system sends to another when something happens (for example, "a contact was created"). The request body usually contains JSON describing the event. A **webhook receiver** is the endpoint that accepts it. Ours is `POST /webhooks/test`.

## Why do we need it?
This is the core of the project. Before connecting a real service, we want to see exactly what a webhook request looks like: its method, headers, and JSON body.

## How it works
1. The sender POSTs JSON to `http://localhost:3000/webhooks/test`.
2. `express.json()` (doc 02) parses the body into `req.body`.
3. Our handler prints the details to the terminal.
4. We reply with HTTP 200 so the sender knows we received it. Real webhook senders often retry if they don't get a 2xx quickly.

## How we implemented it
```js
app.post('/webhooks/test', (req, res) => {
  console.log('\n=== Webhook received ===');
  console.log('Method:', req.method);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Payload:', JSON.stringify(req.body, null, 2));

  res.status(200).json({
    status: 'success',
    message: 'Webhook received.',
  });
});
```

### Code explained
- `app.post(path, handler)`: handles only POST requests.
- `req.method`: the HTTP method (`POST`).
- `req.headers`: an object of all request headers (`content-type`, `user-agent`, ...).
- `req.body`: the parsed JSON payload.
- `JSON.stringify(value, null, 2)`: turns an object into readable, 2-space-indented text.

## Testing it
```bash
curl -X POST http://localhost:3000/webhooks/test \
  -H "Content-Type: application/json" \
  -d '{"event":"contact.created","id":123}'
```
(On Windows PowerShell use Postman instead; see doc 06. PowerShell quoting of JSON is awkward.)

Response (HTTP 200):
```json
{
  "status": "success",
  "message": "Webhook received."
}
```

Terminal output (headers vary by client):
```
=== Webhook received ===
Method: POST
Headers: {
  "content-type": "application/json",
  "host": "localhost:3000",
  ...
}
Payload: {
  "event": "contact.created",
  "id": 123
}
```

Note: the request must have the header `Content-Type: application/json`, otherwise `req.body` will not be parsed.
