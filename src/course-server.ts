import "dotenv/config";
import { buildCourseApp } from "./course/course-server.js";

const port = Number(process.env.COURSE_PORT ?? 4000);
const host = process.env.COURSE_HOST ?? "127.0.0.1";
const app = buildCourseApp();

await app.listen({ port, host });
