import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Code Visualizer",
  description:
    "Write a JavaScript function, inspect its arguments, set breakpoints, and step through a recorded execution trace.",
};

export default function VisualizerLayout({ children }: { children: ReactNode }) {
  return children;
}
