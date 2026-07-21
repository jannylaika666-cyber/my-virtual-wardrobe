import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trips | App",
};

export default function TripLayout({ children }: { children: React.ReactNode }) {
  return children;
}
