import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CodexPanel',
  description: 'Web panel for Codex app server integration',
  other: {
    'format-detection': 'telephone=no, date=no, email=no, address=no',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" translate="no" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
