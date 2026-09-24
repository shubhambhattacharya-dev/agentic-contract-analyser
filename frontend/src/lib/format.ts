// ─── Display formatters ───────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function truncateQuote(quote: string, max = 90): string {
  const clean = quote.replace(/\s+/gu, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export const ACCEPTED_TYPES =
  ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function validateUploadFile(file: File): string | null {
  const name = file.name.toLowerCase();

  if (!name.endsWith(".pdf") && !name.endsWith(".docx")) {
    return "Only PDF and DOCX files are supported.";
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return "File exceeds the maximum allowed size of 25MB.";
  }

  if (file.size === 0) {
    return "The selected file is empty.";
  }

  return null;
}
