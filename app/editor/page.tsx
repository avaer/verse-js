"use client";

import dynamic from "next/dynamic";

// The IDE (Monaco, oniguruma WASM, interpreter) is browser-only.
const Ide = dynamic(() => import("@/src/ide/Ide.jsx"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-[#181818] text-[#8a8a8a]">
      Loading Verse IDE…
    </div>
  ),
});

export default function EditorPage() {
  return (
    <div className="h-dvh overflow-hidden">
      <Ide />
    </div>
  );
}
