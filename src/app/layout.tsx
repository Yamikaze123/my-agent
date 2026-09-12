import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Data Studio | AI Data Analysis",
  description:
    "Explore data, create visualizations, and uncover insights with an AI-powered analysis workspace.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
