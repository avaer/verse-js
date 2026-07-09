import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Verse IDE — verse-js",
  description:
    "Edit, run, and debug Verse in the browser: breakpoints, stepping, live diagnostics, and generated builtin docs.",
};

export default function EditorLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
