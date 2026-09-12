# Steel browser and live-view handoff

This is the implementation contract for future agents adding browser
controls or live browser viewing. Steel credentials and browser handles stay
inside the backend.

## Fight live view

`GET /api/fights/:raceId` and the fight SSE stream return
`fight.agents[].browserView`:

```ts
{
  status: "pending" | "live" | "released" | "unavailable";
  viewerUrl: string | null;
}
```

Completion is verifier-backed: the runner invokes the course adapter after
each browser action, so a site-specific verifier can finish the racer as soon
as the success state is proven. Keep the model's explicit `finish` decision as
a fallback. Ordered sabotage state is available at
`fight.sabotage.steps`; each step has its checkpoint, preset id, state,
timestamps, and hit racers.

The initial preset catalog is `shift-primary-action`, `plant-decoy-control`,
`disable-primary-action`, `rename-primary-action`, and `cover-with-modal`.
Future site adapters should keep the same semantic target-role contract and
add site-specific presets only through the bounded server-side catalog.

For a live Steel fight, render `viewerUrl` in an iframe:

```tsx
<iframe
  src={agent.browserView.viewerUrl ?? undefined}
  title={`${agent.agent.name} live browser`}
  allow="autoplay; fullscreen"
  style={{ pointerEvents: "none" }}
/>
```

The backend creates the viewer URL with `interactive=false` and
`showControls=false`. Keep `pointer-events: none` in the frontend too. Never
add `interactive=true`, expose the CDP websocket URL, or send a Steel API key
to the browser.

The existing frame endpoint remains required:

```text
GET /api/fights/:raceId/agents/:racerId/frame?seq=N
```

Use it for simulated races, pending/unavailable viewer states, and any viewer
load failure. Do not reset an iframe `src` on every SSE update; only change it
when the viewer URL changes.

## Operator browser-session lifecycle

These routes are backend-owned operator capabilities, not spectator routes:

```text
POST   /api/browser-sessions
       body: { "url": "https://example.com" }
       -> { sessionId, status, viewerUrl, pageUrl, pageTitle, createdAt, updatedAt }

GET    /api/browser-sessions/:sessionId
       -> current status and page metadata

POST   /api/browser-sessions/:sessionId/navigate
       body: { "url": "https://example.com/next" }
       -> current status and page metadata

DELETE /api/browser-sessions/:sessionId
       -> released status; closes Playwright and releases Steel
```

The service validates HTTP(S) URLs, owns the Steel session, and releases
sessions on explicit delete and API shutdown. Navigation happens through
backend Playwright; the frontend should never navigate the iframe or control
the browser directly.

## Security and ownership

The current Fastify server has no application authentication. Before exposing
`/api/browser-sessions` or operator race routes publicly:

1. Add authentication and authorize the session owner on every route.
2. Do not return `websocketUrl`, CDP connection details, API keys, or
   Playwright objects.
3. Treat `viewerUrl` as a bearer capability and only return it to an
   authorized owner or spectator policy.
4. Release sessions when an owner closes a run, when a race resolves, and on
   process shutdown.
5. Keep a server-side timeout and an ownership record if sessions outlive one
   HTTP request.

When modifying this flow, update `src/api/dto.ts`,
`src/api/presenters.ts`, `docs/frontend-contract.md`, and the corresponding
backend/frontend tests together.
