"use client";

// ─── Sidebar: brand, upload, navigation, recent conversations, theme ─────────

import { useRef } from "react";

import type { ConversationSummary } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { Spinner } from "@/components/common";
import type { Theme } from "@/hooks/useTheme";

export type View = "documents" | "chat" | "compare";

export function Sidebar(props: {
  view: View;
  onView: (view: View) => void;
  conversations: ConversationSummary[];
  onOpenConversation: (conversationId: string) => void;
  onUploadFile: (file: File) => void;
  uploading: boolean;
  uploadPercent: number;
  uploadError: string | null;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const navItem = (label: string, target: View) => (
    <button
      key={target}
      type="button"
      onClick={() => props.onView(target)}
      aria-current={props.view === target ? "page" : undefined}
      className={`w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
        props.view === target
          ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
          : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      {label}
    </button>
  );

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col gap-4 border-r border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div>
        <p className="text-lg font-bold text-slate-900 dark:text-white">Elcara</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">Contract Analyser</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.docx"
        className="hidden"
        aria-label="Upload a contract (PDF or DOCX)"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) props.onUploadFile(file);
          event.target.value = "";
        }}
      />

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={props.uploading}
        className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
      >
        {props.uploading ? <Spinner className="border-white/40 border-t-white" /> : "+"}
        {props.uploading ? `Uploading ${props.uploadPercent}%` : "Upload Document"}
      </button>

      {props.uploadError ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {props.uploadError}
        </p>
      ) : null}

      <nav className="flex flex-col gap-1" aria-label="Main">
        {navItem("Documents", "documents")}
        {navItem("Chat", "chat")}
        {navItem("Compare", "compare")}
      </nav>

      <div className="flex-1 overflow-y-auto">
        <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Recent conversations
        </p>

        {props.conversations.length === 0 ? (
          <p className="px-1 text-xs text-slate-400">No conversations yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {props.conversations.map((conversation) => (
              <li key={conversation.conversationId}>
                <button
                  type="button"
                  onClick={() => props.onOpenConversation(conversation.conversationId)}
                  className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <span className="block truncate">
                    {conversation.messages.find((message) => message.role === "user")
                      ?.content ?? "Conversation"}
                  </span>
                  <span className="block text-xs text-slate-400">
                    {formatRelative(conversation.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={props.onToggleTheme}
        className="rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        aria-label={`Switch to ${props.theme === "dark" ? "light" : "dark"} mode`}
      >
        {props.theme === "dark" ? "☀ Light mode" : "☾ Dark mode"}
      </button>
    </aside>
  );
}
