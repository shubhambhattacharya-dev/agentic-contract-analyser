import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import type { SupportedDocumentMimeType } from "../../types/document.types.js";
import {
  markIngestionFailed,
  processIngestionJob,
} from "./ingest.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-process ingestion queue
// ─────────────────────────────────────────────────────────────────────────────
//
// Uploads return 202 immediately; the heavy pipeline (extract → chunk →
// BM25 → embeddings → persist) runs here, one document at a time.
//
// Deliberate scope: a single web service (Render free tier) has no separate
// worker process and no broker, so the queue lives in memory. Consequences
// that are accepted and handled:
//
// - Jobs enqueued but not started are lost on restart → boot recovery
//   (recoverInterruptedIngestions) marks their documents failed and cleans up.
// - No retry: a failed job surfaces as status "failed" with a reason and the
//   document is removed from the library (the user re-uploads).
// - Concurrency 1 keeps the free Gemini embedding tier inside its rate limit.

export interface IngestJob {
  documentId: string;
  sessionId: string;
  buffer: Buffer;
  originalName: string;
  mimeType: SupportedDocumentMimeType;
  size: number;
  fileUrl: string;
  filePathname: string;
}

export type IngestJobExecutor = (job: IngestJob) => Promise<void>;

export type IngestJobFailureHandler = (
  job: IngestJob,
  reason: string,
) => Promise<void>;

export class IngestQueue {
  private waiting: IngestJob[] = [];
  private running = false;
  private currentDocumentId: string | null = null;
  private idleResolvers: (() => void)[] = [];

  constructor(
    private readonly executor: IngestJobExecutor,
    private readonly timeoutMs: number,
    private readonly onFailure: IngestJobFailureHandler = (job, reason) =>
      markIngestionFailed(job.sessionId, job.documentId, job.fileUrl, reason),
  ) {}

  enqueue(job: IngestJob): void {
    this.waiting.push(job);

    logger.info(
      {
        documentId: job.documentId,
        sessionId: job.sessionId,
        depth: this.waiting.length,
      },
      "Ingestion job queued.",
    );

    void this.drain();
  }

  /** Resolves once every queued and running job has settled (tests, shutdown). */
  async idle(): Promise<void> {
    if (!this.running && this.waiting.length === 0) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  get depth(): number {
    return this.waiting.length;
  }

  get activeDocumentId(): string | null {
    return this.currentDocumentId;
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      while (this.waiting.length > 0) {
        const job = this.waiting.shift();

        if (!job) {
          continue;
        }

        this.currentDocumentId = job.documentId;

        await this.runJob(job);
      }
    } finally {
      this.running = false;
      this.currentDocumentId = null;

      const resolvers = this.idleResolvers;
      this.idleResolvers = [];

      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  private async runJob(job: IngestJob): Promise<void> {
    const startedAt = Date.now();

    try {
      await this.withTimeout(this.executor(job), this.timeoutMs);

      logger.info(
        {
          documentId: job.documentId,
          durationMs: Date.now() - startedAt,
        },
        "Ingestion job completed.",
      );
    } catch (error) {
      /*
       * The executor owns failure marking (status "failed" + cleanup) for
       * its own errors. This catch is the backstop for executor-level
       * faults — most importantly the hard timeout, whose rejection leaves
       * the executor promise stranded; markIngestionFailed inside the
       * executor may not have run, so the job must be failed here. The
       * executor's final commit re-checks the status record, so a stranded
       * executor that later finishes can no longer flip the document to
       * ready after this.
       */
      const reason =
        error instanceof Error
          ? error.message
          : "Processing failed unexpectedly.";

      logger.error(
        {
          documentId: job.documentId,
          sessionId: job.sessionId,
          durationMs: Date.now() - startedAt,
          err: error,
        },
        "Ingestion job failed.",
      );

      // Best-effort: a failure-handler crash (e.g. Redis hiccup) must not
      // kill the drain loop — the status record then stays "processing"
      // until boot recovery cleans it up on the next restart.
      try {
        await this.onFailure(job, reason);
      } catch (failureError) {
        logger.error(
          { documentId: job.documentId, err: failureError },
          "Ingestion failure handler itself failed.",
        );
      }
    }
  }

  private withTimeout(
    promise: Promise<void>,
    timeoutMs: number,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Ingestion job exceeded the ${Math.round(timeoutMs / 1000)}s hard timeout.`,
            ),
          ),
        timeoutMs,
      );

      timer.unref();
    });

    return Promise.race([promise, timeout]).finally(() => {
      clearTimeout(timer);
    });
  }
}

export const ingestQueue = new IngestQueue(
  processIngestionJob,
  env.INGEST_JOB_TIMEOUT_SEC * 1000,
);
