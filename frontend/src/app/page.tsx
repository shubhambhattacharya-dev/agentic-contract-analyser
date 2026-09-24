"use client";

// ─── Root workspace: library ↔ chat ↔ compare with the evidence viewer ───────

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  api,
  ApiError,
  uploadDocument as uploadDocumentApi,
  type CitedSource,
  type ConversationSummary,
  type DocumentMeta,
} from "@/lib/api";
import { validateUploadFile } from "@/lib/format";
import { useChat } from "@/hooks/useChat";
import { useTheme } from "@/hooks/useTheme";
import { Sidebar, type View } from "@/components/Sidebar";
import { Library } from "@/components/Library";
import { ChatPanel } from "@/components/ChatPanel";
import { ViewerPanel, type ViewerFocus } from "@/components/ViewerPanel";
import { MetadataTab, SectionsTab } from "@/components/WorkspaceTabs";
import { ComparePanel } from "@/components/ComparePanel";
import { StatusChip } from "@/components/common";

const MAX_SELECTED = 5;

type WorkspaceTab = "chat" | "sections" | "metadata";

export default function Page() {
  const { theme, toggle } = useTheme();

  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  const [view, setView] = useState<View>("documents");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("chat");

  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [viewerFocus, setViewerFocus] = useState<ViewerFocus | null>(null);

  const chat = useChat();

  const refreshLibrary = useCallback(async () => {
    setLibraryLoading(true);
    setLibraryError(null);

    try {
      const { documents: result } = await api.listDocuments();
      setDocuments(result);
    } catch (cause) {
      setLibraryError(
        cause instanceof ApiError ? cause.message : "Failed to load the library.",
      );
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      const { conversations: result } = await api.listConversations();
      setConversations(result);
    } catch {
      // Sidebar history is non-critical — leave it empty on failure.
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
    void refreshConversations();
  }, [refreshLibrary, refreshConversations]);

  const activeDocument = useMemo(
    () => documents.find((document) => document.documentId === activeDocId) ?? null,
    [documents, activeDocId],
  );

  const documentNames = useMemo(
    () =>
      Object.fromEntries(
        documents.map((document) => [document.documentId, document.originalName]),
      ),
    [documents],
  );

  const handleUploadFile = useCallback(
    async (file: File) => {
      const validation = validateUploadFile(file);

      if (validation) {
        setUploadError(validation);
        return;
      }

      setUploading(true);
      setUploadError(null);
      setUploadPercent(0);

      try {
        const { document } = await uploadDocumentApi(file, setUploadPercent);

        await refreshLibrary();
        setSelectedIds((previous) =>
          previous.length >= MAX_SELECTED
            ? previous
            : [...previous, document.documentId],
        );
        setActiveDocId(document.documentId);
        setView("chat");
        chat.reset();
      } catch (cause) {
        setUploadError(
          cause instanceof ApiError ? cause.message : "Upload failed.",
        );
      } finally {
        setUploading(false);
      }
    },
    [refreshLibrary, chat],
  );

  const handleDelete = useCallback(
    async (documentId: string) => {
      if (!window.confirm("Delete this document and its chat history?")) {
        return;
      }

      setDeletingDocId(documentId);

      try {
        await api.deleteDocument(documentId);
        setSelectedIds((previous) =>
          previous.filter((id) => id !== documentId),
        );
        if (activeDocId === documentId) {
          setActiveDocId(null);
        }
        await refreshLibrary();
        await refreshConversations();
      } catch (cause) {
        setLibraryError(
          cause instanceof ApiError ? cause.message : "Delete failed.",
        );
      } finally {
        setDeletingDocId(null);
      }
    },
    [activeDocId, refreshLibrary, refreshConversations],
  );

  const handleToggleSelect = useCallback((documentId: string) => {
    setSelectedIds((previous) => {
      if (previous.includes(documentId)) {
        return previous.filter((id) => id !== documentId);
      }

      if (previous.length >= MAX_SELECTED) {
        return previous;
      }

      return [...previous, documentId];
    });
  }, []);

  const handleOpen = useCallback(
    (documentId: string) => {
      setActiveDocId(documentId);
      setSelectedIds((previous) =>
        previous.includes(documentId) ? previous : [documentId],
      );
      setViewerFocus(null);
      chat.reset();
      setView("chat");
      setTab("chat");
    },
    [chat],
  );

  const handleOpenConversation = useCallback(
    async (conversationId: string) => {
      try {
        const { conversation } = await api.getConversation(conversationId);

        chat.reset();
        chat.setMessages(conversation.messages);
        setSelectedIds(
          conversation.documentIds.filter((id) =>
            documents.some((document) => document.documentId === id),
          ),
        );
        if (conversation.documentIds[0]) {
          setActiveDocId(conversation.documentIds[0]);
        }
        setView("chat");
        setTab("chat");
      } catch (cause) {
        setLibraryError(
          cause instanceof ApiError
            ? cause.message
            : "Could not open the conversation.",
        );
      }
    },
    [chat, documents],
  );

  const handleOpenCitation = useCallback((source: CitedSource) => {
    setActiveDocId(source.documentId);
    setViewerFocus({
      documentId: source.documentId,
      startOffset: source.startOffset,
      endOffset: source.endOffset,
      nonce: Date.now(),
    });
  }, []);

  const handleGoToSection = useCallback(
    (startOffset: number) => {
      if (!activeDocId) return;
      setViewerFocus({
        documentId: activeDocId,
        startOffset,
        endOffset: startOffset + 400,
        nonce: Date.now(),
      });
    },
    [activeDocId],
  );

  const startChat = useCallback(
    (question: string) => {
      if (selectedIds.length === 0) {
        return;
      }
      chat.send(question, selectedIds, chat.conversationId ?? undefined);
      setView("chat");
    },
    [chat, selectedIds],
  );

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Sidebar
        view={view}
        onView={(next) => {
          setView(next);
          if (next === "chat" && !activeDocument && selectedIds[0]) {
            setActiveDocId(selectedIds[0]);
          }
        }}
        conversations={conversations}
        onOpenConversation={handleOpenConversation}
        onUploadFile={handleUploadFile}
        uploading={uploading}
        uploadPercent={uploadPercent}
        uploadError={uploadError}
        theme={theme}
        onToggleTheme={toggle}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {view === "documents" ? (
          <section className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="mb-4 flex items-center justify-between">
              <h1 className="text-xl font-bold">Documents</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Select up to {MAX_SELECTED} documents to chat across.
              </p>
            </div>

            {selectedIds.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  if (!activeDocId) setActiveDocId(selectedIds[0]!);
                  setView("chat");
                }}
                className="mb-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                Chat with {selectedIds.length} selected document
                {selectedIds.length > 1 ? "s" : ""} →
              </button>
            ) : null}

            <Library
              documents={documents}
              loading={libraryLoading}
              error={libraryError}
              selectedIds={selectedIds}
              activeDocId={activeDocId}
              onToggleSelect={handleToggleSelect}
              onOpen={handleOpen}
              onDelete={handleDelete}
              deletingDocId={deletingDocId}
              onRetry={refreshLibrary}
              onGoUpload={() =>
                document
                  .querySelector<HTMLInputElement>(
                    'input[aria-label^="Upload a contract"]',
                  )
                  ?.click()
              }
            />
          </section>
        ) : view === "compare" ? (
          <section className="min-h-0 flex-1">
            <ComparePanel
              documents={documents}
              onOpenEvidence={(documentId, startOffset) => {
                setActiveDocId(documentId);
                setViewerFocus({
                  documentId,
                  startOffset,
                  endOffset: startOffset !== null ? startOffset + 400 : null,
                  nonce: Date.now(),
                });
                setView("chat");
              }}
            />
          </section>
        ) : (
          <section className="flex min-h-0 flex-1 flex-col">
            {activeDocument ? (
              <>
                <header className="border-b border-slate-200 p-4 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-3">
                    <h1 className="min-w-0 flex-1 truncate text-xl font-bold">
                      {activeDocument.originalName}
                    </h1>
                    <StatusChip status="ready" />
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {activeDocument.pageCount} pages ·{" "}
                      {Math.round(activeDocument.sizeBytes / 1024)} KB
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Selected ({selectedIds.length}):
                    </span>
                    {selectedIds.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                      >
                        <span className="max-w-[140px] truncate">
                          {documentNames[id] ?? id}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleToggleSelect(id)}
                          aria-label={`Remove ${documentNames[id] ?? id} from selection`}
                          className="text-slate-400 hover:text-red-500"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {selectedIds.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => setView("documents")}
                        className="text-xs font-medium text-blue-600 dark:text-blue-400"
                      >
                        + Add document
                      </button>
                    ) : null}
                  </div>

                  <div
                    className="mt-3 flex gap-1"
                    role="tablist"
                    aria-label="Workspace views"
                  >
                    {(["chat", "sections", "metadata"] as WorkspaceTab[]).map(
                      (candidate) => (
                        <button
                          key={candidate}
                          type="button"
                          role="tab"
                          aria-selected={tab === candidate}
                          onClick={() => setTab(candidate)}
                          className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize ${
                            tab === candidate
                              ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                              : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                          }`}
                        >
                          {candidate}
                        </button>
                      ),
                    )}
                  </div>
                </header>

                <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                  <div className="min-h-0 flex-1">
                    {tab === "chat" ? (
                      <ChatPanel
                        messages={chat.messages}
                        live={chat.live}
                        error={chat.error}
                        busy={chat.busy}
                        documentNames={documentNames}
                        onSend={startChat}
                        onStop={chat.stop}
                        onOpenCitation={handleOpenCitation}
                      />
                    ) : tab === "sections" ? (
                      <div className="h-full overflow-y-auto">
                        <SectionsTab
                          document={activeDocument}
                          onGoToSection={handleGoToSection}
                        />
                      </div>
                    ) : (
                      <div className="h-full overflow-y-auto">
                        <MetadataTab document={activeDocument} />
                      </div>
                    )}
                  </div>

                  <div className="min-h-0 lg:w-[42%]">
                    <ViewerPanel document={activeDocument} focus={viewerFocus} />
                  </div>
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500 dark:text-slate-400">
                Open a document from the library to start chatting with it.
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
