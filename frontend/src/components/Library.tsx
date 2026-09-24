"use client";

// ─── Document library: list, open, delete ─────────────────────────────────────

import type { DocumentMeta } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import { EmptyState, ErrorState, Spinner, StatusChip } from "@/components/common";

export function Library(props: {
  documents: DocumentMeta[];
  loading: boolean;
  error: string | null;
  selectedIds: string[];
  activeDocId: string | null;
  onToggleSelect: (documentId: string) => void;
  onOpen: (documentId: string) => void;
  onDelete: (documentId: string) => void;
  deletingDocId: string | null;
  onRetry: () => void;
  onGoUpload: () => void;
}) {
  if (props.loading) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        {[1, 2, 3].map((index) => (
          <div
            key={index}
            className="h-20 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800"
          />
        ))}
        <span className="sr-only">Loading documents</span>
      </div>
    );
  }

  if (props.error) {
    return <ErrorState message={props.error} onRetry={props.onRetry} />;
  }

  if (props.documents.length === 0) {
    return (
      <EmptyState
        title="No documents yet"
        hint="Upload a PDF or DOCX contract to start asking questions about it."
        action={
          <button
            type="button"
            onClick={props.onGoUpload}
            className="mt-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            + Upload your first document
          </button>
        }
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {props.documents.map((document) => {
        const selected = props.selectedIds.includes(document.documentId);
        const active = props.activeDocId === document.documentId;

        return (
          <li
            key={document.documentId}
            className={`rounded-xl border bg-white p-4 transition-colors dark:bg-slate-900 ${
              active
                ? "border-blue-400 dark:border-blue-600"
                : "border-slate-200 dark:border-slate-800"
            }`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="checkbox"
                checked={selected}
                onChange={() => props.onToggleSelect(document.documentId)}
                aria-label={`Select ${document.originalName} for chat`}
                className="h-4 w-4 accent-blue-600"
              />

              <button
                type="button"
                onClick={() => props.onOpen(document.documentId)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate font-semibold text-slate-900 dark:text-white">
                  {document.originalName}
                </span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {document.pageCount} pages · {formatBytes(document.sizeBytes)} ·{" "}
                  {formatDate(document.createdAt)} · {document.childChunkCount} chunks
                </span>
              </button>

              <StatusChip status="ready" />

              <button
                type="button"
                onClick={() => props.onOpen(document.documentId)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Open
              </button>

              <button
                type="button"
                onClick={() => props.onDelete(document.documentId)}
                disabled={props.deletingDocId === document.documentId}
                className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
              >
                {props.deletingDocId === document.documentId ? (
                  <Spinner className="border-red-300 border-t-red-600" />
                ) : (
                  "Delete"
                )}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
