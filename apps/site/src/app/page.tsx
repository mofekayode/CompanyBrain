import { Hero } from '@/components/home/hero'
import { Problem } from '@/components/home/problem'
import { Process } from '@/components/home/process'
import { Ask } from '@/components/home/ask'
import { Capabilities } from '@/components/home/capabilities'
import { Model } from '@/components/home/model'
import { SecurityBand } from '@/components/home/security-band'
import { FinalCta } from '@/components/home/final-cta'

export default function Home() {
  return (
    <>
      <Hero />
      <Problem />
      <Process />
      <Ask />
      <Capabilities />
      <Model />
      <SecurityBand />
      <FinalCta />
    </>
  )
}
