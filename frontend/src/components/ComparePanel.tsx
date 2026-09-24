"use client";

// ─── Comparison: real POST /api/compare, backend severity/kinds only ─────────

import { useState } from "react";

import {
  api,
  ApiError,
  type ComparisonResponse,
  type DocumentMeta,
} from "@/lib/api";
import { EmptyState, ErrorState, SeverityChip, Spinner } from "@/components/common";

type Filter = "all" | "changed" | "added" | "removed";

export function ComparePanel(props: {
  documents: DocumentMeta[];
  onOpenEvidence: (documentId: string, startOffset: number | null) => void;
}) {
  const [docA, setDocA] = useState<string>("");
  const [docB, setDocB] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ComparisonResponse | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const runCompare = async () => {
    if (!docA || !docB || docA === docB) {
      setError("Pick two different documents to compare.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      setResult(await api.compare(docA, docB));
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "The comparison failed unexpectedly.",
      );
    } finally {
      setLoading(false);
    }
  };

  const selector = (
    value: string,
    onChange: (value: string) => void,
    label: string,
  ) => (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={label}
      className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-white"
    >
      <option value="">Select a document…</option>
      {props.documents.map((document) => (
        <option key={document.documentId} value={document.documentId}>
          {document.originalName}
        </option>
      ))}
    </select>
  );

  const visibleChanges = result
    ? result.changes.filter((change) => filter === "all" || change.kind === filter)
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {selector(docA, setDocA, "Document A")}
        <span aria-hidden="true" className="text-slate-400">⇄</span>
        {selector(docB, setDocB, "Document B")}
        <button
          type="button"
          onClick={runCompare}
          disabled={loading || !docA || !docB}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? <Spinner className="border-white/40 border-t-white" /> : "Compare"}
        </button>
      </div>

      {error ? <ErrorState message={error} /> : null}

      {!result && !loading && !error ? (
        <EmptyState
          title="Compare two versions of a contract"
          hint="Pick the original and the amendment — differences are reported at clause level with severity."
        />
      ) : null}

      {result ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            {(
              [
                ["all", `All (${result.changes.length})`],
                ["changed", `Changed (${result.counts.moderate + result.counts.critical})`],
                ["added", `Added`],
                ["removed", `Missing`],
              ] as [Filter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
                className={`rounded-full border px-3 py-1 font-medium ${
                  filter === value
                    ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                    : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"
                }`}
              >
                {label}
              </button>
            ))}
            <span className="ml-auto text-slate-400">
              🔥 {result.counts.critical} critical · {result.counts.moderate} moderate ·{" "}
              {result.counts.minor} minor
            </span>
          </div>

          {visibleChanges.length === 0 ? (
            <EmptyState
              title="No differences in this category"
              hint="The selected documents are equivalent here."
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {visibleChanges.map((change, index) => (
                <li
                  key={index}
                  className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-white">
                      {change.label}
                    </span>
                    <span className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                      {change.kind}
                    </span>
                    <SeverityChip severity={change.severity} />
                  </div>

                  <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
                    {change.summary}
                  </p>

                  {change.textA || change.textB ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-blue-700 dark:text-blue-300">
                        View evidence
                      </summary>
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        {change.textA ? (
                          <blockquote className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                            <span className="mb-1 block font-semibold">Version A</span>
                            {change.textA.slice(0, 800)}
                          </blockquote>
                        ) : null}
                        {change.textB ? (
                          <blockquote className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                            <span className="mb-1 block font-semibold">Version B</span>
                            {change.textB.slice(0, 800)}
                          </blockquote>
                        ) : null}
                      </div>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
