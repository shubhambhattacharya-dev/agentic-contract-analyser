"use client";

// ─── Chat panel: real SSE pipeline, agent activity, citations, stop ──────────

import { useEffect, useRef, useState } from "react";

import type { CitedSource, ChatMessage } from "@/lib/api";
import { truncateQuote } from "@/lib/format";
import type { LiveAssistant } from "@/hooks/useChat";
import { Spinner } from "@/components/common";

const SUGGESTIONS = [
  "Summarize this document",
  "What are the payment terms?",
  "What is the liability cap?",
  "What is the governing law?",
];

const PHASE_LABEL: Record<string, string> = {
  retrieving: "Retrieving evidence…",
  agent: "Agent is working…",
  generating: "Generating answer…",
};

/** Hides the trailing quotes-JSON footer while tokens are still streaming. */
function stripQuotesFooter(content: string): string {
  const at = content.indexOf('{"quotes"');
  return at === -1 ? content : content.slice(0, at).trimEnd();
}

export function ChatPanel(props: {
  messages: ChatMessage[];
  live: LiveAssistant | null;
  error: string | null;
  busy: boolean;
  documentNames: Record<string, string>;
  onSend: (question: string) => void;
  onStop: () => void;
  onOpenCitation: (source: CitedSource) => void;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
    });
  }, [props.messages.length, props.live?.content]);

  const submit = () => {
    const question = draft.trim();
    if (!question || props.busy) return;
    setDraft("");
    props.onSend(question);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {props.messages.length === 0 && !props.live ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Ask a question about the selected document(s). Answers cite verified
              passages only.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => props.onSend(suggestion)}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <ul className="flex flex-col gap-4">
          {props.messages.map((message) => (
            <li key={message.id}>
              {message.role === "user" ? (
                <div className="ml-auto max-w-[85%] rounded-xl bg-blue-600 px-4 py-2.5 text-sm text-white">
                  {message.content}
                </div>
              ) : (
                <AssistantMessage
                  message={message}
                  documentNames={props.documentNames}
                  onOpenCitation={props.onOpenCitation}
                />
              )}
            </li>
          ))}

          {props.live ? (
            <li>
              <div className="max-w-[95%] rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <AgentActivity live={props.live} />

                {props.live.content ? (
                  <p className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">
                    {stripQuotesFooter(props.live.content)}
                  </p>
                ) : null}

                {props.live.notices.map((notice, index) => (
                  <p
                    key={index}
                    role="status"
                    className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
                  >
                    ⓘ {notice.text}
                  </p>
                ))}

                {props.live.citations.length > 0 ? (
                  <div className="mt-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Citations ({props.live.citations.length})
                    </p>
                    <ul className="flex flex-col gap-2">
                      {props.live.citations.map((source, index) => (
                        <li key={`${source.chunkId}-${index}`}>
                          <CitationCard
                            source={source}
                            documentName={
                              props.documentNames[source.documentId] ??
                              source.documentId
                            }
                            onOpen={() => props.onOpenCitation(source)}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {props.busy ? (
                  <button
                    type="button"
                    onClick={props.onStop}
                    className="mt-3 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                  >
                    ■ Stop generating
                  </button>
                ) : null}

                {props.live.phase === "stopped" ? (
                  <p className="mt-2 text-xs italic text-amber-700 dark:text-amber-400">
                    Generation stopped — partial answer kept.
                  </p>
                ) : null}
              </div>
            </li>
          ) : null}
        </ul>

        {props.error ? (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
          >
            {props.error}
          </p>
        ) : null}
      </div>

      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            disabled={props.busy}
            aria-label="Ask a question about the selected documents"
            placeholder="Ask a question about this document…"
            className="max-h-32 min-h-[42px] flex-1 resize-y rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          />
          <button
            type="button"
            onClick={submit}
            disabled={props.busy || !draft.trim()}
            aria-label="Send question"
            className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  );
}

function AssistantMessage(props: {
  message: ChatMessage;
  documentNames: Record<string, string>;
  onOpenCitation: (source: CitedSource) => void;
}) {
  return (
    <div className="max-w-[95%] rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <p className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">
        {props.message.content}
      </p>

      {props.message.status === "stopped" ? (
        <p className="mt-2 text-xs italic text-amber-700 dark:text-amber-400">
          Generation stopped — partial answer kept.
        </p>
      ) : null}

      {props.message.sources && props.message.sources.length > 0 ? (
        <div className="mt-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Citations ({props.message.sources.length})
          </p>
          <ul className="flex flex-col gap-2">
            {props.message.sources.map((source, index) => (
              <li key={`${source.chunkId}-${index}`}>
                <CitationCard
                  source={source}
                  documentName={
                    props.documentNames[source.documentId] ?? source.documentId
                  }
                  onOpen={() => props.onOpenCitation(source)}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function AgentActivity({ live }: { live: LiveAssistant }) {
  if (live.phase === "done" || live.phase === "stopped" || live.phase === "error") {
    return null;
  }

  return (
    <div className="mb-3" aria-live="polite">
      <p className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
        <Spinner /> {PHASE_LABEL[live.phase] ?? "Working…"}
      </p>

      {live.agentSteps.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 border-l-2 border-blue-200 pl-3 dark:border-blue-800">
          {live.agentSteps.map((step, index) => (
            <li key={index} className="text-xs text-slate-600 dark:text-slate-300">
              <span className="font-medium text-blue-700 dark:text-blue-300">
                Round {step.round}:
              </span>{" "}
              {step.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function CitationCard(props: {
  source: CitedSource;
  documentName: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:border-blue-400 dark:border-slate-700 dark:bg-slate-800/60 dark:hover:border-blue-600"
    >
      <span className="text-base" aria-hidden="true">📄</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
          {props.documentName}
          {props.source.page ? ` · page ${props.source.page}` : ""}
        </span>
        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
          “{truncateQuote(props.source.quote)}”
        </span>
      </span>
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        ✓ Verified
      </span>
      <span aria-hidden="true" className="text-slate-400">›</span>
    </button>
  );
}
