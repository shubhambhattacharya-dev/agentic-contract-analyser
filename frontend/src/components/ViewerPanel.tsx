"use client";

// ─── Document viewer: canonical text, page navigation, verified highlighting ─

import { useEffect, useMemo, useRef, useState } from "react";

import { api, type DocumentContent, type DocumentMeta } from "@/lib/api";
import { renderPage } from "@/lib/highlight";
import { ErrorState, Spinner } from "@/components/common";

export interface ViewerFocus {
  documentId: string;
  startOffset: number | null;
  endOffset: number | null;
  nonce: number;
}

export function ViewerPanel(props: {
  document: DocumentMeta;
  focus: ViewerFocus | null;
}) {
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const markRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);

    api
      .getDocumentContent(props.document.documentId)
      .then((result) => {
        if (!cancelled) setContent(result);
      })
      .catch((error: Error) => {
        if (!cancelled) setError(error.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [props.document.documentId]);

  const pages = content?.pages ?? [];
  const currentPage =
    pages.find((page) => page.pageNumber === pageNumber) ?? null;

  // Jump to the cited page whenever a new citation focus arrives.
  useEffect(() => {
    if (!props.focus || !content) return;

    if (props.focus.startOffset !== null) {
      const target = pages.find(
        (page) =>
          props.focus!.startOffset! >= page.startOffset &&
          props.focus!.startOffset! < page.endOffset,
      );

      if (target) {
        setPageNumber(target.pageNumber);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.nonce, content]);

  useEffect(() => {
    if (props.focus?.startOffset !== null && props.focus?.startOffset !== undefined) {
      markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.nonce, pageNumber, content]);

  const rendered = useMemo(() => {
    if (!content || !currentPage) return null;

    const withinPage =
      props.focus &&
      props.focus.documentId === props.document.documentId &&
      props.focus.startOffset !== null &&
      currentPage.startOffset < (props.focus.endOffset ?? 0) &&
      currentPage.endOffset > props.focus.startOffset
        ? {
            start: props.focus.startOffset,
            end: props.focus.endOffset ?? props.focus.startOffset,
          }
        : null;

    return renderPage(content.text, currentPage, withinPage?.start ?? null, withinPage?.end ?? null);
  }, [content, currentPage, props.focus, props.document.documentId]);

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 p-3 dark:border-slate-800">
        <p className="min-w-0 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
          📄 {props.document.originalName}
        </p>
        <p className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
          Page{" "}
          <input
            type="number"
            min={1}
            max={props.document.pageCount || 1}
            value={pageNumber}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (next >= 1 && next <= (props.document.pageCount || 1)) {
                setPageNumber(next);
              }
            }}
            aria-label="Page number"
            className="w-14 rounded border border-slate-200 px-1 py-0.5 text-center dark:border-slate-700 dark:bg-slate-900"
          />{" "}
          / {props.document.pageCount}
        </p>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setPageNumber((page) => Math.max(1, page - 1))}
            disabled={pageNumber <= 1}
            aria-label="Previous page"
            className="rounded border border-slate-200 px-2 py-1 text-sm disabled:opacity-40 dark:border-slate-700"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() =>
              setPageNumber((page) =>
                Math.min(props.document.pageCount || 1, page + 1),
              )
            }
            disabled={pageNumber >= props.document.pageCount}
            aria-label="Next page"
            className="rounded border border-slate-200 px-2 py-1 text-sm disabled:opacity-40 dark:border-slate-700"
          >
            ›
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-100 p-4 dark:bg-slate-950">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
            <Spinner /> Loading document text…
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={() => setPageNumber((page) => page)} />
        ) : content && rendered ? (
          <article
            lang="en"
            className="mx-auto max-w-2xl rounded-lg bg-white p-8 font-serif text-[15px] leading-7 text-slate-800 shadow-sm dark:bg-slate-900 dark:text-slate-200"
          >
            <p className="mb-4 text-right text-xs text-slate-400">
              Page {currentPage?.pageNumber}
            </p>

            {rendered.before}
            {rendered.mark ? (
              <mark
                ref={markRef}
                data-testid="verified-highlight"
                className="rounded bg-blue-200 px-0.5 text-inherit dark:bg-blue-800/60 dark:text-blue-50"
              >
                {rendered.mark}
              </mark>
            ) : null}
            {rendered.after}

            {!currentPage && content.text ? (
              <span className="whitespace-pre-wrap">{content.text}</span>
            ) : null}
          </article>
        ) : null}
      </div>
    </div>
  );
}
