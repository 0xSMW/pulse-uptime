import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import { VercelAnalytics } from "@/components/analytics"
import { ThemeProvider } from "@/components/dashboard/theme-provider"
import { TimezoneProvider } from "@/components/dashboard/timezone-provider"
import { THEME_BOOT_SCRIPT } from "@/lib/theme-boot"

import "./globals.css"

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
})

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
})

export const metadata: Metadata = {
  title: {
    default: "Pulse",
    template: "%s · Pulse",
  },
  description: "Reliable uptime monitoring for public endpoints",
  applicationName: "Pulse Uptime",
}

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html data-theme="dark" lang="en" suppressHydrationWarning>
      <head>
        <script
          // Runs before first paint so a stored light or system preference
          // never flashes dark, while first-time visitors keep the dark
          // default that matches the server-rendered attribute. The status
          // page CSP admits this exact script by hash, see lib/theme-boot.ts.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static pre-hydration theme stamp, no untrusted input
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <ThemeProvider defaultTheme="dark" enableSystem>
          <TimezoneProvider>{children}</TimezoneProvider>
        </ThemeProvider>
        <VercelAnalytics />
      </body>
    </html>
  )
}
