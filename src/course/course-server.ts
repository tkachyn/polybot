import Fastify, { type FastifyInstance } from "fastify";
import type { CourseState } from "./deterministic-course-verifier.js";

type CourseKey = {
  raceId: string;
  racerId: string;
  courseId: string;
};

type StoredCourseState = CourseState & {
  checkpointCount: number;
};

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error(`${name} must be an integer between 1 and 20`);
  }
  return parsed;
}

function stateKey(input: CourseKey): string {
  return `${input.raceId}\u0000${input.racerId}\u0000${input.courseId}`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function renderCourse(state: StoredCourseState): string {
  const nextCheckpoint = state.completedCheckpoints.length + 1;
  const canFinish = nextCheckpoint > state.checkpointCount;
  const action = state.finished
    ? '<p class="complete">Course complete. Report finish to the arena.</p>'
    : canFinish
      ? '<button data-arena-role="primary-action" id="finish">Finish course</button>'
      : `<button data-arena-role="primary-action" id="checkpoint">Complete checkpoint ${nextCheckpoint}</button>`;
  const clientState = safeJson({
    raceId: state.raceId,
    racerId: state.racerId,
    courseId: state.courseId,
    checkpoint: nextCheckpoint,
    canFinish,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Browser Agent Arena Course</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #10131a; color: #f5f7fb; }
    main { width: min(560px, calc(100% - 48px)); padding: 40px; border: 1px solid #30394b; border-radius: 20px; background: #181d27; }
    h1 { margin-top: 0; }
    p { color: #bdc6d8; line-height: 1.55; }
    button { width: 100%; margin-top: 20px; padding: 16px 20px; border: 0; border-radius: 12px; background: #76a7ff; color: #08111f; font: inherit; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    .complete { color: #83e6aa; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>Deterministic test course</h1>
    <p>Complete each checkpoint in order. After activating a checkpoint, report that checkpoint to the arena before continuing. Report finish only after the course confirms completion.</p>
    <p>Progress: ${state.completedCheckpoints.length} of ${state.checkpointCount} checkpoints</p>
    ${action}
  </main>
  <script>
    const state = ${clientState};
    const button = document.querySelector("button");
    button?.addEventListener("click", async () => {
      button.disabled = true;
      const path = state.canFinish ? "/arena/finish" : "/arena/checkpoint";
      const body = state.canFinish ? state : { ...state, checkpoint: state.checkpoint };
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        button.disabled = false;
        throw new Error(await response.text());
      }
      location.reload();
    });
  </script>
</body>
</html>`;
}

export function buildCourseApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  const states = new Map<string, StoredCourseState>();

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    void reply.status(400).send({ error: message });
  });

  app.get<{ Querystring: Partial<CourseKey> & { checkpointCount?: string } }>(
    "/",
    async (request, reply) => {
      const identity: CourseKey = {
        raceId: requireString(request.query.raceId, "raceId"),
        racerId: requireString(request.query.racerId, "racerId"),
        courseId: requireString(request.query.courseId, "courseId"),
      };
      const checkpointCount = positiveInteger(
        request.query.checkpointCount,
        "checkpointCount",
      );
      const key = stateKey(identity);
      let state = states.get(key);
      if (!state) {
        state = {
          ...identity,
          checkpointCount,
          completedCheckpoints: [],
          finished: false,
        };
        states.set(key, state);
      }
      return reply.type("text/html; charset=utf-8").send(renderCourse(state));
    },
  );

  app.get<{ Querystring: Partial<CourseKey> }>("/arena/state", async (request) => {
    const identity: CourseKey = {
      raceId: requireString(request.query.raceId, "raceId"),
      racerId: requireString(request.query.racerId, "racerId"),
      courseId: requireString(request.query.courseId, "courseId"),
    };
    const state = states.get(stateKey(identity));
    if (!state) return { ...identity, completedCheckpoints: [], finished: false };
    return {
      raceId: state.raceId,
      racerId: state.racerId,
      courseId: state.courseId,
      completedCheckpoints: [...state.completedCheckpoints],
      finished: state.finished,
    };
  });

  app.post<{ Body: Partial<CourseKey> & { checkpoint?: number } }>(
    "/arena/checkpoint",
    async (request) => {
      const identity: CourseKey = {
        raceId: requireString(request.body?.raceId, "raceId"),
        racerId: requireString(request.body?.racerId, "racerId"),
        courseId: requireString(request.body?.courseId, "courseId"),
      };
      const checkpoint = positiveInteger(request.body?.checkpoint, "checkpoint");
      const state = states.get(stateKey(identity));
      if (!state) throw new Error("Course run was not initialized");
      const expected = state.completedCheckpoints.length + 1;
      if (checkpoint !== expected || checkpoint > state.checkpointCount) {
        throw new Error(`Expected checkpoint ${expected}`);
      }
      state.completedCheckpoints.push(checkpoint);
      return { ok: true, checkpoint };
    },
  );

  app.post<{ Body: Partial<CourseKey> }>("/arena/finish", async (request) => {
    const identity: CourseKey = {
      raceId: requireString(request.body?.raceId, "raceId"),
      racerId: requireString(request.body?.racerId, "racerId"),
      courseId: requireString(request.body?.courseId, "courseId"),
    };
    const state = states.get(stateKey(identity));
    if (!state) throw new Error("Course run was not initialized");
    if (state.completedCheckpoints.length !== state.checkpointCount) {
      throw new Error("All checkpoints must be completed before finishing");
    }
    state.finished = true;
    return { ok: true, finished: true };
  });

  return app;
}
