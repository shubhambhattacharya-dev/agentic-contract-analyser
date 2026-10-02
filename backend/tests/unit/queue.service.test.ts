import { describe, expect, it, vi } from "vitest";

import {
  IngestQueue,
  type IngestJob,
} from "../../src/services/ingestion/queue.service.js";

function makeJob(overrides: Partial<IngestJob> = {}): IngestJob {
  return {
    documentId: "doc-1",
    sessionId: "sess-1",
    buffer: Buffer.from("job"),
    originalName: "contract.pdf",
    mimeType: "application/pdf",
    size: 3,
    fileUrl: "local://documents/contract.pdf.pdf",
    filePathname: "documents/contract.pdf.pdf",
    ...overrides,
  };
}

function makeFailureSpy() {
  return vi.fn(async (_job: IngestJob, _reason: string) => undefined);
}

describe("IngestQueue", () => {
  it("processes jobs FIFO and serially, then idle() resolves", async () => {
    const events: string[] = [];
    const failure = makeFailureSpy();

    const executor = vi.fn(async (job: IngestJob) => {
      events.push(`start:${job.documentId}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end:${job.documentId}`);
    });

    const queue = new IngestQueue(executor, 5_000, failure);

    queue.enqueue(makeJob({ documentId: "a" }));
    queue.enqueue(makeJob({ documentId: "b" }));
    queue.enqueue(makeJob({ documentId: "c" }));

    await queue.idle();

    expect(events).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
    expect(executor).toHaveBeenCalledTimes(3);
    expect(failure).not.toHaveBeenCalled();
  });

  it("marks a job failed when the executor rejects, and keeps processing", async () => {
    const processed: string[] = [];
    const failure = makeFailureSpy();

    const executor = vi.fn(async (job: IngestJob) => {
      if (job.documentId === "bad") {
        throw new Error("extraction exploded");
      }

      processed.push(job.documentId);
    });

    const queue = new IngestQueue(executor, 5_000, failure);

    queue.enqueue(makeJob({ documentId: "bad" }));
    queue.enqueue(makeJob({ documentId: "good" }));

    await queue.idle();

    expect(processed).toEqual(["good"]);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0]?.[0].documentId).toBe("bad");
    expect(failure.mock.calls[0]?.[1]).toContain("extraction exploded");
  });

  it("marks a job failed on the hard timeout backstop", async () => {
    const failure = makeFailureSpy();

    const executor = vi.fn(async (job: IngestJob) => {
      if (job.documentId === "hangs") {
        // Never resolves — the timeout must reclaim the slot.
        await new Promise(() => undefined);
      }
    });

    const queue = new IngestQueue(executor, 50, failure);

    queue.enqueue(makeJob({ documentId: "hangs" }));
    queue.enqueue(makeJob({ documentId: "after" }));

    await queue.idle();

    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0]?.[0].documentId).toBe("hangs");
    expect(failure.mock.calls[0]?.[1]).toMatch(/timeout/i);
    expect(executor.mock.calls.map(([job]) => job.documentId)).toEqual([
      "hangs",
      "after",
    ]);
  });

  it("survives a failing failure handler without breaking the drain loop", async () => {
    const failure = vi.fn(async () => {
      throw new Error("redis down while failing the job");
    });

    const processed: string[] = [];

    const executor = vi.fn(async (job: IngestJob) => {
      if (job.documentId === "bad") {
        throw new Error("boom");
      }

      processed.push(job.documentId);
    });

    const queue = new IngestQueue(executor, 5_000, failure);

    queue.enqueue(makeJob({ documentId: "bad" }));
    queue.enqueue(makeJob({ documentId: "after" }));

    await queue.idle();

    expect(processed).toEqual(["after"]);
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it("reports depth and the active document", async () => {
    const release: (() => void)[] = [];

    const executor = vi.fn(async () => {
      await new Promise<void>((resolve) => release.push(resolve));
    });

    const queue = new IngestQueue(executor, 5_000, makeFailureSpy());

    queue.enqueue(makeJob({ documentId: "first" }));
    queue.enqueue(makeJob({ documentId: "second" }));

    // Give the drain loop a tick to pick up the first job.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queue.activeDocumentId).toBe("first");
    expect(queue.depth).toBe(1);

    release[0]?.();

    await queue.idle();

    expect(queue.activeDocumentId).toBeNull();
    expect(queue.depth).toBe(0);
  });
});
