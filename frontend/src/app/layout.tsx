import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Elcara — Contract Analyser",
  description:
    "Upload a contract, ask questions, and get answers backed by verified quotes.",
};

const themeBoot = `
try {
  var theme = localStorage.getItem("elcara-theme");
  if (theme === "dark" || theme === "light") {
    document.documentElement.classList.toggle("dark", theme === "dark");
  } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    document.documentElement.classList.add("dark");
  }
} catch (e) {}
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
