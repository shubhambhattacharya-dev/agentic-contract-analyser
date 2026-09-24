"use client";

// ─── Sections + Metadata tabs ─────────────────────────────────────────────────

import { useEffect, useState } from "react";

import { api, type DocumentContent, type DocumentMeta } from "@/lib/api";
import { deriveSections } from "@/lib/highlight";
import { formatBytes, formatDate } from "@/lib/format";
import { ErrorState, Spinner } from "@/components/common";

export function SectionsTab(props: {
  document: DocumentMeta;
  onGoToSection: (startOffset: number) => void;
}) {
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .getDocumentContent(props.document.documentId)
      .then((result) => {
        if (!cancelled) setContent(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });

    return () => {
      cancelled = true;
    };
  }, [props.document.documentId]);

  if (error) return <ErrorState message={error} />;
  if (!content) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-slate-500">
        <Spinner /> Loading sections…
      </div>
    );
  }

  const sections = deriveSections(content.text);

  if (sections.length === 0) {
    return (
      <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
        No numbered sections were detected in this document text.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
      {sections.map((section) => (
        <li key={section.startOffset}>
          <button
            type="button"
            onClick={() => props.onGoToSection(section.startOffset)}
            className="w-full px-4 py-2.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <span className="font-semibold text-blue-700 dark:text-blue-300">
              {section.number}
            </span>{" "}
            <span className="text-slate-700 dark:text-slate-200">
              {section.title}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function MetadataTab({ document }: { document: DocumentMeta }) {
  const rows: [string, string][] = [
    ["File name", document.originalName],
    ["MIME type", document.mimeType],
    ["Pages", String(document.pageCount)],
    ["Words", String(document.wordCount)],
    ["Characters", String(document.charCount)],
    ["Parent chunks", String(document.parentChunkCount)],
    ["Child chunks", String(document.childChunkCount)],
    ["Size", formatBytes(document.sizeBytes)],
    ["Uploaded", formatDate(document.createdAt)],
  ];

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-4 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="font-medium text-slate-500 dark:text-slate-400">{label}</dt>
          <dd className="break-all text-slate-800 dark:text-slate-100">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
