/**
 * How a replay fight names the recording behind it. Kept apart from the
 * factory so the library can recognise a replay without importing the
 * coordinator it builds.
 */

/** Course id prefix that marks a fight as a replay of a recorded one. */
export const REPLAY_COURSE_PREFIX = "replay:";

/** The course id a replay of `sourceRaceId` runs under. */
export function replayCourseId(sourceRaceId: string): string {
  return `${REPLAY_COURSE_PREFIX}${sourceRaceId}`;
}

/** The recorded fight a replay course id names, or null for any other course. */
export function sourceRaceIdOf(courseId: string): string | null {
  return courseId.startsWith(REPLAY_COURSE_PREFIX)
    ? courseId.slice(REPLAY_COURSE_PREFIX.length)
    : null;
}

/** True for an input that should be replayed rather than run for real. */
export function isReplayInput(input: { courseId: string }): boolean {
  return sourceRaceIdOf(input.courseId) !== null;
}
