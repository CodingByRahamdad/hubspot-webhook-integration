# 05 - Error Handling

## What is it?
Error handling means deciding what the server does when something goes wrong: a bad request, an unknown URL, or a bug in our code.

## Why do we need it?
Without it, Express sends back a default HTML error page, which is confusing for API clients and may leak details. We want clear JSON errors and the right status codes.

## How it works
- **404 handler**: a normal middleware placed *after* all routes. If no route matched, the request falls through to it.
- **Error-handling middleware**: Express recognises it by its **four** parameters `(err, req, res, next)`. When any earlier code throws or passes an error, Express skips to this function. It must come last.
- When the body is not valid JSON, `express.json()` raises an error whose `type` is `'entity.parse.failed'`.

## How we implemented it
```js
// 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// Error handler
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid JSON payload.',
    });
  }

  console.error('Unexpected error:', err);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error.',
  });
});
```

### Code explained
- `400 Bad Request`: the client sent something invalid (broken JSON). It's the client's fault.
- `404 Not Found`: the URL doesn't exist.
- `500 Internal Server Error`: an unexpected bug on our side. We log the full error in the terminal but send only a generic message to the client.
- `next` is unused but must be declared, otherwise Express won't treat the function as an error handler.

## Testing it
Invalid JSON (note the broken body):
```bash
curl -X POST http://localhost:3000/webhooks/test \
  -H "Content-Type: application/json" \
  -d '{bad json'
```
Response (HTTP 400):
```json
{ "status": "error", "message": "Invalid JSON payload." }
```

Unknown route:
```bash
curl http://localhost:3000/nope
```
Response (HTTP 404):
```json
{ "status": "error", "message": "Route not found: GET /nope" }
```
