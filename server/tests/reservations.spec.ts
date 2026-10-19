import { createHash } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { locksDir } from "../src/paths.js";
import { lockFilePath, makeReservationId, release, reserve } from "../src/reservations.js";
import { tmpDir } from "./helpers.js";

describe("reservations", () => {
  it("acquires an exclusive reservation and creates the lock file with O_EXCL semantics", async () => {
    const key = `/repo/project/demo/T1-${Date.now()}`;
    const id = makeReservationId();
    const res = await reserve(key, { id });
    expect(res).toEqual({ ok: true });

    const file = lockFilePath(key);
    expect(existsSync(file)).toBe(true);

    const record = JSON.parse(readFileSync(file, "utf8"));
    expect(record).toEqual({
      key,
      id,
      pid: process.pid,
      startedAt: expect.any(String),
    });

    // Cleanup
    expect(await release(key, id)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("rejects a second call for the same task with TASK_IN_FLIGHT and the holding id", async () => {
    const key = `/repo/project/demo/T2-${Date.now()}`;
    const id1 = makeReservationId();
    const id2 = makeReservationId();

    const r1 = await reserve(key, { id: id1 });
    expect(r1).toEqual({ ok: true });

    const r2 = await reserve(key, { id: id2 });
    expect(r2).toEqual({ ok: false, heldBy: id1 });

    // Release with wrong id does not release
    expect(await release(key, id2)).toBe(false);
    expect(existsSync(lockFilePath(key))).toBe(true);

    // Release with correct id releases
    expect(await release(key, id1)).toBe(true);
    expect(existsSync(lockFilePath(key))).toBe(false);
  });

  it("different keys can be reserved simultaneously without conflict", async () => {
    const key1 = `/repo/project/demo/T1-${Date.now()}`;
    const key2 = `/repo/project/demo/T2-${Date.now()}`;
    const id1 = makeReservationId();
    const id2 = makeReservationId();

    expect(await reserve(key1, { id: id1 })).toEqual({ ok: true });
    expect(await reserve(key2, { id: id2 })).toEqual({ ok: true });

    await release(key1, id1);
    await release(key2, id2);
  });

  it("replaces an orphan lock when its PID is dead, returning a note", async () => {
    const key = `/repo/project/demo/T3-${Date.now()}`;
    const file = lockFilePath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });

    const orphanRecord = {
      key,
      id: "orphan-dead-pid",
      pid: 99999999,
      startedAt: new Date().toISOString(),
    };
    await fs.writeFile(file, JSON.stringify(orphanRecord, null, 2), "utf8");

    const id = makeReservationId();
    const res = await reserve(key, { id });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.note).toMatch(/orphan|huérfano/i);
      expect(res.note).toContain("orphan-dead-pid");
    }

    const currentRecord = JSON.parse(readFileSync(file, "utf8"));
    expect(currentRecord.id).toBe(id);
    expect(currentRecord.pid).toBe(process.pid);

    await release(key, id);
  });

  it("replaces an orphan lock when its PID is alive but older than maxAgeMs (injected clock), returning a note", async () => {
    const key = `/repo/project/demo/T4-${Date.now()}`;
    const file = lockFilePath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });

    const pastTime = 1_000_000;
    const maxAgeMs = 5_000;
    const orphanRecord = {
      key,
      id: "orphan-timed-out",
      pid: process.pid, // current PID is alive!
      startedAt: new Date(pastTime).toISOString(),
    };
    await fs.writeFile(file, JSON.stringify(orphanRecord, null, 2), "utf8");

    const id = makeReservationId();
    // Injected now: 20 seconds later (> 5s maxAgeMs)
    const now = pastTime + 20_000;
    const res = await reserve(key, { id, maxAgeMs, now });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.note).toMatch(/orphan|huérfano/i);
      expect(res.note).toContain("orphan-timed-out");
    }

    const currentRecord = JSON.parse(readFileSync(file, "utf8"));
    expect(currentRecord.id).toBe(id);

    await release(key, id);
  });

  it("release with a different id does not delete the lock file", async () => {
    const key = `/repo/project/demo/T5-${Date.now()}`;
    const id = makeReservationId();
    await reserve(key, { id });

    expect(await release(key, "wrong-id")).toBe(false);
    expect(existsSync(lockFilePath(key))).toBe(true);

    expect(await release(key, id)).toBe(true);
    expect(existsSync(lockFilePath(key))).toBe(false);
  });
  it("lets only one of two concurrent callers take over the same orphan lock", async () => {
    const key = `/repo/project/demo/race-${Date.now()}`;
    const file = lockFilePath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ key, id: "dead", pid: 2 ** 22 + 12345, startedAt: new Date().toISOString() }));
    const [a, b] = await Promise.all([reserve(key, { id: "a" }), reserve(key, { id: "b" })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const winner = a.ok ? "a" : "b";
    expect(JSON.parse(readFileSync(file, "utf8")).id).toBe(winner);
    expect(await release(key, winner)).toBe(true);
  });
});
