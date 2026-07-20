import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Design Wardrobe | App",
};

export default function WardrobeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
