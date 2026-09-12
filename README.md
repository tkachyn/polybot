# Browser Agent Arena Backend

Backend foundation for a four-racer browser-agent race. The current milestone is a dependency-light TypeScript race engine with:

- Four independent racer state machines
- Readiness barrier and simultaneous start
- Semantic checkpoint progression
- Per-racer checkpoint idempotency
- Three-minute target duration
- Hazard freeze at the target duration
- Five-minute absolute safety cap
- Deterministic winner selection
- A no-op obstacle provider for obstacle-free development

## Development

```bash
npm install
npm test
npm run build
```

Steel session management, competitor agent workers, CDP obstacles, and the prediction-market module will be added in later milestones.
