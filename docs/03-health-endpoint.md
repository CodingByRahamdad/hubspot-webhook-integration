# 03 - Health Endpoint

## What is it?
A **health endpoint** is a simple URL that answers "is the server alive?". Ours is `GET /health`.

## Why do we need it?
- Quick manual check that the server started correctly.
- Monitoring tools and hosting platforms commonly ping such a URL to see if your app is up.
- It is the easiest endpoint to test first, before dealing with webhook payloads.

## How it works
A **route** connects an HTTP method (`GET`) and a path (`/health`) to a function. When a matching request arrives, Express calls that function with:
- `req`: the incoming request.
- `res`: the response we send back.

## How we implemented it
```js
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Webhook server is running.',
  });
});
```

### Code explained
- `app.get(path, handler)`: handles only GET requests to that path.
- `res.status(200)`: sets the HTTP status code (200 = OK).
- `.json({...})`: converts the object to JSON and sends it with the right `Content-Type` header.

## Testing it
Browser: open `http://localhost:3000/health`.

Terminal:
```bash
curl http://localhost:3000/health
```

Response (HTTP 200):
```json
{
  "status": "success",
  "message": "Webhook server is running."
}
```
