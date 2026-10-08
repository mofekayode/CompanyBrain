import type { Metadata } from 'next'
import { Geist, Geist_Mono, Newsreader } from 'next/font/google'
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { site } from '@/lib/site'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })
const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-newsreader',
})

export const metadata: Metadata = {
  title: { default: `${site.name}: learn how the company you bought actually works`, template: `%s · ${site.name}` },
  description: site.description,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} ${newsreader.variable}`}>
      <body className="min-h-dvh overflow-x-clip">
        <Nav />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  )
}
