import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ReplayArtifact,
  ReplayFile,
  ReplayStore,
} from "../application/contracts.js";

const SAFE_PART = /^[A-Za-z0-9._-]+$/;

function safePart(value: string, label: string): string {
  if (!SAFE_PART.test(value)) throw new Error(`invalid replay ${label}`);
  return value;
}

function contentTypeForReplayPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (lower.endsWith(".m4s")) return "video/iso.segment";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".ts")) return "video/mp2t";
  return "application/octet-stream";
}

function normalizedFilePath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  if (!normalized || normalized.includes("/") || normalized === "." || normalized === "..") {
    throw new Error("invalid replay file path");
  }
  return safePart(normalized, "file path");
}

/**
 * Stores replay manifests and media segments on the Fly volume. The manifest
 * is written last, so a partially downloaded replay is never advertised as
 * ready.
 */
export class FileReplayStore implements ReplayStore {
  readonly root: string;

  constructor(root: string) {
    if (!root) throw new Error("Replay directory is required");
    this.root = resolve(root);
  }

  async put(raceId: string, racerId: string, artifact: ReplayArtifact): Promise<void> {
    if (typeof artifact.playlist !== "string" || !artifact.playlist.includes("#EXTM3U")) {
      throw new Error("replay playlist is invalid");
    }
    const directory = join(this.root, safePart(raceId, "race id"), safePart(racerId, "racer id"));
    const temporary = `${directory}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(temporary, { recursive: true });
    try {
      const seen = new Set<string>();
      for (const file of artifact.files) {
        const path = normalizedFilePath(file.path);
        if (seen.has(path)) continue;
        seen.add(path);
        if (!(file.body instanceof Uint8Array)) throw new Error(`replay file body is invalid: ${path}`);
        await writeFile(join(temporary, path), file.body);
      }
      await writeFile(join(temporary, "playlist.m3u8"), artifact.playlist, "utf8");
      await rm(directory, { recursive: true, force: true });
      await mkdir(this.root, { recursive: true });
      await rename(temporary, directory);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async playlist(raceId: string, racerId: string): Promise<string | null> {
    try {
      return await readFile(
        join(this.root, safePart(raceId, "race id"), safePart(racerId, "racer id"), "playlist.m3u8"),
        "utf8",
      );
    } catch {
      return null;
    }
  }

  async file(raceId: string, racerId: string, path: string): Promise<ReplayFile | null> {
    const safePath = normalizedFilePath(path);
    try {
      const body = await readFile(
        join(this.root, safePart(raceId, "race id"), safePart(racerId, "racer id"), safePath),
      );
      return { path: safePath, contentType: contentTypeForReplayPath(safePath), body };
    } catch {
      return null;
    }
  }

  async removeRace(raceId: string): Promise<void> {
    await rm(join(this.root, safePart(raceId, "race id")), { recursive: true, force: true });
  }
}

/** Small in-memory implementation for application and route tests. */
export class InMemoryReplayStore implements ReplayStore {
  private readonly replays = new Map<string, ReplayArtifact>();

  async put(raceId: string, racerId: string, artifact: ReplayArtifact): Promise<void> {
    this.replays.set(`${raceId}/${racerId}`, {
      playlist: artifact.playlist,
      files: artifact.files.map((file) => ({ ...file, body: Buffer.from(file.body) })),
    });
  }

  async playlist(raceId: string, racerId: string): Promise<string | null> {
    return this.replays.get(`${raceId}/${racerId}`)?.playlist ?? null;
  }

  async file(raceId: string, racerId: string, path: string): Promise<ReplayFile | null> {
    const file = this.replays.get(`${raceId}/${racerId}`)?.files.find((entry) => entry.path === path);
    return file ? { ...file, body: Buffer.from(file.body) } : null;
  }

  async removeRace(raceId: string): Promise<void> {
    for (const key of this.replays.keys()) {
      if (key.startsWith(`${raceId}/`)) this.replays.delete(key);
    }
  }
}
